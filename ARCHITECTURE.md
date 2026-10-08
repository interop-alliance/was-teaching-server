# Architecture

How a request flows through the Wallet Attached Storage (WAS) reference server,
the domain model, and the ZCap authorization structure. For contribution
conventions see [CONTRIBUTING.md](CONTRIBUTING.md); for agent-facing rules
(tests, logging, endpoint recipes) see [AGENTS.md](AGENTS.md).

This file is the map. Each module entry below summarizes what the module does
and names the topic doc under [docs/](docs/README.md) that holds the full
behavior description. Read that doc before changing the behavior it describes.

## Request Flow

A request flows through these layers, in order:

```
start.ts > server.ts > routes.ts > requests/*Request.ts > storage.ts > backends/*.ts
 (env,      (createApp,  (URL>handler   (per-operation       (storage     (persistence:
  listen)    plugins,     mapping +      handlers; auth       facade)       filesystem)
             decorate)    auth hooks)    verify + storage)
```

- **`src/start.ts`** -- entry point. Reads `SERVER_URL` / `PORT` / `HOST` from
  env, calls `createApp()` and `listen()`, and closes the app on `SIGTERM` /
  `SIGINT` so its `onClose` hooks run.
- **`src/server.ts`** -- `createApp({ serverUrl })` builds the Fastify instance,
  registers plugins (cors, static, view, multipart), decorates the instance with
  `serverUrl`, and registers the four route groups. The registration itself is
  `composeApp({ fastify })`, which `createApp()` calls on the instance
  `createInstance()` builds. The test boot (`startTestServer` in
  `src/testing.ts`) calls the same two, adding the request fault hooks to the
  root instance in between so they run ahead of every route group's hooks.
  Neither is exported from the package.
- **`src/routes.ts`** -- four `init*Routes(app)` functions map URL patterns to
  handler methods. Every group installs the same hook chain first: the
  `requireAuthHeadersOrPublicRead` then `parseAuthHeaders` `onRequest` hooks,
  then the `captureRawBody` (preParsing) and `verifyBodyDigest` (preValidation)
  digest hooks. A container (a Space or a Collection) is canonically addressed
  with a trailing slash: `GET` lists its members, `POST` adds one, `DELETE`
  removes the container, and `PUT` is not defined there. What a container _is_
  lives at its `meta` sub-resource: `GET`/`PUT /space/:spaceId/meta` is the
  Space Metadata object and `GET`/`PUT /space/:spaceId/:collectionId/meta` the
  Collection Metadata object. Every URL a group registers answers 405 for each
  method it does not implement, with an `Allow` header naming the methods it
  does. The refusals are derived from the router: each group records its route
  URLs with an `onRoute` hook (`collectRouteUrls`) and ends with
  `refuseUnimplementedMethods`, which must stay last in its group. The only
  hand-written input is the `PUT`/`DELETE` hints and the two anchors a Space
  does not serve (`/space/:spaceId/query` and `/space/:spaceId/meta/log`). The
  405 has no problem `type` (RFC 9457 `about:blank`, title
  `Method Not Allowed`). A path beneath a reserved segment that no route serves
  is a 404: `refusePathsBeneath` registers a `<segment>/*` wildcard for each id
  in the reserved-id registry (`lib/validateId.ts`), answered through
  `reply.callNotFound()`. The no-slash form of a container URL, and the slash
  form of a Resource or chunk URL, redirect to the canonical form with a 308 for
  every method the canonical form implements, so a signed request must be
  re-signed for the redirect target. A refusal and a redirect carry the `noAuth`
  route config: the auth-header, `parseAuthHeaders` and digest hooks skip them,
  and they answer the same whether or not the target exists and whatever the
  caller's identity. `OPTIONS` is left to the CORS preflight, and `HEAD` follows
  `GET`. The full rules of the refusals, the reserved paths and the redirects
  are in [docs/request-pipeline.md](docs/request-pipeline.md).
