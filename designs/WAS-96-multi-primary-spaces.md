# WAS-96: Multi-primary Spaces (design)

- item: WAS-96
- status: approved
- approved: 2026-10-02
- wire-level decisions contained: listed in section 5 under "Wire-level
  decisions", all signed off; the read-only-switch problem type is WAS-179's
- decision records extracted: contract-binding, in portable-web-spaces-spec's
  decisions: 0009 (origin-stamped write identity), 0010 (the stamp validator and
  the local container segment), 0011 (Collection tombstones, delete wins), 0012
  (immutable Collection descriptors are creation-only), 0013 (replication is a
  pull-only companion spec); the spec roadmap items WASS-47 to WASS-51 carry
  them into spec text. Server-internal, in this repo's `decisions/`: 0003 (one
  server key for export and sync), 0004 (stamps are minted only by this server),
  0005 (the local validator segment and `replicas` on the Space object). The
  records hold the canonical text; this doc is the derivation

## 1. Problem and scope

A Space lived on one server. Every capability's `invocationTarget` embeds that
server's URL, and the only multi-writer case was many clients pushing to one
server, which serializes them. The item makes a Space live on more than one
server, each accepting writes to the same Collections, with the servers
converging. With two primaries there is no total order over a Collection's
writes, only each server's local commit order. Everything below follows from
that.

The design settles six decisions:

1. Conflict model: a per-Collection `revisions` descriptor; last-writer-wins
   (LWW) only in v1.
2. Write identity: a hybrid logical clock (HLC) stamp plus an origin id, minted
   at the origin and replicated verbatim.
3. Validator: `"<generation>.<ms>.<counter>.<originId>"`, replacing the
   per-server counters, with a fifth local segment on container Metadata
   objects.
4. Checkpoints: the per-Collection opaque checkpoint of the `changes` profile,
   with the stamp on each feed document doing the dedup.
5. Sync: pull only, with a per-kind apply rule, Collection tombstones, and a
   clock bound.
6. Identity and registration: host-bound targets, a per-server replica
   registration, the server's own DID as the sync signer, and controller
   resolution from a replicated log.

Out of scope: `keep-conflicts` and stale-`If-Match`-as-sibling (reserved); chunk
replication (WAS-14, designed separately); tombstone retention (WAS-13);
server-signed checkpoints (WAS-36); a read-only replica switch (WAS-179);
host-independent (DID-relative) capability targets, future spec work; a
reader-safety watermark, which only matters if per-Collection write
serialization is ever relaxed.

## 2. Invariants

How the design meets each invariant it touches.

1. The validator layout. The per-record `version` and `metaVersion` counters are
   replaced by the origin stamp. The origin id joins the validator because two
   origins can mint the same `(ms, counter)` for one Resource. A client no
   longer reads the trailing segment as a revision number.
2. A generation is minted when a record's life starts and kept for that life.
   Upheld, with "this server" replaced by "the creating write's origin". Two
   servers re-creating one id while partitioned mint two generations, and the
   creating stamp picks the winner.
3. A Resource's `/meta` object is its own record. It carries its own stamp and
   generation, nested as `meta` on the sidecar, the feed document, the
   provenance statement and the served `/meta` object. A `/meta`-only write
   stamps the `/meta` record alone, so the content `ETag` does not move, and it
   no longer touches `writerId`, which belongs to the content record.
4. A hard delete of a Collection removes its record. Changed: Delete Collection
   leaves a stamped tombstone that reads as absent everywhere except the
   tombstone-aware listing and the apply path. A Space is still hard-deleted.
5. No write creates a container implicitly, and every other write re-checks its
   container under the delete lock. Upheld. The apply path is one more writer
   under the same re-check, and the registration is bound to the Space's
   generation, so a loop that outlives Delete Space, or a registration that
   survives a re-create under the same id, applies nothing.
6. The self-hosted `did:webvh` rule: resolution from a local storage read. Kept
   for controllers. A DID hosted on a replication peer resolves from the local
   copy of its log, through the registration mapping of section 5.11, with no
   network fetch.
7. `resolveServerDid` requires the export key under `assertionMethod` alone. The
   same key may also be listed under `capabilityInvocation`, which is what turns
   on sync signing; the other relationships stay refused.
8. Network resolution of a foreign `did:webvh` is refused. Changed in one
   bounded form: a foreign DID with no stored log may invoke a delegated
   capability on the WAS routes, fetched only after a local-only pre-pass
   verified the chain, under host, size, rate and cache bounds (section 5.10).
9. The container rule. Upheld, and the `replicas` sub-resource is
   controller-only for every method, reads included, since the record holds a
   delegated capability.
10. The Space Metadata and policy caches rest on a single-instance deployment.
    Upheld. The apply path counts as a write and drops the same entries,
    including the `did:webvh` document cache keyed by log location.
