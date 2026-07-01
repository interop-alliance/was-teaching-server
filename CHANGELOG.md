# History

## Unreleased - TBD

### Added

- **Operational `/health` liveness endpoint.** A public, unauthenticated,
  side-effect-free `GET /health` returns `200` with an `application/health+json`
  body (`{ "status": "pass", "version": ... }`, following the IETF
  `draft-inadarei-api-health-check` shape) so load balancers, uptime monitors,
  and orchestrators can poll cheaply; `HEAD /health` serves a bodyless `200` for
  probes that don't want a body. This is an operational affordance, not a WAS
  protocol feature. `scripts/conformance-local.ts` now polls `/health` for
  startup readiness instead of the HTML welcome page.

- **Encryption Scheme Registry enforcement (spec "Encryption Scheme
  Registry").** The server now provides the fail-closed guarantee that plaintext
  can never land in a Collection marked encrypted with a recognized scheme:
  - A Collection `encryption` marker is gated against a recognized-scheme
    registry (`SUPPORTED_ENCRYPTION_SCHEMES`; v1 has `edv` ->
    `application/jose+json`). An unrecognized `scheme` is now rejected with the
    new `unsupported-encryption-scheme` (400) error rather than stored opaquely.
  - A Resource **content** write into a recognized-scheme Collection is
    structurally validated (`Create Resource` `POST`, `Put Resource` `PUT`): the
    request `Content-Type` MUST be the scheme's registered media type and the
    body MUST be a structurally valid envelope (a JWE in JSON serialization for
    `edv`, validated by `src/lib/edvEnvelope.ts` -- shape only, never
    decrypted), else the new `encryption-scheme-mismatch` (422) error. Checked
    after capability verification, so an under-authorized caller still receives
    the privacy-merged `not-found` (404). Server-managed API documents
    (Collection Descriptions, Resource Metadata, policies, linksets) are
    unaffected and stay `application/json`.
  - Requires `@interop/storage-core` ^0.3.1 (adds the two new problem types).

### Fixed

- **Top-level falsy JSON Resources no longer 500.** Storing a bare top-level
  JSON `null` (and likewise `false`, `0`, `""`) into a plaintext Collection
  failed with a 500: the filesystem backend wrote JSON via `fs-json-store`,
  whose `write` re-reads through `readExisting`, which treats a falsy
  round-tripped value as "file does not exist". The backend now serializes and
  writes JSON Resource bodies directly (creating the Collection dir as needed),
  so any top-level JSON value -- object, array, or bare primitive -- round-trips
  intact.

## 0.7.0 - 2026-06-28

### Added

- **Collection client-side encryption marker (spec "Encrypted Collections").** A
  Collection may now carry a non-secret `encryption` marker (e.g.
  `{ "scheme": "edv" }`) declaring its Resources client-side encrypted. The
  server stores it opaquely (it never decrypts), validates only its shape
  (`invalid-request-body` 400 on a malformed marker), and enforces **set-once**
  immutability: declaring a marker on a Collection that lacks one is allowed,
  but changing its `scheme` or clearing it on an existing Collection is rejected
  with the new `encryption-immutable` (409) error. Accepted on Create Collection
  (`POST`) and Update Collection (`PUT`) and echoed in the Collection
  Description, so any authorized reader -- including a delegated consumer -- can
  discover it. New helper `src/lib/encryption.ts` (mirrors the `backend`
  validate/resolve pattern).
- **Per-Collection backend resolver (registered backends are now selectable).**
  A Collection may now **select** a registered `external` backend as its
  `backend`, and its **data plane** (resource bytes, metadata, listings, change
  feed) is routed to that backend's adapter, while the server `default` backend
  keeps the **control plane** (Space/Collection descriptions, policies, backend
  registry records). A new resolver (`src/lib/backendRegistry.ts`) maps a
  Collection's selected `backend.id` to a memoized `StorageBackend` adapter
  built from an injected **provider registry** (`createApp({ providers })`); for
  the `default` selection it short-circuits to the server backend, so existing
  behavior is unchanged. The production provider registry ships **empty**, so a
  Collection that selects an `external` backend with no registered provider
  adapter fails closed with `unsupported-backend` (409) on its data-plane
  operations until a provider is wired (stages 4-5: Google OAuth, Drive adapter,
  at-rest secret encryption). Still provider-agnostic plumbing -- no Google
  dependency.
- **Backend registration allowlist (`WAS_ENABLED_BACKENDS`).** An operator may
  restrict which backend `provider`s a wallet can register via a comma-separated
  env list; a registration whose `provider` is not listed is rejected fast with
  `unsupported-backend` (409). Unset means **permissive** (any provider may be
  registered), preserving prior behavior.

- **Backend registration write endpoints.** A wallet can now register an
  `external` ("Bring Your Own Storage") backend against a Space via
  `POST /space/{id}/backends`, replace it with
  `PUT /space/{id}/backends/{backendId}` (upsert), and deregister it with
  `DELETE /space/{id}/backends/{backendId}`. Authorization is the Space
  controller's capability (capability-only, like Create Collection / Delete
  Space). The write body is secret-bearing (a generic `provider` + `connection`
  envelope), but every response and the `GET /space/{id}/backends` listing
  return a **sanitized** descriptor whose `connection` is reduced to public
  fields (`kind` / `status` / ...) -- the secret connection material is
  reachable only via the internal `getBackend` storage method. The
  `StorageBackend` contract gains `writeBackend` / `getBackend` / `listBackends`
  / `deleteBackend`.

  This increment is provider-agnostic **plumbing**: a registered backend is
  listed but **not yet selectable** as a Collection's `backend` (Collection
  create/select still resolves only `default`), at-rest secret encryption is
  deferred, and registration records do **not** travel in a Space export (after
  import the user re-registers). The live token exchange and provider adapter
  are future work.

