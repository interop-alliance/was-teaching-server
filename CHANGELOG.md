# History

## 0.12.0 - 2026-07-20

### Added

- **Cursor pagination for the List Collections
  (`GET /space/{spaceId}/collections/`) and List Spaces (`GET /spaces/`)
  operations.** Both accept the optional `limit` / `cursor` query parameters and
  return one keyset-ordered page (ascending by id, code-unit order) at a time,
  with a `next` continuation link when a further page may follow -- the same
  profile the List Collection operation already uses. `limit` defaults to 100
  and clamps to 1000; a malformed cursor is rejected with `invalid-cursor`
  (400), after authorization, so an under-authorized caller still gets the
  merged 404. The `limit` / `cursor` parameters select a page within an
  already-authorized target and do not change the capability target, so a `next`
  link verifies against the same bare list capability.
  - List Spaces paginates in the request handler, since the page is a page of
    the Spaces the caller is authorized to see (per-controller authorization
    filtering happens there); it emits `totalItems` only on a complete,
    unpaginated listing (no cursor and no `next`), since computing the true
    total would mean verifying every candidate controller. An anonymous request
    still returns the empty listing without validating a cursor.

### Changed

- The `StorageBackend.listCollections` port now accepts
  `{ spaceId, limit?, cursor? }` and returns the paginated `CollectionsList`
  (`{ url, totalItems, items, next? }`) instead of a bare `CollectionSummary[]`;
  both the filesystem and Postgres backends implement it with the shared keyset
  machinery, and the filesystem backend now sorts Collections in code-unit order
  (matching the cursor seek). Internal full-Space enumerations (import and
  create count-quota checks) read every Collection through a dedicated
  unpaginated path, so they are never truncated to a page.

## 0.11.0 - 2026-07-19

### Added

- **The `equality` query profile (the `equality-query` backend feature).** A
  plaintext Collection can now declare which top-level attributes the server
  extracts and indexes, and answer server-side equality queries over them at
  `POST /space/{spaceId}/{collectionId}/query` with `{ "profile": "equality" }`.
  The body carries exactly one of `equals` (a disjunction of `{ name: value }`
  conjunctions) or `has` (attributes that must be present), plus optional
  `count`, `limit`, and an opaque `cursor`; matching is strict JSON equality
  (`"1"` never matches `1`; a multi-valued array attribute matches any element)
  and a query naming an attribute the Collection does not declare is rejected
  fail-closed (`invalid-request-body`, 400). The response is a
  `{ documents: [{ id, data?, custom? }], hasMore, cursor? }` page in ascending
  Resource-id order (`data` for JSON Resources, `custom` for any Resource with
  custom metadata -- so blob Resources are queryable through their `custom`
  tags), or `{ count }`. Unlike the client-computed `blinded-index` profile, the
  server does the extraction, so a plain Resource write is immediately
  queryable; the profile is capability-or-policy readable like List Collection,
  and an encrypted Collection answers `unsupported-operation` (501). Both
  first-party backends evaluate through one shared module so their semantics
  cannot drift.
- **The `indexes` Collection Description property.** A plaintext Collection opts
  in by declaring `indexes`: an array of attribute-name strings, or objects
  `{ name, source: "content" | "custom", unique: true }` where `source` (default
  `content`) names where the attribute is extracted from -- a JSON Resource's
  content, or any Resource's `custom` metadata object. Declared names must be
  unique across the array. Unlike `encryption`, `indexes` is updatable (entries
  may be added or removed); it MUST NOT be combined with an `encryption` marker
  (rejected `invalid-request-body`, 400, in both directions). An entry marked
  `unique: true` claims per-Collection uniqueness for that attribute's
  `(name, value)` pairs: a content or metadata write whose extracted value is
  already held by a different Resource is rejected with `id-conflict` (409),
  enforced atomically with the write; adding a unique claim to a Collection
  whose stored Resources already violate it is likewise rejected (409).
- **The GET `filter[attr]=value` equality filter on List Collection.**
  `GET /space/{spaceId}/{collectionId}/?filter[attr]=value` runs the equality
  profile over the same machinery from the anonymous, HTTP-cacheable listing
  endpoint: it answers the same document page. Every filter attribute must be
  declared in the Collection's `indexes` (fail-closed 400); on a `PublicCanRead`
  Collection the filter query needs no capability, so a cache can serve it.

## 0.10.2 - TBD

### Changed

- Protocol conformance testing now uses the extracted
  `@interop/was-conformance-suite` package (devDependency) instead of the
  in-tree `conformance/` directory, which has been removed. `pnpm conformance`
  now runs the package's `was-conformance` CLI (URL passed positionally;
  `TEST_SERVER_URL` / `TEST_ONBOARDING_TOKEN` env vars still work as fallbacks),
  and `pnpm conformance:local` still spins up a matched local server but
  delegates the test run to the CLI, forwarding any extra arguments. CI now
  exercises the production build against the CLI twice -- open provisioning and
  onboarding-token-gated -- and uploads the JSON conformance reports as build
  artifacts.

## 0.10.1 - 2026-07-19

### Fixed

- CORS registration now sets `exposedHeaders: ['Location', 'ETag', 'Link']`, so
  browser-based clients can read the `Location` header on space/resource
  creation, `ETag` for metaVersion concurrency, and `Link` for pagination and
  policy linkset discovery. Previously these were blocked by the default CORS
  response-header allowlist, breaking browser wallets.

## 0.10.0 - 2026-07-19

### Added

- **Chunk addressing for chunked Resources (the `chunked-streams` backend
  feature).** A Resource can now carry an ordered set of opaque chunks,
  addressed at
  `PUT|GET|HEAD|DELETE /space/{spaceId}/{collectionId}/{resourceId}/chunks/{n}`
  with a discovery listing at `.../chunks/` (JSON
  `{ resourceId, count, chunks: [{ index, size, contentType, version }] }`; the
  no-slash form 308-redirects to the container form). A chunk body is raw bytes
  plus a content-type, stored exactly like a binary Resource representation --
  the server never parses or reassembles chunks, so any encryption framing (e.g.
  an EDV `{ index, offset, sequence, jwe }` chunk document, or a future
  authenticated per-chunk AEAD layout) is purely a client concern. Both backends
  implement and advertise the feature, which completes the spec's four-token
  `features` vocabulary (`conditional-writes`, `changes-query`,
  `blinded-index-query`, `chunked-streams`).