11. The feed rules: a per-Collection position taken in the write's critical
    section, an opaque checkpoint scoped to the issuing server. Upheld. A
    replicated write takes a fresh local position; positions are not replicated.
    The checkpoint embeds the Collection's feed generation, so a re-created
    Collection restarts a reader instead of skipping its first writes.
12. `writerId` is not an input to any server decision. Upheld. The order key is
    `(ms, counter, originId)`. A client orders stamped records by it and keeps
    `(updatedAt, writerId)` only for a local edit with no stamp yet.
13. `createdBy` is server-verified, record-on-create-only. Upheld. A replicated
    Resource carries the origin's value verbatim; the receiver does not resolve
    it.
14. Export provenance attests server-managed members. The claims are the stamp
    members. A statement for a record whose `originId` is not the exporting
    server's omits `createdBy`, so a peer's unverified claim is not laundered
    into a `verified` statement; import strips it on that object.
15. The `encryption` and `revisions` transition checks run on every Collection
    Metadata write. Upheld at the origin. The apply path stores the stored
    projection under LWW and merges the immutable members forward (section 5.7),
    and the members are creation-only, so a merge cannot regress them.
16. `did.jsonl` only grows. Upheld. The apply path uses the fast-forward rule; a
    prefix is a no-op and a fork stalls the Collection. A fork is permanent on
    both sides, and any holder of a write grant on the Collection can create
    one, since a create is not verified.
17. The service description is built per `serverUrl` with a content-hash `ETag`.
    Upheld. `originId` sits on the core `specs` entry, since registration gates
    on it and a client must not gate on `instance`, and a
    `https://w3id.org/pws/replication` entry claims the facet.
18. A strong validator moves with the representation, on a derived-member change
    too. A container Metadata object's `ETag` carries a fifth, local segment
    that a backend or replica registration and a governed-log append advance;
    the four-field stamp stays the replication order. Served container objects
    are therefore not byte-identical across replicas, and the byte-equality
    claim is scoped to Resources.
19. Server-derived members are ignored in a write body. Upheld. The apply path
    takes the stored projection: it strips `url`, `linkset`, `backends`,
    `replicas`, `createdBy`, `controller` and `type` from the Space object, and
    the derived `encryption` from a governed Collection.
20. The proposed controller must resolve before it is stored. Upheld by making
    `controller` per-server state that is not replicated. The controller
    promotes each replica itself, authorized by the stored `did:key` there. The
    apply path writes `name` only.
21. Policies are versioned records with a stamp, a generation and a tombstone,
    so a deleted public-read policy does not come back from a peer that still
    holds it.
22. The reserved path segments. `replicas` and `zcaps` join the Space-level
    registry; without it the client-annex clause's fourth shape would admit a
    ladder-signed `GET` of a registration record.
23. Per-Collection uniqueness and `immutable` are enforced atomically at write
    time. Upheld per origin only. Two partitioned creates claiming one unique
    value, or one write-once id with different digests, both land, and the
    converged Collection holds both or LWW keeps one. Recorded in the spec as a
    limitation.
24. Quotas and the upload cap apply on every write. Upheld on the apply path: a
    replica smaller than its source refuses the apply as a durable
    per-Collection stall, not a skip and not a bypass. Tombstoned Collections do
    not count.
25. The store layout file holds the layout version. It also holds the origin id
    and the clock's high-water mark, and `writeStoreVersion` preserves members
    it does not own.
26. Two facets sit outside the route structure. The sync loop is a third, with
    storage access and outbound network, and AGENTS.md names it.

## 3. Consumers

Changed in this repo:

- `src/lib/etag.ts`, `src/lib/preconditions.ts`, `src/lib/metadataValidator.ts`
  and every `formatEtag` / `etagOf` / `parseWritePreconditions` caller in the
  request classes: the four-segment validator, the local segment on containers.
- `src/lib/hlc.ts`, `src/lib/originId.ts`, `src/backends/filesystemStore.ts` and
  the Postgres store row: the clock, its high-water mark, the origin id.
- Both backends' stored layouts: the stamp members in sidecars and rows, the
  nested `meta` stamp, the Collection tombstone, the stamped policy, the
  `replicas` records and loop state, the `apply*` methods.
- `src/lib/revisions.ts`, `src/lib/governedLog.ts`: the descriptor and its slot
  in the governing log's `state`.
- `src/lib/changesCheckpoint.ts`, the feed in both backends: `kind`,
  `contentType`, the stamp and `generation` on every document, the generation in
  the checkpoint.
- `src/sync/`, `src/lib/replicaApply.ts`, `src/lib/syncIdentity.ts`,
  `src/lib/webvhLogLocation.ts`, `src/lib/peerWebvh.ts`,
  `src/requests/ReplicaRequest.ts`: the facet.