### Fixed

- **Raw (non-multipart) binary blob writes now work for any content-type.** A
  `PUT`/`POST` carrying a raw body of an arbitrary media type --
  `application/octet-stream`, `application/jsonl`, `image/png`, etc. -- was
  rejected with `415 Unsupported Media Type` before reaching the handler,
  because Fastify ships content-type parsers only for `application/json` and
  `text/plain`. A catch-all parser now passes any other media type through to
  the handler as a raw byte stream (the `kind: 'binary'` storage path), so only
  multipart uploads were possible before. More specific parsers (the built-in
  JSON/text parsers, the `application/*+json` parser, `@fastify/multipart`, and
  the `application/x-tar` import parser) still take precedence.
- **Dotted resource ids (e.g. `index.html`, `photo.png`) no longer mis-parse.**
  The on-disk filename `r.<id>.<encodedContentType>.<ext>` was split naively on
  `.`, so an id containing a dot was read back under the wrong id and
  content-type (and broke Collection-listing keysets). The id and content-type
  filename segments are now dot-escaped (`%2E`) so the separators are
  unambiguous; dot-free ids and types are byte-identical to before.
- **`application/jsonl` (and `json5` / `json-seq`) are no longer mistaken for
  JSON.** The `isJson` content-type test matched any media type merely
  containing the substring `json`, routing JSON-Lines bodies through the JSON
  path (corrupting them). The `json` token is now anchored to the end of the
  media type, so only `application/json` and `application/<prefix>+json` are
  treated as JSON.

## 0.6.0 - 2026-06-15

### Added

- **Replication change feed: the `changes` query profile.** The reserved
  Collection query endpoint `POST /space/{id}/{cid}/query` now serves a
  `changes` profile -- the basis for replicating a WAS Collection into a
  local-first in-browser database such as RxDB. The signed JSON body carries
  `{ profile: "changes", checkpoint?, limit? }`; the response is the
  Collection's JSON documents and tombstones changed strictly after
  `checkpoint`, in change order (`(updatedAt, resourceId)`), each as
  `{ id, _deleted, updatedAt, version, data? }`, plus the next `checkpoint`
  (`null` when nothing changed). A tombstone is surfaced as `_deleted: true`
  with no `data`; binary (non-JSON) Resources are excluded. The default
  filesystem backend advertises the new `changes-query` feature token; a backend
  without the change feed (or any other profile) yields `unsupported-operation`
  (501). The `StorageBackend` contract gains an optional `changesSince` method.

### Changed

- **Resource deletes are now soft deletes (tombstones).** Deleting a Resource
  drops its content representation but keeps its metadata sidecar as a tombstone
  (`deleted: true`, a bumped `version` and `updatedAt`, the last-known
  `contentType` retained), so the change feed (for replication) can surface the
  delete until clients catch up. With no content file left, a tombstone is
  invisible to every normal read path (`GET` / metadata / List Collection all
  404 or skip it), so the change is transparent to the existing API. Re-creating
  a deleted id continues its monotonic `version`, and an export/import roundtrip
  carries tombstones across. Garbage-collection of old tombstones is future
  work.

## 0.5.0 - 2026-06-15

### Added

- **`GET /space/{id}/quotas?include=collections` opt-in.** The Space Quota
  report now omits the per-Collection `usageByCollection` breakdown by default
  and includes it only when `?include=collections` is requested (spec "Quotas"),
  keeping the hot-path payload lean. Previously the breakdown was returned
  unconditionally because a query string broke ZCap `invocationTarget` matching;
  the handler now threads the scoped `allowTargetQuery` flag (introduced for
  pagination) so the signed request authorizes against the bare `/quotas` target
  despite the query. The high-level client requests the breakdown via
  `space.quotas({ includeCollections: true })` (`@interop/was-client@^0.7.1`).

### Changed

