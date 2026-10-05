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
  phrase `Method Not Allowed`, as RFC 9457 asks of an `about:blank` problem).
  Every URL a group registers, the `/kms` group's included, answers the same 405
  for each method it does not implement -- a `DELETE` of either Metadata URL, a
  `GET` of `export`, a `PATCH` of a Space, a Collection or a Resource, at either
  slash form, a `DELETE` of a keystore. Each group records its route URLs with
  an `onRoute` hook (`collectRouteUrls`) and ends with
  `refuseUnimplementedMethods`, which reads the implemented set at each from the
  router (`hasRoute`) and registers a refusal for every other method Fastify
  routes. Neither the URLs nor the `Allow` header can drift from the routes, and
  the only hand-written input is the `PUT`/`DELETE` hints and the two anchors a
  Space does not serve, the cross-collection `/space/:spaceId/query` and the
  Collection-level shape `/space/:spaceId/meta/log`, which answer 405 with an
  empty `Allow`. The call must stay last in its group. `OPTIONS` is left to the
  CORS preflight, and `HEAD` follows `GET`. A bare container form's `Allow`
  names the methods it redirects for. The refusal reads no ids, so it answers
  the same whether or not the Space, Collection, or Resource exists. Without it
  such a request fell through to the parametric route one level up and was
  refused as a 409 `reserved-id`, an answer about ids to a request about a
  method. A path beneath a Space-level or Collection-level reserved segment that
  no route serves is not found (404), as an unmatched URL is.
  `refusePathsBeneath` registers a wildcard route, `<segment>/*`, for each id in
  the reserved-id registry (`lib/validateId.ts`), and anchors the bare segment
  too when no route serves it (`zcaps`), so it is not read as a Collection's
  bare form. The route is marked `noAuth` and answers from a route-level
  `onRequest` hook through `reply.callNotFound()`, so it reads no ids and parses
  no body. Static and parametric routes beat a wildcard, so the endpoints
  beneath a segment (`backends/:backendId`, `meta/log`,
  `zcaps/revocations/:revocationId`) keep answering, their 405 refusals
  included. A refusal and a slash redirect answer the same whatever the caller's
  identity, so both carry the `noAuth` route config and the group's auth-header,
  `parseAuthHeaders` and digest hooks skip them. An anonymous `PUT` of a
  container URL is therefore a 405, not a 401, and a refusal is thrown from a
  route-level `onRequest` hook, ahead of body parsing. The provisioning gate,
  the error handler, the `no-store` marking and the hosted-page sandbox still
  run on them. The no-slash form of a container URL redirects to the slash form
  with a 308 for every container method (spec-defined; see the Glossary's
  Trailing slashes note), so a signed request must be re-signed for the redirect
  target rather than replay its `Authorization` header. The slash form of a
  Resource or chunk URL redirects to the no-slash form the same way, for every
  method the canonical form implements, and refuses `POST` with the canonical
  form's `Allow`. The retired `/space/:spaceId/collections/` endpoint 308s to
  the Space URL, which lists and creates Collections since v0.5; `collections`
  and `meta` stay reserved Collection ids.