- `src/lib/spaceProjection.ts`: `replicas` beside `backends`.
- `src/lib/provenanceStatement.ts`, `exportProvenance.ts`,
  `importProvenance.ts`, `importTar.ts`: stamp claims, the `createdBy` rule, the
  archived tombstone.
- `src/lib/validateId.ts`: `replicas` and `zcaps` reserved.
- `src/serviceDescription.ts`: `originId` on the core entry, the replication
  entry.

Outside this repo, recorded as `touches` on the roadmap items: storage-core's
record types, `ReplicaStallReason` and `ServiceDescription`; was-client's
`parseEtag` and acks; wallet-core's push and remint paths and its single-host
account invariants; was-sync's persisted RxDB schema and `statesEqual`;
was-react; dcw's schema; `@interop/space-archive`'s codec and fixtures;
`@interop/wallet-backup`'s archive survey; the conformance suite's exact-shape
asserts; the Encrypted Collections profile's `version` members and `state`
schema; the core spec's `instance` gating rule, reserved registry and Collection
delete sentence.

Unchanged consumers resting on a new assumption: the `If-None-Match` 304 path
assumes a Resource's validator is byte-identical on every replica, which holds
for Resources alone; the import plan assumes stamps are re-minted on import; the
client-annex clause depends on the DID parser accepting a replicated DID.

## 4. Edge cases

How the existing flows behave under replication. Everything not listed is
unchanged.

- Create Space: per server, by the controller. `controller` is never applied,
  and `type` must match at registration.
- Update Space Metadata: `name` applies under LWW; `controller`, `type` and the
  server-derived members are stripped. Promotion to a peer-hosted DID is done
  per replica, resolving from the local copy.
- Delete Space: per replica. The apply path never deletes a Space. The
  registration dies with the Space, and the peer's loop backs off on the 404. A
  deleted log copy leaves other Spaces that DID controls without a controller.
- Create Collection: a replicated Collection Metadata object creates the
  Collection on apply. A create over a tombstone mints a new generation and
  reads the tombstone as absent for `id-conflict`, the quota, `If-None-Match: *`
  and the provenance carry-over.
- Update Collection Metadata: LWW on the stored projection, immutable members
  merged forward, two different set values a fork. A `backend.id` keeps its
  meaning across servers; one this deployment does not configure stalls as
  `unsupported-backend`.
- Delete Collection: the tombstone applies by stamp and cascades, and wins over
  a newer member write. A replicated tombstone of a log Collection removes the
  controller on the replica too.
- Resource write: applied when the stamp is greater than the held one and the
  `GET`'s `ETag` equals the feed's, else skipped or retried. Refused under a
  Collection tombstone, which advances the checkpoint. Under `immutable`, both
  partitioned creates land and LWW keeps one. A write on a one-way replica never
  reaches the source.
- Resource `/meta` write: LWW by the `/meta` record's own stamp. One stamped
  after a Resource tombstone is skipped while the tombstone holds.
- Governed log and `did.jsonl` append: fast-forward; a prefix is a no-op; a fork
  stalls the Collection. The wallet may append on the replica directly for
  disaster recovery, after which the copy leads and a fork is permanent.
- Export Space: statements attest the stamp members, `createdBy` omitted for a
  foreign origin; tombstoned Collections are archived as tombstones; the
  registration is not exported; a log copy exports as a Resource.
- Import Space: every stamp re-minted with the importer as origin, the archived
  stamps read for provenance only; tombstones restored when the destination
  holds nothing under the id; import never creates a registration; import is
  skip-not-overwrite, so an archived body differing from a stored write-once one
  is skipped.
- Changes feed pull by a client: documents carry the stamp members and `kind`; a
  replicated write surfaces at a local position; a checkpoint from another feed
  generation is refused (400) and the reader restarts.
- Policy write and read: stamped and tombstoned, LWW on apply, cache dropped. A
  Collection policy dies with the Collection tombstone.
- Revocation submit and keystore operations: per replica, not replicated. A
  submitted chain resolves a peer-hosted controller from the copy.
- Client-annex clause: reads the invoked chain, not the write's origin. The
  annex log's auxiliary Space must be registered too, and the pull delegation
  cannot be ladder-signed.
- Backend registration: per-server Space state, moving the local segment only.
- Clock bound exceeded by a received stamp: `clock-bound` stall on that
  Collection, which clears as local time catches up.
- Quota refused on apply: a durable `quota-exceeded` stall naming the quota.
- Two-way pair: an echoed stamp compares equal and is skipped, so nothing
  travels round.

## 5. Design

### 5.1 The `revisions` descriptor

