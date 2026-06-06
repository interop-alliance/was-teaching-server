# History

## 0.2.0 - TBD

### Added

- Emit the spec-REQUIRED `type` property on every `application/problem+json`
  error response. A new `src/problem-types.ts` defines a `ProblemTypes` catalog
  of problem-_kind_ `type` URIs (e.g. `#not-found`, `#invalid-id`,
  `#controller-mismatch`), keyed by the kind of problem and reused across
  operations per [[RFC9457]] -- not per operation. Privacy-sensitive conditions
  (Space / Collection / Resource not found, failed capability invocation) all
  collapse to a single `#not-found` so `type` cannot be used to probe resource
  existence. Body-validation responses now also carry a `pointer` (RFC 6901
  JSON Pointer, `#/field` form) identifying the offending field; the combined
  Create/Update Space "name and controller" check is split so each missing field
  reports its own `#/name` / `#/controller` pointer. The WAS spec gains an
  "Error Type Registry" appendix documenting the catalog.

### Changed

- Re-parent the error classes in `src/errors.ts` onto a shared `ProblemError`
  base carrying `type` / `title` / `detail` / `statusCode` and an optional
  `problems: { detail, pointer }[]` array, removing the repeated field-triad
  boilerplate. `handleError` now serializes `type` and the `problems` array
  (falling back to `[{ detail }]`).
- Refactor `conformance/helpers.ts` to dogfood `@interop/was-client`: identities
  built by `buildZcapClients()` now carry a high-level `was` client alongside the
  raw `rootClient`, a new `wasClient({ signer })` helper mirrors
  `zcapClient({ signer })`, and `createSpace()`'s ZCap path goes through
  `WasClient.request()`. The exported helper surface is unchanged. (Requires the
  unpublished `@interop/was-client` dependency to be added once it ships to npm.)

### Security