- **`src/requests/*Request.ts`** -- request handlers as static class methods
  (`SpaceRequest.post`, etc.). Each handler follows the same shape: fetch the
  Space/Collection for context, call `handleZcapVerify(...)`, then call a
  storage method. Handlers read both `serverUrl` and `storage` from
  `request.server` (the `FastifyInstance` decorated in `server.ts`), not via a
  `this` binding. A write answers from what the backend returns (the validator,
  whether the write created the record, and the stored object as the write
  stamped it), not from a read made after it. The status and body rules of each
  write are in [docs/validators-and-stamps.md](docs/validators-and-stamps.md)
  under "Write responses".
- **`src/auth-header-hooks.ts`** -- `requireAuthHeaders` (401 if missing) and
  `parseAuthHeaders` (parses `Authorization` / `Capability-Invocation` /
  `Digest` into `request.zcap`).
- **`src/digest.ts`** -- Request Body Integrity (spec "Request Body Integrity").
  `captureRawBody` (preParsing) tees JSON/text body bytes onto
  `request.rawBody`; `verifyBodyDigest` (preValidation) requires the `digest`
  header be covered by the signature and recomputes it against the body before
  capability verification (400 `invalid-authorization-header` on failure). It
  runs on any request that carries a body, and refuses a body with no
  `Content-Type` as `missing-content-type` (400) first, so the catch-all parser
  never hands an unsigned raw stream to Import Space or the governed-log `PUT`.
  `captureRawBody` bounds what it buffers by the route's `bodyLimit`, which
  `src/lib/bodyLimit.ts` derives from the active backend's `maxUploadBytes`: an
  over-limit body is refused with `payload-too-large` (413) at the byte that
  crosses the limit, before any signature is verified, and the refusal closes
  the connection. A signed multipart body is tapped rather than piped: the hook
  hashes it as busboy reads it and leaves the verdict on
  `request.multipartDigest`, which the multipart write path awaits before it
  stores anything. See [docs/request-pipeline.md](docs/request-pipeline.md).