`CollectionMetadata.revisions?: { resolution?, immutable?, merge? }` in
storage-core, held by `src/lib/revisions.ts`. `resolution` is a closed set with
one value, `last-writer-wins`, also the default; an unknown value (the reserved
`keep-conflicts` included) is `invalid-request-body` (400). `immutable` is a
boolean, default `false`. `merge` is served verbatim and not read.

`resolution` and `immutable` are creation-only, as `encryption` is: declared by
the write that creates the Collection (Create Collection, a create by
`PUT .../meta`, or a governing log's guarded create), and a change to a set
value is `revisions-immutable` (409). A governing log's `state` has a
`revisions` slot, and a direct write on a governed Collection may restate but
not change it.

`immutable: true` is the write-once rule, decided on both backends inside the
write's critical section: an update of a live Resource is `resource-immutable`
(409); a repeat create with an equal body `Digest`, or a create over a tombstone
with one, is a no-op answering the current `ETag`; a different digest is
refused. Chunks inherit the descriptor. The rule holds per origin: two
partitioned creates with different digests both pass their origin's check and
LWW keeps one, and an update stamped before the flag arrived but applied after
it is stored.

### 5.2 The origin id

`StorageBackend.originId`, one per store, read from `store.json` (filesystem) or
the `store` row (Postgres). `WAS_ORIGIN_ID` is used verbatim when set; a
mismatch with the stored id refuses boot naming both. Otherwise a random 16-byte
base58 id is minted on first boot, under the store lock, and kept for the
store's life. The charset is `[A-Za-z0-9_-]{1,64}`. It is advertised on
`/service` as `originId` on the core `specs` entry.

A cloned data directory carries its origin id with it, so a restored clone that
runs beside its source must boot with a fresh `WAS_ORIGIN_ID`; the admin guide
says so. The apply path refuses a received stamp whose `originId` equals the
local one. Data-plane backend adapters share the hosting server's origin id and
mint no stamps of their own.

### 5.3 The write stamp and the validator

`src/lib/hlc.ts` holds one clock per backend. `now()` returns `{ ms, counter }`
by the HLC send rule, and `observe()` takes a received stamp in by the receive
rule, refusing one more than the clock bound ahead of physical time. A stamp is
minted inside the write's critical section, as
`max(hlc.now(), held stamp + one counter tick)` after the clock observes the
held stamp, so an overwrite sorts above what it replaces even when physical time
stepped back or the process restarted. The clock persists a high-water mark of
its physical part about once a second, and once more on `close()`, and starts
one millisecond past it at boot. The physical clock is injectable.

Every versioned record stores `updatedAt` (the ISO string of `ms`),
`updatedAtCounter` and `originId`. The order key is `(ms, counter, originId)`,
the first two numerically and the origin id by plain string comparison. The
`ETag` is `"<generation>.<ms>.<counter>.<originId>"`; a container Metadata
object appends a fifth, local segment, a per-server counter that a backend or
replica registration and a governed-log append advance and a stamped write
resets to 0. Resources keep the four-field form, which the 304 path relies on. A
container's `If-Match` compares all five.

A Resource has two stamp sets: the content record's, served top-level, and the
`/meta` record's, nested as
`meta: { updatedAt, updatedAtCounter, originId, generation }`. `epoch` and
`writerId` belong to the content record.

One server process per store. Two processes over one store would share its
origin id and could mint one stamp for two writes. The requirement is recorded
beside the read caches that already rest on it.

On the filesystem backend the sidecar, which holds the stamp and the feed
position in one write, is the commit point: the representation lands first under
a name the sidecar then points at, so a torn write reads as the prior revision.
A received stamp is shape-checked before it is stored.

### 5.4 Collection tombstones

Delete Collection writes a tombstone in place of the Collection Metadata object,
`deleted: true` plus the delete's stamp, and still cascades to Resources,
chunks, policies and the governing log. The tombstone reads as absent everywhere
except the Space listing under `?include=deleted` and the apply path: the
container re-check, `If-None-Match: *`, `id-conflict`, the Collection quota,
`totalItems`, import's existence check, the backend registry and the provenance
carry-over all treat it as absent. A create over it mints a new generation. A
second Delete Collection answers 404, while one of an id never used answers 204.

The cascade is resumable. The tombstone is written first, so a tombstone with
members still present is an unfinished cascade detectable from durable state,
finished at boot, on any touch of the Collection, before a create over it, and
by the apply path. Postgres does the delete in one transaction.

Two lives of one Collection id are ordered by their creating stamps, since their
generations are random. The creating stamp is a served, server-managed member of
the Collection Metadata object, `created`. A received life created after the
held one replaces it as tombstone-then-create, members included; one created
before it is skipped. A tombstone carries no generation and no creating stamp:
it removes any life created before its own stamp, and a received life is created
over a held tombstone only when its creating stamp is greater.

Delete wins. The cascade removes members whose stamps are newer than the
tombstone, and a member write refused under a tombstone advances the checkpoint.
This is a stated exception to greater-stamp-wins, the one Cassandra and Riak
document for container deletes. A controller who wants the member back
re-creates the Collection and the Resource.

### 5.5 Discovery: the widened `changes` feed

The `changes` profile carries every record kind a puller needs. Every Resource
write and tombstone takes a feed position whatever its content type, with a
`contentType` member on the document; a Collection Metadata write, a Collection
or Resource policy write or tombstone, and a governed-log append each take a
position too. Every document carries a required `kind` from a closed set
(`resource`, `collection-metadata`, `policy`, `log`), its write stamp, its
`generation` and its `etag`; a `resource` document also carries the `meta` stamp
once metadata was written, and the non-Resource kinds carry the record's
absolute URL as `id`. A consumer skips a `kind` it does not know. A tombstone is
marked `deleted: true`, the one name for a tombstone on every object; was-sync
maps it to RxDB's `_deleted` at its boundary.

The feed stays per Collection, so the checkpoint and the stall unit are per
Collection. Space-level state has no Collection feed to ride: Space Metadata
`name`, the Space policy and Collection tombstones are discovered by the
tombstone-aware Space listing and conditional `GET`s of the Space's `meta` and
`policy`, where a policy tombstone reads under `?include=deleted`.

The feed has a read-only form for the loop,
`GET /space/:spaceId/:collectionId/query?profile=changes`, with `checkpoint` and
`limit` in the query string, since a pull capability carries `GET` and `HEAD`
only.

### 5.6 Registration and the pull loop

A replica registration is a controller-only sub-resource of the Space,
`/space/:spaceId/replicas` (`GET` lists as `{ url, totalItems, items }`, `POST`
adds) and `/space/:spaceId/replicas/:replicaId` (`GET`, `DELETE`, no `PUT`),
every method controller-only through the container rule, reads included. The
record is a directed edge the controller writes and reads back unchanged under
its own `ETag`: `id` (client-supplied, `id-conflict` on a duplicate),
`fromSpace` (the peer Space's canonical URL), `toSpace` (the local Space's),
`capability` (the pull capability, delegated to this server's DID with
`allowedAction` within `GET` and `HEAD`), an optional `collections` list of
`{ id }`, and `role` (`source`). Runtime state is served at
`GET .../replicas/:replicaId/status`, controller-only and uncacheable: `state`
(`idle | pulling | backing-off | stalled`), the pull times, `nextPullAt`, and
`collections`, each `{ id, state, lastAppliedAt, stall? }` with `state` from
`synced | syncing | stalled | skipped` and `stall` as
`{ reason, since, detail }`.

The record is stored inside the Space (`.replica.<id>.json` beside
`.replica.<id>.state.json` in the filesystem Space dir, a row of the Postgres
`replicas` table), so Delete Space removes it. It carries the Space's
generation. It is not replicated and not exported, and the stored capability is
served to its controller only. Storing or removing one advances the Space
Metadata object's local segment, since the served `replicas` member
(`[{ fromSpace, toSpace, role }]`, derived beside `backends`) changed. The
topology disclosure is accepted: the object's readers are the controller's own
sessions or a holder of a Space-wide grant the controller issued.

A registration passes these checks before it is stored, a break of one being
`replica-refused` (409): the local Space is not the `server` Space; this server
has a sync signer and the capability is delegated to its DID; the peer's
`/service` lists the replication entry at this server's version and an
`originId` that is not this server's; the peer Space, read through the
capability, has the local Space's `type` set and a controller the local one
matches (equal, or a `did:webvh` hosted in the peer Space whose current document
lists the local `did:key` under `capabilityInvocation`, read through the
capability and verified offline); each Collection both sides hold agrees on the
immutable members; and no other local Space already replicates the same peer
Space with a Collection in common. The peer Space's id need not equal the local
one. Delete Replica and Update Space are refused when they would leave a local
Space's `did:webvh` controller with no copy of its log to resolve from.

One loop per registration starts at boot and on registration. A cycle reads the
peer Space's Metadata object and policy conditionally, then its Collection
listing under `?include=deleted`. The `collections` list selects among the
listed Collections, and the Collection holding the controller's log is always
selected and pulled first. For each selected live Collection the loop applies
the Collection Metadata object when this server does not hold that life, then
reads the `changes` feed from the stored checkpoint and applies each document by
`kind`, reading a Resource's content by `GET` or from inline `data` and its
`/meta` for the members the content write set. An `ETag` that no longer equals
the one the feed named means the record moved, and the Collection is read again
next cycle. The checkpoint advances past a document once it is applied or
skipped, and is written only after every apply it covers is durable.

A request to the peer that fails, a 404 for the Space included (which the masked
denial answers for an unresolvable key, an expired grant, or a transient failure
to fetch this server's log), ends the cycle, and the loop backs off, doubling
its delay up to a limit, with one `warn` when the failures begin. Nothing stops
a loop but the removal of its registration. The manager stops every loop in the
`onClose` hook that closes the backend, ahead of it.

The transport (`sync/peerFetch.ts`) is bound as the peer log fetch is: `https`
only, the default port, no redirect followed, public addresses only, checked
after DNS. A plugin option replaces it in tests.

### 5.7 The apply path

`StorageBackend` gains `apply*` methods (Resource, Resource `/meta`, Collection
Metadata including the tombstone, Space Metadata, policy, log fast-forward).
Each takes a record a pull loop read and stores it under the peer's stamp and
generation, inside the critical section the matching request-layer write takes,
under the same container re-check, taking a fresh feed position and dropping the
same cache entries. No request route reaches them. Each checks, in order: the
registration is still stored and was made for the Space's current generation,
else `unregistered`; the clock takes the received stamps in, else `refused` as
`clock-bound`; the record's Collection is live, else `skipped`.

A record is applied when its stamp sorts above the held one and skipped
otherwise; an equal stamp is a record this server already holds. The rules per
kind:

- The input is the stored projection, not the served object (invariant 19).
- Space Metadata: `name` under LWW. Nothing else.
- Collection Metadata: LWW on the stored projection, with the members immutable
  once set (`encryption`, `revisions.resolution`, `revisions.immutable`, and
  `backend`, which keeps the held selection) merged forward. A member the
  incoming object omits and the local one holds is kept; two different set
  values are a fork. `encryption.version` merges by `max`.
- Resource and `/meta`: LWW per record on its own stamp.
- Collection tombstone and the two-lives rule: section 5.4.
- Policy: LWW on its stamp, tombstone included.
- Governing log and `did.jsonl`: fast-forward; a prefix is a no-op; a fork
  stalls the Collection.

Preconditions, the encrypted-Collection envelope rule, the write-once rule and
the unique-attribute claims are not evaluated, since the origin admitted the
write. Quotas and the upload cap are. `controller`, `type`, revocations, backend
registrations and keystores are not replicated.

### 5.8 Stalls and the checkpoint

A stall is per Collection. The checkpoint holds, the reason (`clock-bound`,
`fork`, `quota-exceeded`, `unsupported-backend`, `container-refused`, and the
two chunk-pull reasons) and the position are recorded with the loop state and
served at the `status` sub-resource, and the loop retries that Collection each
cycle while the others continue. A clock-bound stall clears itself. A fork, a
quota or a backend stall clears when the controller removes the cause or deletes
the registration. A refusal under a Collection tombstone is a skip, not a stall.

### 5.9 The clock bound

A received stamp whose `ms` exceeds local time by more than
`REPLICATION_CLOCK_BOUND_MS` (`WAS_REPLICATION_CLOCK_BOUND_MS`, default 60 s,
the value the replication specification recommends) is not applied, and the
Collection stalls as `clock-bound`. The bound does not compound across hops,
since each receiver checks against its own physical time.

### 5.10 The sync signer and peer verification

The one seed key serves export signing and sync signing. The admin lists it in
the server log under `assertionMethod` and `capabilityInvocation`; the server
signs pull invocations as `{serverDid}#{publicKeyMultibase}`, and a controller
delegates the pull capability to `serverDid`, so a key rotation in the log needs
no re-delegation. There is no second key and no `/service` member. Replication
requires the identity: a registration on a server with no advertised
`serverDid`, or whose log does not list the key under `capabilityInvocation`, is
refused.

A peer verifies the invocation by fetching this server's log. The HTTP-signature
verifier resolves the signing key before it reads the capability, so
`handleZcapVerify` runs a pre-pass first: it verifies the embedded delegation
chain to the Space controller with local-only resolution and requires the
invoked capability's sole `controller` to equal the invoker DID. Only then does
the key resolver fetch that one DID's log (`src/lib/peerWebvh.ts`). The fetch is
`https` only, on the default port, follows no redirect, connects to public
addresses only, is size-bounded with a timeout, is rate-limited per host for
first-contact fetches with its own in-flight limits, and the verified document
is cached per DID in an LRU for a TTL, re-fetched at most once per interval when
a signature names a key the document lacks. The log must extend the last head
verified for the DID. A foreign DID with no stored log may invoke but may not
delegate or be a controller; `/kms`, revocation submission, create consent and
List Spaces stay local-only. A fetcher option replaces the fetch in tests.

### 5.11 Controller resolution from a replicated log

A DID hosted on a replication peer, `did:webvh:<scid>:<H>:space:<S>:<C>`, has a
local copy when exactly one local Space X holds a registration whose `fromSpace`
is `https://H/space/S/` and which pulls Collection C. The log is then X's
`C/did.jsonl`, and the resolver reads it through the same verify, cache,
head-record and fast-forward path as a native one, with no network fetch
(`src/lib/webvhLogLocation.ts`). The mapping goes through the registration
because a local Space named S could belong to anyone on this server, and only
the peer Space's controller can make one. When two or more local Spaces map one
DID it does not resolve from storage. Such a DID may be a Space controller, a
keystore controller, a delegator and a `createdBy`; the server identity, the
sync signer and import provenance stay native-only. An applied `did.jsonl` drops
the cached document, so a key retired at the origin stops authorizing after the
next pull.

### 5.12 Grants per replica

Capability targets are host-bound, so every grant a wallet holds names one
server's URL and verifies nowhere else. A controller delegates once per replica,
for every kind: the generation delegation to the client annex, each app's
Collection grant, the annex and transient-session grants, the unlock-Space
management capability and what is minted from it, the bridge grants, the
backup-export grant, and the pull capability itself. On the replica each is
minted anew against the replica's URL, needs the replica's own annex log, and is
revoked there separately. Until the wallet has re-minted on a replica, only root
invocations by enrolled-client keys work there, which is what the replicated
controller log buys.

### Wire-level decisions (all signed off)

1. `revisions.resolution` values: `last-writer-wins`; reserved `keep-conflicts`.
   `revisions.immutable` boolean. `revisions.merge` object, verbatim.
2. `resource-immutable` (409) for a write refused by `revisions.immutable`;
   `revisions-immutable` (409) for a change to a set `resolution` or
   `immutable`.
3. The origin-id charset `[A-Za-z0-9_-]{1,64}`; `originId` on the core `specs`
   entry of `/service`; `WAS_ORIGIN_ID` used verbatim.
4. The stamp members `updatedAt`, `updatedAtCounter`, `originId` on every record
   and feed document, and the nested `meta` object for the `/meta` record; the
   order key `(ms, counter, originId)`.
5. The validator `"<generation>.<ms>.<counter>.<originId>"` with `ms` the epoch
   integer, and the fifth local segment on container Metadata objects, an
   integer counter outside the replication order.
6. `?include=deleted` on the Space listing and on Get Policy.
7. The `replicas` sub-resource paths, record members, `status` shape and stall
   reasons of section 5.6; `replica-refused` (409); the linkset relation
   `https://w3id.org/pws#replicas`; `replicas` and `zcaps` in the reserved
   registry; the `GET` form of the changes query.
8. `replicas` on the served Space Metadata object as
   `[{ fromSpace, toSpace, role }]`.
9. No sync key member and no HKDF label: the one seed key under
   `capabilityInvocation` in the server log.
10. `WAS_REPLICATION_CLOCK_BOUND_MS`, default 60000.
11. The policy document's stamp members and `deleted` tombstone, with `PUT` and
    `DELETE` taking `If-Match` / `If-None-Match: *`.
12. The feed document's `kind` set, `contentType`, `generation`, URL `id` on the
    non-Resource kinds, and `deleted` in place of `_deleted`.
13. The provenance statement's stamp claims and the `createdBy` omission for a
    foreign origin (transitional; WAS-184's write-time creation statement is the
    lasting answer).
14. The checkpoint embeds the Collection feed generation; a mismatch stays
    `invalid-request-body` (400).
15. The archived Collection tombstone: the same `.collection.<id>.json` file,
    body `deleted: true` plus the stamp with `_generation` embedded, no
    Collection directory, `deleted: true` on the manifest entry; `_version`
    leaves every Metadata file and the stamp members are stored bare.
16. The Resource write response: `PUT /:id` answers `201` on create (over a
    tombstone included) and `200` on update, `PUT /:id/meta` `200`, both with
    the `ETag` and a JSON body of the server-managed members (`contentType`,
    `size`, the content stamp; `createdAt` and `createdBy` on a `201`; the
    nested `meta` on a `/meta` write), no `custom`, `epoch` or `writerId`.
17. A store holding any Space whose records carry no stamp is refused at boot
    with `StoreVersionError`; no stamping migration.
18. A `https://w3id.org/pws/replication` entry (version `0.1`) in `/service`
    `specs`, listing it the claim that the `replicas` sub-resource, the pull
    loop and the apply path are served; no `features` token. The stamp members,
    the four-field validator and the widened feed are baseline requirements of
    the core spec version.

## 6. Alternatives rejected

Alternatives 1 to 5 are recorded with revisit criteria in spec decision 0009, 6
to 12, 14 and 15 and the deferral of 13 in spec decision 0013, and 8 also in
spec decision 0011.

1. `writerId` in the tie-break. Unreachable once the stamp carries a counter and
   origin, and the spec forbids it as a server input. Do not reopen.
2. A packed 64-bit stamp. Exceeds JavaScript's safe integer range in JSON. Do
   not reopen.
3. A content-hash validator as the primary. Identical on every replica for free,
   but carries no time, so LWW would need a second field. A content hash may
   return beside the stamp for `keep-conflicts`.
4. The server DID, or the export key's `did:key`, as origin id. Absent on most
   deployments, embeds the host, changes on seed rotation, and nothing verifies
   a stamp. Do not reopen.
5. A client-declared clock, including import restoring archived stamps verbatim.
   A write grant or a delegated importer could mint a revision dated far ahead
   that no honest write beats and that stalls every peer. Do not reopen.
6. Push transport, or a sync-ingest endpoint. A second write path whose
   authorization must say "this caller may assert stamps". Do not reopen for v1;
   revisit only with a receipt or witness design.
7. A vector checkpoint. Not needed while a client replicates against one server
   at a time; can be added inside the opaque value later.
8. Space tombstones. A Space on two servers is two URL identities, each deleted
   by its own root invocation, and the registration dies with the Space. Add one
   if restore-from-replica into a re-created Space ever proves unwanted.
9. A per-Collection replica unit. Space-level state has no loop to ride, a
   deleted Collection is indistinguishable from a revoked grant, and a new
   sibling Collection is invisible. Do not reopen for the unit.
10. Registration as a Space Metadata member, as a controller-document service
    entry, or as operator config. The controller delegates, so the controller
    registers, and the two sides' records must differ. Do not reopen.
11. Network resolution of user controllers from the original host. If that host
    is lost for good the account can never rotate a key again. A replicated copy
    keeps root invocations working on the surviving server. Do not reopen.
12. Excluding the `id` Collection from replication, with the wallet writing each
    replica's log itself. Same disaster-recovery reason.
13. Host-independent capability targets. Deferred, not rejected.
14. Replicating `controller` with a resolve-before-apply rule. A compromised or
    merely different source would take over the replica Space on the next pull,
    or deadlock it with a DID whose log has not arrived.
15. `did:webvh`'s own portable move as the disaster-recovery mechanism.
    Deferred; it moves the account rather than copying it, and interacts with
    wallet-core's single-host account pointer.
16. Minting a stamp on a derived-member change. A local bookkeeping change would
    win LWW on every peer over a real earlier edit.
17. Serving `backends` and `replicas` only at their sub-resources. Reverses the
    decision to carry `backends` on the Space object and does not help the
    Collection object's derived `encryption`.
18. A second HKDF-derived sync key, and a `did:key` signing fallback before the
    log lists the key. Two rotation stories for one holder, and replication on a
    server with no identity.
19. A separate replication listing under the Space, or a per-cycle `GET` of
    every `meta`, `policy` and `meta/log`, as the discovery channel. A second
    checkpoint discipline for the same records, or one request per record per
    cycle and blind to a binary tombstone.
20. Replicating revocations. Targets are host-bound, so a revocation stored on
    one server revokes nothing on another and lets a peer inject unverified
    records. Key retirement through the log is the cross-replica revoke.
21. Stamping existing records at upgrade. Refused at boot instead, under the
    greenfield stance.

## 7. Tests

The HLC and origin-id units (`test/hlc.test.ts`,
`test/filesystem-store-version.test.ts`,
`test/postgres-store-origin-id.test.ts`); the validator layout and the local
segment in the per-route suites and `test/helpers.ts`;
`test/revisions-api.test.ts`; `test/collection-tombstones-api.test.ts`; the
two-server replication suites (`test/replication-api.test.ts`,
`test/mixed-backends-replication.test.ts`,
`test/replicated-webvh-controller.test.ts`,
`test/postgres-replica-apply.test.ts`), which boot two in-process servers with
`startTestServer` and an injected `peerFetch`, pause and resume pulls through
`faults`, and disagree the two physical clocks through the injectable clock; the
server-identity and peer-webvh-resolution suites with an injected log fetcher;
the provenance suites and the re-pinned archive fixtures;
`test/storage-backend-contract.ts` for the `apply*` methods on both backends;
and `pnpm conformance:local`.

## 8. Left to other items

- Chunk replication: WAS-14, designed and shipped separately.
- Tombstone retention, which needs peers to report their position back: WAS-13.
- Whether `keep-conflicts` accepts a stale `If-Match` write as a sibling on a
  single server: the item that promotes `keep-conflicts`.
- Pull cadence and an unauthenticated "changes available" nudge: interval first.
- The multi-process store: WAS-185.
- The write-time creation statement that replaces the `createdBy` omission:
  WAS-184.
- wallet-core's account on more than one host (the chain-head pin keyed by Space
  id, the single `host` in the account pointer, the DID-derived host in the
  annex log), and the per-replica re-mint of every grant in section 5.12: a
  wallet-core item.
- Delete Space's ordering tear between revocations and the Space directory:
  WAS-180.