- The `StorageBackend.reportUsage` contract gains an `includeCollections?`
  option; the breakdown is computed/returned only when set.

  accepts optional `?limit` and `?cursor` query parameters and returns a `next`
  link (a ready-to-follow URL with the opaque cursor and limit baked in) when a
  further page may follow; the absence of `next` is the authoritative
  end-of-list signal. Items are returned in a stable total order (ascending
  `resourceId`, which also fixes the prior nondeterministic listing order, since
  glob v13 does not sort). The filesystem backend reads `.meta` sidecars only
  for the items on the page (previously one per Resource on every list). A
  malformed or un-honorable cursor yields the new `invalid-cursor` (400) problem
  type; authorization is checked before cursor validation, so an
  under-authorized caller still gets the privacy-merged `404`. Pagination is
  OPTIONAL: a request with neither parameter returns the first page (or
  everything, if it fits). The opaque cursor codec lives in `src/lib/cursor.ts`.
  ZCap verification gained a scoped `allowTargetQuery` flag (List Collection
  only) so a capability for the bare Collection authorizes the query-bearing
  `next` URL, honoring the spec's "Pagination parameters and authorization" rule
  (the `limit`/`cursor` parameters select a page within an already-authorized
  target and do not change the target a capability must match). Uses the new
  `invalid-cursor` problem type and `CollectionResourcesList.next` field from
  `@interop/storage-core@^0.2.3`.

- **Conditional writes (`conditional-writes` feature).** The filesystem backend
  now exposes each Resource's monotonic `version` as an HTTP `ETag` strong
  validator (returned on `GET` / `HEAD` / `GET .../meta` and on the `PUT` /
  `POST` write responses) and honors the RFC9110 write preconditions:
  - `If-Match: "<etag>"` -- update-if-unchanged: the write proceeds only if the
    Resource's current ETag matches, else `412 precondition-failed`.
  - `If-None-Match: *` -- create-if-absent: the write proceeds only if the
    Resource does not yet exist, else `412 precondition-failed`. `DELETE` honors
    `If-Match` the same way. The precondition is evaluated atomically with the
    write under a per-Resource in-process mutex (ported from
    `@interop/edv-server`), so two concurrent writers cannot both observe the
    same prior version and both succeed -- the lost-update guard. Authorization
    is checked _before_ the precondition, so a `412` is only ever observable by
    a caller already authorized to write the target (an under-authorized caller
    gets the privacy-merged `404`). This is single-instance write locking only;
    horizontally-scaled locking is out of scope. Uses the new
    `precondition-failed` (412) problem type from
    `@interop/storage-core@^0.2.2`.

- The default filesystem backend descriptor now carries a `features` array
  (surfaced at `GET /space/{id}/backends` and `GET /space/{id}/{cid}/backend`),
  using the `features` field added in `@interop/storage-core@^0.2.0`. It
  advertises `['conditional-writes']` (above); the remaining _server
  affordances_ (`blinded-index-query`, `chunked-streams`) are added as each
  lands.

- Accept `application/<suffix>+json` request bodies (e.g. `application/edv+json`
  for EDV-over-WAS encrypted documents, `application/ld+json`) by parsing them
  as JSON. Fastify's built-in parser only matches `application/json` exactly, so
  structured-suffix JSON media types previously returned 415; a root-level
  content-type parser now handles them (the suffix content type is preserved on
  read). `isJson()` already treated `+json` as JSON downstream.

- `HEAD /space/{id}/{cid}/{rid}` (Head Resource). Returns the same headers a
  `GET` would, with no body: a bodyless 200 whose `Content-Type` and
  `Content-Length` are set from the Resource Metadata's `contentType`/`size`
  (spec "Content Types and Representations"). Authorized as a read
  (capability-or-policy, the same decision as `GET`), and reads only the
  Metadata so it never opens the resource byte stream. Registered explicitly
  ahead of the `GET` route to override Fastify's auto-exposed HEAD, which would
  share the streaming GET handler and yield no `Content-Length`.

- Space and Collection Description objects now carry a relative `url` property
  (`/space/{id}` and `/space/{id}/{cid}`) in their `GET` responses, alongside
  the existing `linkset` (spec: the server populates the description `url`),
  consistent with the `url` already present on List Spaces / List Collections
  items.

- Reject a multipart write that does not carry exactly one file part with
  `invalid-request-body` (400) (spec "Content Types and Representations").
  `resolveResourceInput` now iterates `request.parts()` rather than taking the
  first file part and silently ignoring extras, so both zero file parts and more
  than one are rejected. The multipart `files` limit was raised from 1 to 2 so a
  disallowed second part reaches the handler to be rejected with this 400 (a
  `files: 1` limit instead has busboy silently drop it and raise its own
  `FST_FILES_LIMIT` 413). The single permitted part is buffered in memory
  bounded by the backend's `maxUploadBytes` (a multipart `fileSize` limit), so
  an oversize multipart upload is rejected with `payload-too-large` (413) before
  it is fully buffered. Large binaries should use the streaming raw-body upload
  path; multipart is a convenience for the HTML-form workflow (see the README).