- **`src/requests/*Request.ts`** — request handlers as static class methods
  (`SpaceRequest.post`, etc.). Each handler follows the same shape: fetch the
  Space/Collection for context, call `handleZcapVerify(...)`, then call a
  storage method. Handlers read both `serverUrl` and `storage` from
  `request.server` (the `FastifyInstance` decorated in `server.ts`), not via a
  `this` binding.

  A write answers from what the backend returns, not from a read made after it.
  `writeResource` and `writeResourceMetadata` return the validator beside the
  server-managed members as the write left them. `writeResourceMetadata` also
  returns the content record's validator, for the `/meta` `ETag` (below). The
  filesystem backend reads them under the per-Resource lock, and Postgres takes
  them from the writing statement's `RETURNING`. Create or Update Resource
  (`PUT /space/:s/:c/:id`) answers `201` when the write created the Resource, a
  write over a tombstone included, and `200` when it updated a live one. A
  write-once repeat updates nothing, but the Resource is live, so it answers
  `200` with the stored members. Update Resource Metadata (`PUT .../:id/meta`)
  answers `200` and never creates. A `/meta` write to an absent Resource is
  a 404. Both keep the `ETag` header and send a JSON body that holds only
  server-managed members: `contentType`, `size`, and the content record's write
  stamp (`updatedAt`, `updatedAtCounter`, `originId`). A `201` adds `createdAt`
  and `createdBy`, so a writer learns no provenance it did not record. A `/meta`
  write adds the nested `meta` stamp and generation. The body never carries
  `custom`, `epoch`, or `writerId`. A Resource created over a tombstone records
  fresh provenance: this write's invoker as `createdBy` and its stamp's time as
  `createdAt`. The tombstone's values stay with the deleted Resource. Create
  Resource (`POST`), a chunk `PUT`, Delete Resource, and the governing log `PUT`
  keep their answers. The `did.jsonl` write shares the Resource `PUT` handler
  and answers the same way.

  Container writes follow the same rule. `writeSpace` and `writeCollection`
  return the validator, whether the write created the container, and the stored
  object as the write stamped it. Create Space, Create Collection, and the
  create-by-`PUT` of a container's `meta` send that object through the read
  projection, and choose `201` or `204` from the backend's answer. The handler's
  own read happens before the lock. Two unconditional `PUT`s of one new
  Collection's `meta` can both see it absent, but only the first write creates
  it, and the second answers `204`. Update Space pins its write to its pre-read
  (`assertTransition`), and Create Space is a guarded create, so their create
  decision already matched the backend's.

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
  Resource's `/meta` object, a Collection's governing history log, an
  access-control policy at each of its three levels, and each container's
  Metadata object (the Space Metadata object, the Collection Metadata object)
  carries a generation and the write stamp of its last write (`lib/hlc.ts`,
  below). `formatEtag` emits the two together as one strong `ETag` on GET/HEAD,
  `"<generation>.<ms>.<counter>.<originId>"`, where `ms` is the stamp's
  `updatedAt` in epoch milliseconds. A container's Metadata object appends a
  fifth segment, its local segment:
  `"<generation>.<ms>.<counter>.<originId>.<local>"`. Every write mints a new
  stamp, so the validator moves with every write. One validator covers a
  container's whole Metadata object. v0.5 merged what used to be a separate
  Collection description and its `/meta` annotation object into one
  `CollectionMetadata` record, so a configuration write (`backend`,
  `encryption`, `generator`) and an annotation write (`custom`, `epoch`) each
  mint the object's stamp. Some changes move a Metadata object's served
  representation without a write of the object. A backend registered or
  deregistered on a Space changes the Space Metadata object's served `backends`
  member. A governed-log write changes the Collection Metadata object's derived
  `encryption` member. A strong validator must move with the representation, so
  each of these advances the object's local segment and keeps its generation and
  stamp, under the same lock as a Metadata write. A stamp would replicate as a
  write of the object, while the local segment is this server's own. The next
  stamped write resets it to 0. The terms "Space Description" and "Collection
  Description" are retired. Storage exposes one validator per container through
  `writeSpace` / `getSpaceMetadata` and `writeCollection` /
  `getCollectionMetadata`, as the out-of-band `metaGeneration` / `metaLocal`
  beside the stamp members of the body. There is no separate
  `writeCollectionMetadata` / `getCollectionMetadata` pair. The generation is a
  random base58 marker minted at the record's first write and kept for the
  record's life. A Resource's content record continues through a tombstone and
  its re-create, so its generation does too. The Resource's `/meta` object is a
  record of its own, with its own stamp and generation. A `/meta` write mints a
  stamp on that record only. The content record's stamp and `ETag` do not
  change, so the Resource's top-level `updatedAt` is the time of its last
  content write. The filesystem sidecar nests both under its `meta` member, and
  Postgres keeps them in `meta_` columns. The `/meta` body serves members of
  both records, so its `ETag` covers both (`resourceMetaEtag`). It is the
  content record's four segments, the Resource's own `ETag` value, followed by
  the `/meta` record's four once metadata has been written:
  `"<generation>.<ms>.<counter>.<originId>.<generation>.<ms>.<counter>.<originId>"`.
  So it moves with every content write and every `/meta` write, and exists from
  the Resource's first write. A `/meta` `If-Match` is evaluated against this
  composite, in both backends. `If-None-Match: *` on a `/meta` write passes only
  while no `/meta` record exists. The changes feed's `metaEtag` is the same
  composite. A soft delete drops that record together with `custom`, so a
  re-create's first metadata write starts a fresh generation and a `/meta`
  `ETag` held from before the delete cannot pass `If-Match` against it. A hard
  delete (a chunk, a Space) removes the record, so the next record under the
  same id mints a new generation and its validators never coincide with the old
  record's; a client's stale cached `ETag` then matches nothing instead of being
  answered 304 over different bytes. Delete Collection leaves a tombstone (see
  the Glossary's Collection tombstone), which keeps the generation and takes the
  delete's stamp. A create over the tombstone mints a new generation, with the
  same effect on held validators. A client treats the whole quoted value as
  opaque, and `If-Match` and `If-None-Match` compare the whole string. Writes
  are gated by `If-Match` / `If-None-Match: *`, which `parseWritePreconditions`
  normalizes and the backends evaluate atomically with the write through
  `preconditions.ts`. The Space and Collection Metadata objects take both: the
  `If-None-Match: *` guarded create is what resolves two clients provisioning
  the same Space or Collection at once (the loser's replace-semantics `PUT`
  would otherwise rewrite the winner's `type` array or `backend`), and it
  refuses whenever the container already has a Metadata object, `ETag` or not.
  Update Space (`PUT /space/:spaceId/meta`) chooses its authorization from an
  unlocked read, so its write passes `writeSpace` an `assertTransition` hook
  that pins it to that read: the Space must still be absent on a create, and
  carry the same validator on an update. On a mismatch the handler re-reads and
  re-authorizes on the branch the fresh read selects. A create that lost a race
  is then authorized as an update against the winner's controller. After three
  attempts it answers 503 with `Retry-After`. The client's own preconditions go
  to the backend as sent, so a 412 answers only a header the client sent. The
  generation and local segment are embedded in the stored record as reserved
  `_generation` / `_local` members -- the filesystem backend keeps one file per
  container (`.space.<id>.json`, `.collection.<id>.json`) holding the wire body
  and the two together -- and as `meta_generation` / `meta_local` columns on the
  Postgres `spaces` and `collections` rows, kept out of the wire body. The stamp
  members are wire members and are stored in the body. An export archive's
  Metadata entry carries `_generation` alone, since the local segment does not
  leave this server. The `ETag` is emitted on Read Space / Read Collection and
  on the Create/Update responses. A Space Metadata write is serialized per Space
  (the `spacemeta:` lock in the filesystem backend, an advisory lock plus row
  lock in Postgres) and a Collection Metadata write per Collection (the `cmeta:`
  lock), so the check and the stamp are atomic. Reads are conditional the other
  way round: a GET/HEAD carrying `If-None-Match` is parsed by `parseIfNoneMatch`
  into the set of validators the client holds (RFC 9110 weak comparison, list
  and `*` forms), and a handler answers 304 Not Modified with the `ETag` and no
  body when that set covers the current one (`isNotModified`, sent by the shared
  `requests/notModified.ts` helper). The decision sits in each read handler,
  after authorization, so an under-authorized conditional read still gets the
  404 mask. A Resource or chunk GET consults the stored metadata first when the
  header is present and opens the byte stream only on a miss. A representation
  with no validator (a Resource whose sidecar is missing, and so its `/meta`
  object) is matched only by `*`, which RFC 9110 makes true for any current
  representation; its 304 then carries no `ETag`, as its 200 would not. A
  Collection Metadata read takes the object before the governing log, not beside
  it. A log append advances the object's local segment, so a read in the other
  order could serve the new `ETag` over the old descriptors, and a 304 would
  then keep them. In this order the worst case is the old `ETag` over the new
  descriptors, which the next revalidation replaces. Responses to non-idempotent
  POSTs are marked `Cache-Control: no-store` by an `onSend` hook in `routes.ts`;
  a slash-variant redirect and a POST route registered with `config.safe` (Query
  and Export, reads that use POST to carry a body) stay cacheable. The spec
  defers further `Cache-Control` semantics. The Metadata-object pieces (the
  five-segment `ETag` and the reserved `_generation` / `_local` file members)
  live in `src/lib/metadataValidator.ts`.
- **`src/lib/hlc.ts`** -- the write stamp. Each storage backend holds one hybrid
  logical clock for its store, and a versioned write mints its stamp with it
  inside the write's critical section. The stamp is the clock reading plus the
  store's origin id, carried as `updatedAt` (the ISO string of the reading's
  milliseconds), `updatedAtCounter`, and `originId`. Stamps are ordered by
  `(ms, counter, originId)`, the first two numerically and the origin id by
  plain string comparison. The clock reading never runs below the largest
  physical time or stamp the clock has seen. Within one millisecond the counter
  ticks, and it restarts at 0 when the millisecond advances. A write over a
  stored record first raises the clock to that record's stamp, so the mint is
  `max(now, held stamp + one counter tick)`. The new stamp therefore sorts above
  the one it replaces, even when physical time stepped back or the process
  restarted. The physical clock is injectable (a `physicalClock` option), so a
  test can freeze or step it. The clock persists a high-water mark of its
  physical part at most about once a second: `clockHighWater` in the filesystem
  `store.json`, `store.clock_high_water` in Postgres. A backend's `close()`
  persists it once more, so a clean restart starts above every stamp minted
  before it. At boot the clock starts one millisecond past that mark. The mark
  can trail the last stamp minted before a crash by up to about a second, so it
  is the held-stamp rule that keeps an overwrite above the stamp it replaces. A
  failed write of the mark is logged at `warn` and retried at the next mint. It
  does not fail the write that minted. The clock also has a receive rule for a
  stamp from a peer, which refuses one dated more than the clock bound ahead of
  physical time (`WAS_REPLICATION_CLOCK_BOUND_MS`, default 60000 ms). No request
  route receives a peer's stamp. A peer's stamp enters a store through the apply
  path alone (`lib/replicaApply.ts`, below), which takes each one in by that
  receive rule. Every other stamp comes from the store's own clock: an import
  re-stamps every record it writes. One server process per store is an
  assumption the stamps rest on. Two processes over one store would share its
  origin id and could mint the same stamp for two different writes, which would
  give different bytes one strong validator. The read caches below rest on the
  same assumption.
- **`src/lib/changesCheckpoint.ts`** -- the `changes` query profile's wire
  checkpoint. The feed is ordered by a per-Collection feed position, a positive
  integer sequence. Every Resource-level write takes the next one: a content
  write, a metadata write, a soft delete, and a Resource written by an import.
  It does so whatever the Resource's content type. A Collection Metadata write
  takes one too, the create included, and so does a governed-log write (the
  guarded create and each append). A log write takes no position for the
  Metadata object, whose local segment it advances. A byte-identical log write
  takes none. A Collection's own policy and each Resource policy take one with
  every write and every delete, which leaves a tombstone. A Space policy takes
  none, since it is in no Collection. A chunk write takes none, so it never
  moves its parent. The feed holds one document per record, at the position of
  its latest write, and each document carries a `kind`. A `resource` document is
  a Resource or its tombstone, with its `contentType`, and its body inline as
  `data` when it is a live JSON Resource. A `collection-metadata` document is
  the Collection Metadata object, a `log` document its governing history log,
  and a `policy` document the Collection's own policy or a Resource's. None of
  the three has an id of its own, so its `id` is the record's absolute URL
  (`.../meta`, `.../meta/log`, `.../policy`), and it carries no body. Every
  document carries the record's write stamp, its `generation`, and its `etag`,
  so a puller can decide whether to apply a change from the feed alone. A
  `resource` document also carries the `/meta` record's stamp and generation
  under `meta`, once metadata was written. A `/meta` write moves the document to
  a new position with a new `meta` stamp, and its top-level stamp and `etag`
  stay the content record's. A tombstone is marked `deleted: true`. A consumer
  skips a `kind` it does not know. A Collection's own tombstone is not in the
  feed, since the feed goes with the Collection. The position is assigned inside
  the per-Collection critical section that makes the write visible, so no write
  lands at or before a position a reader was already handed. The write stamp
  each feed document carries orders two revisions of one Resource, not the feed.
  `updatedAt` alone has no ordering role, since two writes can share a
  millisecond. The filesystem backend keeps the counter in
  `.feed.<collectionId>.json` in the Collection dir and stamps the position on
  the sidecar as `feedPosition`, under a `feed:` key nested inside the
  per-Resource lock. The counter file is `{ generation, position, records }`.
  Its `records` map holds the latest position of the Collection Metadata object
  (key `collection-metadata`) and of the log (key `log`), each absent until that
  record took one. A Collection's own policy and each Resource policy carry
  their position in the policy file, as a reserved `_feedPosition` member
  written last, beside `_generation`, in the same `feed:` section after the
  counter advances. A Space policy takes none. The counter file's size does not
  depend on how many policies the Collection holds. Postgres keeps a policy's
  position in `policies.feed_position`. `changesSince` reads the counter under
  that key and admits only positions at or below it. A caught-up poll reads the
  counter file alone. Any other poll lists the Collection dir and reads every
  policy file in it outside the key, admitting the positions past the reader's.
  A policy file that does not parse is logged at `warn` and left out. The
  Postgres backend increments `collections.feed_position` with
  `UPDATE ... RETURNING`, whose row lock is held to commit, so positions are
  commit-ordered, and stamps `resources.feed_position` in the same transaction.
  A position is one server's fact about its own feed: export strips it and
  import assigns fresh ones. An imported Resource with no archived metadata gets
  fresh metadata, so it takes a position too. The counter has a generation,
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
  policies the policy fallback reads. It reads through `getPolicy`, which
  answers a deleted policy's tombstone as no policy, so a tombstone is cached as
  an absence and grants nothing. Both expire entries after 10 s
  (`SPACE_METADATA_CACHE_TTL`, `POLICY_CACHE_TTL` in `config.default.ts`). A
  write drops the affected entries, but only in the process that made the write.
  The TTLs therefore rest on a single-instance deployment. When several
  instances share one storage backend, a controller retired by an Update Space
  on one instance keeps its authority on another for up to one TTL. A changed or
  deleted policy likewise keeps granting there for up to one TTL. The write
  stamps rest on the same single-instance deployment (see `lib/hlc.ts`).
- **`src/lib/governedDescriptorsCache.ts`** -- a third read cache, one per
  storage backend, memoizing the `encryption` and `revisions` descriptors
  derived from a log-governed Collection's history log. The parse is what it
  saves, since the log is append-only and grows. The log body is still read on
  each request. An entry is keyed by Collection and by the log's own
  four-segment `ETag`, so a log write leaves the old key behind and the next
  derivation misses on a new one. It therefore carries none of the
  multi-instance staleness the two caches above carry. Delete Collection, Delete
  Space, and Import Space still drop entries by prefix. Entries expire after 600
  s and are capped at 1000 (`GOVERNED_DESCRIPTORS_CACHE_TTL`,
  `GOVERNED_DESCRIPTORS_CACHE_MAX`).
- **`src/lib/governedLog.ts`** -- the `governed-history-logs` feature: a
  Collection's governing history log, served at its own sub-resource
  (`GET`/`PUT /space/:spaceId/:collectionId/meta/log`,
  `CollectionRequest.getLog` / `putLog`). The log is not a Resource: it is
  absent from listings, exempt from the encrypted-Collection envelope rule, and
  left untouched by a `PUT /meta`. The changes feed carries it as its own `log`
  document, apart from the Resources. It is served as `text/jsonl` with its own
  `ETag`, from its generation and write stamp, so a conditional `GET` behaves
  like any other record; a `PUT` is either a guarded create (`If-None-Match: *`)
  or a compare-and-swap append (`If-Match` carrying the prior bytes verbatim
  plus one new line), 412 on a lost race. `GET` is capability-or-policy at the
  Collection's target; `PUT` is capability-only, like `/meta`, and carries the
  same container rule as `/meta` (see below): a direct root invocation, or a
  delegated capability whose tail targets exactly the Space's canonical
  trailing-slash URL. The guarded create is the declaration that puts the
  Collection under log governance, and is refused with `encryption-immutable`
  (409) on a Collection whose Metadata object already carries a client-written
  `encryption` member, or a `plaintext` member. The derived `encryption` and a
  stored `plaintext` would exclude each other on every later Metadata write, and
  `plaintext` has no removal path. From then on, the Collection's served
  `encryption` member -- read by Get Collection and by every handler that loads
  the Collection Metadata object through `getCollectionOrThrow`, so the
  write-time envelope check sees it too -- is derived from the log's last line's
  `state`, with a `history: { method, resource }` member always stamped on
  (`method` from the genesis line's `parameters.method`, `resource` the log's
  own URL); the stored Collection Metadata object never carries that derived
  member, a direct `encryption` write against it is refused with
  `encryption-history-log-governed` (409), and its other fields still update
  normally. The `state` has one reserved slot, `revisions`. It is taken out of
  the derived `encryption` member and served as the Collection's `revisions`
  member instead, replacing any stored one. A direct `revisions` write on a
  governed Collection is checked against the derived descriptor and is not
  stored. A body `merge` that differs from the derived one is refused with
  `revisions-immutable` (409, pointer `#/revisions/merge`). Omitting `merge` or
  restating the derived one passes. The stored `revisions` member is carried
  forward untouched by such a write. The guarded create may move a member off
  its default, but may not change one the stored object sets to another value
  (`revisions-immutable`, 409). The derivation is memoized per backend by the
  log's validator (`lib/governedDescriptorsCache.ts`, above). Update
  Collection's recheck under the lock derives from the log the backend hands its
  `assertTransition` callback, so a Metadata write parses the log at most once.
  The server verifies neither proofs nor a hash chain. It checks that the body
  is JSON Lines, each line a JSON object with an object `state` member and the
  last line the head. It also checks that the genesis line's `parameters`
  carries a string `method`, and that no line's `state` carries a `history`
  member, since the server stamps that member itself. A break of any of these is
  `invalid-request-body` (400). It also checks that an append fast-forwards the
  stored log (the stored bytes verbatim followed by exactly one new line; a body
  the stored log is not a prefix of is `precondition-failed`, 412, with or
  without `If-Match`, and one adding more than one line is
  `invalid-request-body`, 400). A body equal to the stored log byte for byte is
  a no-op. Once its preconditions pass, it answers 204 with the current `ETag`
  and writes nothing, so neither the log's `ETag` nor the Collection Metadata
  object's moves. A body that is a strict prefix of the stored log would erase
  lines and stays a 412. On every append the server runs the same `encryption`
  and `revisions` transition checks against the prior head that an ordinary
  Collection Metadata update runs, and checks the shape of the head's
  `revisions` slot. The fast-forward rule keeps the log append-only at the
  server: a write capability can add history but not erase it, while a break
  inside an appended entry stays the verifying reader's to detect. A log write
  mints the log's own stamp. It also advances the Collection Metadata object's
  local segment, since the object's served content changed, and leaves that
  object's stamp untouched, `updatedAt` included. It is serialized with
  Collection Metadata writes through the same per-Collection lock.
- **`src/lib/policyRecord.ts`** -- access-control policies as versioned records,
  at all three levels. A stored policy carries the write stamp of its last write
  and a generation. Get Policy serves the stamp members (`updatedAt`,
  `updatedAtCounter`, `originId`) beside the body and the four-segment `ETag`,
  and answers a conditional read 304. The generation is in the `ETag` only. A
  `PUT` body's stamp members, `deleted` and `_generation` are not stored. `PUT`
  and `DELETE` take `If-Match` / `If-None-Match: *`, evaluated by the backend
  against the live policy under the write's lock (the filesystem `policy:` key,
  the Postgres Space row). `PUT` answers 201 or 204 from what the backend
  reports. Delete Policy leaves a tombstone, `deleted: true` plus the delete's
  stamp, with the generation kept and no `type`, and answers 204 with its
  `ETag`. A delete of an absent or already deleted policy writes nothing and
  answers 204 with no `ETag`. A tombstone reads as absent everywhere:
  `getPolicy` answers it as no policy, so the policy fallback, the policy cache,
  the listing's `public` flag and the linkset never see it. Only
  `getPolicyRecord` returns it, for Get Policy under `?include=deleted`
  (capability-only, like every policy read), which answers it 200 with its
  `ETag`, and for the changes feed. A plain Get Policy answers it with the same
  404 as no policy. A `PUT` over a tombstone is a create: 201, a new generation,
  and a stamp above the tombstone's. The filesystem backend stores a policy file
  as the served body with `_generation` embedded, and for a Collection or
  Resource policy the server-local `_feedPosition` as well. A `PUT` body's
  `_feedPosition` is not stored, and no read of a policy carries it, `getPolicy`
  and the policy cache included. Postgres keeps the body in `policies.policy`
  (NULL on a tombstone) and the stamp, generation and `deleted` mark in columns.
  Export carries live policies only, as stored, with `_generation` but without
  `_feedPosition`. Import drops an archived `_feedPosition` and assigns a fresh
  position. It keeps the archived generation, re-stamps with the importing
  store's clock, and skips a level where the destination holds any policy
  record, a tombstone included, so an import does not undo a delete. An archived
  tombstone refuses the import as `invalid-import` (400). Delete Collection and
  Delete Space still remove their policies outright. Delete Resource leaves the
  Resource's policy in place.
