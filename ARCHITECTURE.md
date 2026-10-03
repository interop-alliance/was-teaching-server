# Architecture

How a request flows through the Wallet Attached Storage (WAS) reference server,
the domain model, and the ZCap authorization structure. For contribution
conventions see [CONTRIBUTING.md](CONTRIBUTING.md); for agent-facing rules
(tests, logging, endpoint recipes) see [AGENTS.md](AGENTS.md).

## Request Flow

A request flows through these layers, in order:

```
start.ts > server.ts > routes.ts > requests/*Request.ts > storage.ts > backends/*.ts
 (env,      (createApp,  (URL>handler   (per-operation       (storage     (persistence:
  listen)    plugins,     mapping +      handlers; auth       facade)       filesystem)
             decorate)    auth hooks)    verify + storage)
```

- **`src/start.ts`** — entry point. Reads `SERVER_URL` / `PORT` / `HOST` from
  env, calls `createApp()` and `listen()`, and closes the app on `SIGTERM` /
  `SIGINT` so its `onClose` hooks run.
- **`src/server.ts`** — `createApp({ serverUrl })` builds the Fastify instance,
  registers plugins (cors, static, view, multipart), decorates the instance with
  `serverUrl`, and registers the four route groups. The registration itself is
  `composeApp({ fastify })`, which `createApp()` calls on the instance
  `createInstance()` builds. The test boot (`startTestServer` in
  `src/testing.ts`) calls the same two, adding the request fault hooks to the
  root instance in between so they run ahead of every route group's hooks.
  Neither is exported from the package.
