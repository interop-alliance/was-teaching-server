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

- **`src/start.ts`** — entry point. Reads `SERVER_URL` / `PORT` from env, calls
  `createApp()` and `listen()`.
- **`src/server.ts`** — `createApp({ serverUrl })` builds the Fastify instance,
  registers plugins (cors, static, view, multipart), decorates the instance with
  `serverUrl`, and registers the four route groups.
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
  failure). `captureRawBody` also bounds what it buffers, by the route's
  `bodyLimit`, which `src/lib/bodyLimit.ts` derives from the active backend's
  `maxUploadBytes`: the body is read in the hook (`readBoundedBody`, the one
  bounded reader `readTextBody` shares), so an over-limit body is refused with
  `payload-too-large` (413) at the byte that crosses the limit, before any
  signature is verified and whichever parser the media type reaches, and the
  refusal closes the connection. A signed multipart body, which
  `@fastify/multipart` reads off the raw request itself, is tapped rather than
  piped: the hook hashes it as busboy reads it and leaves the verdict on
  `request.multipartDigest`, which the multipart write path awaits before it
  stores anything.
- **`src/zcap.ts`** — `handleZcapVerify()` performs the capability-invocation
  signature verification against the Space controller's key.
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
  The terms "Space Description" and "Collection Description" are retired;
  storage exposes one validator pair per container, `metaGeneration` /
  `metaVersion`, through `writeSpace` / `getSpaceMetadata` and `writeCollection`
  / `getCollectionMetadata` -- there is no separate `writeCollectionMetadata` /
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
  container already has a Metadata object, `ETag` or not. The validator is
  embedded in the stored record as reserved `_generation` / `_version` members
  -- the filesystem backend keeps one file per container (`.space.<id>.json`,
  `.collection.<id>.json`) holding the wire body and the validator together --
  and as `meta_generation` / `meta_version` columns on the Postgres `spaces` and
  `collections` rows, kept out of the wire body; it is emitted on Read Space /
  Read Collection and on the Create/Update responses. A Space Metadata write is
  serialized per Space (the `spacemeta:` lock in the filesystem backend, an
  advisory lock plus row lock in Postgres) and a Collection Metadata write per
  Collection (the `cmeta:` lock), so the check and the version bump are atomic.
  Reads are conditional the other way round: a GET/HEAD carrying `If-None-Match`
  is parsed by `parseIfNoneMatch` into the set of validators the client holds
  (RFC 9110 weak comparison, list and `*` forms), and a handler answers 304 Not
  Modified with the `ETag` and no body when that set covers the current one
  (`isNotModified`, sent by the shared `requests/notModified.ts` helper). The
  decision sits in each read handler, after authorization, so an
  under-authorized conditional read still gets the 404 mask. A Resource or chunk
  GET consults the stored metadata first when the header is present and opens
  the byte stream only on a miss. A representation with no validator (a legacy
  Resource, or metadata never written) is matched only by `*`, which RFC 9110
  makes true for any current representation; its 304 then carries no `ETag`, as
  its 200 would not. Responses to non-idempotent POSTs are marked
  `Cache-Control: no-store` by an `onSend` hook in `routes.ts`; a slash-variant
  redirect and a POST route registered with `config.safe` (Query and Export,
  reads that use POST to carry a body) stay cacheable. The spec defers further
  `Cache-Control` semantics.
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
  `state`, with a `history: { method, resource }` member stamped on (`method`
  from the genesis line's `parameters.method`, `resource` the log's own URL);
  the stored Collection Metadata object never carries that derived member, a
  direct `encryption` write against it is refused with
  `encryption-history-log-governed` (409), and its other fields still update
  normally. The server verifies neither proofs nor a hash chain: it checks that
  the body is JSON Lines, each line a JSON object with an object `state` member
  and the last line the head (`invalid-request-body`, 400 on a break), that an
  append fast-forwards the stored log (the stored bytes verbatim followed by
  exactly one new line; a body the stored log is not a prefix of is
  `precondition-failed`, 412, with or without `If-Match`, and one adding other
  than one line is `invalid-request-body`, 400), and on every append it runs the
  same encryption-descriptor transition checks against the prior head that an
  ordinary Collection Metadata update runs. The fast-forward rule keeps the log
  append-only at the server: a write capability can add history but not erase
  it, while a break inside an appended entry stays the verifying reader's to
  detect. A log write also bumps the Collection Metadata object's own `ETag`,
  since its served content changed, but leaves its `updatedAt` untouched -- both
  backends advance only the version counter -- and is serialized with Collection
  Metadata writes through the same per-Collection lock.