- **`src/lib/revisions.ts`** -- the Collection `revisions` descriptor:
  `resolution` (a closed set, `last-writer-wins` only, which is also the
  default), `immutable` (a boolean, default `false`), and `merge` (an object the
  server stores and serves verbatim and does not read). It holds the shape
  check, which refuses an unknown `resolution` (the reserved `keep-conflicts`
  included), a wrong member type, and an unknown member as
  `invalid-request-body` (400). It holds the transition check: `resolution` and
  `immutable` are declared by the write that creates the Collection (a Create
  Collection `POST`, a create by `PUT .../meta`, or a governing log's guarded
  create) and are immutable afterward. An absent member stands for its default,
  and members are compared by the value they stand for. Restating a default, or
  dropping an explicit default, passes. Setting `immutable: true` on an existing
  Collection, or dropping or changing a set `immutable: true`, is refused with
  `revisions-immutable` (409). So a full replacement that omits a set
  `immutable: true` is refused, as one that omits a set `encryption` is. A
  governing log's guarded create may move a member off its default, but may not
  change one set to another value. `merge` follows the body. The module also
  holds the split of a governing log's `state` into its `encryption` and
  `revisions` parts, and the write-once rule.

  The write-once rule is decided in two ways. A handler that read the Collection
  as write-once passes `immutable: true` to the backend. Otherwise it passes a
  recheck callback as `immutable` (built by `writeOnceOptions` in
  `requests/collectionContext.ts`). Over a live Resource or chunk, the backend
  calls it inside the write's critical section with the governing history log it
  reads there. A log's guarded create is the one write that can declare
  `immutable` on an existing Collection. In the filesystem backend, a log write
  that may create the log runs on the exclusive side of the Space gate, so it
  cannot land between a write's log read and its bytes. An append stays on the
  shared side. In the Postgres backend, the recheck reads the log under the
  `collections` row lock a log write takes.

  Inside the critical section, after its preconditions pass, the backend
  compares a write over a live Resource or chunk with the stored representation.
  The media type is compared without its parameters and case-insensitively, so a
  retry that adds `; charset=utf-8` is still a repeat. Bytes are compared
  exactly, a JSON body as the `JSON.stringify` serialization both backends
  store, so a different key order is a different body. The filesystem backend
  compares the stored size first, then JSON bytes directly or a SHA-256 of a
  binary body read through the upload cap. An over-cap body answers
  `payload-too-large` (413), as a write would. A repeat is a no-op answering the
  stored `ETag`, with no new stamp and no feed position. A byte-identical repeat
  over a live Resource or chunk whose sidecar is missing or carries no validator
  (a write torn between its bytes and its sidecar) stamps the sidecar and
  answers the new `ETag`. Any other write is refused with `resource-immutable`
  (409). Both backends decide the rule before the unique-claim scans (blinded
  `unique` attributes and `unique` plaintext indexes). A write the rule answers
  runs no Collection scan, and a changed body that also collides answers
  `resource-immutable`. A tombstone keeps no bytes, so a write over one is an
  ordinary create. Delete, Resource `/meta` writes, and imports are not
  restricted. An import is skip-not-overwrite, so it never changes a stored
  Resource, and an archived body that differs from a stored one is skipped
  rather than refused. The rule holds on plaintext and encrypted Collections
  alike, and on a `did.jsonl`, whose append is an update.

  Import checks the descriptor too. The plan builder (`lib/importTar.ts`) runs
  the shape check on an archived Collection Metadata object's `revisions`
  member. When the archive also carries the Collection's governing log, it
  requires the log head's `revisions` slot to keep what the archived object sets
  (the guarded-create check). A break of either refuses the import as
  `invalid-import` (400).