- Live `@interop/was-client` conformance coverage for storage introspection:
  `space.backends()` / `space.quotas()` (the backend list and the per-backend
  quota report with its per-collection breakdown) and `collection.backend()` /
  `collection.quota()` (the Collection's selected backend descriptor and its
  backend-scoped usage report). The collection-level tests require a published
  client that exposes those methods.

### Changed

- The Space and Collection `id` is now immutable on update: a `PUT /space/{id}`
  (resp. `PUT /space/{id}/{cid}`) whose body carries an `id` that does not match
  the id in the URL is rejected with `invalid-request-body` (400, pointer
  `#/id`), before any controller/capability check. (The spec spells this out for
  Update Space; it is applied to Update Collection for parity.)

- Space and Collection Description `type` arrays are served lexically sorted
  (spec SHOULD).

## 0.4.0 - 2026-06-13

### Added

- Enforce Request Body Integrity via the `Digest` header (spec "Request Body
  Integrity"). Any request carrying a `Content-Type` must cover the `digest`
  header in its HTTP Signature (MUST) and present a `Digest` header; for
  JSON/text bodies the server now independently recomputes the body's multihash
  and compares it to the header (SHOULD), so a body cannot be swapped without
  invalidating the signature. A missing, uncovered, malformed, or non-matching
  digest is rejected with `invalid-authorization-header` (400). Implemented as
  two route-group hooks (`src/digest.ts`): `captureRawBody` (preParsing) tees
  the exact body bytes onto `request.rawBody` so the digest is checked against
  precisely what the client signed (re-serializing the parsed JSON is not
  guaranteed byte-identical); `verifyBodyDigest` (preValidation) performs the
  checks before capability verification. Streamed bodies (multipart uploads, tar
  import) are left unbuffered and get the covered-header + presence checks only.
  Adds the `@interop/http-digest-header` dependency (`verifyHeaderValue`).

- Implement Update Resource Metadata, `PUT /space/{id}/{cid}/{rid}/meta` (spec
  "Update Resource Metadata"), replacing the previous `unsupported-operation`
  (501) stub. A `PUT` is a full replacement of the Metadata object's
  user-writable `custom` object (`name`, `tags`): any property omitted is
  cleared, and a body with no `custom` (e.g. `{}`) clears them all.
  Server-managed properties are untouched and any top-level property other than
  `custom` in the body is ignored, so a client may GET-modify-PUT the whole
  object. The operation does not create -- a `PUT` to the `/meta` of a
  nonexistent Resource is a 404 -- and returns 204; a malformed body or `custom`
  shape is `invalid-request-body` (400). Authorization is capability-only (the
  `PUT` action), like Put Resource. Read Resource Metadata (`GET .../meta`) now
  also returns the OPTIONAL `createdAt` / `updatedAt` timestamps and the
  `custom` object, and a Resource's `custom.name` is surfaced as its `name` in
  List Collection results. Metadata is persisted in a per-Resource sidecar
  (`.meta.<resourceId>.json`, the same dot-file convention as `.policy.`) via
  the new `StorageBackend` `writeResourceMetadata()`; the sidecar is
  created/maintained on Resource writes, swept on delete, and carried through
  Space export/import.

- Implement the per-Collection Quota report, `GET /space/{id}/{cid}/quota` (spec
  "Quotas"). Returns a single backend-usage entry scoped to the Collection:
  `usageBytes` reflects only that Collection's consumption, while `state` /
  `limit` / `restrictedActions` describe the backend's overall condition (the
  quota is a per-backend limit). Backed by the new optional
  `StorageBackend.reportCollectionUsage()` (filesystem: the Collection's slice
  of the existing one-pass `du` breakdown); a backend that cannot account
  per-Collection omits the method and the endpoint returns
  `unsupported-operation` (501). Authorization is capability-or-policy, so an
  unauthorized caller gets the maximum-privacy 404.

- Implement the per-upload `maxUploadBytes` constraint and `payload-too-large`
  (413) enforcement (spec "Quotas"). A new `MAX_UPLOAD_BYTES` env var (parsed by
  `parseMaxUploadBytes`, threaded through `createApp` to the default backend)
  caps the size of a single Create/Update Resource write, distinct from the
  cumulative per-Space quota: an oversized JSON or blob write is rejected with
  `payload-too-large` (413) -- via an up-front size pre-flight plus a streaming
  `_uploadCapGuard` for bodies whose size is not declared -- while smaller
  uploads still succeed. The cap is advertised in both the Space and
  per-Collection quota reports under `constraints.maxUploadBytes`. This wires
  the previously type-only `PayloadTooLargeError`.

- Advertise the remaining quota/backend linkset relations (spec linksets): the
  Collection linkset now carries the `quota` relation
  (`https://wallet.storage/spec#quota`, alongside the `backend` relation), and
  the Space linkset now carries `backends-available`
  (`https://wallet.storage/spec#backends-available`) and `quotas`
  (`https://wallet.storage/spec#quotas`), all unconditionally (their endpoints
  always exist).