- **`src/serviceDescription.ts`** -- the service description (spec "Service
  Description"): `GET /service`, unauthenticated, serving the JSON document that
  lists three entries in its `specs`. The core entry, under the
  `https://w3id.org/pws` identifier, names the spec version this server speaks
  (`0.5`), the Spaces Repository URL, and the `features` tokens naming the
  optional sections of the core spec this server serves, `changes-query` among
  them. A Backend descriptor advertises no tokens of its own. Conditional writes
  and the `epoch` stamp are baseline guarantees of every backend a Collection
  may be created on, since the server -- not the storage engine -- serializes
  each write and mints its own opaque validator; a content hash would serve as a
  strong validator as well as the version counter used here. The entry under
  `https://w3id.org/pws/authz-profile` names the zCap authorization profile
  version (`0.1`) and its rendered location, and carries the accepted
  `signatureAlgorithms` and `zcapCryptosuites` (profile
  ["Service Description Entry"](https://w3c-ccg.github.io/wallet-attached-storage-spec/authz-profile/#service-description-entry)).
  Listing the profile is how a client learns this server authorizes with
  capability invocations, before its first signed request. The last two members
  are read off `zcap.ts` (`INVOCATION_SIGNATURE_ALGORITHMS`,
  `delegationProofCryptosuites`), so a change to what verification accepts
  changes the advertisement too. The third entry, under
  `https://w3id.org/pws/encrypted-collections`, is the Encrypted Collections
  profile (version `0.1`). Listing it at all is this server's claim that it
  serves the chunk endpoints -- no token names those -- and its `features` array
  names the profile's two optional affordances this server serves,
  `blinded-index-query` and `governed-history-logs`. Those two moved here off
  the Backend descriptor: they are affordances of that companion specification,
  not of a storage engine. The document is built per `serverUrl` and served with
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
- **`src/storage.ts`** — supplies `defaultBackend()`, the `FileSystemBackend`
  (rooted at `data/`) that `createApp()` uses when no backend is injected. The
  active backend is injected via `createApp({ backend })` and decorated onto the
  instance as `request.server.storage`.
- **`src/backends/{filesystem}.ts`** — interchangeable persistence
  implementation (`implements StorageBackend` from `src/types.ts`). A backend
  offers no precondition primitive of its own to a client: the server serializes
  the write and evaluates `If-Match` / `If-None-Match: *` atomically with it, so
  every backend honors both unconditionally. Each backend's `exportSpace` builds
  the archive's entry tree out of its own storage and hands it to
  `packSpaceArchive`; the per-Space archive codec itself -- the file-name
  dialect, the `manifest.yml` document and the packer -- lives in
  `@interop/space-archive`, shared with the wallets that read a backup, and
  `src/lib/importTar.ts` reads the same dialect back. The codec is isomorphic
  and resolves a streamx-based tar-stream `Pack`, which the backend wraps with
  `Readable.from`. `test/space-archive-fixture.test.ts` pins this server's entry
  trees against the archive fixture that package checks in.
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
  bookkeeping rather than user data and is excluded from List Spaces; a wallet
  reaches its auxiliary Space through the account document's service entry
  instead. Its `url`, and the `Location` of a newly created Space, carry the
  trailing slash.
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
  where its log happens to live.

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

**Chain inspection:** after signature verification, the dereferenced chain
passes through two composed inspectors. The revocation inspector
(`lib/revocations.ts`) fails a chain containing any capability with a stored
revocation, with an error named `CapabilityRevokedError`. The annex-chain
inspector (`lib/clientAnnexClause.ts`) bounds what a _ladder_ verification
method may delegate. A ladder VM is the stable, credential-derived method a
wallet publishes on a ladder-anchored account document, recognized by relation
asymmetry: a `capabilityDelegation` member of the resolved self-hosted
`did:webvh` document that is absent from `capabilityInvocation`. A delegation
signed by one is admitted only in one of four shapes.

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
latter) with `allowedAction` within {GET, PUT}.

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
the annex garbage collector re-points that entry first and tolerates a refused
revocation. It also holds for an annex a `did:key` controller delegated to
directly, where no delegator document exists to walk.

Both inspectors bind the capability decision only. A refusal falls through to
the target's access-control policy like any other failed verification, so a
world-readable read still serves. The clause is fail-open across servers: a
server running unmodified verification accepts exactly what this clause refuses,
so a wallet publishes a ladder VM only on a host it assumes enforces the
client-annex profile. That assumption is unverified: the profile's service
description entry (profile
["Service Description Entry"](https://w3c-ccg.github.io/wallet-attached-storage-spec/authz-profile/#service-description-entry))
advertises the algorithms and cryptosuites a server accepts but defines no
member for advertising the clause, and this server advertises nothing.

**The container rule** (`lib/containerRule.ts`): an unsafe method at a container
URL is controller-only, with two exceptions. The hazard is that a data grant's
`invocationTarget` is the container URL itself, and the zcap library's target
attenuation is a `/`-boundary prefix rule, so nothing separates writing a
Resource under a Collection from rewriting or deleting the Collection.
`PUT /space/<S>/meta` on an existing Space and `DELETE /space/<S>/<C>/` accept
nothing else: any delegated invocation is refused there, whatever its
`allowedAction`. That refusal turns on nothing but whether the
`Capability-Invocation` header embeds a delegated capability -- a root
invocation carries only the capability id, a delegated one embeds the capability
itself -- so `handleZcapVerify` decides it straight off that header, before
signature or chain verification: no chain is dereferenced and no delegation
proof is verified for a request refused this way. The other two rules below
still need the dereferenced chain, since they admit some delegated shapes and
not others; a third chain inspector, composed first because it resolves nothing,
reads the invoked capability -- the chain's tail -- for those. A chain of length
one is the synthesized root alone, so a direct root invocation always passes.
`DELETE /space/<S>/` also accepts a delegated capability whose tail targets
exactly that Space's canonical trailing-slash URL with `allowedAction` exactly
`['DELETE']`; a single-verb DELETE grant is not a data grant, which is why the
exception is keyed on the exact action set. `PUT /space/<S>/<C>/meta/log` also
accepts one whose tail targets exactly the Space's items subtree, the
trailing-slash Space URL a wallet's generation delegation carries, so a
transient session can put a Collection under log governance or append to its
log; the guarded create of that log is the declaration that starts governing the
Collection's `encryption` descriptor and refuses every direct `encryption` write
from then on. A tail aimed at the Collection container URL, at the log URL, or
at a Resource stays refused there. `PUT /space/<S>/<C>/meta` carries no rule: a
tail on the Space subtree, on the Collection container URL, or on the Metadata
URL itself writes the object. An app holds a Collection-scoped grant, not a
Space-subtree one, and declares its own indexes and `encryption` on that
Collection through this write. The prefix hazard is weak there, since a holder
of a Collection data grant already writes and deletes every Resource in it, the
`encryption` descriptor is immutable once set, and Delete Collection stays
controller-only. Create Collection (`POST /space/<S>/`) is outside the rule. The
tail alone is read, so a DELETE-only child of a two-verb management parent still
deletes the Space, and the rule says nothing about who signed any link: it holds
whatever DID method the controller or a delegator uses. The client-annex
clause's two invocation-time bounds close that gap between them. The ladder
bound runs on a chain carrying a ladder-signed link. The transient-annex bound
covers the case the ladder bound cannot: a generation delegation signed by an
enrolled client's key, carrying no ladder-signed link at all, narrowed
downstream into a DELETE-only child by a transient annex verification method. It
refuses any chain carrying a link signed by that kind of method outright,
whatever shape the link or the links above it have. The two compose rather than
overlap. This rule refuses first on the invoked shape; the clause still refuses
a ladder-signed or transient-annex-signed chain this rule would admit, reading
those links instead of the tail. The clause's `PUT`-on-Space-Metadata branches
are now shadowed by this rule: this rule already refuses any delegated
`PUT /space/<S>/meta` regardless of chain composition, so the clause's own
refusal there never decides anything on its own and is kept only as defense in
depth. Its `DELETE`-on-canonical-Space-URL branches still decide a case this
rule does not: this rule reads only the tail, so a ladder-signed link earlier in
the chain that is not itself target-exact-DELETE-only, later narrowed to that
shape by attenuation, passes this rule but is still refused by the ladder bound.
Any chain carrying a transient-annex-signed link is refused by the
transient-annex bound regardless of the tail's shape. A refusal binds the
capability decision only and surfaces as the ordinary masked `not-found`, since
all four handlers are capability-only.

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
and `proof.cryptosuite`, so the links of one chain may mix them.