- **`src/zcap.ts`** -- `handleZcapVerify()` performs the capability-invocation
  signature verification against the Space controller's key. See
  [ZCap Structure](#zcap-structure).
- **`src/lib/hostedPageSandbox.ts`** -- an `onSend` hook every route group
  installs (`installGroupHooks`) stamps `Content-Security-Policy: sandbox ...`
  on every response in the WAS and `/kms` groups, 304s, redirects and errors
  included, except a response whose `content-type` is `application/pdf`. A
  stored HTML page then runs with an opaque origin and cannot read the storage
  of the origin serving it. The policy leaves out `allow-same-origin` and
  `allow-popups-to-escape-sandbox`. It is group-wide so a new route serving
  stored bytes cannot be added without it, and always on. The welcome page,
  `/common/`, `/service` and the CORS proxy sit outside the groups; the CORS
  proxy sends its own stricter set. See
  [docs/request-pipeline.md](docs/request-pipeline.md).
- **`src/lib/etag.ts`**, **`src/lib/preconditions.ts`**, **`src/lib/hlc.ts`**,
  **`src/lib/metadataValidator.ts`**, **`src/lib/policyRecord.ts`** -- the write
  stamp and the validators. Every versioned record carries a write stamp minted
  by the store's hybrid logical clock inside the write's critical section, and a
  generation minted at its first write. The two form the strong `ETag`,
  `"<generation>.<ms>.<counter>.<originId>"`; a container Metadata object
  appends a local segment. `If-Match` / `If-None-Match: *` are evaluated by the
  backend atomically with the write, and a `GET`/`HEAD` carrying `If-None-Match`
  answers 304 after authorization. Access-control policies are versioned records
  too, with a tombstone on delete. The full rules, including the `/meta`
  composite validator, the Update Space pin, and the status and body of each
  write, are in [docs/validators-and-stamps.md](docs/validators-and-stamps.md).
- **`src/lib/changesCheckpoint.ts`** -- the `changes` query profile. The feed is
  ordered by a per-Collection feed position, which every Resource-level write,
  Collection Metadata write, governed-log write, and Collection- or
  Resource-level policy write takes inside the write's critical section. Each
  feed document carries a `kind`, its write stamp, `generation` and `etag`. The
  wire checkpoint is an opaque base64url string scoped to the server, the
  Collection, and the life of its feed. See
  [docs/changes-feed.md](docs/changes-feed.md).
- **`src/lib/spaceMetadataCache.ts`** and **`src/lib/policyCache.ts`** -- two
  short-TTL read caches on the authorization path, one per storage backend: the
  Space Metadata object (whose `controller` every capability check verifies
  against) and the access-control policies the policy fallback reads. Both
  expire entries after 10 s (`SPACE_METADATA_CACHE_TTL`, `POLICY_CACHE_TTL` in
  `config.default.ts`). A write drops the affected entries only in the process
  that made it, so the TTLs rest on a single-instance deployment, as the write
  stamps do. The staleness a multi-instance deployment gets is in
  [docs/request-pipeline.md](docs/request-pipeline.md).
- **`src/lib/governedLog.ts`**, **`src/lib/revisions.ts`**,
  **`src/lib/governedDescriptorsCache.ts`** -- the `governed-history-logs`
  feature and the Collection `revisions` descriptor. A Collection's governing
  history log is served at `meta/log`; its guarded create puts the Collection
  under log governance, after which its served `encryption` and `revisions`
  members are derived from the log's head and a direct write of them is refused.
  Appends must fast-forward the stored log. The `revisions` descriptor
  (`resolution`, `immutable`, `merge`) has shape and transition checks, and
  `immutable: true` is the write-once rule the backends decide inside the
  write's critical section. See
  [docs/governed-logs-and-revisions.md](docs/governed-logs-and-revisions.md).
- **`src/serviceDescription.ts`** -- `GET /service`, unauthenticated, lists five
  `specs` entries (the core spec, the zCap authorization profile, the Encrypted
  Collections profile, the client-annex profile, and the replication
  specification). Listing an entry is a conformance claim. The core entry
  carries `originId`; the `instance` member carries `exportSigningKey` and
  `serverDid`. A root-level `onSend` hook appends
  `Link: <.../service>; rel="service"` to every response. See
  [docs/service-description.md](docs/service-description.md).
- **`src/lib/serverIdentity.ts`**, **`src/lib/provenanceStatement.ts`**,
  **`src/lib/exportProvenance.ts`**, **`src/lib/importProvenance.ts`** -- the
  server's own identity and export provenance. The server derives an
  export-signing key from `WAS_SERVER_KEY_SEED`; the admin's `did:key`
  (`WAS_ADMIN_DID`) holds the update key of the server's self-hosted
  `did:webvh`, whose log lives in the provisioned `server` Space. Export signs
  one `StorageAttestation` statement per exported object, and import verifies
  each against the archive's log snapshot and strips the `createdBy` of any
  object that is not `verified`. See
  [docs/server-identity-and-provenance.md](docs/server-identity-and-provenance.md)
  and [decision 0003](decisions/0003-one-server-key-for-export-and-sync.md).
- **`src/lib/peerWebvh.ts`**, **`src/lib/webvhLogWrite.ts`**,
  **`src/lib/webvhBlocklist.ts`** -- the `did:webvh` paths. A self-hosted
  `did:webvh` resolves from a local storage read of its `did.jsonl`, verified
  (SCID pinning, hash chain, no witnesses) under the current-key-set rule. The
  log only grows: a fast-forward `PUT`, `DELETE` 405, a per-DID head record, and
  verify-on-append. The one network fetch is a foreign `did:webvh` with no
  stored log invoking a delegated capability, bounded by `PEER_WEBVH_*` and
  `WAS_WEBVH_BLOCKLIST`. See
  [docs/webvh-controllers.md](docs/webvh-controllers.md).
- **`src/sync/`**, **`src/lib/replicaApply.ts`**, **`src/lib/syncIdentity.ts`**,
  **`src/lib/webvhLogLocation.ts`** -- the replication facet. A replica
  registration (`POST /space/:spaceId/replicas`, controller-only) is one source
  peer of a Space, with the pull capability the controller delegated to this
  server's DID. One pull loop per registration reads the peer's Space and each
  selected Collection's `changes` feed, and stores what it reads through the
  backend's `apply*` methods only, under the peer's stamp and generation. No
  request route can supply a write stamp. A replicated `did:webvh` resolves from
  the local copy of its log when exactly one registration maps it there. See
  [docs/replication.md](docs/replication.md) and
  [decision 0004](decisions/0004-stamps-are-minted-only-by-this-server.md).
- **`src/lib/importTar.ts`**, **`src/lib/importPlan.ts`**,
  **`src/lib/importRevocations.ts`** and each backend's `exportSpace` /
  `importSpace` -- Export and Import Space. The archive codec lives in
  `@interop/space-archive`; a backend builds the entry tree and the plan builder
  reads it back. Import is skip-not-overwrite, applies the live write shape
  checks to archived objects before anything is written, and installs archived
  revocations last. No write creates a container implicitly, and every other
  write re-checks its container under the delete lock. See
  [docs/export-import.md](docs/export-import.md).
- **`src/storage.ts`** -- supplies `defaultBackend()`, which opens the
  `FileSystemBackend` (rooted at `data/`) that `createApp()` uses when no
  backend is injected. The active backend is injected via
  `createApp({ backend })` and decorated onto the instance as
  `request.server.storage`.
- **`src/backends/*.ts`** -- interchangeable persistence implementations
  (`implements StorageBackend` from `src/types.ts`), obtained only from a static
  async `open()`, which runs the layout migrations and settles the store's
  origin id. The filesystem backend keeps `store.json` at the data root, finds a
  live Resource or chunk through its `.meta.<id>.json` sidecar, keeps a Resource
  tombstone as `.tombstone.<id>.json`, and takes no lock on reads. It derives
  the Collection listing's `totalItems` from the names in a directory listing.
  Delete Collection leaves a tombstone in both backends. See
  [docs/filesystem-layout.md](docs/filesystem-layout.md).
- **`src/errors.ts`** -- custom error classes plus `handleError`, the Fastify
  error handler installed by each route group.
- **`src/exchanges.ts`** -- the ephemeral exchanges facet
  (`/workflows/ephemeral/exchanges`), a self-contained sibling of the WAS route
  groups: a transient rendezvous for cross-device flows (a desktop page mints an
  exchange, a phone scans its QR, and posts the answer back). It installs none
  of the auth/digest hooks and is unauthenticated by design, a capability URL
  where possession of the unguessable exchange URL is the only access control.
  The relayed `request` and `response` are opaque JSON the server never
  inspects; exchanges live in memory only, expire about 10 minutes after
  creation, are capped in number (429 past the cap), and are lost on restart. It
  holds no wallet data and grants no access to any Space.
- **`src/types.ts`** -- shared domain types and the Fastify module augmentation
  (`FastifyInstance.serverUrl`, `FastifyInstance.storage`,
  `FastifyRequest.zcap`); reuses `@interop/data-integrity-core` types where they
  fit.

## Glossary

This is the repo's ubiquitous language: one canonical term per concept, used
identically in code, tests, docs, and conversation. An `Avoid:` line lists the
synonyms this repo does not use, so a term that drifts can be challenged in
review. The convention is canonical in isomorphic-lib-template's ARCHITECTURE.md
Glossary section. The protocol terms (Space, Collection, Resource, controller,
zcap, root capability, invocation target) are owned by the
[WAS spec](https://github.com/w3c-ccg/wallet-attached-storage-spec)'s
Terminology section; entries below restate one only to say how this server uses
it, and otherwise cover this repo's own concepts.

Containment: **SpacesRepository > Space > Collection > Resource**.

- **SpacesRepository** -- the top-level container the server hosts. New Spaces
  are created under it via `POST /spaces/`.
- **Space** -- a storage area identified by `spaceId`, canonically addressed
  with a trailing slash (`/space/:spaceId/`): `GET` lists its Collections,
  `POST` adds one, `DELETE` removes the Space. Has a `controller` (a DID) that
  owns it and authorizes access. Its Space Metadata object, at
  `/space/:spaceId/meta`, carries the `controller` and a `type` array subtyping
  `Space`, set at creation and immutable afterward; `PUT` there creates the
  Space when absent or replaces it (`PUT` at the bare Space URL answers 405). A
  Space typed `AuxiliarySpace` (e.g.
  `['AuxiliarySpace', 'DelegatedClientsSpace', 'Space']`) holds bookkeeping
  rather than user data. A wallet reaches its auxiliary Space through the
  account document's service entry. It counts toward its controller's
  `maxSpacesPerController` quota (`MAX_SPACES_PER_CONTROLLER`), since both
  backends count every stored Space by controller. List Spaces therefore lists
  it like any other Space, so a controller can see what uses its quota. Every
  List Spaces item carries the Space's `type` array, which is how a wallet tells
  an auxiliary Space from a data Space without a Read Space per item. Its `url`,
  and the `Location` of a newly created Space, carry the trailing slash. The
  object splits in two: its user-writable members are `type` and `name`, and its
  server-derived members are `createdBy`, `url`, `linkset`, `backends` (the same
  listing `GET /space/:spaceId/backends` serves, carried here so a reader learns
  it without a second request) and `replicas` (each replica registration's
  `fromSpace`, `toSpace` and `role`, with no registration id and no capability).
  The object also carries the write stamp of its last write (`updatedAt`,
  `updatedAtCounter`, `originId`), which the server sets. A server-derived or
  stamp member supplied in a write body is ignored, and an unknown member is not
  stored. A `PUT` of the Space Metadata object on an existing Space replaces its
  user-writable members in full, so an omitted `name` is removed.
  `src/lib/spaceProjection.ts` holds the two projections from the stored record:
  the served object, which Read Space and the two create responses go through,
  and the export archive's `.space.<id>.json` entry, which keeps the on-disk
  layout and stamps only `backends`; both derive `backends` there, so no path
  drifts on it. A create response projects the object `writeSpace` returns, as
  the write stored it. It hands the projection the listing instead of having it
  read one: a Space that did not exist before the write has no registrations,
  since registering one needs the Space Metadata object to authorize against.
- **`server` Space** -- the auxiliary Space that hosts this server's own
  identity: its `id` Collection holds the `did.jsonl` history log of the
  server's `did:webvh`. Provisioned at startup under the administrator's
  `did:key` (`WAS_ADMIN_DID`) and typed
  `['AuxiliarySpace', 'ServerInstanceSpace', 'Space']`. The id is reserved on
  every client create, configured or not, and no client can create a Space under
  that subtype. The admin is the controller and the only writer; the server only
  reads the log. Avoid: admin Space, server-controlled Space.
- **Server identity** -- the server's `did:webvh`
  (`did:webvh:{scid}:{host}:space:server:id`) together with the export-signing
  key derived from `WAS_SERVER_KEY_SEED`. The key is advertised on `/service` as
  `exportSigningKey`; the DID as `serverDid` once the log lists the key under
  `assertionMethod`, and under `capabilityInvocation` at most. The same key
  signs export provenance, only while the DID is advertised, and, once listed
  under `capabilityInvocation`, sync invocations, as the method
  `{serverDid}#{publicKeyMultibase}`. Distinct from the admin identity, which
  holds the log's update key. Avoid: server DID key, server controller.
- **Origin id** -- the store-level id that is the origin half of a write's
  replicated identity. One per store (a filesystem data dir, a Postgres schema):
  `WAS_ORIGIN_ID` verbatim when set, else a random 16-byte base58 id minted on
  first boot and kept for the store's life (`lib/originId.ts`). It is the
  `originId` member of every write stamp the store mints, and need only be
  stable and unique among every server a Space may replicate to. It is not the
  server identity. Advertised on `/service` as `originId` on the core specs
  entry. Avoid: node id, replica id, server id.
- **Provenance statement** -- one line of an export archive's
  `provenance.jsonl`: a `StorageAttestation` JSON object naming one exported
  object by its absolute URL, its server-managed members, and its content
  digest, signed by the server identity with one `eddsa-jcs-2022` proof. It is
  not a verifiable credential. Avoid: receipt (reserved for a future write-time
  statement returned to the writer), signature envelope, VC.
- **Collection** -- a named grouping of Resources within a Space, canonically
  addressed with a trailing slash (`/space/:spaceId/:collectionId/`): `GET`
  lists its Resources, `POST` adds one, `DELETE` removes the Collection. Its
  Collection Metadata object, at `/space/:spaceId/:collectionId/meta`, holds its
  configuration (`backend`, `encryption`, `generator`, `revisions`) and its
  annotation (`custom`, `epoch`) under one `ETag`; `PUT` there is a full
  replacement that creates the Collection when absent. It carries `created`, its
  creating stamp. Deleting it leaves a Collection tombstone.
- **Creating stamp** -- the write stamp of the write that created a Collection,
  served as the Collection Metadata object's `created` member and kept for the
  Collection's life. A create over a tombstone records a new one, and an import
  records its own stamp. The apply path orders two lives of one Collection id by
  it, since their generations are random and cannot be ordered. Server-managed:
  a value in a write body is ignored. Avoid: creation time, generation stamp.
- **Replica registration** -- one source peer of a Space, stored on the server
  that pulls: a directed edge from `fromSpace` (the peer's Space) to `toSpace`
  (this one), with the pull capability the controller delegated to this server's
  DID. Replication is one-way per registration; a two-way pair is two
  registrations, one on each server. Not replicated and not exported. Avoid:
  peer (the other server), subscription, sync config.
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
- **Resource** -- an individual stored item, JSON object or binary blob, within
  a Collection (`/space/:spaceId/:collectionId/:resourceId`).
- **Feed position** -- a record's place in its Collection's `changes` feed: the
  per-Collection sequence number its latest write took. Local to one server and
  never replicated. The wire **checkpoint** wraps one in an opaque string scoped
  to the issuing Collection URL and to the feed counter's generation. Avoid:
  keyset, cursor (the listings' pagination token), `updatedAt` as an ordering
  key.
- **Write stamp** -- the identity of a record's last write: `updatedAt`,
  `updatedAtCounter`, and `originId`, minted by the store's hybrid logical clock
  inside the write's critical section (`lib/hlc.ts`). Every versioned record
  carries one. With the record's generation it forms the `ETag`. Stamps order
  two revisions of one record by `(ms, counter, originId)`; they do not order
  the `changes` feed, which the feed position does. Avoid: version,
  `metaVersion`, revision number, timestamp.
- **Local segment** -- the fifth `ETag` segment of a Space or Collection
  Metadata object, a per-record counter this server keeps. It advances when the
  served object changes through a derived member without a write of the object
  (a backend registration or removal on the Space, a replica registration, a
  governed-log write on the Collection). The next stamped write resets it to 0.
  It does not leave this server. Avoid: version, version bump.
- **Controller** -- the DID that owns a Space; its Ed25519 key signs capability
  invocations and is checked during ZCap verification. Three shapes are
  accepted: a `did:key` (the only one a Space may be _created_ with), a
  self-hosted `did:webvh` a Space may be _updated_ to, or a `did:webvh` hosted
  on a replication peer, on a replica that holds a copy of its log. Distinct
  from the wallet repos' `clientId`: an enrolled client appears here as a
  verification method inside the controller's document, not as the controller
  itself.
- **ZCap (Authorization Capability)** -- the authorization model. Clients sign
  HTTP requests; the server verifies the signature against the Space
  controller's key rather than using sessions or bearer tokens. Avoid: session,
  bearer token, access token.
- **`invocationTarget`** -- the full URL (including host and port) a capability
  authorizes. Must exactly match the server's `serverUrl`-derived URL.
- **Root capability** -- `urn:zcap:root:<url-encoded target>`, whose controller
  is the Space controller. Synthesized by the document loader in `zcap.ts`. For
  the WAS route family, `target` is the Space's canonical trailing-slash URL
  (`spaceRootTarget` in `requests/spaceContext.ts`), the same URL a delegated
  chain attenuates from.
- **`did:key`** -- the default DID method here; keys are Ed25519
  (`Ed25519VerificationKey2020` / `Ed25519Signature2020`). Space creation, and
  the `/kms` keystore routes, accept nothing else.
- **Self-hosted `did:webvh`** -- the second accepted Space-controller shape:
  `did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>`, whose history log is
  the `did.jsonl` Resource in that Collection of that Space on _this_ server. A
  Space is **promoted** to one by PUTting its Space Metadata object with the new
  `controller`, still authorized by the stored `did:key`. Resolution is a local
  storage read, verified and never trusted, and key validity is the
  current-key-set rule. Any other cross-host `did:webvh`, `did:web`, and every
  other method are refused as a controller or a delegator. See
  [docs/webvh-controllers.md](docs/webvh-controllers.md).

**Trailing slashes:** a trailing slash marks a container, a Space or a
Collection, in its canonical form: `GET` lists its members, `POST` adds one,
`DELETE` removes it, and `PUT` is not defined there. Everything else (a
container's `meta` sub-resource, a Resource, and every other sub-resource path)
carries no trailing slash. No two registered paths differ only by a trailing
slash. Routes redirect the non-canonical form to the canonical one with a 308,
so a signed request must be re-signed for the redirect target rather than replay
its `Authorization` header.

## ZCap Structure

A zcap answers "**who** can do **what**, **with** which resource, **given** what
restrictions": `controller` (who, a DID) / `allowedAction` (what, e.g. HTTP
verbs) / `invocationTarget` (with, a URL) / caveats like `expires` (given). A
delegated zcap also carries `parentCapability` and a `proof` with a
`capabilityChain`; a root zcap carries none of those.

**Root vs delegated invocation** (the `Capability-Invocation` header):

- Root: `zcap id="urn:zcap:root:<url-encoded target>"`, just the id.
- Delegated: `zcap capability="<base64url(gzip(json))>",action="GET"`, the full
  capability and its `proof.capabilityChain`, embedded and compressed.

Both verify through the same path: the `urn` protocol handler in `verifyZcap`
synthesizes the root capability on demand (its controller is the Space
controller). For a bare root invocation that _is_ the capability; for a
delegated invocation it's the terminal `parentCapability` at the base of the
chain, which the verifier walks down to.

The `allowTargetQuery` option of `verifyZcap`, set on the paginated listings and
the other reads that carry a query, bounds the accepted root set only. It adds
the query-bearing request URL's own root capability to that set. Every WAS route
passes the Space's root as an accepted ancestor root, so on those routes the
request URL, query included, is always an accepted invocation target.

The Space listing's `?include=deleted` lists tombstoned Collections only under a
verified capability. `fetchSpaceAndAuthorize` reports what granted the read
(`grantedBy`), and a listing served through the access-control policy fallback
ignores the flag and lists live Collections only.

**The `did:webvh` resolver on every path:** each verification engages the local
`did:webvh` resolver, whatever the scope's own controller is: route invocations,
both halves of a revocation submission, create consent, and List Spaces. It
refuses any DID this server holds no log for, with one bounded exception: a
foreign `did:webvh` may invoke a delegated capability on the WAS routes, and its
log is fetched only after a local-only pre-pass verified the chain
(`peerInvokerGrant`). Full rules in
[docs/webvh-controllers.md](docs/webvh-controllers.md).

**Chain inspection:** after signature verification, the dereferenced chain
passes through composed inspectors. The revocation inspector
(`lib/revocations.ts`) fails a chain containing any capability with a stored
revocation. The annex-chain inspector (`lib/clientAnnexClause.ts`) bounds what a
ladder verification method (a `capabilityDelegation`-only method of a
self-hosted `did:webvh` document) may delegate, to five admitted shapes, and
adds two invocation-time bounds on `PUT` at a Space Metadata URL and `DELETE` at
a canonical Space URL. The service description's client-annex entry claims the
clause, and a change to what it admits is a new version of that entry. Full
rules in [docs/client-annex-clause.md](docs/client-annex-clause.md).

**The container rule** (`lib/containerRule.ts`): an unsafe method at a container
URL is controller-only, since a data grant's `invocationTarget` is the container
URL itself and the zcap library's target attenuation is a `/`-boundary prefix
rule. `PUT /space/<S>/meta` on an existing Space, `DELETE /space/<S>/<C>/`, and
Update Keystore refuse every delegated invocation, decided off the
`Capability-Invocation` header before any chain is read. `DELETE /space/<S>/`
also accepts a tail targeting exactly that Space URL with `allowedAction`
exactly `['DELETE']`, and `PUT /space/<S>/<C>/meta/log` one targeting exactly
the Space's items subtree. `PUT /space/<S>/<C>/meta` and Create Collection carry
no rule. The rule reads the tail alone; the client-annex clause's two bounds
cover the chains it admits. A refusal surfaces as the masked `not-found`. Full
rules in [docs/client-annex-clause.md](docs/client-annex-clause.md).

**Denial reasons:** a refusal is a 404 whose `type` is the merged `not-found`,
with two exceptions named by `type` only, the status unchanged (`denialError` in
`zcap.ts`, on the shared `verifiedOrThrow` path every route family uses).
`capability-revoked` means the revocation inspector failed the chain.
`capability-expired` means the zcap library raised its named expiry error for
the invoked capability or one in its chain. The two are told apart from every
other cause by `err.name`, the cross-package rule. A cause is named only for a
caller signing with the invoked capability's own controller key, which
`denialError` checks server-side (`invokerIsController`), and only after every
delegation proof in the chain verified. A copy of a revoked or expired grant
invoked with any other key, a tampered proof, a wrong action, or a chain that
never verified all stay the plain `not-found`. A denial with a named cause still
falls through to the target's access-control policy, and the error surfaces only
when the policy does not grant either. A DID resolved over the network gets no
named cause.

The plain `not-found` body is byte-identical whether the target is absent or the
caller is under-authorized: same `title`, naming no entity noun, and the same
`detail`, `URL not found or invalid authorization.`. A signing key the server
cannot resolve is answered the same way, since resolving it is part of
authorization. Revocation submission's body-shape and chain-verification checks,
and Create Space's `id-conflict` existence check, run only after the invocation
verifies, so their 400s cannot be used to probe whether a scope or a Space id
exists. The full rules are in
[docs/request-pipeline.md](docs/request-pipeline.md).

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
verify a delegation proof (the invocation path, the revocation chain check, and
the revocation's own invocation), because grants a wallet recorded under the old
suite are submitted back for revocation. The two suites are told apart by
`proof.type` and `proof.cryptosuite`, so the links of one chain may mix them.
The service description's `zcapCryptosuites` names `eddsa-jcs-2022` alone; the
legacy proof type is accepted but not advertised.