- **`src/routes.ts`** — four `init*Routes(app)` functions map URL patterns to
  handler methods. Every group installs the same hook chain first: the
  `requireAuthHeadersOrPublicRead` then `parseAuthHeaders` `onRequest` hooks,
  then the `captureRawBody` (preParsing) and `verifyBodyDigest` (preValidation)
  digest hooks. A container -- a Space or a Collection -- is canonically
  addressed with a trailing slash: `GET` lists its members, `POST` adds one,
  `DELETE` removes the container, and `PUT` is not defined there. What a
  container _is_ lives at its `meta` sub-resource instead:
  `GET`/`PUT /space/:spaceId/meta` is the Space Metadata object and
  `GET`/`PUT /space/:spaceId/:collectionId/meta` the Collection Metadata object.
  A `PUT` of a container URL answers 405, with an `Allow` header naming the
  methods the container accepts (the spec assigns this refusal no problem
  `type`, so it is RFC 9457's `about:blank`, and its `title` is the status
  phrase `Method Not Allowed`, as RFC 9457 asks of an `about:blank` problem; the
  refusing URL is named in the `detail`). Every reserved endpoint (spec
  "Reserved Path Segment Registry") answers the same 405 for each method it does
  not implement -- a `DELETE` of either Metadata URL, a `GET` of `export`, a
  `PUT` of a Collection's `quota`. Each group ends with
  `refuseUnimplementedMethods`, which reads the implemented set from the router
  (`hasRoute`) and registers a refusal for every other method Fastify routes, so
  the `Allow` header cannot drift from the routes. It must stay last in its
  group. `OPTIONS` is left to the CORS preflight, and `HEAD` follows `GET`.
  Without these refusals such a request fell through to the parametric route one
  level up and was refused as a 409 `reserved-id`, an answer about ids to a
  request about a method. The refusal reads no ids, so it answers the same
  whether or not the Space, Collection, or Resource exists. A reserved endpoint
  this server anchors but serves nothing at (the cross-collection
  `/space/:spaceId/query`) sends an empty `Allow`. The no-slash form of a
  container URL redirects to the slash form with a 308 for every method
  (spec-defined; see the Glossary's Trailing slashes note), so a signed request
  must be re-signed for the redirect target rather than replay its
  `Authorization` header. The retired `/space/:spaceId/collections/` endpoint
  308s to the Space URL, which lists and creates Collections since v0.5;
  `collections` and `meta` stay reserved Collection ids.
- **`src/requests/*Request.ts`** — request handlers as static class methods
  (`SpaceRequest.post`, etc.). Each handler follows the same shape: fetch the
  Space/Collection for context, call `handleZcapVerify(...)`, then call a
  storage method. Handlers read both `serverUrl` and `storage` from
  `request.server` (the `FastifyInstance` decorated in `server.ts`), not via a
  `this` binding.
- **`src/auth-header-hooks.ts`** — `requireAuthHeaders` (401 if missing) and
  `parseAuthHeaders` (parses `Authorization` / `Capability-Invocation` /
  `Digest` into `request.zcap`).
- **`src/digest.ts`** — Request Body Integrity (spec "Request Body Integrity"):
  `captureRawBody` (preParsing) tees JSON/text body bytes onto
  `request.rawBody`; `verifyBodyDigest` (preValidation) requires the `digest`
  header be covered by the signature and recomputes/compares it against the body
  before capability verification (400 `invalid-authorization-header` on
  failure). It runs on any request that carries a body (a `Content-Type`, a
  `Transfer-Encoding`, or a non-zero `Content-Length`), and refuses a body with
  no `Content-Type` as `missing-content-type` (400) first. Without that, the
  catch-all parser would hand such a body to Import Space or the governed-log
  `PUT` as a raw stream the signature never covered. `captureRawBody` also
  bounds what it buffers, by the route's `bodyLimit`, which
  `src/lib/bodyLimit.ts` derives from the active backend's `maxUploadBytes`: the
  body is read in the hook (`readBoundedBody`, the one bounded reader
  `readTextBody` shares), so an over-limit body is refused with
  `payload-too-large` (413) at the byte that crosses the limit, before any
  signature is verified and whichever parser the media type reaches, and the
  refusal closes the connection. A signed multipart body, which
  `@fastify/multipart` reads off the raw request itself, is tapped rather than
  piped: the hook hashes it as busboy reads it and leaves the verdict on
  `request.multipartDigest`, which the multipart write path awaits before it
  stores anything.
- **`src/zcap.ts`** — `handleZcapVerify()` performs the capability-invocation
  signature verification against the Space controller's key.
- **`src/lib/hostedPageSandbox.ts`** -- the hosted-page sandbox. An `onSend`
  hook that every route group installs (`installGroupHooks`) stamps
  `Content-Security-Policy: sandbox ...` on every response in the WAS and `/kms`
  groups, 304s, redirects and errors included. It skips a response whose
  `content-type` is `application/pdf`: Chromium refuses to render a PDF in a
  sandboxed document, and a browser's PDF viewer cannot reach the serving
  origin's storage anyway. A stored HTML page then runs with an opaque origin
  and cannot read the storage of the origin serving it, which matters when a
  wallet serves this server on its own origin. The hook is group-wide so that a
  new route serving stored bytes, such as a default document, cannot be added
  without it. A sandbox has no effect on a response read with `fetch()`, so the
  JSON responses carry it harmlessly. The welcome page, `/common/`, `/service`
  and the CORS proxy sit outside the groups and do not carry it. The CORS proxy
  sends its own stricter set instead (`default-src 'none'; sandbox`, `nosniff`,
  `Content-Disposition: attachment`). The policy leaves out `allow-same-origin`,
  which combined with `allow-scripts` would let a page lift its own sandbox, and
  `allow-popups-to-escape-sandbox`, so a popup a page opens is sandboxed too. It
  is always on, with no setting. These responses send no
  `X-Content-Type-Options: nosniff`, so a Resource stored with a generic type is
  still sniffed, and runs sandboxed too.
- **`src/lib/etag.ts`** and **`src/lib/preconditions.ts`** — the `ETag`
  validators (spec "Caching" and "Conditional Requests"). A Resource, a chunk, a
  Resource's `/meta` object, and each container's Metadata object (the Space
  Metadata object, the Collection Metadata object) carries a generation and a
  monotonic version that `formatEtag` emits together as one strong `ETag`
  (`"<generation>.<version>"`) on GET/HEAD. One validator covers a container's
  whole Metadata object: v0.5 merged what used to be a separate Collection
  description and its `/meta` annotation object into one `CollectionMetadata`
  record, so `metaVersion` advances on a configuration write (`backend`,
  `encryption`, `generator`) and an annotation write (`custom`, `epoch`) alike.
  The Space Metadata object's `metaVersion` also advances when a backend is
  registered or deregistered on the Space: its served `backends` member changed
  while its stored body did not, and a strong validator must move with the
  representation (both backends bump the version only, the generation kept,
  under the same per-Space lock as a Metadata write). The terms "Space
  Description" and "Collection Description" are retired; storage exposes one
  validator pair per container, `metaGeneration` / `metaVersion`, through
  `writeSpace` / `getSpaceMetadata` and `writeCollection` /
  `getCollectionMetadata` -- there is no separate `writeCollectionMetadata` /
  `getCollectionMetadata` pair. The generation is a random base58 marker minted
  when the record's counter starts and kept for the record's life. A Resource's
  content counter continues through a tombstone and its re-create, so its
  generation does too. The Resource's `/meta` object is a record of its own with
  its own generation (`metaGeneration` in the sidecar, `meta_generation` in
  Postgres), and a soft delete drops it together with `custom` and
  `metaVersion`, so a re-create's first metadata write starts a fresh generation
  at version 1 and a `/meta` `ETag` held from before the delete cannot pass
  `If-Match` against it. A hard delete (a chunk, a Collection, a Space) removes
  the counter with the record, so the next record under the same id mints a new
  generation and its validators never coincide with the old record's; a client's
  stale cached `ETag` then matches nothing instead of being answered 304 over
  different bytes. A client treats the whole quoted value as opaque and may read
  the trailing integer as the revision number. Writes are gated by `If-Match` /
  `If-None-Match: *`, which `parseWritePreconditions` normalizes and the
  backends evaluate atomically with the write through `preconditions.ts`. The
  Space and Collection Metadata objects take both: the `If-None-Match: *`
  guarded create is what resolves two clients provisioning the same Space or
  Collection at once (the loser's replace-semantics `PUT` would otherwise
  rewrite the winner's `type` array or `backend`), and it refuses whenever the
  container already has a Metadata object, `ETag` or not. Update Space
  (`PUT /space/:spaceId/meta`) chooses its authorization from an unlocked read,
  so its write passes `writeSpace` an `assertTransition` hook that pins it to
  that read: the Space must still be absent on a create, and carry the same
  validator on an update. On a mismatch the handler re-reads and re-authorizes
  on the branch the fresh read selects. A create that lost a race is then
  authorized as an update against the winner's controller. After three attempts
  it answers 503 with `Retry-After`. The client's own preconditions go to the
  backend as sent, so a 412 answers only a header the client sent. The validator
  is embedded in the stored record as reserved `_generation` / `_version`
  members -- the filesystem backend keeps one file per container
  (`.space.<id>.json`, `.collection.<id>.json`) holding the wire body and the
  validator together -- and as `meta_generation` / `meta_version` columns on the
  Postgres `spaces` and `collections` rows, kept out of the wire body; it is
  emitted on Read Space / Read Collection and on the Create/Update responses. A
  Space Metadata write is serialized per Space (the `spacemeta:` lock in the
  filesystem backend, an advisory lock plus row lock in Postgres) and a
  Collection Metadata write per Collection (the `cmeta:` lock), so the check and
  the version bump are atomic. Reads are conditional the other way round: a
  GET/HEAD carrying `If-None-Match` is parsed by `parseIfNoneMatch` into the set
  of validators the client holds (RFC 9110 weak comparison, list and `*` forms),
  and a handler answers 304 Not Modified with the `ETag` and no body when that
  set covers the current one (`isNotModified`, sent by the shared
  `requests/notModified.ts` helper). The decision sits in each read handler,
  after authorization, so an under-authorized conditional read still gets the
  404 mask. A Resource or chunk GET consults the stored metadata first when the
  header is present and opens the byte stream only on a miss. A representation
  with no validator (a legacy Resource, or metadata never written) is matched
  only by `*`, which RFC 9110 makes true for any current representation; its 304
  then carries no `ETag`, as its 200 would not. Responses to non-idempotent
  POSTs are marked `Cache-Control: no-store` by an `onSend` hook in `routes.ts`;
  a slash-variant redirect and a POST route registered with `config.safe` (Query
  and Export, reads that use POST to carry a body) stay cacheable. The spec
  defers further `Cache-Control` semantics.
- **`src/lib/changesCheckpoint.ts`** -- the `changes` query profile's wire
  checkpoint. The feed is ordered by a per-Collection feed position, a positive
  integer sequence. Every Resource-level write takes the next one: a content
  write, a metadata write, a soft delete, and a Resource written by an import. A
  chunk write takes none, so it never moves its parent. The position is assigned
  inside the per-Collection critical section that makes the write visible, so no
  write lands at or before a position a reader was already handed. `updatedAt`
  has no ordering role: two writes can share a millisecond. The filesystem
  backend keeps the counter in `.feed.<collectionId>.json` in the Collection dir
  and stamps the position on the sidecar as `feedPosition`, under a `feed:` key
  nested inside the per-Resource lock. `changesSince` reads the counter under
  that key and admits only positions at or below it. The Postgres backend
  increments `collections.feed_position` with `UPDATE ... RETURNING`, whose row
  lock is held to commit, so positions are commit-ordered, and stamps
  `resources.feed_position` in the same transaction. A position is one server's
  fact about its own feed: export strips it and import assigns fresh ones. An
  imported Resource with no archived metadata gets fresh metadata, so it takes a
  position too. A Resource stored before positions existed has none and is
  absent from the feed until it is rewritten. The counter has a generation,
  minted with the first position it hands out and kept for the Collection's life
  (`generation` in the counter file, `collections.feed_generation` in Postgres).
  It goes with the Collection, so a Collection re-created under the same id, by
  hand or by an import, restarts at 1 under a fresh one; an import keeps the
  archived Collection Metadata generation, so that one cannot tell the two lives
  apart. On the wire the checkpoint is an opaque string, which a client compares
  by equality only and echoes back verbatim. This server encodes it as
  `base64urlnopad(JSON.stringify({ feed, generation, position }))`, where `feed`
  is the Collection's absolute trailing-slash URL and `generation` the feed
  counter's, so a checkpoint is scoped to the server, the Collection, and the
  life of its feed that issued it. Each feed document carries the checkpoint
  that resumes right after it, and the page's `checkpoint` is its last
  document's. A checkpoint this server did not issue for the Collection, the
  retired `{ id, updatedAt }` object included, is `invalid-request-body` (400)
  at `#/checkpoint`. So is one issued for the Collection before it was deleted
  and re-created: reading its position into the new feed would skip every write
  at or below it. The handler learns the current generation from the backend's
  page (`feedGeneration`), so the position goes to the backend first and the
  generation is compared afterward.
- **`src/lib/spaceMetadataCache.ts`** and **`src/lib/policyCache.ts`** -- the
  two short-TTL read caches on the authorization path, one per storage backend.
  The first memoizes the Space Metadata object, whose `controller` every
  capability check verifies against. The second memoizes the access-control
  policies the policy fallback reads. Both expire entries after 10 s
  (`SPACE_METADATA_CACHE_TTL`, `POLICY_CACHE_TTL` in `config.default.ts`). A
  write drops the affected entries, but only in the process that made the write.
  The TTLs therefore rest on a single-instance deployment. When several
  instances share one storage backend, a controller retired by an Update Space
  on one instance keeps its authority on another for up to one TTL. A changed or
  deleted policy likewise keeps granting there for up to one TTL.
- **`src/lib/governedEncryptionCache.ts`** -- a third read cache, one per
  storage backend, memoizing the `encryption` descriptor derived from a
  log-governed Collection's history log. The parse is what it saves, since the
  log is append-only and grows. The log body is still read on each request. An
  entry is keyed by Collection and by the log's own validator
  (`<generation>.<version>`), so a log write leaves the old key behind and the
  next derivation misses on a new one. It therefore carries none of the
  multi-instance staleness the two caches above carry. Delete Collection, Delete
  Space, and Import Space still drop entries by prefix, since an import installs
  an archived log with the archive's own validator, which could coincide with a
  cached one over different bytes. Entries expire after 600 s and are capped at
  1000 (`GOVERNED_ENCRYPTION_CACHE_TTL`, `GOVERNED_ENCRYPTION_CACHE_MAX`).
- **`src/lib/governedLog.ts`** -- the `governed-history-logs` feature: a
  Collection's governing history log, served at its own sub-resource
  (`GET`/`PUT /space/:spaceId/:collectionId/meta/log`,
  `CollectionRequest.getLog` / `putLog`). The log is not a Resource: it is
  absent from listings and the changes feed, exempt from the
  encrypted-Collection envelope rule, and left untouched by a `PUT /meta`. It is
  served as `text/jsonl` with its own generation/version `ETag`, so a
  conditional `GET` behaves like any other record; a `PUT` is either a guarded
  create (`If-None-Match: *`) or a compare-and-swap append (`If-Match` carrying
  the prior bytes verbatim plus one new line), 412 on a lost race. `GET` is
  capability-or-policy at the Collection's target; `PUT` is capability-only,
  like `/meta`, and carries the same container rule as `/meta` (see below): a
  direct root invocation, or a delegated capability whose tail targets exactly
  the Space's canonical trailing-slash URL. The guarded create is the
  declaration that puts the Collection under log governance, and is refused with
  `encryption-immutable` (409) on a Collection whose Metadata object already
  carries a client-written `encryption` member. From then on, the Collection's
  served `encryption` member -- read by Get Collection and by every handler that
  loads the Collection Metadata object through `getCollectionOrThrow`, so the
  write-time envelope check sees it too -- is derived from the log's last line's
  `state`, with a `history: { method, resource }` member always stamped on
  (`method` from the genesis line's `parameters.method`, `resource` the log's
  own URL); the stored Collection Metadata object never carries that derived
  member, a direct `encryption` write against it is refused with
  `encryption-history-log-governed` (409), and its other fields still update
  normally. The derivation is memoized per backend by the log's validator
  (`lib/governedEncryptionCache.ts`, above). Update Collection's recheck under
  the lock derives from the log the backend hands its `assertTransition`
  callback, so a Metadata write parses the log at most once. The server verifies
  neither proofs nor a hash chain. It checks that the body is JSON Lines, each
  line a JSON object with an object `state` member and the last line the head.
  It also checks that the genesis line's `parameters` carries a string `method`,
  and that no line's `state` carries a `history` member, since the server stamps
  that member itself. A break of any of these is `invalid-request-body` (400).
  It also checks that an append fast-forwards the stored log (the stored bytes
  verbatim followed by exactly one new line; a body the stored log is not a
  prefix of is `precondition-failed`, 412, with or without `If-Match`, and one
  adding more than one line is `invalid-request-body`, 400). A body equal to the
  stored log byte for byte is a no-op. Once its preconditions pass, it answers
  204 with the current `ETag` and writes nothing, so neither the log's version
  nor the Collection Metadata object's moves. A body that is a strict prefix of
  the stored log would erase lines and stays a 412. On every append the server
  runs the same encryption-descriptor transition checks against the prior head
  that an ordinary Collection Metadata update runs. The fast-forward rule keeps
  the log append-only at the server: a write capability can add history but not
  erase it, while a break inside an appended entry stays the verifying reader's
  to detect. A log write also bumps the Collection Metadata object's own `ETag`,
  since its served content changed, but leaves its `updatedAt` untouched -- both
  backends advance only the version counter -- and is serialized with Collection
  Metadata writes through the same per-Collection lock.
- **`src/serviceDescription.ts`** -- the service description (spec "Service
  Description"): `GET /service`, unauthenticated, serving the JSON document that
  lists four entries in its `specs`. The core entry, under the
  `https://w3id.org/pws` identifier, names the spec version this server speaks
  (`0.5`), the Spaces Repository URL, and the `features` tokens naming the
  optional sections of the core spec this server serves, `changes-query` among
  them. It also carries `originId`, the active backend's origin id, which a
  replication peer reads when it registers. It sits on the core entry rather
  than on `instance` because a peer may gate on it, and the spec forbids a
  client gating on `instance`. The archive's `service.json` carries it too. A
  Backend descriptor advertises no tokens of its own. Conditional writes, the
  `epoch` stamp, and the `writerId` writer-attribution label are baseline
  guarantees of every backend a Collection may be created on, since the server
  -- not the storage engine -- serializes each write and mints its own opaque
  validator; a content hash would serve as a strong validator as well as the
  version counter used here. The entry under
  `https://w3id.org/pws/authz-profile` names the zCap authorization profile
  version (`0.1`) and its rendered location, and carries the accepted
  `signatureAlgorithms` and `zcapCryptosuites` (profile
  ["Service Description Entry"](https://w3c-ccg.github.io/wallet-attached-storage-spec/authz-profile/#service-description-entry)).
  The document's `instance` member, the operator's disclosure of the deployed
  software, also carries the instance's identity when the server has one
  (`lib/serverIdentity.ts`, below): `exportSigningKey`, the `did:key` of the key
  the server will sign export archives with, present whenever
  `WAS_SERVER_KEY_SEED` is set; and `serverDid`, the server's own self-hosted
  `did:webvh`, present only once the resolved current document of the log at
  `server/id/did.jsonl` lists that key under `assertionMethod` and under no
  other relationship. They sit on `instance` rather than on a `specs` entry
  because they describe this deployment, not a specification it implements.
  `serverDid` is read per request, since the admin writes that log after boot,
  and the served body and its `ETag` are recomputed when it changes. The outcome
  is memoized per backend on the log Resource's `ETag`, so a request costs one
  metadata read while the log stands still. Listing the profile is how a client
  learns this server authorizes with capability invocations, before its first
  signed request. The last two members are read off `zcap.ts`
  (`INVOCATION_SIGNATURE_ALGORITHMS`, `delegationProofCryptosuites`), so a
  change to what verification accepts changes the advertisement too. The third
  entry, under `https://w3id.org/pws/encrypted-collections`, is the Encrypted
  Collections profile (version `0.1`). Listing it at all is this server's claim
  that it serves the chunk endpoints -- no token names those -- and its
  `features` array names the profile's two optional affordances this server
  serves, `blinded-index-query` and `governed-history-logs`. Those two moved
  here off the Backend descriptor: they are affordances of that companion
  specification, not of a storage engine. The fourth entry, under
  `https://w3id.org/pws/client-annex`, is the client annex profile (version
  `0.1`). Listing it is this server's claim that it enforces the client-annex
  delegation clause described below. It carries `version` alone, since it is a
  conformance claim with nothing further to advertise. A client ignores a member
  it does not know, and treats an entry whose `version` it does not speak, or
  whose `url` is not a string, as absent. The document is built per `serverUrl`
  and served with `Cache-Control: public` and a content-hash `ETag`. The module
  also installs the one hook every response passes through: a root-level
  `onSend` hook (`addServiceLinkHook`, added by the plugin) that appends
  `Link: <{serverUrl}/service>; rel="service"` to every response -- successes,
  errors, 404s for unmatched routes, 308 redirects, 405 refusals, CORS
  preflights, and the teaching-server extras. It appends to a `Link` header a
  handler already set rather than replacing it. The CORS registration exposes
  `Link`, so a cross-origin client can read it. The Space and Collection
  linksets carry the same URL under the `service` relation. The
  `discloseVersion` option (`WAS_DISCLOSE_VERSION`) withholds the version from
  the document's `instance` member, `/health`, and the welcome page together.
- **`src/lib/serverIdentity.ts`** -- the server's own identity, which export
  provenance (`lib/exportProvenance.ts`, below) signs with. Two keys with two
  holders: the server derives an Ed25519 export-signing key from
  `WAS_SERVER_KEY_SEED` and holds nothing else; the administrator's `did:key`
  (`WAS_ADMIN_DID`) holds the update key of the server's `did:webvh` history
  log, so the server never mints or extends its own log and a compromised server
  cannot take the DID over. The DID is the self-hosted
  `did:webvh:{scid}:{host}:space:server:id`, whose log is the `did.jsonl`
  Resource of the `id` Collection in the `server` Space; it resolves through the
  same `webvhController.ts` path as any Space controller, so the log gets the
  fast-forward and verify-on-append rules and the document cache with no code of
  its own. The plugin provisions the `server` Space at registration when
  `WAS_ADMIN_DID` is set, as a guarded create typed
  `['AuxiliarySpace', 'ServerInstanceSpace', 'Space']` with the admin DID as
  controller, and refuses to start over a stored `server` Space that lacks the
  subtype or carries another controller. A create that loses the guarded write
  to another instance booting over the same storage re-reads and checks what the
  winner stored, and one the Space count quota refuses fails naming
  `WAS_ADMIN_DID`. The Space id `server` is reserved on every client create
  (`assertCreatableSpaceId`, `reserved-id` 409), configured or not, and the
  subtype is refused there too (`assertClientCreatableSpaceType`) while the
  shape check still admits it, so the admin's own Update Space, which must
  restate the stored `type` set, goes through. `resolveServerDid` reads the
  log's head for the DID, checks it is hosted at `server/id` of this server,
  resolves it, and requires the signing key to be listed under `assertionMethod`
  alone, reading every method that carries the key and any method embedded in a
  relationship: a key under `capabilityInvocation` could root-invoke, and one
  under `capabilityDelegation` without `capabilityInvocation` would read as a
  ladder verification method to the client-annex clause. A log that is absent,
  does not verify, or lists the key otherwise leaves `serverDid` off `/service`
  with a `warn` line, logged once per log version rather than per request, and
  the server signs nothing. The log is admin-custodied state: it dies with a
  data wipe, and the admin's copy is what restores it.
- **`src/lib/provenanceStatement.ts`** -- the provenance statement contract,
  shared by the two halves below and owned by neither. It holds the statement
  `type` (`STORAGE_ATTESTATION_TYPE`), the members a statement attests
  (`Claims`, `CLAIM_MEMBERS`), and the rules for computing them from an archived
  object. `serverFieldsOf` reads the server-managed members off an archived
  Metadata file or `.meta.<id>.json` sidecar. `fileDigest` digests a file's
  bytes in the `Digest` header's `mh=` form. `chunkedDigest` computes a chunked
  Resource's composite digest. Export signs what these compute, and import
  recomputes the same values to judge a statement.
- **`src/lib/exportProvenance.ts`** -- export provenance, the signing half of
  the server identity. `loadExportAttestor` runs once per Export Space request.
  It takes the server DID from `resolveServerDid`, reads the log's bytes as the
  log Resource serves them, and checks that snapshot on its own terms: its head
  names the same DID, it verifies as that DID's log, and its document lists the
  seed key under `assertionMethod` alone as the method
  `{serverDid}#{publicKeyMultibase}`. With no identity the handler logs one
  `warn` line naming the reason and the export carries no provenance. With one,
  the backend's `exportSpace` hands its finished entry tree to
  `attestArchiveEntries` before packing it. That call emits one
  `StorageAttestation` statement per exported object in manifest order: the
  Space Metadata object, each Collection Metadata object, and each Resource with
  a representation (a tombstone holds no content and gets none). A statement is
  `{ id, type, createdBy, createdAt, version, digest, didLogVersionId }`. `id`
  is the object's absolute URL on this server. The server-managed members are
  read back off the archived Metadata file or `.meta.<id>.json` sidecar, and a
  member the record lacks is left out. `digest` is the `Digest` header's `mh=`
  form over the representation's archived bytes. A chunked Resource's `digest`
  is the same form over the JCS serialization of its chunk digests in index
  order, so its parent representation's bytes are not covered. These reading and
  digest rules live in `lib/provenanceStatement.ts`. A Metadata statement
  carries `metaVersion` (the file's embedded `_version`) in place of `version`
  and `digest`. `didLogVersionId` is the snapshot head's `versionId`, since
  `proof.created` is not trustworthy. Each statement carries one
  `eddsa-jcs-2022` proof, `proofPurpose` `assertionMethod`, made straight from
  the suite rather than through `jsigs.sign`, which would add a JSON-LD
  `@context` the statement does not carry. The proof has no `created`, and
  Ed25519 is deterministic, so signing the same statement again yields the same
  bytes. That keeps a later write-time signature interchangeable with an
  export-time one. The statements go into the archive's `provenance.jsonl` and
  the snapshot into its `did.jsonl`, both root entries ahead of `space/`, so
  each Resource is read twice, once to digest it and once to pack it. The export
  is not one transaction, so a Resource written between the two reads leaves a
  statement that does not match its archived bytes. One deleted after the
  backend built the entry tree gets no statement, and the export goes on. Import
  verifies both entries (`lib/importProvenance.ts`, below).
- **`src/lib/importProvenance.ts`** -- import provenance, the verifying half.
  The Import Space handler runs it through one call, `prepareImportPlan` in
  `lib/importPlan.ts`, which extracts the archive and builds the plan with
  `importTar.ts` first. It removes every `createdBy` the archive did not earn
  before the plan reaches a backend. A backend's `importSpace` takes the judged
  plan and the verdict counts, and persists what it is handed. The signer is the
  DID the `did.jsonl` snapshot's head names, and the whole snapshot must verify
  offline as that DID's history log (`verifyWebvhLog`). Any server DID whose log
  verifies is accepted. There is no allowlist and no setting, and the importer's
  own `serverDid` gets no special treatment: the log, not the importer,
  establishes who signed. A statement is then judged on its own. Its
  `verificationMethod` must name the snapshot's DID, and that DID must be the
  `server/id` DID of the host the statement's `id` names. The document is
  resolved at the log entry whose `versionId` equals the statement's
  `didLogVersionId`, by verifying the log up to that entry, and must list the
  method under `assertionMethod` alone. Then the `eddsa-jcs-2022` proof is
  verified. Last, the statement's claims are compared with the archived object:
  `createdBy`, `createdAt`, `version` or `metaVersion`, and a Resource's
  `digest` (the composite chunk digest for a chunked Resource). The archived
  object's members and digests are computed by the same
  `lib/provenanceStatement.ts` functions export signs with. Each object the
  archive carries an attestable entry for gets one verdict, whether or not the
  destination already holds it: `verified`, `unattested` (no statement, or no
  `provenance.jsonl`), `proofInvalid`, `contentMismatch`, or `unknownSigner` (no
  `did.jsonl`, a log that does not verify, a method outside the snapshot's DID,
  a version the log lacks, or a method not under `assertionMethod` alone there).
  The counts are the `provenance` member of the returned `ImportStats`. Outside
  `verified` the object is still imported, with its `createdBy` removed. A
  tombstone carries no statement and is not counted, and its sidecar loses
  `createdBy` too, since a re-create over a tombstone keeps the tombstone's
  creator. The Space Metadata object's verdict is counted only, since an import
  never restores its `createdBy`. A `proofInvalid` and a `contentMismatch` are
  logged at `warn` with different messages, so damaged bytes are not read as a
  bad signature. `createdAt` and the version members keep their import behavior
  whatever the verdict.
- **`src/storage.ts`** — supplies `defaultBackend()`, which opens the
  `FileSystemBackend` (rooted at `data/`) that `createApp()` uses when no
  backend is injected. The active backend is injected via
  `createApp({ backend })` and decorated onto the instance as
  `request.server.storage`.
- **`src/backends/filesystemStore.ts`** -- the filesystem backend's storage
  layout version. The data root holds `store.json`, whose integer `version`
  names the layout, beside `spaces/`, `keystores/` and `space-revocations/`.
  `STORE_MIGRATIONS` is an ordered, append-only list of migration functions,
  version `n` being entry `n - 1`, like `MIGRATIONS` in `postgresSchema.ts`. The
  backend's async factory, `FileSystemBackend.open()`, applies pending steps in
  order under a lock and rewrites `store.json` after each one, so every step
  must be idempotent. Each runner creates its own `store.lock.<nonce>` file and
  withdraws if it then sees another live one. A lock file whose heartbeat
  stopped, or whose holder is gone from this host, is ignored and removed. An
  empty data dir is stamped at the current version. A data dir that holds data
  but no `store.json` predates the stamp and is at the baseline layout, so it is
  taken as version 0 and every step runs over it, the baseline step stamping it
  first. Startup is refused when `store.json` names a version newer than the
  code knows. The version is private to the backend: it is not exported, not
  stored in any Space, and not served. The Postgres backend's `applyMigrations`
  refuses the same way, with the same `StoreVersionError`, when its
  `schema_migrations` table records a version newer than `MIGRATIONS` knows.
  `store.json` also carries the store's origin id as its `originId` member (see
  the Glossary's Origin id). `open()` settles it on every boot, under the same
  lock, and it is not a migration step. A store with no id takes `WAS_ORIGIN_ID`
  when set, else a minted one, and writes it before any step runs. A stored id
  is kept, and a set `WAS_ORIGIN_ID` that differs from it refuses startup with
  `StoreOriginIdError`, naming both. Every rewrite of `store.json` keeps the id,
  and any member this code does not know. The Postgres twin is the single row of
  the `store` table (column `origin_id`), settled by `applyMigrations` in the
  same transaction, under its advisory lock. Each backend exposes the id as
  `StorageBackend.originId`, and a data-plane backend adapter carries the
  hosting server's id, handed to it through the `BackendProvider` options. Both
  primary backends are obtained only from a static async `open()` (their
  constructors are protected), which resolves once the migrations have run and
  the id is settled, so a backend in hand is never half-built and the id is a
  plain member with no "not yet" state. The plugin opens the default backend
  itself and, when it owns the backend, wires only `close()`. `start.ts` passes
  the Postgres backend as a function, which the plugin calls at registration
  with the Fastify logger once its other options are validated. The plugin
  refuses a backend with no origin id, after wiring `close()`.
- **`src/backends/{filesystem}.ts`** — interchangeable persistence
  implementation (`implements StorageBackend` from `src/types.ts`). A backend
  offers no precondition primitive of its own to a client: the server serializes
  the write and evaluates `If-Match` / `If-None-Match: *` atomically with it, so
  every backend honors both unconditionally. No write creates a container
  implicitly: only a Space Metadata write creates a Space, and only a Collection
  Metadata write or an import creates a Collection. Every other write re-checks
  that its Space, and its Collection where it names one, has a Metadata object,
  under the lock it holds against Delete Space and Delete Collection (the
  filesystem backend's Space gate, the Postgres `spaces` row). It is refused
  with a 404 otherwise. The request layer's own existence check runs before that
  lock, so a write racing a delete would otherwise recreate the removed
  container. A Space-scoped revocation insert is one of these writes, though its
  records live outside the Space tree. Each backend's `exportSpace` builds the
  archive's entry tree out of its own storage and hands it to
  `packSpaceArchive`; the per-Space archive codec itself -- the file-name
  dialect, the `manifest.yml` document and the packer -- lives in
  `@interop/space-archive`, shared with the wallets that read a backup, and
  `src/lib/importTar.ts` reads the same dialect back. The codec is isomorphic
  and resolves a streamx-based tar-stream `Pack`, which the backend wraps with
  `Readable.from`. The Export Space handler passes this server's Service
  Description to `exportSpace`, which the codec writes into the archive verbatim
  as its `service.json` entry beside `manifest.yml`, so an importer can read
  which specification versions and feature set the contents were written under
  before it writes anything. It is informational, and `importTar.ts` ignores it.
  When the handler has an export attestor (the server has an identity), the
  backend also passes the codec the `provenance.jsonl` statements
  `attestArchiveEntries` builds over its entry tree and the `did.jsonl` log
  snapshot (see `lib/exportProvenance.ts` above); the layout under `space/` does
  not change, so the import walk is the same either way, and
  `lib/importProvenance.ts` judges the two root entries beside it. The archive's
  `.space.<id>.json` entry is the stored Space Metadata object in the filesystem
  backend's on-disk layout, with the server-derived `backends` listing stamped
  on (`archivedSpaceMetadata` in `lib/spaceProjection.ts`, the same module the
  served object is projected in). On the way back in, an import reads that
  object's user-writable members only under an invocation of the Space's root
  capability (decided off the verified result, `verifiedRootInvocation` in
  `zcap.ts`: a dereferenced chain of one link is the synthesized root alone),
  skips them under a delegated chain, and never restores a server-derived member
  or `controller`. `name` is restored when the archive carries one, by the same
  write Update Space Metadata makes; an archive without a `name` leaves the
  destination's in place. `type` is immutable once a Space exists, so it is
  checked rather than applied: an archive naming a different set of types than
  the destination's is refused as `invalid-import` (400) before anything is
  written, and one whose `type` breaks the shape rule Update Space enforces is
  treated as carrying none. An entry that does not parse as a JSON object is
  treated as absent, so the rest of the archive still imports. The outcome is
  the `spaceMetadata` member of the returned `ImportStats`: `'restored'`,
  `'skipped'` (a delegated chain, or a Space with no stored object to apply the
  entry over), or `'absent'` when the archive carried no such entry.
  `test/space-archive-fixture.test.ts` pins this server's entry trees against
  the archive fixture that package checks in.
- **`src/errors.ts`** — custom error classes plus `handleError`, the Fastify
  error handler installed by each route group.
- **`src/exchanges.ts`** — the ephemeral exchanges facet
  (`/workflows/ephemeral/exchanges`), a self-contained sibling of the WAS route
  groups rather than one of them: a transient rendezvous for cross-device flows
  (a desktop page mints an exchange, a phone scans its QR, and posts the answer
  back). It installs none of the auth/digest hooks and is unauthenticated by
  design — it is a **capability URL**, where possession of the unguessable
  exchange URL is the only access control. The relayed `request` and `response`
  are opaque JSON the server never inspects; exchanges live in memory only,
  expire ~10 minutes after creation, are capped in number (429 past the cap),
  and are lost on restart. It holds no wallet data and grants no access to any
  Space.
- **`src/types.ts`** — shared domain types and the Fastify module augmentation
  (`FastifyInstance.serverUrl`, `FastifyInstance.storage`,
  `FastifyRequest.zcap`); reuses `@interop/data-integrity-core` types where they
  fit.

## Glossary

This is the repo's ubiquitous language: one canonical term per concept, used
identically in code, tests, docs, and conversation. An `Avoid:` line lists the
synonyms this repo does not use, so a term that drifts can be challenged in
review. The convention is canonical in isomorphic-lib-template's ARCHITECTURE.md
Glossary section. The protocol terms -- Space, Collection, Resource, controller,
zcap, root capability, invocation target -- are owned by the
[WAS spec](https://github.com/w3c-ccg/wallet-attached-storage-spec)'s
Terminology section; entries below restate one only to say how this server uses
it, and otherwise cover this repo's own concepts.

Containment: **SpacesRepository ⊃ Space ⊃ Collection ⊃ Resource**.

- **SpacesRepository** — the top-level container the server hosts. New Spaces
  are created under it via `POST /spaces/`.
- **Space** — a storage area identified by `spaceId`, canonically addressed with
  a trailing slash (`/space/:spaceId/`): `GET` lists its Collections, `POST`
  adds one, `DELETE` removes the Space. Has a `controller` (a DID) that owns it
  and authorizes access. Its Space Metadata object, at `/space/:spaceId/meta`,
  carries the `controller` and a `type` array subtyping `Space`, set at creation
  and immutable afterward; `PUT` there creates the Space when absent or replaces
  it (`PUT` at the bare Space URL answers 405). A Space typed `AuxiliarySpace`
  (e.g. `['AuxiliarySpace', 'DelegatedClientsSpace', 'Space']`) holds
  bookkeeping rather than user data. A wallet reaches its auxiliary Space
  through the account document's service entry. It counts toward its
  controller's `maxSpacesPerController` quota (`MAX_SPACES_PER_CONTROLLER`),
  since both backends count every stored Space by controller. List Spaces
  therefore lists it like any other Space, so a controller can see what uses its
  quota. Every List Spaces item carries the Space's `type` array, which is how a
  wallet tells an auxiliary Space from a data Space without a Read Space per
  item. Its `url`, and the `Location` of a newly created Space, carry the
  trailing slash. The object splits in two: its user-writable members are `type`
  and `name`, and its server-derived members are `createdBy`, `url`, `linkset`
  and `backends` (the same listing `GET /space/:spaceId/backends` serves,
  carried here so a reader learns it without a second request). A server-derived
  member supplied in a write body is ignored, and an unknown member is not
  stored. A `PUT` of the Space Metadata object on an existing Space replaces its
  user-writable members in full, so an omitted `name` is removed.
  `src/lib/spaceProjection.ts` holds the two projections from the stored record:
  the served object, which Read Space and the two create echoes go through, and
  the export archive's `.space.<id>.json` entry, which keeps the on-disk layout
  and stamps only `backends`; both derive `backends` there, so no path drifts on
  it. The create echoes hand it the listing instead of having it read one: a
  Space that did not exist before the write has no registrations, since
  registering one needs the Space Metadata object to authorize against.
- **`server` Space** -- the auxiliary Space that hosts this server's own
  identity: its `id` Collection holds the `did.jsonl` history log of the
  server's `did:webvh`. Provisioned at startup under the administrator's
  `did:key` (`WAS_ADMIN_DID`) and typed
  `['AuxiliarySpace', 'ServerInstanceSpace', 'Space']`. List Spaces lists it for
  the admin with that `type`. The id is reserved on every client create,
  configured or not, and no client can create a Space under that subtype. The
  name says the Space hosts the server's identity, not that the server controls
  it: the admin is the controller and the only writer, and the server only reads
  the log. Avoid: admin Space (the admin's own data Space, if any, is an
  ordinary Space), server-controlled Space.
- **Server identity** -- the server's `did:webvh`
  (`did:webvh:{scid}:{host}:space:server:id`) together with the export-signing
  key derived from `WAS_SERVER_KEY_SEED`. The key is advertised on `/service` as
  `exportSigningKey`; the DID is advertised there as `serverDid` once the log
  lists the key under `assertionMethod` alone. The key signs an export's
  provenance statements as the method `{serverDid}#{publicKeyMultibase}`, and
  only while the DID is advertised. Distinct from the admin identity, which
  holds the log's update key and authorizes operator actions. Avoid: server DID
  key (ambiguous between the two), server controller.
- **Origin id** -- the store-level id that is the origin half of a write's
  replicated identity, for replicating a Space between servers. One per store (a
  filesystem data dir, a Postgres schema): `WAS_ORIGIN_ID` verbatim when set,
  else a random 16-byte base58 id minted on first boot, kept for the store's
  life (`lib/originId.ts`). It need only be stable and unique among every server
  a Space may replicate to, since nothing verifies it. It is not the server
  identity, which most deployments lack, which embeds the host, and which
  changes when the admin re-mints the log. A cloned data dir carries its id, so
  a clone that runs beside its source boots with a fresh `WAS_ORIGIN_ID` over an
  empty store. Advertised on `/service` as `originId` on the core specs entry.
  Avoid: node id, replica id, server id.
- **Provenance statement** -- one line of an export archive's
  `provenance.jsonl`: a `StorageAttestation` JSON object naming one exported
  object by its absolute URL, its server-managed members, and its content
  digest, signed by the server identity with one `eddsa-jcs-2022` proof. Built
  by `lib/exportProvenance.ts` and judged on import by
  `lib/importProvenance.ts`. It is not a verifiable credential. Avoid: receipt
  (reserved for a future write-time statement returned to the writer), signature
  envelope, VC.
- **Collection** — a named grouping of Resources within a Space, canonically
  addressed with a trailing slash (`/space/:spaceId/:collectionId/`): `GET`
  lists its Resources, `POST` adds one, `DELETE` removes the Collection. Its
  Metadata object, at `/space/:spaceId/:collectionId/meta`, merges what were
  once two separate objects -- the Collection description (`backend`,
  `encryption`, `generator`) and the `/meta` annotation object (`createdAt`,
  `updatedAt`, `custom`, `epoch`) -- into one object under one `ETag`; `PUT`
  there is a full replacement that creates the Collection when absent. Its
  `url`, and the `Location` of a newly created Collection, carry the trailing
  slash.
- **Resource** — an individual stored item, JSON object or binary blob, within a
  Collection (`/space/:spaceId/:collectionId/:resourceId`).
- **Feed position** -- a Resource's place in its Collection's `changes` feed:
  the per-Collection sequence number its latest Resource-level write took
  (`feedPosition` on the filesystem sidecar, `feed_position` in Postgres). Local
  to one server and never replicated. The wire **checkpoint** wraps one in an
  opaque string scoped to the issuing Collection URL and to the feed counter's
  generation, which a re-create of the Collection replaces (see
  `lib/changesCheckpoint.ts`). Avoid: keyset, cursor (the listings' pagination
  token), `updatedAt` as an ordering key.
- **Controller** — the DID that owns a Space; its Ed25519 key signs capability
  invocations and is checked during ZCap verification. Two shapes are accepted:
  a `did:key` (the only one a Space may be _created_ with), or a **self-hosted
  `did:webvh`** a Space may be _updated_ to (see below). Distinct from the
  wallet repos' `clientId`: an enrolled client appears here as a verification
  method inside the controller's document, not as the controller itself.
- **ZCap (Authorization Capability)** — the authorization model. Clients sign
  HTTP requests; the server verifies the signature against the Space
  controller's key rather than using sessions or bearer tokens. Avoid: session,
  bearer token, access token.
- **`invocationTarget`** — the full URL (including host and port) a capability
  authorizes. Must exactly match the server's `serverUrl`-derived URL — see the
  ZCap constraint under Test Suite in [AGENTS.md](AGENTS.md).
- **Root capability** — `urn:zcap:root:<url-encoded target>`, whose controller
  is the Space controller. Synthesized by the document loader in `zcap.ts`. For
  the WAS route family, `target` is the Space's canonical trailing-slash URL
  (`spaceRootTarget` in `requests/spaceContext.ts`), the same URL a delegated
  chain attenuates from.
- **`did:key`** — the default DID method here; keys are Ed25519
  (`Ed25519VerificationKey2020` / `Ed25519Signature2020`). Space creation, and
  the `/kms` keystore routes, accept nothing else.
- **Self-hosted `did:webvh`** — the second accepted Space-controller shape, so a
  wallet can carry one stable user identity whose DID document lists a
  verification method per enrolled client. The DID must be anchored on _this_
  server: `did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>`, whose
  history log is the `did.jsonl` Resource in that Collection of that Space. Any
  Collection may host one, as long as its name round-trips the DID path
  encoding. WAS Collection ids are restricted to the RFC 3986 unreserved
  charset, which is never percent-encoded, so the rule is just that check; a
  final DID segment carrying `%` or another reserved character is refused by the
  parser. A Space is **promoted** to one by PUTting its Space Metadata object
  (at `meta`) with the new `controller`, still authorized by the stored
  `did:key` — creation stays `did:key`-only. Resolution is a **local storage
  read, never a network fetch**: cross-host `did:webvh`, `did:web`, and every
  other method are refused. The log's Space need not be the Space an invocation
  targets: the DID string carries the log's own `spaceId`, so a cross-Space
  controller resolves through the same path as any other. A capability-gated
  Collection works too — the server reads its own storage regardless of read
  policy, so such a DID resolves for authorization while its log stays
  unreadable without a capability. The log is verified, not trusted (SCID
  pinning plus full hash-chain / update-key verification via
  `@interop/did-method-webvh`), because after promotion the writes to that log
  are authorized by the very document being resolved. The proposed controller
  must resolve _before_ it is stored, or the Space would be deadlocked. Key
  validity is the **current-key-set rule** (profile
  ["Current-key-set rule"](https://w3c-ccg.github.io/wallet-attached-storage-spec/authz-profile/#current-key-set-rule)):
  an invocation or delegation verifies iff its verification method is in the
  currently resolved document, under the right verification relationship. One
  piece of code carries that on both sides. `webvhVerifier` finds the invocation
  key by membership in the flat `verificationMethod` array and restates
  `controller: <did>` on the method it reconstructs. That string sends jsigs'
  `ControllerProofPurpose` to dereference the controller document through the
  local webvh resolver driver (`webvhDidResolverDriver` / `dereferenceFragment`)
  and read `capabilityInvocation` out of it. So a root invocation and a
  delegation proof are relation-scoped identically, and a delegation-only method
  cannot root-invoke. Before promotion the Space controller is a `did:key` and
  takes the `did:key` branch of `createGetVerifier`, where no relation applies.
  Resolved documents are cached, keyed by the log's location (Space plus
  Collection), and a write that could change a log at that location drops the
  entry. Entries exist only for DIDs actually resolved for authorization, so a
  `did.jsonl` written into a Collection no reference names drops nothing and
  costs no re-verification. Path-hosting is not endorsement: anyone with a write
  grant on a user's Space can put a resolvable log under that Space's path, and
  it proves only that something wrote it there. A DID is self-certified by its
  own SCID and log, and acquires authority only by being referenced -- as a
  Space's stored controller, or by a capability delegated to it -- never by
  where its log happens to live. The log only grows at this server
  (`src/lib/webvhLogWrite.ts`). A `did.jsonl` in any Collection is written only
  by a fast-forward `PUT`: the stored bytes must be a prefix of the body, else
  412, and the write is pinned to the `ETag` of the log it checked. A `DELETE`
  of one is refused with 405 (`Allow: GET, HEAD, PUT`), before authorization.
  Every prefix of a valid log is a valid log with the same SCID, so without the
  rule a subtree grant could restore a key a later entry retired, or leave the
  controller unresolvable. The resolver also records the head it last verified
  per DID (entry count and head `versionId`) and refuses a log that does not
  extend it. The record is in memory, survives cache invalidation, and is
  dropped only when the log's Collection or Space is deleted, so a restore that
  re-creates the Space can land an older log. So a log goes away only with its
  Collection or Space. Deleting the Collection that holds a controller's log
  leaves every Space that DID controls with no resolvable controller, and there
  is no break-glass. An append must also verify: the whole body is verified as
  the history log of the DID the stored log's head names, and a junk or tampered
  entry is refused as `invalid-request-body` (400) before it is stored. A stored
  `did.jsonl` that names no DID cannot be appended to. A create is not verified.

**Trailing slashes:** a trailing slash marks a container -- a Space or a
Collection -- in its canonical form: `GET` lists its members, `POST` adds one,
`DELETE` removes it, and `PUT` is not defined there. Everything else -- a
container's `meta` sub-resource, a Resource, and every other sub-resource path
-- carries no trailing slash. No two registered paths differ only by a trailing
slash. Routes redirect the non-canonical form to the canonical one with a `308`,
so a signed request must be re-signed for the redirect target rather than replay
its `Authorization` header.

## ZCap Structure

A zcap answers "**who** can do **what**, **with** which resource, **given** what
restrictions": `controller` (who, a DID) / `allowedAction` (what, e.g. HTTP
verbs) / `invocationTarget` (with, a URL) / caveats like `expires` (given). A
delegated zcap also carries `parentCapability` and a `proof` with a
`capabilityChain`; a root zcap carries none of those.

**Root vs delegated invocation** (the `Capability-Invocation` header):

- Root: `zcap id="urn:zcap:root:<url-encoded target>"` — just the id.
- Delegated: `zcap capability="<base64url(gzip(json))>",action="GET"` — the full
  capability and its `proof.capabilityChain`, embedded and compressed.

Both verify through the same path: the `urn` protocol handler in `verifyZcap`
synthesizes the root capability on demand (its controller is the Space
controller). For a bare root invocation that _is_ the capability; for a
delegated invocation it's the terminal `parentCapability` at the base of the
chain, which the verifier walks down to.

The `allowTargetQuery` option of `verifyZcap`, set on the paginated listings and
the other reads that carry a query, bounds the accepted root set only. It adds
the query-bearing request URL's own root capability to that set. It does not
decide which invocation targets are accepted. Every WAS route passes the Space's
root as an accepted ancestor root, so on those routes the request URL, query
included, is always an accepted invocation target, with or without the option.

**The `did:webvh` resolver on every path:** each verification engages the local
`did:webvh` resolver, whatever the scope's own controller is. That covers route
invocations, both halves of a revocation submission (the submitted chain and the
submission's own invocation), create consent, and List Spaces. A delegated link
may be signed by a self-hosted `did:webvh` method on a `did:key` Space, the
unlock-Space shape, so narrowing the resolver to the scope's controller would
leave such a grant live on every route yet unrevocable. The resolver widens
resolution only: it refuses any DID this server does not host, and the chain
still roots in the scope's root capability. A submitted chain may root in the
scope's root capability or in the root of any URL under it, the same roots an
invocation accepts, so a grant delegated from a Collection's or a Resource's own
root is revocable too. List Spaces verifies against one candidate controller at
most: the signer of a root invocation, or the signer of a delegated chain's base
delegation, read off the header before any signature work. A listing grant roots
in the `/spaces/` root capability, which no revocation route accepts, so it
carries no revocation scope and its `expires` bounds it.

**Chain inspection:** after signature verification, the dereferenced chain
passes through two composed inspectors. The revocation inspector
(`lib/revocations.ts`) fails a chain containing any capability with a stored
revocation, with an error named `CapabilityRevokedError`. The annex-chain
inspector (`lib/clientAnnexClause.ts`) bounds what a _ladder_ verification
method may delegate. A ladder VM is the stable, credential-derived method a
wallet publishes on a ladder-anchored account document, recognized by relation
asymmetry: a `capabilityDelegation` member of the resolved self-hosted
`did:webvh` document that is absent from `capabilityInvocation`. A delegation
signed by one is admitted only in one of five shapes.

The first shape is bounded by grantee, target, and action together. Its sole
`controller` equals the client-annex DID named by the account document's
`https://w3id.org/byoe#DelegatedClients` service entry (a self-hosted
`did:webvh` string, compared by pointer equality). Its `invocationTarget` lies
within the items subtree of the Space that carries the delegator's own history
log: the trailing-slash Space URL, or any path under it, except the Space
Metadata URL `/space/<S>/meta` and anything under it. Its `allowedAction` is
present, non-empty, and drawn from the closed WAS verb vocabulary {GET, HEAD,
POST, PUT, DELETE}. The whole vocabulary is admitted rather than a chosen
subset, because the generation delegation a wallet already mints carries exactly
it, and a child capability may not exceed its parent. The target bound does the
narrowing: keystore targets are outside the subtree by path, and the `meta`
exclusion refuses a ladder delegation aimed at the Metadata object directly,
though a whole-subtree grant still covers it by attenuation at invocation time
(see the invocation-time bound below). An onward grant minted by a two-relation
annex verification method is a child of the admitted delegation, so it cannot
exceed that subtree either.

The second shape is bridge-shaped, with two branches. The `invocationTarget` is
the delegator account's own history log resource URL (derived from the account
DID, which carries its log's Space and Collection) with `allowedAction` within
{PUT}. Or it is the trailing-slash URL of a Space whose Metadata object declares
it delegated-clients bookkeeping (typed `AuxiliarySpace` +
`DelegatedClientsSpace`, the only combination Create Space accepts for the
latter) with `allowedAction` within {GET, PUT, POST}. The POST reaches that
Space's export and import endpoints and Create Resource on each Collection
container beneath it, and adds no authority a PUT holder lacked.

The third shape is a target-exact single-verb grant on the Space itself, split
by verb. Its DELETE branch: `invocationTarget` is the canonical trailing-slash
Space URL, equal to the parent capability's own target unchanged -- whether that
parent is a delegated capability or the Space's synthesized root -- and
`allowedAction` is exactly {DELETE}. Its GET branch: `invocationTarget` is the
Space Metadata URL `/space/<S>/meta`, `allowedAction` is exactly {GET}, and the
parent's target is either that same Metadata URL or the Space's canonical
trailing-slash URL. Either branch only narrows toward the one read or delete the
ladder VM may sign and cannot widen it; a two-verb set does not qualify on
either branch.

The fourth shape is a target-exact single-verb read of one Resource. Its
`invocationTarget` is a Resource URL `/space/<S>/<C>/<R>`, three URL-safe
segments with `<C>` and `<R>` outside the reserved path-segment registry, so a
Collection Metadata object, a policy, or a query endpoint does not qualify. Its
`allowedAction` is exactly {GET}, and the parent's target is either that same
Resource URL or the Space's canonical trailing-slash URL; the parent may be a
delegated capability or the Space's synthesized root. This is the shape a
transient wallet session mints to read one record, the keyring record of an
unlock Space, under the management delegation the Space's controller granted the
account at bind time. The server recognizes no unlock Space: the shape holds for
any Space, since the parent already bounds which Space the read can target. By
attenuation the grant also reaches the reads under that Resource URL (its
`/meta`, `/policy`, and chunks), all reads.

The fifth shape is a target-exact single-verb `POST` over a delegated management
capability. Its `invocationTarget` is the canonical trailing-slash Space URL,
equal to the parent capability's own target unchanged, and its `allowedAction`
is exactly {POST}; a two-verb set does not qualify, and neither does any other
verb. The parent must be a delegated capability rather than the Space's
synthesized root, its sole `controller` must be the delegator account itself,
and the controller DID of the parent's own delegation proof must be the Space's
stored controller (one memoized Space Metadata read), so the parent is the
management capability that Space's controller delegated to the account. This is
the shape a transient wallet session mints from the management zcap of a sibling
unlock Space to invoke Export Space on it (the backup export). Like the third
shape's DELETE branch, it widens who signs the last link of a grant the account
already holds rather than what the account may do, and it reaches no Space the
account holds no management capability on. The invocation is not classified by
the invocation-time bounds below: those read `PUT` on a Space Metadata URL and
`DELETE` on a canonical Space URL, and a `POST` at `/space/<S>/export` is
neither.

A `PUT` branch was drafted beside it, for a restore creating a sibling Space by
id, and withdrawn before it landed: a `PUT` child of the Space URL reaches every
resource beneath the Space by prefix attenuation, so a transient session on one
credential could overwrite a sibling credential's keyring record with no logged
record of it. A bounded create-only shape comes back with the restore's sibling
stage (freewallet FW-531). Create Space by Id now verifies a chain with a
`did:webvh` link, but the invocation-time bound below still refuses one that
carries a ladder-signed link.

Under v0.4 the Space Description sat outside the container: a `/space/<S>/`
subtree grant could not reach `PUT /space/<S>` (the controller rewrite) or
`DELETE /space/<S>` at all, since the zcap library's target attenuation is a
`/`-boundary prefix rule. v0.5 moved both operations inside the subtree -- the
controller rewrite is now `PUT /space/<S>/meta`, and Delete Space is
`DELETE /space/<S>/`, the subtree URL itself -- so a subtree grant admitted
under the first shape or the second shape's Space branch now reaches both by
ordinary attenuation. The clause closes that gap with an invocation-time bound,
applied to any chain carrying a ladder-signed link regardless of which shape
admitted it: invoked as `PUT` on a Space Metadata URL, the chain is refused
outright; invoked as `DELETE` on a canonical Space URL, it is refused unless
every ladder-signed link in the chain is itself the third shape's DELETE branch
(target-exact, action exactly `DELETE`). The bound reads the ladder-signed links
rather than the chain's tail, because the tail's shape is not the ladder VM's to
determine: an annex verification method, which holds both relations and so is
not ladder authority, can narrow a whole-subtree grant into a target-exact
DELETE-only child by ordinary attenuation, and a tail-only check would read that
narrowing as the third shape it is not. A genuine third-shape grant still
verifies, and may still be delegated onward, since attenuation can only keep
such a child target-exact and DELETE-only. `handleZcapVerify` threads the
operation's target and action into the inspector through its `invocation`
option, since the zcap library's chain-inspection hook otherwise sees only the
dereferenced chain; the revocation route, whose target is never a Space or Space
Metadata URL, builds the inspector without one and gets the delegation-shape
bound alone.

A second invocation-time bound targets a different signer: the _transient annex
VM_, a per-visit method a wallet publishes in its client-annex document under
`capabilityInvocation` and `capabilityDelegation` and under no other relation.
It is not a ladder VM, so the bound above never sees the links it signs. That
left a path open: a transient VM holding a generation delegation -- the
Space-subtree grant with the full verb vocabulary, signed by an enrolled
client's key, so no ladder link is anywhere in the chain -- could narrow it into
a target-exact DELETE-only child and invoke it, satisfying the container rule's
DELETE exception without tripping the ladder bound. A `DELETE` on a canonical
Space URL is now refused whenever any link in the chain is signed by a transient
annex VM, whoever signed the links above it. The bound reads who signed a link,
not who invokes it: a per-visit key's own delegation never ends an account or
its annex, while a DELETE-only child an enrolled client signs to the annex DID
stays admitted. A wallet's own delete flows sign their DELETE-only children with
the ladder VM and invoke them under a `did:key`, and the annex garbage
collector's re-mint is signed by an enrolled client, so no admitted shape is
lost. A `PUT` on a Space Metadata URL needs no branch of this bound: the
container rule's `controller-only` rule refuses every delegated invocation
there, off the header, before any chain is read.

A transient annex VM is recognized by the shape of the signer's own document
alone: listed under `capabilityInvocation` and `capabilityDelegation`, and
absent from `authentication`, `assertionMethod`, and `keyAgreement`. Nothing
else a wallet publishes has that shape. An enrolled-client method carries all
four signing relations, and a ladder VM is absent from `capabilityInvocation`.
The document is the one the delegation-proof verification just resolved, so the
check costs no further read. Reading nothing but the signer's document keeps the
bound total. It holds for a retired annex generation the account document's
`DelegatedClients` entry no longer names but whose grant is still live, since
the annex garbage collector re-points that entry before it revokes that
generation's grant. It also holds for an annex a `did:key` controller delegated
to directly, where no delegator document exists to walk.

Both inspectors bind the capability decision only. A refusal falls through to
the target's access-control policy like any other failed verification, so a
world-readable read still serves. The clause is fail-open across servers: a
server running unmodified verification accepts exactly what this clause refuses,
so a wallet signs up an account only on a host that claims the client-annex
profile. The wallet checks once, at signup, and does not re-check. A host that
drops the claim later leaves that account's ladder VMs standing. This server
makes that claim with its service description's
`https://w3id.org/pws/client-annex` entry at version `0.1`, which names the
clause as enforced here, with its five admission predicates. A change to what
the clause admits is a new version of that entry.

**The container rule** (`lib/containerRule.ts`): an unsafe method at a container
URL is controller-only, with two exceptions. The hazard is that a data grant's
`invocationTarget` is the container URL itself, and the zcap library's target
attenuation is a `/`-boundary prefix rule, so nothing separates writing a
Resource under a Collection from rewriting or deleting the Collection.
`PUT /space/<S>/meta` on an existing Space and `DELETE /space/<S>/<C>/` accept
nothing else: any delegated invocation is refused there, whatever its
`allowedAction`. Update Keystore (`POST /kms/keystores/<K>`) carries the same
rule. Its body rewrites the keystore's `controller`, so a keystore `write`
grant, or an action-less one, would otherwise hand its holder every key in the
keystore and leave the old controller unable to revoke it. That refusal turns on
nothing but whether the `Capability-Invocation` header embeds a delegated
capability -- a root invocation carries only the capability id, a delegated one
embeds the capability itself -- so `handleZcapVerify` decides it straight off
that header, before signature or chain verification: no chain is dereferenced
and no delegation proof is verified for a request refused this way. The other
two rules below still need the dereferenced chain, since they admit some
delegated shapes and not others; a third chain inspector, composed first because
it resolves nothing, reads the invoked capability -- the chain's tail -- for
those. A chain of length one is the synthesized root alone, so a direct root
invocation always passes. `DELETE /space/<S>/` also accepts a delegated
capability whose tail targets exactly that Space's canonical trailing-slash URL
with `allowedAction` exactly `['DELETE']`; a single-verb DELETE grant is not a
data grant, which is why the exception is keyed on the exact action set.
`PUT /space/<S>/<C>/meta/log` also accepts one whose tail targets exactly the
Space's items subtree, the trailing-slash Space URL a wallet's generation
delegation carries, so a transient session can put a Collection under log
governance or append to its log; the guarded create of that log is the
declaration that starts governing the Collection's `encryption` descriptor and
refuses every direct `encryption` write from then on. A tail aimed at the
Collection container URL, at the log URL, or at a Resource stays refused there.
`PUT /space/<S>/<C>/meta` carries no rule: a tail on the Space subtree, on the
Collection container URL, or on the Metadata URL itself writes the object. An
app holds a Collection-scoped grant, not a Space-subtree one, and declares its
own indexes and `encryption` on that Collection through this write. The prefix
hazard is weak there, since a holder of a Collection data grant already writes
and deletes every Resource in it, the `encryption` descriptor is immutable once
set, and Delete Collection stays controller-only. Create Collection
(`POST /space/<S>/`) is outside the rule. The tail alone is read, so a
DELETE-only child of a two-verb management parent still deletes the Space, and
the rule says nothing about who signed any link: it holds whatever DID method
the controller or a delegator uses. The client-annex clause's two
invocation-time bounds close that gap between them. The ladder bound runs on a
chain carrying a ladder-signed link. The transient-annex bound covers the case
the ladder bound cannot: a generation delegation signed by an enrolled client's
key, carrying no ladder-signed link at all, narrowed downstream into a
DELETE-only child by a transient annex verification method. It refuses any chain
carrying a link signed by that kind of method outright, whatever shape the link
or the links above it have. The two compose rather than overlap. This rule
refuses first on the invoked shape; the clause still refuses a ladder-signed or
transient-annex-signed chain this rule would admit, reading those links instead
of the tail. The clause's `PUT`-on-Space-Metadata branches are now shadowed by
this rule: this rule already refuses any delegated `PUT /space/<S>/meta`
regardless of chain composition, so the clause's own refusal there never decides
anything on its own and is kept only as defense in depth. Its
`DELETE`-on-canonical-Space-URL branches still decide a case this rule does not:
this rule reads only the tail, so a ladder-signed link earlier in the chain that
is not itself target-exact-DELETE-only, later narrowed to that shape by
attenuation, passes this rule but is still refused by the ladder bound. Any
chain carrying a transient-annex-signed link is refused by the transient-annex
bound regardless of the tail's shape. A refusal binds the capability decision
only and surfaces as the ordinary masked `not-found`, since all five handlers
are capability-only.

**Denial reasons:** a refusal is a 404 whose `type` is the merged `not-found`,
with two exceptions named by `type` only, the status unchanged (`denialError` in
`zcap.ts`, on the shared `verifiedOrThrow` path every route family uses).
`capability-revoked` means the revocation inspector failed the chain.
`capability-expired` means the zcap library raised its named expiry error for
the invoked capability or one in its chain. The two are told apart from every
other cause by `err.name`, the cross-package rule, since the verifier hands the
cause back as a bare error or wrapped in a jsigs `VerificationError`. A cause is
named only for a caller signing with the invoked capability's own controller
key. The zcap library performs that controller match itself, but only after the
chain walk, and the walk raises an expired parent link before it gets there. So
`denialError` repeats the match server-side (`invokerIsController`), reading the
signing key id and the embedded capability from the request headers. The request
signature is verified before any of this, and each named cause is raised only
after every delegation proof in the chain verified. A named cause therefore
reaches only the holder of the capability and its invoking key, and tells it
something about its own grant: a revocation it did not see, or an `expires` it
already carries. A copy of a revoked or expired grant invoked with any other
key, a tampered proof, a wrong action, or a chain that never verified all stay
the plain `not-found`. An under-authorized caller still cannot tell an absent
target from one it may not see. The policy fallback in `authorize.ts` is
unchanged. A denial with a named cause still falls through to the target's
access-control policy, and the error surfaces only when the policy does not
grant either.

The plain `not-found` body is byte-identical whether the target is absent or the
caller is under-authorized: same `title`, naming no entity noun, and the same
`detail`, `URL not found or invalid authorization.`. A signing key the server
cannot resolve -- an unresolvable self-hosted `did:webvh`, a keyId absent from
the resolved document, an undecodable `did:key` -- is answered the same way,
since the keyId is the client's own choice and resolving it is part of
authorization, not request parsing. Revocation submission's body-shape and
chain-verification checks, and Create Space's `id-conflict` existence check, now
run only after the invocation verifies, so their 400s cannot be used to probe
whether a scope or a Space id exists.

**Signing:** requests are signed with Cavage HTTP Signatures Draft 12 (not yet
RFC 9421). The `Authorization` header signs
`(key-id) (created) (expires) (request-target) host capability-invocation`, plus
`content-type digest` when there's a body. The `Digest` header is a multihash
(`mh=`, sha256). See the
[zCap Developer Guide](https://github.com/interop-alliance/zcap-developer-guide).

A delegated capability's own `proof` is a separate signature, on the document
rather than on the request. Clients sign it with `eddsa-jcs-2022`, which
canonicalizes with JCS and so needs no JSON-LD document loader at signing time.
The server accepts `Ed25519Signature2020` there as well, at all three sites that
verify a delegation proof -- the invocation path, the revocation chain check,
and the revocation's own invocation -- because clients upgrade on their own
schedule and grants a wallet recorded before the switch are submitted back for
revocation under the old suite. The two suites are told apart by `proof.type`
and `proof.cryptosuite`, so the links of one chain may mix them. The service
description's `zcapCryptosuites` lists Data Integrity cryptosuite names only, so
it names `eddsa-jcs-2022` alone. The legacy proof type is still accepted but not
advertised.