- Sanitize `spaceId` / `collectionId` / `resourceId` against path traversal. A
  new `src/lib/validateId.ts` exports `assertValidId(id, { kind })` /
  `assertValidIds(ids)`, which reject any id that is not a single URL-safe path
  segment (empty, `.`, `..`, containing `/` or `\`, or outside the RFC 3986
  unreserved charset -- which also excludes every glob metacharacter). It is
  enforced at the request layer (every `SpaceRequest` / `CollectionRequest` /
  `ResourceRequest` handler, plus client-supplied ids in the Create Space /
  Create Collection bodies) before any storage access, and at the tar-import
  layer (`src/lib/importTar.ts`) for every id parsed out of an archive entry
  name. As defense in depth, `FileSystemBackend` now asserts that every built
  path resolves within its `spaces/` root before any filesystem operation. New
  `InvalidCollectionIdError` / `InvalidResourceIdError` (400) join the existing
  `InvalidSpaceIdError`.

### Fixed

- Replace generic `throw new Error('Could not ...')` in the Collection and
  Resource create/update/delete paths with
  `StorageError({ cause, requestName })` so storage failures surface a typed 500
  with a title/detail through `handleError` instead of a bare 500 (and rename
  the `e` catch vars to `err`).
- Validate request bodies and headers before use: Create Space (`POST /spaces/`)
  and Update Space (`PUT /space/:spaceId`) now reject a body missing `name` or
  `controller` with a typed 400 (`InvalidRequestBodyError`) rather than failing
  deeper, and `resolveResourceInput` rejects a missing `Content-Type` header
  with a typed 400 (`MissingContentTypeError`) instead of asserting it non-null.

### Changed

- Make the storage backend an injectable dependency of `createApp()`. The app
  factory now accepts a `backend` (`createApp({ serverUrl, backend })`) and
  decorates the Fastify instance with it; request handlers read it as
  `request.server.storage` rather than importing a module-level facade.
  `src/storage.ts` no longer holds a hardcoded singleton — it exposes
  `defaultBackend()` (a filesystem backend rooted at `data/`), which
  `createApp()` uses when no backend is injected (production / `start.ts`). Each
  `test/` suite now injects its own `FileSystemBackend` over an `mkdtemp` temp
  dir and removes it in `afterAll`, so suites no longer share (or leak) the
  gitignored `data/` directory.

- Decouple the `StorageBackend` persistence port from the HTTP transport.
  `writeResource` now takes a transport-neutral `ResourceInput` value object
  (`{ kind: 'json'; data } | { kind: 'binary'; stream }`, both carrying a
  `contentType`) instead of a raw Fastify `request`. A new request-layer
  adapter, `resolveResourceInput()` in `src/requests/resourceInput.ts`, is now
  the only place that reads `request.body` / `request.file()` and distinguishes
  multipart from raw-blob bodies; the backends (`filesystem`, `memory`) no
  longer import Fastify at all.

  _Architectural note (ports & adapters):_ `StorageBackend` is a driven
  (secondary) port with two interchangeable adapters. Passing the inbound
  `FastifyRequest` into it coupled that driven port to the HTTP driving
  (primary) adapter — the one dependency direction hexagonal architecture
  forbids. Routing the conversion through `resolveResourceInput()` restores the
  boundary: backends now depend only on domain types, can be unit-tested with
  plain values (no fake request objects — see `test/storage.test.ts`), and the
  multipart/blob distinction lives where it belongs, in the HTTP layer.

- Tighten the `StorageBackend` contract so a Resource has exactly one current
  representation, identified by `resourceId` alone within a Collection.
  Previously a resource's identity was effectively `(resourceId, contentType)`
  -- an emergent property of how each backend stored the content-type out of
  band (filename segment on the filesystem, composite
  `${resourceId}::${contentType}` map key in memory). As a result, `PUT`-ing an
  id as one content-type and then re-`PUT`-ing it under another left two stored
  representations instead of replacing the first; `getResource` returned a
  nondeterministic one and the listing emitted the id twice. Now `writeResource`
  replaces any prior representation regardless of its content-type (the
  filesystem backend prunes the old file after writing the new one; the memory
  backend overwrites in place), and `getResource`'s `contentType` parameter is
  advisory -- the single representation is resolved by `resourceId` alone, with
  the stored content-type returned in `ResourceResult.storedResourceType`. The
  content-type stays human-visible in the filesystem filename; it is now a
  descriptive attribute, not part of identity. No method signatures or spec
  behaviour changed.

- Route all server diagnostics through the Fastify pino logger instead of
  scattered `console.*` calls. `FileSystemBackend` now logs through an injected
  logger (`StorageBackend.logger`, typed as Fastify's `FastifyBaseLogger`);
  `createApp()` wires `fastify.log` into the active backend, and the backend
  defaults to a silent pino logger until then. `StorageError` no longer logs
  from its constructor -- `handleError` now logs 5xx faults (including the
  underlying `cause`) once, through `request.log`, leaving 4xx client errors
  unlogged.

### Fixed

- `GET /space/:spaceId/:collectionId/:resourceId` no longer masks every
  `getResource` failure as a 404. The handler previously swallowed any error
  from the backend and reported "resource not found"; it now re-throws a genuine
  `ResourceNotFoundError` as the 404 and wraps any other failure as a typed 500
  (`StorageError`) so real storage faults are no longer hidden.

## 0.1.0 - 2026-06-04

### Changed

- Convert the codebase from JavaScript (ES2020 + JSDoc) to TypeScript (strict,
  `NodeNext`). Dev runs via `tsx`; production builds with `tsc` to `dist/`.
  Tooling adopted: ESLint flat config, Prettier, Vitest.
- Migrate the `test/` integration suite to Vitest; keep the `conformance/` suite
  standalone (run via `tsx --test`).
- Bump `@interop/*` packages to v7: `did-method-key` 7.x, `ed25519-signature`
  7.x, `ed25519-verification-key` 7.x; update `security-document-loader` to
  9.2.x and `ezcap` (dev) to 7.x.
- Swap `@interop-alliance/http-signature-zcap-verify` for the typed
  `@interop/http-signature-zcap-verify` fork.

### Added

- Add `@interop/data-integrity-core` as a direct dependency (source of shared
  types).

### Fixed

- `writeResource` now awaits `request.file()` in both backends (multipart
  resource writes).
- `ResourceRequest.delete` / `CollectionRequest.delete` now import the
  `StorageError` they throw.
- Fix test ordering bug in collection and resource api tests.

## 0.0.6 - 2026-05-31

### Changed

- Migrate to `@interop/` forks of the key, signature and DID packages.

## 0.0.5 - 2026-05-11

### Added

- Implement 'List Collections' request.

## 0.0.4 - 2026-05-11

### Changed

- Refactor storage.js into file and memory backends.
- Fix start server error logging.
- Refactor listCollectionItems to use 'items' instead of 'rows'.
- Add exportSpace functionality to FileSystemBackend.
- Bump deps to latest.

## 0.0.3 - 2026-03-25

### Changed

- Add PUT Resource route.
- Refactor listCollections result objects.

## 0.0.2 - 2026-03-24

### Changed

- Add SERVER_URL and PORT env vars, better errors.

## 0.0.1 - 2025-08-25

### Added

- Initial commits