- Chunk semantics: every chunk operation requires its parent Resource to exist
  (404 otherwise -- chunks cannot be orphaned, and an orphan left by out-of-band
  state is unreadable), each chunk carries its own monotonic `ETag` and honors
  `If-Match` / `If-None-Match` (412 on mismatch), oversized chunk bodies reuse
  the per-upload cap (`payload-too-large`, 413), and -- unlike Delete Resource
  -- deleting an absent chunk is a 404, so a reassembling reader can distinguish
  "gone" from "never written". A non-canonical `{n}` (negative, non-integer,
  leading zeros) or one above 2^31-1 is a 400 (both backends enforce the same
  index range). Deleting the parent Resource cascade-deletes its chunks; chunk
  bytes count toward Space/Collection usage and quotas; Space export archives
  carry chunk files and imports restore them (skip-not-overwrite, both backends,
  cross-backend compatible), holding each restored chunk to the same
  canonical-index rule as the live route and skipping orphan chunk files whose
  parent Resource is absent or tombstoned. Chunk writes and deletes never
  surface on the `changes` feed (per spec): a replicating client finishes a
  chunked write by `PUT`ting the parent Resource's own content, which does.
- Authorization follows the existing exact-match model: chunk writes are
  capability-only and chunk reads capability-or-policy, each against the chunk's
  own full URL (or the `chunks/` container URL for the listing), with the parent
  Resource's policy governing reads.

### Fixed

- Postgres backend: the Space's `usage_bytes` quota counter no longer
  over-counts when two writers race to create the same not-yet-existing
  Resource. Under `READ COMMITTED` a `SELECT ... FOR UPDATE` on an absent row
  locks nothing, so both creators read "no prior row" and both counted their
  full byte size as the usage delta, permanently inflating the counter by one
  write's size. Same-key creates now serialize on a transaction-scoped advisory
  lock and re-read the row under lock, so the second writer's precondition,
  version, and usage delta are all computed from the first writer's committed
  row.

### Added

- **Offline re-encryption tool for at-rest WebKMS key records**
  (`pnpm reencrypt-kms-records [--dry-run] [--data-dir <path>]`,
  `scripts/reencrypt-kms-records.ts`). With the server stopped, it walks every
  stored key record, decrypts each through the configured KEK registry
  (plaintext records pass through), and rewrites it in place under the current
  KEK -- or back to plaintext under `KMS_RECORD_CURRENT_KEK=none`. This is what
  makes a rotation finishable: records written before encryption was enabled (or
  under a since-rotated KEK) can now be re-wrapped, so an old KEK can finally be
  retired from `KMS_RECORD_KEKS`, and the decrypt-only wind-down can end with
  the KEK variables dropped entirely. Idempotent (records already in the target
  form are untouched); filesystem backend only (refuses to run when
  `DATABASE_URL` is set).
- **ZCap revocation on the WAS route families.** A capability delegated from a
  Space's root capability can now be revoked, via
  `POST /space/:spaceId/zcaps/revocations/:revocationId` -- the sibling of the
  existing `/kms` revocation endpoint, and the same wire contract
  (`:revocationId` is the to-be-revoked capability's id, URL-encoded; the body
  is that capability, verbatim; success is 204). Previously the only lever
  against a leaked Space or Collection capability was a short `expires` and
  waiting it out. The submission is authorized under the dual-root rule: an
  invocation rooted in the Space, or in the revocation URL itself, whose
  synthesized root is controlled by every controller in the to-be-revoked
  capability's chain -- so a delegee can revoke its own capability without
  holding a separate one. A root capability is never revocable; resubmitting a
  stored revocation is a 400.
- A revoked capability is rejected from then on wherever a Space-rooted chain is
  verified: the write and privileged routes, and the capability leg of the read
  routes. Because access-control policies are permissive, revoking a capability
  withdraws only what that capability granted -- access a policy already grants
  everyone (a public-readable Space) is unaffected.
- Space exports carry the Space's revocation records (top-level `revocations/`
  entries in the archive, on both backends), and imports restore them under the
  destination Space's scope -- so an export/import round-trip (backup/restore,
  backend migration) does not resurrect a revoked capability. Archives from
  servers that predate this carry none and import as before.
- **Multi-recipient encrypted Collections and key epochs.** An encrypted
  Collection's `encryption` marker may now carry per-epoch wrapped collection
  keys -- `epochs` (each an `{ id, recipients }`, where a recipient is the JWE
  recipients-entry shape: a `header` with `kid` / `alg` plus a wrapped
  `encrypted_key`) and a `currentEpoch`. Each app holds its own key-agreement
  key and gets the epoch key wrapped to it, so adding a reader wraps the current
  key to it and removing one appends a fresh epoch that excludes it. The server
  never holds a key: it validates only the marker's shape (recipients are
  well-formed, `currentEpoch` names an epoch that exists) and enforces two
  safety rails on update -- `epochs` is append-only and `currentEpoch` never
  moves backwards -- rejecting a violation with `invalid-request-body` (400).
  Recipient churn within an epoch stays a free update (the set-once check is
  still scheme-only).