- **`src/serviceDescription.ts`** -- the service description (spec "Service
  Description"): `GET /service`, unauthenticated, serving the JSON document that
  lists five entries in its `specs`. The core entry, under the
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
  write stamp used here. The entry under `https://w3id.org/pws/authz-profile`
  names the zCap authorization profile version (`0.1`) and its rendered
  location, and carries the accepted `signatureAlgorithms` and
  `zcapCryptosuites` (profile
  ["Service Description Entry"](https://w3c-ccg.github.io/wallet-attached-storage-spec/authz-profile/#service-description-entry)).
  The document's `instance` member, the operator's disclosure of the deployed
  software, also carries the instance's identity when the server has one
  (`lib/serverIdentity.ts`, below): `exportSigningKey`, the `did:key` of the key
  the server will sign export archives with, present whenever
  `WAS_SERVER_KEY_SEED` is set; and `serverDid`, the server's own self-hosted
  `did:webvh`, present only once the resolved current document of the log at
  `server/id/did.jsonl` lists that key under `assertionMethod`, and under
  `capabilityInvocation` at most. They sit on `instance` rather than on a
  `specs` entry because they describe this deployment, not a specification it
  implements. `serverDid` is read per request, since the admin writes that log
  after boot, and the served body and its `ETag` are recomputed when it changes.
  The outcome is memoized per backend on the log Resource's `ETag`, so a request
  costs one metadata read while the log stands still. Listing the profile is how
  a client learns this server authorizes with capability invocations, before its
  first signed request. The last two members are read off `zcap.ts`
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
  conformance claim with nothing further to advertise. The fifth entry, under
  `https://w3id.org/pws/replication`, is the replication specification (version
  `0.1`). Listing it is this server's claim that it serves the `replicas`
  registration sub-resource, the pull loop and the apply path. A registration
  reads the peer's entry and refuses a peer that lists none at this version. It
  carries `version` alone too. A client ignores a member it does not know, and
  treats an entry whose `version` it does not speak, or whose `url` is not a
  string, as absent. The document is built per `serverUrl` and served with
  `Cache-Control: public` and a content-hash `ETag`. The module also installs
  the one hook every response passes through: a root-level `onSend` hook
  (`addServiceLinkHook`, added by the plugin) that appends
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
  `WAS_SERVER_KEY_SEED`, and that seed is its only secret; the administrator's
  `did:key` (`WAS_ADMIN_DID`) holds the update key of the server's `did:webvh`
  history log, so the server never mints or extends its own log and a
  compromised server cannot take the DID over. The DID is the self-hosted
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
  resolves it, and requires the signing key to be listed under
  `assertionMethod`. It reads every method that carries the key and any method
  embedded in a relationship. The key may also be listed under
  `capabilityInvocation`, which is how the admin enables replication. It may not
  be listed under `capabilityDelegation`, `authentication` or `keyAgreement`. A
  key under `capabilityDelegation` without `capabilityInvocation` would read as
  a ladder verification method to the client-annex clause. One predicate,
  `signingKeyRelationshipProblem`, decides this for `/service`, the export
  snapshot check and the import statement check. A log that is absent, does not
  verify, or lists the key otherwise leaves `serverDid` off `/service` with a
  `warn` line, logged once per log version rather than per request, and the
  server signs nothing. The log is admin-custodied state: it dies with a data
  wipe, and the admin's copy is what restores it.
- **`src/lib/syncIdentity.ts`** -- the signer a server invokes a peer's
  capabilities with when it replicates a Space. It is the same seed key, named
  as the method `{serverDid}#{publicKeyMultibase}`. `loadSyncSigner` returns a
  signer only when `resolveServerDid` yields a `serverDid` and the resolved
  document lists the key under `capabilityInvocation`. Otherwise it returns a
  refusal with a reason: no advertised `serverDid`, or the key not listed under
  `capabilityInvocation`. A storage fault met while reading the log is thrown as
  its 5xx and is not a refusal. A controller delegates the pull capability to
  `serverDid`, so a peer verifies the invocation against the server's log. There
  is no second key and no `/service` member. Listing the relationship is the
  switch that enables replication. Every read a pull loop makes of a peer Space
  is signed with it (`sync/peerClient.ts`).
- **`src/lib/peerWebvh.ts`** -- the one network resolution of a foreign
  `did:webvh`: any DID on another host whose log this server does not store,
  with any path or none. It covers a peer server's own DID,
  `did:webvh:<scid>:<host>:space:server:id`, and a service's or an agent's DID.
  It resolves one only as the invoker of a delegated capability on the WAS
  routes (see "The `did:webvh` resolver on every path" below). The log is
  fetched from the URL the did:webvh method maps the DID to
  (`https://<host>/<path>/did.jsonl`, or `https://<host>/.well-known/did.jsonl`
  for a host-only DID), by `getFileUrl` of `@interop/did-method-webvh`. A DID
  whose host carries a port, or is an IP address, is refused. The log is
  verified like any log (see the Glossary's Self-hosted `did:webvh` on
  witnesses). It must extend the last head verified for the DID, so a host
  cannot serve an older prefix to restore a retired key. A verified document is
  cached per DID in an LRU for a TTL, then fetched and verified again. A
  signature that names a key the cached document lacks forces one fetch per DID
  per interval. A failure is remembered briefly, so a failing host is not asked
  on every request. A first-contact fetch is one for a DID with no verified head
  here. Those are counted per host over a window and refused past a limit. A
  refresh of a DID that already verified does not draw on that window, so other
  DIDs on its host cannot starve it. Each of the two kinds also has its own
  limit on fetches in flight, and a fetch past it is refused, not queued. The
  body is size-bounded and the fetch has a timeout. The `PEER_WEBVH_*` constants
  in `config.default.ts` set these bounds. The default fetcher, `fetchPeerLog`,
  speaks `https` only, on the default port, follows no redirect, and connects
  only to the public addresses it checked after DNS. `lib/outboundAddress.ts`
  holds those address checks, the pinned lookup and the size-bounded body
  reader, shared with the CORS proxy. `peerLogFetcher` is a plugin and
  `createApp` option that replaces the fetcher in tests, since the host bound
  keeps a real fetch out of the suite. No environment variable reaches the
  fetcher. The operator's blocklist (`lib/webvhBlocklist.ts`) does reach the
  resolver. `WAS_WEBVH_BLOCKLIST` and the `webvhBlocklist` plugin option take
  comma-separated entries. An entry is a host name, which blocks every DID on
  that host, or a full `did:webvh` DID. A blocked DID is refused before any
  fetch with the masked `not-found`, and a malformed entry refuses startup. The
  blocklist covers the network path only. A DID whose log this server stores
  never takes that path. The resolver is one per app, decorated as `peerWebvh`,
  and `mayFetch` tells it whether a DID may be fetched at all.
- **`src/lib/webvhLogLocation.ts`** -- where this server stores the history log
  of a `did:webvh`. A self-hosted DID's log is the one the DID names. A DID
  hosted in a Space on a replication peer, `did:webvh:<scid>:<H>:space:<S>:<C>`,
  has a local copy when exactly one local Space X holds a replica registration
  whose `fromSpace` is `https://H/space/S/` and which pulls Collection C. The
  log is then X's `C/did.jsonl`, and X need not be S. `locateWebvhLog` makes the
  mapping, and the resolver reads that log through the same verify, cache,
  head-record and fast-forward path as a native one. The mapping goes through
  the registration because a local Space named S could belong to anyone on this
  server. A registration passes the controller check in `sync/registration.ts`,
  so only the peer Space's controller, or a current invocation key of its
  `did:webvh` document, can make one. When two or more local Spaces map one DID,
  it has no location and does not resolve from storage. An older copy could list
  a retired key, and the head record is lost on restart, so picking either copy
  would let the older one win. The registrations are read through an index of
  every stored registration, cached per backend for `REPLICA_INDEX_CACHE_TTL`.
  Storing or removing a registration drops it, and so does Delete Space. The
  head record of a replicated DID is keyed by the DID alone, so it survives a
  change of the local Space that keeps the copy. The apply path's write of a
  `did.jsonl` drops the cached document, so a key retired at the origin stops
  authorizing after the next pull. Such a DID may be a Space controller, a
  keystore controller, a delegator, and the `createdBy` of a write.
  `lib/serverIdentity.ts`, `lib/syncIdentity.ts` and import provenance stay
  native-only. `invokerDid` (`createdBy`) also records a DID resolved over the
  network, since the authorization that ran before decided its key. A create the
  provisioning policy granted verifies no signature, so it records no
  `createdBy`.
- **`src/lib/replicaApply.ts`** -- the rules the apply path stores a replicated
  record by. A storage backend's `apply*` methods take a record a pull loop read
  from a peer and store it under the peer's write stamp and generation, so the
  record's `ETag` here equals the peer's. No request route reaches them. Both
  backends decide through this module. A record is applied when its stamp sorts
  above the held one by `(ms, counter, originId)`, and skipped otherwise. An
  equal stamp is a record this server already holds, which is also what stops a
  record from travelling round a two-way pair. Three records follow other rules.
  A history log (a Collection's governing log, or a `did.jsonl`) fast-forwards:
  the held bytes must be a prefix of the received ones, a prefix of the held
  bytes is skipped, and anything else is a fork. A Collection tombstone carries
  no generation. It removes any life of the Collection created before its stamp,
  with its members, whatever their stamps, so a delete wins over a later member
  write. Two lives of one Collection id are ordered by their creating stamps
  (see the Glossary): a received life created after the held one replaces it,
  members included, and one created before it is skipped. An update of a held
  life replaces the object except for the members that are immutable once set
  (`encryption`, `revisions.resolution`, `revisions.immutable`). One the
  received object omits is kept, and two different set values are a fork.

  Each apply method runs inside the critical section the matching request-layer
  write takes, and checks there, in order: that the registration is still stored
  and was made for the Space's current generation (else `unregistered`), that
  the backend's clock takes the received stamps in (else `refused` with reason
  `clock-bound`), and that the record's Collection is live (else `skipped`). An
  applied record takes a local feed position, so it appears in this server's own
  `changes` feed and a third server can pull it from here. Preconditions, the
  encrypted-Collection envelope rule, the write-once rule and the
  unique-attribute claims are not evaluated, since the origin server admitted
  the write. Quotas and the upload cap are. The Space Metadata object replicates
  its `name` alone: `controller`, `type` and the server-derived members stay per
  server. Revocations, backend registrations, keystores and chunks are not
  replicated.

- **`src/sync/`** -- the replication facet: replica registrations and their pull
  loops. A registration is one source peer of a Space, a directed edge the
  controller writes at `POST /space/:spaceId/replicas`
  (`requests/ReplicaRequest.ts`): `id`, `fromSpace` (the peer Space's URL),
  `toSpace` (this Space's URL), `capability` (the pull capability, delegated to
  this server's DID with `allowedAction` within `GET` and `HEAD`), an optional
  `collections` list, and `role` (`source`). `GET` there lists the records as
  `{ url, totalItems, items }`. `GET` and `DELETE` of
  `/space/:spaceId/replicas/:replicaId` read and remove one, and there is no
  `PUT`. Every method is controller-only, the reads included, through the
  container rule's `controller-only`. A record is stored inside the Space
  (`.replica.<id>.json` beside `.replica.<id>.state.json` in the filesystem
  Space dir, a row of the Postgres `replicas` table), so Delete Space removes
  it. It is not replicated and not exported. Storing or removing one advances
  the Space Metadata object's local segment, since the served `replicas` member
  changed.

  `sync/registration.ts` holds the checks a registration passes before it is
  stored. A malformed body is `invalid-request-body` (400). The rest read the
  peer, and a break of one is `replica-refused` (409). The local Space is not
  the `server` Space. This server has a sync signer, and the capability is
  delegated to its DID. The peer's `/service` lists the replication entry at
  this server's version and an `originId` that is not this server's. The peer
  Space, read through the capability, has the local Space's `type` set, and a
  controller the local one matches. The two are equal, or the peer controller is
  a `did:webvh` hosted in the peer Space whose current document lists the local
  Space's `did:key` controller under `capabilityInvocation`. The second branch
  is the common order: a wallet promotes its Space to its `did:webvh` before the
  Space gains a replica, and a new local Space is created under one of the
  account's enrolled client keys. The local Space cannot be promoted first,
  since the DID resolves here only through the registration. For that branch the
  check reads the peer's `did.jsonl` through the pull capability, verifies it
  offline, as a replicated copy is, and requires the registration to pull the
  log's Collection, so the copy the promotion needs arrives with the first pull.
  The DID is never fetched by itself. Once the first pull lands, Update Space
  moves the local Space to the DID, and the controllers are equal from then on.
  Without the controller check, a holder of any readable pull capability could
  register another user's Space as a source and read the copy through root
  invocations. A key the document lists under `capabilityDelegation` alone, a
  ladder method, does not pass. Each Collection both sides hold agrees on the
  immutable members. The peer Space's id need not equal the local one. One check
  reads no peer. A registration is refused when another local Space already
  replicates the same peer Space with a Collection in common, since a
  `did:webvh` hosted in a Collection two local Spaces replicate resolves from
  neither copy (`lib/webvhLogLocation.ts`). Two registrations on one local Space
  may overlap. The check is not atomic with the write, so two concurrent
  registrations can both pass, and the resolver then refuses the DID.

  Delete Replica is refused with the same `replica-refused` (409) while the
  registration is the only one that maps a local Space's `did:webvh` controller
  to a copy of its log. Removing it would leave that Space with no resolvable
  controller, and both repairs, a new registration and Update Space, are
  authorized by the controller. The handler scans every stored Space for such a
  controller. The caller changes that Space's controller first. To replace a
  registration, the caller adds the new one on the same Space before removing
  the old one. A removal that ends a two-Space mapping is allowed. A keystore
  controller is not checked. Delete Space and Delete Collection are not guarded
  either: a replicated copy of a log goes away with its Collection or Space, as
  a self-hosted log does.

  `sync/replication.ts` is the `ReplicationManager`, one per app, decorated as
  `replication`. It runs one pull loop per stored registration, started at
  `onReady` and on registration. A cycle reads the peer Space's Metadata object
  and policy (conditional reads), then its Collection listing under
  `?include=deleted`. The registration's `collections` list selects among the
  listed Collections, live and tombstoned, and the Collection that holds the
  controller's history log is always selected. The rule is
  `peerCollectionSelector` in `sync/collectionSelection.ts`, which the pull loop
  shares with `lib/webvhLogLocation.ts`, so the two cannot drift. A selected
  tombstone is applied. One for a Collection the registration does not pull is
  ignored, so it cannot remove a local Collection that shares its id. For each
  selected live Collection the loop applies the Collection Metadata object when
  this server does not hold that life of the Collection, then reads its
  `changes` feed from the stored checkpoint and applies each document by `kind`.
  A Resource's content is read by `GET`, or taken from the document's inline
  `data`, and its `/meta` object is read for the members the content write set.
  An `ETag` that no longer equals the one the feed named means the record moved,
  and the Collection is read again next cycle. The checkpoint advances past a
  document once it is applied or skipped. A feed page too large to buffer is
  asked for again at half the size, down to one document, which is read up to
  the upload cap. A binary Resource's read times out on the wait for the
  response and for each chunk, so a long transfer is not cut off.

  A `refused` apply stalls that Collection alone. The checkpoint holds and the
  reason (`clock-bound`, `fork`, `quota-exceeded`, `unsupported-backend`,
  `container-refused`) is stored with the loop state, which
  `GET .../replicas/:replicaId/status` serves beside the loop `state` and the
  pull times. The Collection is retried each cycle while the others go on, and a
  clock-bound stall clears itself as local time catches up. A Collection stored
  on a registered external backend on the peer stalls as `unsupported-backend`:
  this server replicates into its own default backend only. A request to the
  peer that fails, a 404 for the Space included, ends the cycle. The loop then
  backs off, doubling its delay up to a limit, and logs one `warn` when the
  failures begin. Nothing stops a loop but the removal of its registration. The
  manager stops every loop in the same `onClose` hook that closes the backend,
  ahead of it.

  `sync/peerFetch.ts` is the transport. `fromSpace` is a URL the controller
  supplies, so every request to it is bound as the peer log fetch is: `https`
  only, the default port, no redirect followed, and a connection only to the
  public addresses checked after DNS. The plugin's `peerFetch` option replaces
  it in tests. The feed has a read-only form for the loop,
  `GET /space/:spaceId/:collectionId/query?profile=changes`, with `checkpoint`
  and `limit` in the query string, verified under the `GET` action. The `POST`
  form needs a `POST` capability, which a pull capability does not carry.

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
  seed key as the method `{serverDid}#{publicKeyMultibase}`, under
  `assertionMethod` and at most `capabilityInvocation`. With no identity the
  handler logs one `warn` line naming the reason and the export carries no
  provenance. With one, the backend's `exportSpace` hands its finished entry
  tree to `attestArchiveEntries` before packing it. That call emits one
  `StorageAttestation` statement per exported object in manifest order: the
  Space Metadata object, each Collection Metadata object, and each Resource with
  a representation (a tombstone holds no content and gets none). A Collection
  tombstone is a Space-level file entry and gets no statement either. A
  statement is
  `{ id, type, createdBy, createdAt, updatedAt, updatedAtCounter, originId, meta, digest, didLogVersionId }`.
  `id` is the object's absolute URL on this server. The server-managed members
  are read back off the archived Metadata file or `.meta.<id>.json` sidecar, and
  a member the record lacks is left out. `digest` is the `Digest` header's `mh=`
  form over the representation's archived bytes. A chunked Resource's `digest`
  is the same form over the JCS serialization of its chunk digests in index
  order, so its parent representation's bytes are not covered. These reading and
  digest rules live in `lib/provenanceStatement.ts`. `updatedAt`,
  `updatedAtCounter` and `originId` are the object's write stamp as archived. A
  Resource's `meta` is its `/meta` record's stamp and generation, present once
  metadata was written. A Metadata statement carries no `meta` and no `digest`.
  `didLogVersionId` is the snapshot head's `versionId`, since `proof.created` is
  not trustworthy. Each statement carries one `eddsa-jcs-2022` proof,
  `proofPurpose` `assertionMethod`, made straight from the suite rather than
  through `jsigs.sign`, which would add a JSON-LD `@context` the statement does
  not carry. The proof has no `created`, and Ed25519 is deterministic, so
  signing the same statement again yields the same bytes. That keeps a later
  write-time signature interchangeable with an export-time one. The statements
  go into the archive's `provenance.jsonl` and the snapshot into its
  `did.jsonl`, both root entries ahead of `space/`, so each Resource is read
  twice, once to digest it and once to pack it. The export is not one
  transaction, so a Resource written between the two reads leaves a statement
  that does not match its archived bytes. One deleted after the backend built
  the entry tree gets no statement, and the export goes on. Import verifies both
  entries (`lib/importProvenance.ts`, below).
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
  method under `assertionMethod`, and at most `capabilityInvocation`. Then the
  `eddsa-jcs-2022` proof is verified. Last, the statement's claims are compared
  with the archived object: `createdBy`, `createdAt`, the write stamp
  (`updatedAt`, `updatedAtCounter`, `originId`), and for a Resource its `meta`
  and its `digest` (the composite chunk digest for a chunked Resource). `meta`
  is compared member by member. The archived object's members and digests are
  computed by the same `lib/provenanceStatement.ts` functions export signs with.
  Each object the archive carries an attestable entry for gets one verdict,
  whether or not the destination already holds it: `verified`, `unattested` (no
  statement, or no `provenance.jsonl`), `proofInvalid`, `contentMismatch`, or
  `unknownSigner` (no `did.jsonl`, a log that does not verify, a method outside
  the snapshot's DID, a version the log lacks, or a method there that is not
  under `assertionMethod`, or is under any relationship besides
  `capabilityInvocation`). The counts are the `provenance` member of the
  returned `ImportStats`. Outside `verified` the object is still imported, with
  its `createdBy` removed. A tombstone carries no statement and is not counted,
  and its sidecar loses `createdBy` too, since the tombstone's change document
  carries it. A Collection tombstone travels on the plan apart from the live
  Collections (`collectionTombstones`), so it is never judged or counted. The
  Space Metadata object's verdict is counted only, since an import never
  restores its `createdBy`. A `proofInvalid` and a `contentMismatch` are logged
  at `warn` with different messages, so damaged bytes are not read as a bad
  signature. `createdAt` keeps its import behavior whatever the verdict. The
  archived stamps are read for this comparison only: the importing backend
  re-stamps every record it writes with its own clock and origin id, and keeps
  each record's archived generation.
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
  code knows. Version 2 is the write-stamp layout. Its step refuses a data dir
  that holds any Space, with `StoreVersionError`, since a record written before
  stamps carries none and there is no stamping step. The refusal repeats on
  every boot until the dir is wiped. An empty data dir passes and is stamped at
  the new version. The Postgres backend refuses a populated pre-stamp schema the
  same way. Version 3 is the policy-stamp layout, in which an access-control
  policy carries a write stamp and a generation, and its delete leaves a
  tombstone. Its step refuses a data dir that holds any policy file, on the same
  terms. Postgres schema migration 12 refuses a `policies` table that holds any
  row the same way, then adds the stamp, generation, `deleted` and
  `feed_position` columns. Version 4 is the feed-position layout, in which a
  policy file carries its own feed position and the feed counter file holds a
  `records` map. Its step refuses a data dir that holds any feed counter file or
  any Collection- or Resource-level policy file, with `StoreVersionError`, on
  every boot and with no conversion step. A Space policy alone passes. An empty
  data dir is stamped at version 4. Postgres is unchanged. The version is
  private to the backend: it is not exported, not stored in any Space, and not
  served. The Postgres backend's `applyMigrations` refuses the same way, with
  the same `StoreVersionError`, when its `schema_migrations` table records a
  version newer than `MIGRATIONS` knows. `store.json` also carries the store's
  origin id as its `originId` member (see the Glossary's Origin id). `open()`
  settles it on every boot, under the same lock, and it is not a migration step.
  A store with no id takes `WAS_ORIGIN_ID` when set, else a minted one, and
  writes it before any step runs. A stored id is kept, and a set `WAS_ORIGIN_ID`
  that differs from it refuses startup with `StoreOriginIdError`, naming both.
  `store.json` also carries `clockHighWater`, the high-water mark of the store's
  hybrid logical clock in epoch milliseconds (see `lib/hlc.ts`). The clock
  raises it at runtime, and a lower value never replaces a stored higher one. It
  is not a migration step either. Every rewrite of `store.json` keeps the id,
  the high-water mark, and any member this code does not know. The Postgres twin
  is the single row of the `store` table (column `origin_id`, beside
  `clock_high_water`), settled by `applyMigrations` in the same transaction,
  under its advisory lock. Each backend exposes the id as
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
  that its Space, and its Collection where it names one, has a Metadata object
  (a tombstoned Collection has none), under the lock it holds against Delete
  Space and Delete Collection (the filesystem backend's Space gate, the Postgres
  `spaces` row). It is refused with a 404 otherwise. The request layer's own
  existence check runs before that lock, so a write racing a delete would
  otherwise recreate the removed container. A Space-scoped revocation insert is
  one of these writes, though its records live outside the Space tree. Each
  backend's `exportSpace` builds the archive's entry tree out of its own storage
  and hands it to `packSpaceArchive`; the per-Space archive codec itself -- the
  file-name dialect, the `manifest.yml` document and the packer -- lives in
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

  Delete Collection leaves a tombstone in both backends. The filesystem backend
  keeps it as the Collection's `.collection.<id>.json`, now holding only
  `deleted: true`, the stamp, and `_generation`, in the Collection dir. It
  writes the tombstone first, durably, then removes every other entry of the
  dir. A tombstone beside other entries is a delete cut short, detected from the
  disk alone. `open()` finishes every such delete at boot. A read of the
  Collection (`getCollectionMetadata`) finishes it on the exclusive side of the
  Space gate, a retried delete finishes it and answers 404, and a create or an
  import over the tombstone finishes it before writing the new life. A
  Collection dir with no Metadata file (a create cut short) is no Collection: a
  delete removes it whole and answers 204, as for an id never used.
  `deleteCollection` resolves `deleted`, `already-deleted` or `absent`, and the
  handler answers 204, 404 and 204. Every reader of the Metadata file goes
  through one low-level reader that returns the tombstone, and every other path
  treats it as absent, so a new call site is safe by default. The Postgres
  backend deletes in one transaction: member rows and policies go, and the
  `collections` row stays with `deleted` set (schema migration 10), `metadata`
  NULL, the log and feed columns cleared, and the generation and stamp columns
  kept. A Collection on a registered external backend keeps its tombstone in the
  primary store, where its Metadata object lives. Delete Space stays a hard
  delete and takes the tombstones with it. Tombstones are never reaped. Export
  writes a tombstone as `.collection.<id>.json` directly in the archive's Space
  directory, with no Collection directory, and the codec flags it on the
  manifest. Members a delete cut short left on disk do not travel. Import plans
  it apart from the live Collections, refuses an archive holding one id both
  ways as `invalid-import` (400), and writes it only when the destination holds
  no record under the id, live or tombstoned. It keeps the archived generation
  and takes a stamp from the importing store's clock. `ImportStats` does not
  count it. A live archived Collection imported over a destination tombstone
  also keeps its archived generation, as every imported record does. It is the
  one create over a tombstone that does not mint a new generation, and its stamp
  still sorts above the tombstone's. An archive with a `deleted: true` body
  inside a Collection directory is refused as `invalid-import` (400).

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
  and `name`, and its server-derived members are `createdBy`, `url`, `linkset`,
  `backends` (the same listing `GET /space/:spaceId/backends` serves, carried
  here so a reader learns it without a second request) and `replicas` (each
  replica registration's `fromSpace`, `toSpace` and `role`, with no registration
  id and no capability). The object also carries the write stamp of its last
  write (`updatedAt`, `updatedAtCounter`, `originId`), which the server sets. A
  server-derived or stamp member supplied in a write body is ignored, and an
  unknown member is not stored. A `PUT` of the Space Metadata object on an
  existing Space replaces its user-writable members in full, so an omitted
  `name` is removed. `src/lib/spaceProjection.ts` holds the two projections from
  the stored record: the served object, which Read Space and the two create
  responses go through, and the export archive's `.space.<id>.json` entry, which
  keeps the on-disk layout and stamps only `backends`; both derive `backends`
  there, so no path drifts on it. A create response projects the object
  `writeSpace` returns, as the write stored it. It hands the projection the
  listing instead of having it read one: a Space that did not exist before the
  write has no registrations, since registering one needs the Space Metadata
  object to authorize against.
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
  lists the key under `assertionMethod`, and under `capabilityInvocation` at
  most. The key signs an export's provenance statements as the method
  `{serverDid}#{publicKeyMultibase}`, and only while the DID is advertised. Once
  the log also lists it under `capabilityInvocation`, the same key signs sync
  invocations as the same method (`lib/syncIdentity.ts`), and a controller
  delegates a pull capability to `serverDid`. Distinct from the admin identity,
  which holds the log's update key and authorizes operator actions. Avoid:
  server DID key (ambiguous between the two), server controller.
- **Origin id** -- the store-level id that is the origin half of a write's
  replicated identity, for replicating a Space between servers. One per store (a
  filesystem data dir, a Postgres schema): `WAS_ORIGIN_ID` verbatim when set,
  else a random 16-byte base58 id minted on first boot, kept for the store's
  life (`lib/originId.ts`). It is the `originId` member of every write stamp the
  store mints. It need only be stable and unique among every server a Space may
  replicate to, since nothing verifies it. It is not the server identity, which
  most deployments lack, which embeds the host, and which changes when the admin
  re-mints the log. A cloned data dir carries its id, so a clone that runs
  beside its source boots with a fresh `WAS_ORIGIN_ID` over an empty store.
  Advertised on `/service` as `originId` on the core specs entry. Avoid: node
  id, replica id, server id.
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
  there is a full replacement that creates the Collection when absent. It also
  carries the optional `revisions` descriptor: the conflict `resolution`, the
  write-once `immutable` flag, and a verbatim `merge` object (see
  `lib/revisions.ts`). It carries `created`, its creating stamp. Its `url`, and
  the `Location` of a newly created Collection, carry the trailing slash.
  Deleting it leaves a Collection tombstone.
- **Creating stamp** -- the write stamp of the write that created a Collection,
  served as the Collection Metadata object's `created` member and kept for the
  Collection's life. A create over a tombstone records a new one, and an import
  records its own stamp. The apply path orders two lives of one Collection id by
  it, since their generations are random and cannot be ordered. Server-managed:
  a value in a write body is ignored. Avoid: creation time (`createdAt` is one
  member's worth of it), generation stamp.
- **Replica registration** -- one source peer of a Space, stored on the server
  that pulls: a directed edge from `fromSpace` (the peer's Space) to `toSpace`
  (this one), with the pull capability the controller delegated to this server's
  DID. Replication is one-way per registration. A two-way pair is two
  registrations, one on each server. This server's own, like a backend
  registration: it is not replicated and not exported. Avoid: peer (the other
  server), subscription, sync config.
- **Pull loop** -- the loop that reads one replica registration's source and
  stores what it reads through the apply path (`sync/replication.ts`). Its state
  per Collection is `synced`, `syncing`, `stalled` or `skipped`. Avoid: sync
  job, replicator.
- **Collection tombstone** -- what Delete Collection leaves in place of the
  Collection Metadata object: `deleted: true`, the Collection's generation, and
  the delete's write stamp, and nothing else of the old body. It reads as absent
  everywhere except the Space listing under `?include=deleted`. A create over it
  is a create: a new generation, a stamp above the tombstone's, and no
  `createdAt` or `createdBy` carried over. A second Delete Collection answers
  404, while one of an id never used answers 204. Avoid: soft-deleted
  Collection, deleted marker, placeholder row.
- **Resource** — an individual stored item, JSON object or binary blob, within a
  Collection (`/space/:spaceId/:collectionId/:resourceId`).
- **Feed position** -- a record's place in its Collection's `changes` feed: the
  per-Collection sequence number its latest write took. A Resource keeps it as
  `feedPosition` on the filesystem sidecar and `feed_position` in Postgres. The
  Collection Metadata object and the governing history log keep theirs in the
  filesystem feed counter file's `records` map (keys `collection-metadata` and
  `log`) and in the Postgres `collections` columns `metadata_feed_position` and
  `log_feed_position`. A Collection or Resource policy keeps its position in its
  own policy file as `_feedPosition`, and in the Postgres
  `policies.feed_position` column. Local to one server and never replicated. The
  wire **checkpoint** wraps one in an opaque string scoped to the issuing
  Collection URL and to the feed counter's generation, which a re-create of the
  Collection replaces (see `lib/changesCheckpoint.ts`). Avoid: keyset, cursor
  (the listings' pagination token), `updatedAt` as an ordering key.
- **Write stamp** -- the identity of a record's last write: `updatedAt`,
  `updatedAtCounter`, and `originId`, minted by the store's hybrid logical clock
  inside the write's critical section (`lib/hlc.ts`). Every versioned record
  carries one: a Resource's content, a chunk, a Resource's `/meta` record
  (nested under `meta`, beside its generation), the Space and Collection
  Metadata objects, a governing history log, and an access-control policy. With
  the record's generation it forms the `ETag`. Stamps order two revisions of one
  record by `(ms, counter, originId)`. They do not order the `changes` feed,
  which the feed position does. Avoid: version, `metaVersion`, revision number,
  timestamp (`updatedAt` alone is one member of the stamp).
- **Local segment** -- the fifth `ETag` segment of a Space or Collection
  Metadata object, a per-record counter this server keeps (`_local` in the
  filesystem Metadata file, `meta_local` in Postgres). It advances when the
  served object changes through a derived member without a write of the object:
  a backend registration or removal on the Space, or a governed-log write on the
  Collection. The next stamped write resets it to 0. It does not leave this
  server, so export strips it. Avoid: version, version bump.
- **Controller** — the DID that owns a Space; its Ed25519 key signs capability
  invocations and is checked during ZCap verification. Three shapes are
  accepted: a `did:key` (the only one a Space may be _created_ with), a
  **self-hosted `did:webvh`** a Space may be _updated_ to (see below), or a
  `did:webvh` hosted on a replication peer, which a Space may be updated to on a
  replica that holds a copy of its log (see below). Distinct from the wallet
  repos' `clientId`: an enrolled client appears here as a verification method
  inside the controller's document, not as the controller itself.
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
  `did:key` — creation stays `did:key`-only. Resolution of a self-hosted DID is
  a **local storage read**, with no network fetch. A `did:webvh` on a
  replication peer's host,
  `did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>`, resolves the same
  way from the local copy of its log, when exactly one replica registration maps
  it there (`lib/webvhLogLocation.ts`). It may be a Space controller, a keystore
  controller, a delegator, and a `createdBy`. Any other cross-host `did:webvh`,
  `did:web`, and every other method are refused as a controller or a delegator.
  The one network exception is a foreign `did:webvh` with no stored log, as the
  invoker of a delegated capability (see "The `did:webvh` resolver on every
  path" under ZCap Structure). The log's Space need not be the Space an
  invocation targets: the DID string carries the log's own `spaceId`, so a
  cross-Space controller resolves through the same path as any other. A
  capability-gated Collection works too — the server reads its own storage
  regardless of read policy, so such a DID resolves for authorization while its
  log stays unreadable without a capability. The log is verified, not trusted
  (SCID pinning plus full hash-chain / update-key verification via
  `@interop/did-method-webvh`), because after promotion the writes to that log
  are authorized by the very document being resolved. The server verifies a log
  against no witness proofs, on every path. A log that declares witnesses does
  not verify here, self-hosted or not, and nothing fetches `did-witness.json`.
  The proposed controller must resolve _before_ it is stored, or the Space would
  be deadlocked. Key validity is the **current-key-set rule** (profile
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

The Space listing's `?include=deleted` lists tombstoned Collections only under a
verified capability. `fetchSpaceAndAuthorize` reports what granted the read
(`grantedBy`), and a listing served through the access-control policy fallback,
a public read, ignores the flag and lists live Collections only. An unknown
`include` section is ignored, as on the quota report.

**The `did:webvh` resolver on every path:** each verification engages the local
`did:webvh` resolver, whatever the scope's own controller is. That covers route
invocations, both halves of a revocation submission (the submitted chain and the
submission's own invocation), create consent, and List Spaces. A delegated link
may be signed by a self-hosted `did:webvh` method on a `did:key` Space, the
unlock-Space shape, so narrowing the resolver to the scope's controller would
leave such a grant live on every route yet unrevocable. The resolver widens
resolution only: it refuses any DID this server holds no log for, and the chain
still roots in the scope's root capability. A submitted chain may root in the
scope's root capability or in the root of any URL under it, the same roots an
invocation accepts, so a grant delegated from a Collection's or a Resource's own
root is revocable too. List Spaces verifies against one candidate controller at
most: the signer of a root invocation, or the signer of a delegated chain's base
delegation, read off the header before any signature work. A listing grant roots
in the `/spaces/` root capability, which no revocation route accepts, so it it
carries no revocation scope and its `expires` bounds it.

One bounded exception reaches the network. Any `did:webvh` on another host whose
log this server does not store may invoke a delegated capability on the WAS
routes. That covers a peer server's DID,
`did:webvh:<scid>:<host>:space:server:id`, and a service's or an agent's DID,
under any path or none. It applies in `authorize()` and `fetchSpaceAndVerify()`.
The HTTP-signature verifier resolves the signing key before it reads the
capability, so a fetch made there would answer any host a request names.
`handleZcapVerify` therefore runs a pre-pass first (`peerInvokerGrant`). It
verifies the embedded delegation chain to the Space controller with local-only
resolution, through the same roots and chain inspectors the invocation applies.
It also requires the invoked capability's sole `controller` to equal the DID. It
gives no grant to a DID that is on the operator's blocklist, nor to one whose
log this server stores, since that DID resolves from storage
(`lib/webvhLogLocation.ts`). Only then does the verification that follows fetch
that one DID's log (`lib/peerWebvh.ts`). A foreign DID with no stored log may
invoke and may not delegate or be a controller, since every link of the chain
must be signed by a key this server resolves without a fetch. A root invocation
by a foreign DID never fetches. `/kms`, revocation submission, create consent
and List Spaces stay local-only. Every refusal is the plain masked `not-found`.

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
grant either. A DID resolved over the network is the one holder that gets no
named cause. Its key is resolved only after its chain verifies, so a revoked or
expired grant leaves the key unresolved and the answer is the plain `not-found`.

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