- Implement Collection backend selection (spec "Collection Backend Selected" /
  "Backends"). A Collection Description now carries an optional `backend` object
  (`{ "id": "default" }` by default); Create Collection (POST) and Update/Create
  Collection (PUT) accept a body `backend`, validate its `id` against the
  Space's backends-available, and persist the normalized value. An unknown id is
  rejected with `unsupported-backend` (409) -- the error registry's previously
  type-only entry now has its emit site -- and a malformed `backend` (not an
  object with a string `id`) is `invalid-request-body` (400). The new
  `GET /space/{id}/{cid}/backend` ("Collection Backend Selected") returns the
  full backend descriptor for the Collection's selection, and the Collection
  linkset now advertises the `backend` relation
  (`https://wallet.storage/spec#backend`). Get Collection reports the selected
  backend, default-filled for Collections created before the property existed.

- Implement the List Spaces operation, `GET /spaces/` (spec "List Spaces
  Operation"), replacing the hardcoded 501. The response is
  `{ url, totalItems, items }` with only the Spaces the caller is authorized to
  see; each item carries `id`, `name` (when set), and the relative `url`
  (`/space/{id}`). An anonymous or unauthorized request is not an error -- it
  gets the empty-items `200`, the spec's explicit exception to 404 masking, so
  the listing reveals nothing about which Spaces exist (the SpacesRepository
  route group now installs `requireAuthHeadersOrPublicRead` so the read can
  reach the handler; Create Space still 401s without auth headers). Candidates
  come from the new `StorageBackend.listSpaces()` (filesystem backend: the
  subdirectories of the spaces root), and authorization is decided once per
  distinct Space controller: a bare-root invocation lists the signer's own
  Spaces, while a delegated invocation lists the Spaces of whichever controller
  roots its capability chain.

- Complete the spec's Error Type Registry (`src/problem-types.ts`): added the
  three missing problem kinds and matching error classes -- `reserved-id` (409,
  `ReservedIdError`), `unsupported-backend` (409, `UnsupportedBackendError`),
  and `payload-too-large` (413, `PayloadTooLargeError`). `reserved-id` is
  enforced immediately: the id sanitizer (`src/lib/validateId.ts`) now carries
  the spec's full Reserved Path Segment Registry, per id position -- Collection
  ids may not be `backends` / `collections` / `export` / `linkset` / `policy` /
  `query` / `quotas` (plus this server's non-spec `import`), and Resource ids
  may not be `backend` / `linkset` / `policy` / `query` / `quota` -- and a
  collision is rejected with the spec's `reserved-id` (409) instead of the
  previous `invalid-id` (400), which also only covered `policy` and `linkset`.
  This closes a routing hole on verbs without a static route: for example,
  `PUT /space/:spaceId/export` used to fall through to the parametric Create
  Collection route and happily create a Collection literally named `export`,
  shadowing the export endpoint. The other two new kinds have no emit sites yet:
  `unsupported-backend` awaits the Collection `backend` property, and
  `payload-too-large` awaits the per-upload `maxUploadBytes` constraint.

- Support the spec's delegated Create Space chain of authorization. The
  invocation on `POST /spaces/` (and on create-via-`PUT /space/:spaceId`, see
  Fixed below) must be _authorized by_ the body's `controller`: signed directly
  by it (the common case), or signed by another DID presenting a delegation
  chain rooted in it -- enabling provisioning services that create a Space on a
  user's behalf, with the user's DID as `controller` from the start. Previously
  `POST /spaces/` rejected any signer other than the body's `controller` with
  `controller-mismatch` _before_ verification, which blocked the delegated form.
  The friendly pre-verification 400 is kept for bare-root invocations (where the
  signer is the invoker, so it must be the controller); a delegated invocation
  is instead judged by the capability-chain verification (which synthesizes the
  root capability with the body's `controller` as its controller), and a chain
  not rooted in the body's `controller` is rejected with the spec's
  `controller-mismatch` (400). New `isRootInvocation()` helper in `src/zcap.ts`
  distinguishes the two `Capability-Invocation` header forms;
  `SpaceControllerMismatchError` now carries the spec's "signed by it, or via a
  delegation chain rooted in it" detail (and an optional `cause`).

- Enforce a per-Space storage quota (spec "Quotas"). A new
  `STORAGE_LIMIT_PER_SPACE` environment variable sets each Space's capacity in
  bytes; when configured, writes that would push a Space over its limit are
  rejected with a new `quota-exceeded` (507) error. Enforcement lives in
  `FileSystemBackend.writeResource` and `importSpace`: a cheap `du`-based
  pre-flight rejects writes whose size is known up front (JSON bodies and blobs
  with a `Content-Length`), and a byte-counting streaming guard hard-caps blobs
  whose size is not declared (cleaning up the partial file on overflow). The
  limit is a soft cap under concurrency (two simultaneous writes can each pass
  the pre-flight and jointly overshoot); the streaming guard still bounds each
  individual write. Unset (`STORAGE_LIMIT_PER_SPACE` absent) leaves every Space
  unlimited, as before, with zero enforcement overhead. The per-upload
  `maxUploadBytes` / `payload-too-large` (413) constraint remains future work.

- Implement the `GET /space/:spaceId/quotas` ("Quotas") endpoint. Returns the
  Space's storage report grouped by backend (spec "Quotas"); this reference
  server ships one server-configured backend, so the `backends` array has a
  single entry. Each entry combines the backend's identity (`id` / `name` /
  `managedBy`, from its `describe()`) with measured `usageBytes`, a derived
  `state` (`ok` / `near-limit` / `over-quota`), the configured `limit`
  (`isUnlimited` by default -- the filesystem backend reports an unlimited quota
  unless a `capacityBytes` is configured), `restrictedActions`
  (`["POST", "PUT"]` once `over-quota`), a `measuredAt` timestamp, and a
  per-Collection `usageByCollection` breakdown. Usage is measured with `du` (GNU
  coreutils) on the Space's storage directory. Authorization is
  capability-or-policy, the same as List Collections and the backends list (a
  caller not authorized to read the report receives a 404, per the spec's
  maximum-privacy invariant). The new `StorageBackend.reportUsage()` port method
  backs the endpoint, and `FileSystemBackend` gains an optional `capacityBytes`
  constructor option that drives the `state` thresholds.

  _Known limitation:_ the spec makes the per-Collection breakdown opt-in via
  `?include=collections`, but a query string in the request URL currently breaks
  ZCap `invocationTarget` matching (the signed root capability target would
  include the query and no longer match the bare `/quotas` path). For now the
  breakdown is returned unconditionally and the query parameter is not
  consulted, pending an upstream fix in the ezcap client. The per-Collection
  `/quota` endpoint (`GET /space/:spaceId/:collectionId/quota`) is not yet
  implemented.

- Implement the `GET /space/:spaceId/backends` ("Space Backends Available")
  endpoint. Returns the list of storage backends registered for the Space; this
  reference server ships one server-configured backend, so the list has a single
  entry derived from the active backend's own `describe()`. Each entry is a
  Backend description object (spec "Backend Data Model"): `id`, `name`,
  `managedBy`, `storageMode`, and `persistence`. Authorization is
  capability-or-policy, the same as List Collections (a public-readable Space
  may list its backends).
- Implement `/meta` resource endpoint.
- Observability on the access-control policy authorization path. A
  policy-granted read now emits an info log -- "Access granted by access-control
  policy." with `spaceId` / `collectionId` / `resourceId` / `action` /
  `policyType` -- so public-access decisions are auditable, and an unrecognized
  policy `type` now emits a warn as it fail-closes in `policyGrants`. The
  decision logic is unchanged; this is purely diagnostics.
- Test + CI tooling:
  - Added a `test:coverage` script (`vitest run --coverage`) and wired coverage
    into CI: the `test` job now runs `pnpm run test:coverage` and uploads the
    v8/lcov `coverage/` report (reporters already configured in
    `vite.config.ts`) as a downloadable build artifact.
  - Added direct unit tests for the previously integration-only core --
    `test/zcap.test.ts` (the `handleZcapVerify` error contract:
    `UnauthorizedError` on a failed invocation vs `AuthVerificationError` +
    `cause` + logging on a verification error), `test/auth-header-hooks.test.ts`
    (header gating and `request.zcap` parsing), and `test/importTar.test.ts`
    (manifest validation, merge-plan building, tar extraction, and the
    id-traversal guards). Coverage of all three modules is now ~94-100%.
- Memoized the Space Description lookup. Every authorized handler reads the
  Space Description through `getSpaceDescriptionOrThrow` in
  `src/requests/spaceContext.ts`, so it is now cached per storage backend via
  `@interop/lru-memoize` (a `WeakMap`-scoped `LruCache` per backend, short TTL
  from `SPACE_DESCRIPTION_CACHE_TTL`). Writes invalidate explicitly through the
  new `invalidateSpaceDescription()` -- wired into Space create
  (`POST /spaces/`), update (`PUT /space/:spaceId`), and delete -- so a read
  after a write never serves a stale description; the TTL is a backstop that
  also bounds staleness across multiple server processes sharing one backend. No
  API change.

### Fixed

- Close the create-via-PUT controller consent gap. `PUT /space/:spaceId`
  creating a _new_ Space used to verify the invocation against the signer
  itself, never tying it to the body's `controller` -- so any signer could
  create a Space whose stored controller is an unrelated, non-consenting DID
  (squatting meaningful ids "in their name", or burning per-controller
  onboarding allowances). Creates now apply the same
  authorized-by-body-controller rule as `POST /spaces/` (signed by the body's
  `controller` directly, or via a delegation chain rooted in it; violations are
  `controller-mismatch`, 400). Updates of an existing Space are unchanged: they
  verify against the _stored_ controller, with the body's `controller` as just
  the proposed new value.
- Dead-code and error-handling cleanup:
  - `src/lib/importTar.ts` now throws the typed `InvalidImportError` for the
    five archive-validation failures instead of generic `Error`, and the
    invalid-YAML case chains the underlying parse error as its `cause`
    (`InvalidImportError` gained an optional `cause`). The `Import Space`
    handler no longer flattens every failure into a fresh `InvalidImportError`:
    typed `ProblemError`s now propagate unchanged (preserving status code and
    message), and only an unexpected decode failure is wrapped -- keeping the
    original as the `cause`.
  - `resolveResourceInput` (`src/requests/resourceInput.ts`) guards the
    multipart parse: a `multipart` request with no file part now returns a clean
    `400` instead of throwing a raw `TypeError` on a non-null assertion.
- Validate the Space `controller` DID at the request layer. `POST /spaces/`
  (Create Space) and `PUT /space/:spaceId` (Update Space) now reject a body
  whose `controller` is not a syntactically valid Ed25519 `did:key` with a typed
  400 (`InvalidControllerError`, pointer `#/controller`) on the way in -- rather
  than storing a malformed controller that only fails later, at
  capability-verification time. New `src/lib/validateDid.ts` exports
  `assertValidController` / `isValidController`.
- Reject `POST /spaces/` (Create Space) with an `id` that already exists,
  instead of silently overwriting the existing Space. The handler now checks for
  an existing Space Description before anything else and rejects with the spec's
  `id-conflict` (409) error type (new `ProblemTypes.ID_CONFLICT` catalog entry
  and `IdConflictError` class, pointer `#/id`). Create-or-replace at a
  client-chosen id remains available via the idempotent `PUT /space/:spaceId`.
  Create Collection (`POST /space/:spaceId/`) gets the same `id-conflict` (409)
  check instead of silently overwriting -- there it runs _after_ the capability
  verification, so an unauthorized caller cannot probe Collection ids;
  create-or-replace remains the idempotent `PUT /space/:spaceId/:collectionId`.

### Changed

- Adopt `@interop/storage-core` for the shared WAS wire model and error
  vocabulary, replacing the in-repo declarations that were drifting from the
  `was-client` copies. `src/types.ts` now imports/re-exports the data-model
  shapes (`SpaceDescription`, `CollectionDescription`, `BackendDescriptor`,
  `BackendUsage`, `ResourceMetadata`, etc.) from core and keeps only the
  server-local contracts (`StorageBackend`, `ResourceInput`, `ResourceResult`,
  `ParsedZcap`, the Fastify augmentation); `src/problem-types.ts` is removed in
  favor of core's `ProblemTypes` / `ProblemType`, and `errors.ts` re-exports the
  wire `Problem` shape from core. Two listing types were renamed to remove a
  cross-repo collision: the resources-in-a-collection listing is now
  `CollectionResourcesList` (was `CollectionListing`). The unified types also
  tightened two producer behaviors: `FileSystemBackend.describe()` now returns
  the always-populated `Required<BackendDescriptor>`, and `PUT .../meta` now
  rejects non-string `custom.tags` values (400), matching the spec's string-tag
  guidance.
- Tighten `PUT .../policy` body validation: a policy `type` that is empty or
  whitespace-only is now rejected with a 400 (`InvalidPolicyError`) instead of
  being stored. The recognized-types set stays intentionally open (an unknown
  `type` is stored and fail-closes at evaluation time), so this is a shape check
  only, not a known-types allowlist.
- Centralize the relative URL path templates. New `src/lib/paths.ts` exposes
  `spacePath` / `collectionPath` / `resourcePath` / `policyPath` / `linksetPath`
  builders that mirror the route shapes in `routes.ts`; the policy and linkset
  code (`src/policy.ts`, `PolicyRequest`, and the Space/Collection linkset
  handlers) now builds those paths through the helpers rather than re-deriving
  them inline. The linkset relation URI moved from `src/policy.ts` into
  `config.default.ts` (`POLICY_LINK_RELATION`). The follow-up full sweep then
  routed _every_ remaining inline path template through the module: the
  trailing-slash container forms via a `trailingSlash` option on `spacePath` /
  `collectionPath`, plus new `spacesPath` (SpacesRepository container and member
  -- the latter being the create `Location`, deliberately `/spaces/:id`),
  `collectionsPath`, `exportPath`, and `importPath` builders. All `*Request.ts`
  `targetPath`s, the `Location`-header `new URL(...)` constructions, the
  `List Collections` `url` field, and the `FileSystemBackend` listing `url`
  fields now build through the helpers, making `src/lib/paths.ts` the single
  source of truth for every server path shape. New `test/paths.test.ts` pins
  each builder's member-vs-container output. No API change.
- Removed dead code: the commented-out `@fastify/accepts` import/registration in
  `src/server.ts`, the commented debug log in `src/auth-header-hooks.ts`, and
  the three speculative `// TODO: use a uuid v5 or another hash based id`
  comments (random v4 ids are correct for these server-assigns-id create
  endpoints; deterministic ids have no natural key here and would change
  semantics).
- Extracted the fetch-space-and-verify boilerplate repeated across ~18 handlers
  (in five files) into the new neutral module `src/requests/spaceContext.ts`. It
  loads the Space and builds the capability `invocationTarget` URL once, then
  exposes two named entry points so each call site names its authorization
  model: `fetchSpaceAndAuthorize()` (**capability-or-policy** -- capability
  invocation first, then access-control policy fallback; for read/list
  endpoints) and `fetchSpaceAndVerify()` (**capability-only**; for
  write/privileged + policy endpoints). Both return the verified context. The
  old `getSpaceController` helper was dropped (subsumed). No behavior change,
  except the handlers that fetched the Collection before verifying now verify
  first.

### Removed

- The in-memory storage backend (`src/backends/memory.ts`). It was never wired
  into the server or the test suite -- its purpose was to drive the
  `StorageBackend` port to the right level of abstraction, which it has done.
  That abstraction now lives in the port (`src/types.ts`) and survives the
  removal; a future durable/queryable backend (SQLite/Postgres/LMDB) will be the
  real second adapter that proves the port.

## 0.3.0 - 2026-06-06

### Added

- Access-control **policy** documents, enabling world-readable ("public read")
  Collections and Resources. A `policy` auxiliary resource may be set at the
  Space, Collection, or Resource level via
  `GET|PUT|DELETE /space/{id}[/{col}[/{res}]]/policy`. Reads (`GET`/`HEAD`) now
  fall back to the effective policy when no capability is presented, or when the
  presented capability does not authorize the request -- so an anonymous `GET`
  of a resource in a Collection whose policy is `{ "type": "PublicCanRead" }`
  succeeds. Policies are **permissive-only** (they broaden access beyond
  capabilities, never restrict a valid capability holder) and resolved
  most-specific-first (Resource over Collection over Space, per the spec). The
  policy document is a `type`-discriminated, extensible shape: v1 recognizes
  only `PublicCanRead`; any unrecognized `type` grants nothing (fail-closed).
  New modules: `src/policy.ts` (resolution + evaluation + linkset building),
  `src/authorize.ts` (the capability-then-policy decision), and
  `src/requests/PolicyRequest.ts` (the policy CRUD handler).
- **Linkset discovery** (RFC9264): Space and Collection Description objects now
  carry a `linkset` property, and `GET /space/{id}/linkset` /
  `GET /space/{id}/{col}/linkset` return an `application/linkset+json` document
  advertising the access-control `policy` resource (relation
  `https://wallet.storage/spec#policy`) when one is set.
- Space export/import now round-trips policies. Space-, Collection-, and
  Resource-level `.policy.*` documents are carried in the export tarball and
  restored on import: the space policy fills in when the target has none (no
  clobber), and Collection/Resource policies travel with a newly-created
  Collection/Resource. `ImportStats` gains `policiesCreated` /
  `policiesSkipped`.

### Changed

- Read requests (`GET`/`HEAD`) on Space / Collection / Resource routes no longer
  require auth headers up front: they are allowed through so the handler can
  fall back to an access-control policy. An anonymous (or unauthorized) read
  that no policy grants is now denied with **404** (consistent with the existing
  no-leak policy for failed capability invocation) rather than **401**. Writes,
  and all SpacesRepository (`/spaces`) admin routes, still require auth (401
  when absent). `policy` and `linkset` are now reserved id segments and cannot
  be used as Collection or Resource ids.

## 0.2.0 - 2026-06-06

### Added

- Emit the spec-REQUIRED `type` property on every `application/problem+json`
  error response. A new `src/problem-types.ts` defines a `ProblemTypes` catalog
  of problem-_kind_ `type` URIs (e.g. `#not-found`, `#invalid-id`,
  `#controller-mismatch`), keyed by the kind of problem and reused across
  operations per [[RFC9457]] -- not per operation. Privacy-sensitive conditions
  (Space / Collection / Resource not found, failed capability invocation) all
  collapse to a single `#not-found` so `type` cannot be used to probe resource
  existence. Body-validation responses now also carry a `pointer` (RFC 6901 JSON
  Pointer, `#/field` form) identifying the offending field; the combined
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
  built by `buildZcapClients()` now carry a high-level `was` client alongside
  the raw `rootClient`, a new `wasClient({ signer })` helper mirrors
  `zcapClient({ signer })`, and `createSpace()`'s ZCap path goes through
  `WasClient.request()`. The exported helper surface is unchanged.

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