- A Resource may declare the key epoch its content was encrypted under, so a
  reader picks the right key before attempting decryption: a `WAS-Key-Epoch`
  request header on a content write (working uniformly for JSON, raw-stream, and
  multipart writes), or a top-level `epoch` member on a `PUT .../meta` body. The
  value is advisory client-declared metadata -- the server stores it opaquely,
  never computing or verifying it, and requires only that a present value be a
  non-empty string (400 otherwise). A content write stores the header's value
  and clears the stamp when absent (the new ciphertext's epoch is unknown); a
  metadata write preserves the stored value unless the body supplies a new one.
  The stamp is returned by `GET .../meta`, rides each List Collection item and
  each `changes`-feed document, and survives a Space export/import round-trip,
  on both backends.
- **Conditional Collection Description writes.**
  `PUT /space/:spaceId/:collectionId` now honors an `If-Match` precondition
  against the Collection Description's monotonic version, evaluated atomically
  with the write (a stale validator is `precondition-failed`, 412), and every
  create/update surfaces the new version as an `ETag` header -- as does `GET` of
  the Collection. This gives recipient edits a compare-and-swap so two clients
  concurrently changing the marker cannot silently clobber one another; an
  unconditional `PUT` still works exactly as before. Both backends advertise the
  `key-epochs` feature token.
- **Multi-KEK registration for at-rest key-record encryption.** An operator can
  now register more than one key-encryption key (KEK) for the WebKMS key-record
  cipher, so a rotation adds a new KEK while keeping the old one available to
  decrypt records already written under it. Two new env variables join the
  existing `KMS_RECORD_KEK` (which stays the single-KEK alias):
  `KMS_RECORD_KEKS` takes a comma-separated list of AES-256 Multikey KEKs -- the
  first entry is the current KEK by default, so a rotation is "prepend the new
  KEK, keep the old one behind it"; `KMS_RECORD_CURRENT_KEK` optionally names
  which registered KEK wraps new records (a `urn:kek:sha256:` id, a multibase
  value, or the literal `none`). `none` selects a decrypt-only posture: existing
  encrypted records still read, but new key records are written plaintext -- the
  path for winding encryption back down. Malformed or ambiguous configuration
  (both single and list forms set, a current-KEK reference that matches nothing,
  a duplicate list entry) fails fast at startup without echoing any secret.

### Changed

- The revocation store (`StorageBackend.insertRevocation` / `isRevoked`) is now
  keyed on a `RevocationScope` -- a keystore or a Space -- rather than a
  keystore id. A revocation stored under one scope has no effect on the other;
  Space revocations live outside the Space's own tree and are deleted with the
  Space.

### Fixed

- **Space exports are now byte-reproducible.** Every entry in an export archive
  is written with a fixed `mtime` (the Unix epoch) instead of the wall-clock
  time it was packed, on both backends. Previously two exports of an unchanged
  Space differed whenever they straddled a one-second boundary, which made
  byte-for-byte comparisons of consecutive exports intermittently fail. An
  export is now a pure function of the Space's contents -- content-addressable
  and diff-stable. The timestamp carried no meaning on import.

## 0.9.0 - 2026-07-09

### Added

- **Server-managed `createdBy` provenance on Spaces, Collections, and
  Resources.** A read-only `createdBy` (a `did:key` DID string) now records who
  created each Space, Collection, and Resource: taken from the invoker of the
  _first_ write (the capability's signing key, fragment stripped) and preserved
  verbatim on every later write, so it names the creator rather than the last
  writer. It is server-authoritative -- a `createdBy` supplied in a client's
  request body is always dropped, never honored -- and is omitted/absent when
  there was no resolved invoker (a token-provisioned Space create, or data
  written before this change). Recorded only when a write _creates_ the record:
  an object created without an invoker keeps an absent `createdBy` forever,
  rather than a later writer being backfilled as its creator. A soft-deleted
  Resource keeps its `createdBy` on its tombstone, so re-creating it under a
  different invoker still reports the original creator; export/import
  round-trips the value. Surfaced in `GET /space/:spaceId`,
  `GET /space/:spaceId/:collectionId`, and
  `GET /space/:spaceId/:collectionId/:resourceId/meta`, and echoed in the 201
  body of Create Space / Create Collection so a create response and a subsequent
  GET agree. The `changes` query profile carries it on live documents and on
  tombstones, so a replica learns each Resource's creator from the feed rather
  than fetching `/meta` per Resource.

### Changed

- The `changes` query profile's response documents are now typed by the shared
  `ChangeDocument` / `ChangesPage` wire shapes from `@interop/storage-core`,
  rather than an inline shape. The `StorageBackend.changesSince` port keeps its
  own (differently named) document shape: it is the storage contract, not the
  wire model.

- **Blinded-index EDV query (the `blinded-index` query profile /
  `blinded-index-query` feature).** The reserved Collection
  `POST /space/{s}/{c}/query` endpoint gains a second profile alongside
  `changes`: the EDV blinded-attribute query. A body of
  `{ profile: 'blinded-index', index, equals | has, count?, limit?, cursor? }`
  is evaluated against the HMAC-blinded `indexed` entries of the Collection's
  stored documents (the envelopes `@interop/edv-client`'s IndexHelper produces):
  `equals` is an OR across array elements of an AND within each element's
  blinded `{name: value}` pairs, scoped to the `index` HMAC key id; `has`
  requires every named blinded attribute be present. Matching is opaque string
  comparison -- the server performs no cryptography and never sees plaintext
  attribute names or values, so it is agnostic to the client's
  attribute-blinding version. The response is `{ documents, hasMore, cursor? }`
  -- the matching stored documents verbatim, ascending by resource id -- or
  `{ count }` for a count query. Pagination closes the known EDV protocol gap
  (`limit` + `hasMore` with no way to resume) by reusing WAS's opaque cursor
  convention: `cursor` is present iff `hasMore`, and echoing it back in the next
  query body resumes the scan. Query parameters ride the signed JSON POST body
  (covered by the `Digest`); authorization is capability-or-policy with the same
  read semantics as List Collection (an under-authorized caller receives a 404).
  A malformed query body is a 400 `invalid-request-body`; a malformed cursor is
  a 400 `invalid-cursor`; an unknown profile, or a backend without the
  affordance, stays 501 `unsupported-operation`.

  Implemented as an optional `StorageBackend.queryByBlindedIndex` method, served
  by both first-party backends through a shared evaluator
  (`src/lib/blindedIndex.ts` -- validation, matching, ordering, and cursor
  pagination in one place, so the backends cannot drift), with a full-scan
  strategy deliberate for these teaching backends. Both backends now advertise
  `features: [..., 'blinded-index-query']`. Covered by a new backend-contract
  block (run against filesystem and Postgres) and a `blinded-index-query-api`
  integration suite.

- **`unique: true` blinded-attribute enforcement on write.** The other half of
  the EDV blinded-index affordance: a Resource write whose `indexed` blinded
  attributes include one marked `unique: true` is rejected with **409**
  (`UniqueAttributeConflictError`, reusing the `id-conflict` problem type like
  the WebKMS conflicts) when another live JSON document in the same Collection
  already claims the same triple. Semantics match the EDV reference servers
  exactly: a conflict requires `unique: true` on **both** sides (an existing
  document carrying the same pair without `unique` does not conflict), the claim
  is keyed on the full **(HMAC key id, name, value)** triple (the same pair
  under a different HMAC key is no conflict), a document keeping its own unique
  attribute across an update never self-conflicts, enforcement applies to create
  and update alike, and a tombstoned holder frees its claim. The check is atomic
  with the write: only unique-carrying JSON writes pay for it -- the filesystem
  backend serializes them per Collection on its keyed mutex (nested outside the
  ordinary per-Resource lock), and the Postgres backend takes a per-Collection
  transaction-scoped advisory lock (held to commit, so of N racing claimants
  exactly one wins) -- so plain writes keep their existing locking. The conflict
  scan lives with the query evaluator in `src/lib/blindedIndex.ts`
  (`collectUniqueBlindedTerms` / `assertNoUniqueBlindedConflict`), shared by
  both backends. When a unique conflict and a failing `If-Match` both apply, the
  409 wins over the 412 (both backends agree; pinned by the contract suite).
  Space import (tar merge) bypasses `writeResource` and therefore does not
  enforce the invariant -- imports restore a controller's own export, matching
  the check's write-path scope. Covered by a new backend-contract block
  (including an N-concurrent- claimants race) and an API-level 409 test.

- **Config validation & fail-fast startup.** The whole env surface
  (`SERVER_URL`, `PORT`, `DATABASE_URL`, `STORAGE_LIMIT_PER_SPACE`,
  `MAX_UPLOAD_BYTES`, `WAS_ENABLED_BACKENDS`, `KMS_RECORD_KEK`,
  `WAS_ONBOARDING_TOKEN`) is now read and validated in one place,
  `loadConfigFromEnv()` (`src/config.default.ts`), consumed by `start.ts`.
  `SERVER_URL` is required (unset previously started a server whose ZCap
  matching silently failed on every request) and must be an absolute
  `http:`/`https:` URL with no path, query, or fragment -- a sub-path
  `SERVER_URL` would silently break every delegated invocation and `Location`
  header (the URL-join sites drop a base path), so it is rejected at startup
  instead. `PORT` is validated as an integer in 1-65535 (default 3002). The
  `fastifyWas` plugin applies the same `serverUrl` shape check at registration
  (`assertValidServerUrl`), so a downstream composition inherits the fail-fast
  behavior; omitting `serverUrl` there remains allowed (test compositions).

- **Provisioning gate (`authorizeProvisioning` / `WAS_ONBOARDING_TOKEN`).** A
  new seam that lets a deployment gate the two open provisioning endpoints
  (`POST /spaces/` and `POST /kms/keystores`) without touching the rest of the
  ZCap surface. The `fastifyWas` plugin gains an `authorizeProvisioning`
  callback (`{ request }` in, `'verify'` / `'grant'` / `'deny'` out -- or a
  thrown `ProblemError`) plus a built-in, off-by-default onboarding-token check
  (`onboardingToken` option / `WAS_ONBOARDING_TOKEN` env), implemented as a
  stock authorizer over that same seam (`onboardingTokenAuthorizer`, exported):
  when a token is set, the two endpoints require an
  `Authorization: Bearer <token>` header (timing-safe compared), which then
  substitutes for ZCap verification on that request while every other operation
  keeps its normal capability-invocation path. The two options are mutually
  exclusive (rejected at startup). Default behavior (neither configured) is
  unchanged -- provisioning stays open, authorized by proving control of the
  body's `controller` DID (the teaching default). Adds `src/provisioning.ts`.
  The conformance suite's high-level `WasClient` suites now provision Spaces
  through the token path when `TEST_ONBOARDING_TOKEN` is set (a shared
  `provisionSpace` helper), so the full suite passes against a token-gated
  server:
  `WAS_ONBOARDING_TOKEN=abc TEST_ONBOARDING_TOKEN=abc pnpm conformance:local`.

- **WebKMS List Keys (`GET /kms/keystores/:keystoreId/keys`).** A fork extension
  beyond upstream webkms-switch (which has no key list): enumerates a keystore's
  public key descriptions — the Get Key Description projection per key
  (`describeKmsKey`, never a secret field) plus `keyUrl`, the key's canonical
  invocation URL (`<keystoreId>/keys/<localId>`), which the `publicAlias` /
  `publicAliasTemplate` override otherwise erases from `id` — exactly the handle
  a recovery client needs to rediscover — sorted by local id and paginated with
  the standard opaque cursor (`KEY_LIST_LIMIT` per page; an empty keystore
  returns `{ results: [] }`, not 404). Capability-verified as `read` against the
  keystore controller with `<keystoreId>/keys` accepted as an attenuated target,
  so a `sign`-scoped delegation on one key URL still cannot enumerate the
  keystore. Adds `listKeys` to the `StorageBackend` contract (both backends) and
  `KeyRequest.list`.

- **PostgreSQL storage backend (`DATABASE_URL`).** A second first-party
  `StorageBackend` (`src/backends/postgres.ts`, schema in
  `src/backends/postgresSchema.ts`), implementing the full WAS + WebKMS surface
  over rows and selected by setting `DATABASE_URL` (unset keeps the default
  filesystem backend). Four deliberate design departures: **transactional quota
  accounting** (`spaces.usage_bytes`, maintained in the same transaction as
  every content write/delete -- the per-Space capacity is now a _hard_ limit
  under concurrency, closing the filesystem backend's documented soft-limit
  caveat); **row-lock concurrency** (`SELECT ... FOR UPDATE` transactions
  replace the single-process `KeyedMutex`, so conditional writes stay correct
  across multiple server processes sharing one database); **buffered `bytea`
  blobs** (bounded by `maxUploadBytes`, which defaults to a 64 MiB cap on this
  backend rather than "unbounded"; chunked-row streaming is a planned
  follow-up); and **cross-backend export/import** (the same tar archive dialect
  as the filesystem backend, so a Space exported from one imports into the other
  -- the migration path in both directions -- with the Postgres apply loop
  additionally atomic in one transaction). Embedded idempotent migrations run at
  startup under an advisory lock; `ORDER BY` / keyset columns are `COLLATE "C"`
  so pagination and change-feed ordering match the filesystem's code-unit order
  exactly. New optional `StorageBackend.init()` / `close()` lifecycle hooks
  (wired by the plugin), `PostgresBackend` exported from the package root, and a
  new shared backend-contract test suite (`test/storage-backend-contract.ts`)
  run against both backends -- opt-in for Postgres via `WAS_TEST_DATABASE_URL`
  (`pnpm test:pg`), with per-suite throwaway schemas for isolation. Shared logic
  extracted so the two backends cannot drift: precondition evaluation
  (`src/lib/preconditions.ts`), quota report derivation
  (`src/lib/backendUsage.ts`), export manifest building
  (`src/lib/exportManifest.ts`), and page-size clamping
  (`src/lib/pagination.ts`).

- **At-rest encryption of WebKMS key records (`KMS_RECORD_KEK`).** The optional,
  schema-compatible hardening increment: when a record KEK is configured, the
  secret-bearing fields of a stored `/kms` key record (`privateKeyMultibase` /
  `secret`, and anything not on the plaintext allowlist) are envelope-encrypted
  -- a fresh per-record `A256GCM` content-encryption key wrapped `A256KW` under
  a config-supplied AES-256 KEK -- before the record reaches storage, so a
  disk/database dump exposes only ciphertext and a `kekId`. It is **off by
  default** (plaintext when unset, the teaching default), needs **no schema
  migration** to enable (old plaintext records stay readable via an
  unconditional decrypt pass-through, and are never retroactively rewritten),
  and supports **KEK rotation without re-encryption** (each record keeps the
  `kekId` it was written under). The wire projection (`KmsKeyDescription`) is
  untouched: secrets never crossed the wire and still don't. New pure,
  backend-agnostic cipher `src/lib/kmsRecordCipher.ts`, applied at the KMS
  orchestration seam in `src/requests/KeyRequest.ts` (encrypt before
  `insertKey`, single decrypt funnel after `getKey`). See the `KMS_RECORD_KEK`
  environment variable in the README.

- **Library entry point (`src/index.ts`) and package `exports` map.** The
  package is now consumable as a dependency, not only runnable standalone:
  `import { fastifyWas, createApp, FileSystemBackend, defaultBackend } from 'was-teaching-server'`,
  plus the `StorageBackend` contract (and the rest of the domain types) and the
  typed protocol errors. The entry point also loads the Fastify module
  augmentation, so a consumer sees the decorated `FastifyInstance` typed. `tsc`
  now emits declarations (`declaration` / `declarationMap`), and `package.json`
  gains `main` / `types` / `exports` pointing at `dist/`, plus a `files`
  allowlist (`dist`, `common`, `src` -- so the emitted source/declaration maps
  resolve -- and `CHANGELOG.md`) so the published tarball excludes the test
  suites. Usage (including composing a minimal or hardened server from the
  plugin) is documented in `docs/consuming-server-as-library.md`.

### Security

- **Default-on limits.** The server no longer runs unbounded out of the box:
  - `MAX_UPLOAD_BYTES` now defaults to **64 MiB** on both backends (previously
    unset meant no cap on the filesystem backend, and the catch-all binary
    content-type parser hands the handler a raw stream that bypasses Fastify's
    `bodyLimit` entirely -- so a raw blob PUT/POST had no size limit at all, and
    an unbounded multipart part could buffer without limit). Set
    `MAX_UPLOAD_BYTES=unlimited` to opt out explicitly (filesystem backend only:
    the Postgres backend buffers each upload in memory as a single `bytea` and
    rejects `unlimited` at startup).
  - New **count quotas**, default-on: `MAX_SPACES_PER_CONTROLLER` (100),
    `MAX_COLLECTIONS_PER_SPACE` (100), and `MAX_RESOURCES_PER_SPACE` (10000,
    live Resources across a Space's Collections; tombstones don't count). A
    create beyond a limit is rejected with a 507 `quota-exceeded` problem
    (`CountQuotaExceededError`, exported); overwrites never trip a count check,
    deletes free slots, and the tar import path enforces the Collection/Resource
    counts identically on both backends. Enforcement is transactional (hard
    under concurrency) on Postgres -- Space counts serialize on a per-controller
    advisory lock, and the `spaces` table gains a backfilled, indexed
    `controller` column (automatic migration) -- and soft on the filesystem
    backend, matching the byte quota's posture. Each accepts `unlimited` to opt
    out. Matching `fastifyWas` plugin options (`maxSpacesPerController` /
    `maxCollectionsPerSpace` / `maxResourcesPerSpace`) apply to the default
    backend; both backend constructors take them directly. Pinned by the shared
    backend contract suite for both backends.
  - `STORAGE_LIMIT_PER_SPACE` stays unlimited when unset, but startup now logs a
    **warning** prompting an explicit choice;
    `STORAGE_LIMIT_PER_SPACE=unlimited` acknowledges and silences it (the
    warning lives in `start.ts` only, so library and test compositions stay
    silent). A startup warning is also logged when the per-upload cap is
    explicitly disabled.
- **`StorageError` responses no longer leak internal fault details.** The 500
  `storage-error` problem+json body copied the underlying cause message into its
  `title` and `detail`, so filesystem paths, errnos, or SQL fragments from a
  failed backend operation could reach clients. The wire body is now a generic
  "An internal storage error occurred."; the underlying `cause` still goes to
  the server log via `handleError`. Pinned by a no-leak regression test.
- **`/api/cors` proxy is no longer an open SSRF vector.** The proxy now only
  fetches `http`/`https` URLs and refuses any host that resolves to a private,
  loopback, or link-local address (RFC 1918, `127.0.0.0/8`, `169.254.0.0/16`
  cloud-metadata, CGNAT, IPv6 ULA/link-local, and IPv4-mapped forms), so a
  request like `?url=http://169.254.169.254/...` is rejected before any fetch.
  Redirects are now followed manually (capped at 5 hops) with every hop
  re-validated the same way, closing the bypass where an allowed public URL 302s
  the proxy to an internal address. (Adding a lightweight auth gate remains a
  reasonable follow-up.)
- **`/api/cors` proxy hardening: DNS-rebinding protection and a response size
  cap.** Two remaining gaps in the CORS proxy are closed. The SSRF host check
  validated the resolved addresses but the subsequent `fetch` re-resolved DNS
  independently, so a rebinding attacker could pass validation with a public IP
  and have the connection land on a private one (a TOCTOU); the proxy now pins
  each hop's connection to exactly the addresses it validated -- a per-request
  undici `Agent` whose `connect.lookup` resolves only from that pin map -- while
  keeping the original hostname on the wire so TLS certificate validation and
  SNI still work. The relayed response body is now capped at 10 MiB, enforced
  both from a declared `content-length` (rejected before reading the body) and
  incrementally while streaming (the upstream stream is cancelled once the cap
  is exceeded); an oversized response is a 502. Uses undici's `fetch` so the
  dispatcher and fetch share one build.
- **Streamed and binary request bodies are now bound to their signed `Digest`.**
  Previously only JSON/text bodies were recomputed and compared; an
  `application/octet-stream`, image, multipart, or tar body could be swapped
  under a valid signed `Digest`. Such bodies now pass through a hashing
  transform that verifies the digest incrementally at end-of-stream, failing the
  write on a mismatch (the partial file is removed).
- **KMS "unsupported key type / operation" gate is no longer bypassable via
  prototype-chain names.** `generateKmsKey` and `runKeyOperation` now guard with
  `Object.hasOwn`, so a client-supplied `type`/operation of `constructor`,
  `toString`, etc. is rejected as unsupported rather than resolving to an
  inherited `Object` member.
- **Backend-id enumeration is closed on Collection create/update.** The
  backends-available check now runs after capability verification (like the
  `id-conflict` / `encryption-immutable` conflicts), so an unauthorized caller
  can no longer probe a Space's registered backend ids by distinguishing a `409`
  from the masked `404`.

### Fixed

- **`FileSystemBackend.deleteSpace()` is idempotent.** Deleting an absent Space
  resolves instead of rejecting with `ENOENT`, matching the documented
  `StorageBackend` delete contract (pinned by the new backend-contract suite).
- **Slash/no-slash redirects now send a followable `Location`.** The
  canonicalization redirects emitted the literal route template (e.g.
  `Location: /space/:spaceId`) with a `302`; they now build the concrete request
  path (trailing slash toggled, query string preserved) and use `308` so a
  redirected POST/PUT replays its method and body. The List-Collections no-slash
  redirect is also registered as `GET` (it was mistakenly a `PUT`, so
  `GET /space/:id/collections` fell through to a `409`).
- **A description-less Collection directory no longer 500s the whole Space
  listing.** `listCollections` / `listCollectionItems` fall back to the
  directory name instead of dereferencing an undefined description.
- **`text/plain` (and other string-parsed) resource bodies are stored
  byte-for-byte.** A string body is written as its UTF-8 bytes rather than
  iterated per character, so multi-byte / astral-plane content is no longer
  corrupted.
- **Collection delete is idempotent.** Deleting an absent (or already-deleted)
  Collection resolves `204` instead of surfacing an `ENOENT` as a `500`.
- **Space import inherits the write-path guards.** Import now enforces the
  per-upload size cap (413) and fail-closed encryption conformance (422) on
  every staged resource, and no longer resurrects a tombstoned resource (it
  checks the metadata sidecar, not only the content file, before writing).
- **External-backend Collection listing no longer 500s.** `listCollectionItems`
  accepts the caller's control-plane Collection description, which a selected
  data-plane backend does not hold.
- **Malformed `Authorization` (missing `headers="..."`) is a clean `400`**
  rather than an unhandled `500`.
- **Repeated `?include=` on `/quotas` no longer 500s** (an unauthenticated-
  reachable fault on a public-readable Space); the value is normalized when the
  query parser yields an array.
- Typed backend errors are no longer flattened to `500` (or double-logged) by
  the Collection/Resource read/delete handlers; a memoized external-backend
  adapter logs with the stable instance logger rather than the first request's;
  a revocation with an unparseable `expires` no longer throws a `RangeError`;
  and zcap verification failures log the underlying error (object-first) instead
  of dropping it.

### Changed

- **Atomic, durable writes in the filesystem backend.** Every write the
  `FileSystemBackend` performs now goes through one audited helper module
  (`src/lib/atomicFile.ts`): bytes are staged into a `.tmp-<uuid>` file in the
  same directory, fsync'd, `rename`d (or hard-`link`ed, for the create-only
  `wx`-style key/revocation inserts, preserving their EEXIST conflict semantics)
  onto the final path, and the containing directory is fsync'd -- so a crash or
  power loss mid-write can no longer leave a torn JSON document or a truncated
  blob under a Resource's name. Previously, JSON resource bodies and
  `importSpace` writes went directly to the final path, and blob uploads
  streamed into it (with cleanup only on pipeline error, not crash); blobs now
  stream into the temp file and are committed whole. Descriptions, sidecars,
  policies, and keystore configs (previously written via fs-json-store, which
  was atomic per-file but never fsync'd the directory) route through the same
  helper; their read paths are unchanged. (The Postgres backend is unaffected --
  durability there is the database's WAL.)
- **The `conformance/` suite no longer pins the default backend's display name**
  (`Server Filesystem`); it asserts a non-empty `name` instead, so the suite
  passes against any conforming WAS server -- including a Postgres-backed one
  (`DATABASE_URL=... pnpm conformance:local`).
- **The WAS protocol surface is now a registerable Fastify plugin, `fastifyWas`
  (`src/plugin.ts`).** The plugin owns the `serverUrl` / `storage` /
  backend-provider decorations, CORS, multipart, the content-type parsers, and
  the route groups (the four WAS groups plus the WebKMS `/kms` facet) --
  everything from `routes.ts` down, including the per-group auth/digest hook
  chains and error handler. `createApp()` (`src/server.ts`) is now the thin
  community-edition composition: it registers `fastifyWas` (passing its options
  through unchanged) plus the teaching-server extras (static assets, welcome
  page, `/health`, the CORS proxy). No wire-behavior change; this is the
  enabling refactor for the two-codebase strategy -- a hardened downstream
  server can register the same plugin around its own persistence and policy
  plugins. Adds `fastify-plugin` as a dependency (the decorations/parsers land
  on the root instance, as before).

## 0.8.0 - 2026-07-02

### Added

- **Space-rooted delegated capabilities on the space-family routes.** Every
  `/space/:spaceId/...` route now also accepts a delegated capability chain
  rooted at the _Space's_ root capability with RESTful target attenuation -- the
  same shape the WebKMS keystore routes already allowed. A controller can
  delegate one capability for the whole Space (or, by attenuating the
  `invocationTarget` at delegation time, for a single Collection under it) and
  the delegate can invoke it against any URL underneath: resources, listings,
  `/meta`, the changes-query endpoint, `/quotas` (composing with the existing
  query-parameter attenuation). Root invocations of the exact target's own root
  capability verify unchanged, so this only widens what the Space controller can
  delegate, never who can access. Implemented as `verifyZcap`'s new
  `attenuatedRootTarget` option, threaded through `authorize()` and the
  `spaceContext` preludes; exercised by the new `test/session-zcaps.test.ts`
  suite (the browser-session-key shape: space-wide read + per-collection
  read/write, negative cases included -- notably that a collection-scoped
  capability cannot PUT the Space Description, and that only the Space root is
  accepted as a chain root).
- **WebKMS `/kms` facet: zcap revocations + delegation policy.** Delegated
  capabilities on the `/kms` facet can now be revoked, and every keystore-rooted
  verification enforces a unified delegation policy; driven end-to-end by
  `@interop/webkms-client`'s `revokeCapability` in the new
  `test/kms-revocation-api.test.ts` suite:
  - `POST /kms/keystores/:keystoreId/zcaps/revocations/:revocationId`
    (`:revocationId` = the URL-encoded id of the capability being revoked, which
    is also the request body; 204 on success). Authorization follows
    ezcap-express's `authorizeZcapRevocation` dual-root rule: the invocation may
    root in the keystore, or in the revocation URL itself, whose synthesized
    root capability is controlled by _every controller in the to-be-revoked
    capability's fully verified chain_ -- so a delegee can revoke its own zcap
    without holding a separate capability. The submitted chain must root in the
    keystore being posted to; root zcaps cannot be revoked (400); a chain
    containing an already-revoked link (resubmissions included) is a 400, with
    the 409 duplicate reserved for a write race.
  - Revocations are checked on every subsequent keystore-rooted invocation via
    the zcap library's `inspectCapabilityChain` hook (`src/lib/revocations.ts`;
    written route-family-agnostic so a later WAS-side store can reuse it).
    Storage is the new insert-once `StorageBackend` pair `insertRevocation` /
    `isRevoked`, unique on `(delegator, capability.id)` per keystore under
    `data/keystores/<localId>/revocations/`; records lapse one day past the
    capability's own `expires` (the filesystem analogue of a TTL index, pruned
    lazily on read).
  - Unified delegation policy on all `/kms` verifications: max chain length 10
    (`KMS_MAX_CHAIN_LENGTH`) and a single 90-day max delegation TTL
    (`KMS_MAX_DELEGATION_TTL`). The per-key `maxCapabilityChainLength` stored at
    generate time is now enforced at operation time.
  - `handleZcapVerify` now returns the verification result (the dereferenced
    chain feeds the per-key gate), and `verifyZcap` grew optional
    `inspectCapabilityChain` / `maxChainLength` / `maxDelegationTtl`
    pass-throughs -- absent on the WAS route families, whose behavior is
    unchanged. New runtime dependencies `@interop/zcap` and
    `@interop/jsonld-signatures` (both already in the tree transitively) power
    the revocation route's standalone `CapabilityDelegation` chain verification.

- **WebKMS `/kms` facet: local KMS module + key operations.** The `/kms` facet
  now generates and uses server-held keys, driven end-to-end by
  `@interop/webkms-client`'s `KeystoreAgent` and all four key classes
  (`AsymmetricKey`, `KeyAgreementKey`, `Hmac`, `Kek`) in the new
  `test/kms-key-api.test.ts` suite:
  - `POST /kms/keystores/:keystoreId/keys` (`GenerateKeyOperation`, responding
    200 + `Location` + `{ keyId, keyDescription }` per webkms-switch),
    `POST .../keys/:keyId` (operation dispatch by envelope `type`), and
    `GET .../keys/:keyId` (public key description; capability-verified with the
    `read` action). Every key route roots its capability in the **keystore** URL
    with the key URL accepted as an attenuated target (a new
    `allowTargetAttenuation` mode in `verifyZcap`); the expected zcap action is
    the decapitalized operation name (`generateKey`, `sign`, ...).
  - The single in-process `local-v1` module (`src/lib/kmsModule.ts`): Ed25519
    sign (via `@interop/ed25519-verification-key`), X25519 `deriveSecret` (via
    `@interop/x25519-key-agreement-key`, a new runtime dependency; raw ECDH, no
    KDF), HMAC-SHA-256 sign/verify and AES-256-KW wrap/unwrap (node crypto).
    Custody draws the line on what is served: asymmetric verify is client-local
    by design and requesting it is a clean 400 not-supported. `publicAlias` /
    `publicAliasTemplate` are applied to the description `id` at generate time
    and re-applied stably on every read.
  - Fixed: a wrong-length HMAC `signatureValue` is an ordinary
    `{ verified: false }` (not an uncaught `timingSafeEqual` throw), and a
    failed AES-KW unwrap resolves `{ unwrappedKey: null }`. A mismatched
    `deriveSecret` `publicKey.type` is likewise a clean 400.
  - Key records are stored using the `{ keystoreId, localId, meta, key }` shape
    (secret material included, plaintext this increment; `controller`
    deliberately not stored -- it is read live from the keystore config), as
    opaque units behind new insert-once `StorageBackend` methods (`insertKey` /
    `getKey`, with the protocol's 409 duplicate conflict) under
    `data/keystores/<localId>/keys/<keyLocalId>.json`. Wire projections never
    include secret fields.

- **WebKMS `/kms` facet: keystore lifecycle.** The server now hosts the first
  slice of the Interop TypeScript analogue of Digital Bazaar's WebKMS system,
  interoperating with `@interop/webkms-client@14.4.2` (whose `KmsClient` drives
  the new test suite, `test/kms-keystore-api.test.ts` -- the client is the
  conformance suite for this wire contract):
  - `POST /kms/keystores` (Create Keystore, 201 + `Location` + bare config;
    authorization is the chain-to-body-controller bootstrap rule, mirroring
    Create Space), `GET /kms/keystores?controller=<did>` (list-by-controller,
    `{ results }` capped at 100 -- you can only list your own),
    `GET /kms/keystores/:keystoreId` (bare config), and
    `POST /kms/keystores/:keystoreId` (update: `sequence` must be exactly
    previous+1 and `kmsModule` is immutable -- both gated atomically in storage
    with a 409 state conflict -- responding with the `{ config }` wrapper).
    Local ids follow webkms-switch's scheme (multibase base58btc,
    multihash-framed 128-bit random, via `@digitalcredentials/bnid`, now a
    runtime dependency).
  - The `/kms` route group is the first to use the strict `requireAuthHeaders`
    hook: every webkms route -- GETs included -- is zcap-invoked, with `read` /
    `write` zcap actions (not HTTP verbs); the protocol has no public reads.
    Unknown keystores and failed authorization stay masked as `not-found` (404),
    the server-wide convention.
  - Storage grows a keystore tree (`data/keystores/<localId>/config.json`, a
    sibling of `spaces/` -- the facet is deliberately separable) behind new
    `StorageBackend` methods (`writeKeystore` / `getKeystore` / `updateKeystore`
    / `listKeystoresByController`).

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
    `application/json`). An unrecognized `scheme` is now rejected with the new
    `unsupported-encryption-scheme` (400) error rather than stored opaquely.
  - A Resource **content** write into a recognized-scheme Collection is
    structurally validated (`Create Resource` `POST`, `Put Resource` `PUT`): the
    request `Content-Type` MUST be the scheme's registered media type and the
    body MUST be a structurally valid envelope. For `edv` that is an **EDV
    Encrypted Document** -- a JSON object whose `jwe` member is a JWE in JSON
    serialization (`isValidEdvDocument` wrapping `isValidEdvEnvelope`, shape
    only, never decrypted) -- carried as `application/json`, matching what the
    EDV codec actually stores (the earlier bare-`application/jose+json` JWE
    profile was corrected to this before release). A non-conforming body (a
    plaintext object, or a bare JWE with no `jwe` wrapper) is the new
    `encryption-scheme-mismatch` (422). Checked after capability verification,
    so an under-authorized caller still receives the privacy-merged `not-found`
    (404).
  - Requires `@interop/storage-core` ^0.3.1 (adds the two new problem types).

- **Encrypted Resource Metadata profile (spec "Encrypted Collections").** On a
  Collection with a recognized `encryption` marker, a Resource's user-writable
  `custom` metadata is now stored as an encryption **envelope** (the same
  EDV-Document profile as content), symmetric with how content is stored:
  - `PUT .../meta` on an encrypted Collection validates `custom` structurally as
    a conforming envelope (`assertEncryptedMetaConforms`), rejecting a plaintext
    `{ name, tags }` (or any non-envelope) with `encryption-scheme-mismatch`
    (422), checked after auth + 404. The metadata document itself stays
    `application/json`; only its `custom` sub-value is the envelope. The server
    stores it opaquely and never decrypts. Plaintext Collections are unaffected
    (`{ name, tags }` validated as before).
  - The `/meta` sub-resource now carries its **own** monotonic `metaVersion`
    ETag (V2 metadata versioning), independent of the content `version`: a
    metadata-only write bumps `metaVersion` (and `updatedAt`) but leaves the
    content ETag untouched, and honors `If-Match` / `If-None-Match` on
    `metaVersion` (412 on mismatch), evaluated atomically under the per-Resource
    write lock. `GET .../meta` returns the `metaVersion` as its `ETag`.
  - The replication change feed (`changesSince`) now carries `metaVersion` and
    the `custom` envelope, so a metadata-only edit replicates alongside content
    (re-surfacing the Resource with a bumped `updatedAt` / `metaVersion` but
    unchanged `version` / `data`).
  - List Collection omits `name` from item summaries on an encrypted Collection
    (the server cannot project a name out of an opaque envelope).

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
