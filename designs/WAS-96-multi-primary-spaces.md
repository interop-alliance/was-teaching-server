# WAS-96: Multi-primary Spaces (design)

- item: WAS-96
- status: draft
- approved:
- wire-level decisions contained: listed in section 5 and individually signed
  off
- decision records extracted: none

## 1. Problem and scope

A Space lives on one server today. Every capability's `invocationTarget` embeds
that server's URL, and the only multi-writer case is many clients pushing to one
server, which serializes them. The item makes a Space live on more than one
server, each accepting writes to the same Collections, with the servers
converging. With two primaries there is no total order over a Collection's
writes, only each server's local commit order. Everything in this doc follows
from that.

The design settles six decisions, worked through with the maintainer on
2026-10-01 and summarized on the roadmap item:

1. Conflict model: a per-Collection `revisions` descriptor; last-writer-wins
   (LWW) only in v1.
2. Write identity: a hybrid logical clock (HLC) stamp plus an origin id, minted
   at the origin and replicated verbatim.
3. Validator: `"<generation>.<ms>.<counter>.<origin>"`, replacing the per-server
   counters.
4. Checkpoints: unchanged from WAS-93; the stamp on each change document does
   the dedup.
5. Sync: pull only, with a per-kind apply rule, Collection tombstones, and a
   clock bound.
6. Identity and registration: host-bound targets, a per-server replica
   registration, a sync key, and controller resolution from a replicated log.

Out of scope: `keep-conflicts` and stale-`If-Match`-as-sibling (reserved); chunk
and blob replication (WAS-14); tombstone retention (WAS-13); server-signed
checkpoints (WAS-36); a read-only replica switch (WAS-179); host-independent
(DID-relative) capability targets, future spec work; a reader-safety watermark,
which only matters if per-Collection write serialization is ever relaxed.

The research behind decisions 2 and 3 is `_spec/research-write-stamps.md`
(primary sources: the HLC paper, CouchDB, Riak, Cassandra, CockroachDB, MongoDB,
Dynamo, Spanner, Automerge, Yjs, Cosmos, Firestore, S3).

## 2. Invariant inventory

Each entry: the ARCHITECTURE.md invariant, upheld or changed, how, and the doc
edit that records it.

1. Validator layout `"<generation>.<version>"` (`src/lib/etag.ts:1-24`,
   `EtagValidator` at `:33`). Changed. The per-record `version` and
   `metaVersion` counters are replaced by the origin stamp, and the origin id
   joins the validator because two origins can mint the same `(ms, counter)` for
   one Resource. Doc edit: the `etag.ts` section and the `etag.ts` header
   comment.

2. Generation minted when a record's counter starts, kept for its life; a hard
   delete removes the counter, so a re-create mints a new generation
   (`etag.ts:11-24`). Upheld, with "this server" replaced by "the creating
   write's origin". Two servers re-creating one id while partitioned mint two
   generations and the stamp picks the winner. How a generation is chosen stays
   an implementation detail the spec does not name. Doc edit: same section.

3. A Resource's `/meta` object is its own record, dropped by a soft delete.
   Upheld. The `/meta` object takes the same stamp members; a replicated
   tombstone drops it as a local one does.

4. A hard delete of a Collection removes its record (`etag.ts:17-19`). Changed.
   Delete Collection leaves a stamped tombstone (WAS-174), still cascading to
   Resources and chunks. A Space is still hard-deleted. Doc edit: the `etag.ts`
   section, the Glossary's Collection entry.

5. No write creates a container implicitly; every other write re-checks its
   container under the delete lock (ARCHITECTURE "backends" entry). Upheld. The
   apply path is one more writer and runs the same re-check, so a pull racing
   Delete Space writes nothing into a removed Space.

6. The self-hosted `did:webvh` rule: resolution is a local storage read, never a
   network fetch; only a log this server stores
   (`src/lib/webvhController.ts:385-388`); the head record; the fast-forward
   `PUT`. Changed in one clause (WAS-177): a DID whose host is a registered peer
   and whose log Collection is replicated here resolves from the local copy
   through the same verify, cache, head-record and fast-forward path. Still no
   network fetch for a controller. Doc edit: the Controller and self-hosted
   `did:webvh` Glossary entries.

7. `resolveServerDid` requires the export key under `assertionMethod` alone
   (`src/lib/serverIdentity.ts:344-387`). Upheld for the export key. Changed for
   the server document as a whole: a second, sync key may be listed under
   `capabilityInvocation` (WAS-175). The export key is still refused under any
   other relationship. Doc edit: the `serverIdentity.ts` section and the Server
   identity Glossary entry.

8. Network resolution of a foreign `did:webvh` is refused everywhere
   (`webvhController.ts:385`; WAS-162 context). Changed in one bounded form
   (WAS-175): a DID with path `space:server:id`, named as the invoker by a
   delegated capability whose chain verified to the Space controller, is fetched
   from its host, verified, cached, re-fetched once on a key miss, with a size
   bound and timeout. Every other foreign DID stays refused. Doc edit: the ZCap
   Structure section, "the `did:webvh` resolver on every path".

9. The container rule (`src/lib/containerRule.ts`): an unsafe method at a
   container URL is controller-only, with the listed exceptions. Upheld, and
   extended to the registration sub-resource, which is controller-only with no
   exception (WAS-176). Doc edit: the container rule paragraph.

10. The Space Metadata cache and policy cache rest on a single-instance
    deployment: a write drops entries only in the process that made it
    (`src/config.default.ts:94-141`; ARCHITECTURE `spaceMetadataCache.ts`
    entry). Upheld as stated, and the apply path counts as a write: applying a
    Space Metadata object, a policy, or a `did.jsonl` log drops the same entries
    a request-layer write drops, including the webvh document cache keyed by log
    location. Doc edit: a sentence in that entry.

11. WAS-93's feed rules: a per-Collection feed position assigned in the write's
    critical section; the checkpoint is opaque and scoped to the issuing server.
    Upheld. A replicated write takes a fresh local position; the position is
    never replicated; no vector checkpoint. Doc edit: none beyond WAS-93's.

12. `writerId` MUST NOT be an input to any server decision (spec, "Resource data
    model"). Upheld. The order key is `(ms, counter, origin)`; `writerId` is
    served verbatim as today. The spec's client-side `(updatedAt, writerId)`
    tie-break sentence is revised to say clients pick the winner by the stamp
    order. Doc edit: spec only.

13. `createdBy` is server-verified, record-on-create-only
    (`src/requests/ResourceRequest.ts:159`, `src/lib/metadataWrite.ts:75`).
    Upheld. A replicated write carries the origin's verified value, stored
    verbatim, since the origin verified the creating invocation and the receiver
    holds nothing better. The receiver does not resolve that DID. Doc edit: the
    createdBy sentence in the Glossary gains "or the origin's".

14. Export provenance attests `version` / `metaVersion` as claims
    (`src/lib/provenanceStatement.ts:26-43`). Changed. The claim members become
    the stamp members, and a replicated Resource's statement is signed by the
    exporting server over the origin's stamp. Import compares the same members.
    Doc edit: the `provenanceStatement.ts` and `exportProvenance.ts` entries.

15. The governed-log and `encryption` transition checks run on every Collection
    Metadata write (ARCHITECTURE `governedLog.ts` entry;
    `src/lib/encryption.ts`). Upheld at the origin only. The apply path stores a
    replicated Collection Metadata object verbatim, because a lagging receiver
    cannot re-run a transition against its own stale state without false
    refusals. Doc edit: a sentence in the `governedLog.ts` entry.

16. `did.jsonl` only grows: fast-forward `PUT`, verify-on-append, head record
    (`src/lib/webvhLogWrite.ts`). Upheld. The apply path uses the same
    fast-forward rule; a replicated log that is not a fast-forward of the local
    one stalls that Resource with a `warn`. A log replicated from a peer that is
    not the DID's host still verifies against its SCID.

17. The service description is built per `serverUrl` with a content-hash `ETag`.
    Upheld. Two new `instance` members (origin id, sync key) change the hash as
    `serverDid` does.

## 3. Consumer enumeration

Method: `grep -rn` across `src/` and `test/` for `formatEtag`, `parseEtag`,
`metaVersion`, `meta_version`, `generation`, `parseWritePreconditions`,
`updatedAt`, `changesSince`, `deleteCollection`, `createdBy`, `webvhController`,
`resolveServerDid`, `spaceProjection`, `spaceMetadataCache`, `policyCache`; plus
the storage-core `src/was.ts` exports and the was-sync and was-client sites
named in the roadmap `touches` lists. Run 2026-10-01.

Validator and stamp (WAS-172):

- `src/lib/etag.ts`: `EtagValidator`, `formatEtag`, `parseWritePreconditions`,
  `mintGeneration`.
- `src/lib/preconditions.ts`: the atomic evaluation both backends call.
- `formatEtag` callers: `src/requests/ChunkRequest.ts:133`,
  `SpacesRepositoryRequest.ts:352`, `SpaceRequest.ts:336,458`,
  `CollectionRequest.ts:233,608,677,780`, `ResourceRequest.ts:173,569`,
  `src/lib/metaSidecar.ts:25`.
- `parseWritePreconditions` callers: `ChunkRequest.ts` (3),
  `CollectionRequest.ts` (3), `ResourceRequest.ts` (5), `SpaceRequest.ts` (2).
- Stored layouts: `src/backends/filesystem.ts` (sidecars, `.space.<id>.json`,
  `.collection.<id>.json`, chunk sidecars), `src/backends/postgresSchema.ts` and
  `postgres.ts` (`version`, `meta_version`, `meta_generation` columns).
- Projections: `src/lib/spaceProjection.ts`, `src/lib/metadataWrite.ts`,
  `src/lib/metaSidecar.ts`, `src/requests/collectionContext.ts`,
  `src/requests/notModified.ts`.
- Provenance: `src/lib/provenanceStatement.ts:26-43` (`version`, `metaVersion`
  claims), `exportProvenance.ts`, `importProvenance.ts`, `importTar.ts`.
- `src/types.ts`: `MetadataValidatorParts`, `ChunkMetadata`, the
  `StorageBackend` write return types, `changesSince` (`:1102-1124`).
- Tests reading `metaVersion` or validator layout: `test/changes-query-api`,
  `collection-api`, `encryption-enforce-api`, `resource-api`, `space-meta-race`,
  `spaces-api`, `storage-backend-contract`, `storage`.
- storage-core `src/was.ts`: `SpaceMetadata` (`:31`), `CollectionMetadata`
  (`:260`), `ResourceMetadata.writerId` (`:487`), `ChangesCheckpoint` (`:496`),
  `ChangeDocument` (`:520`, whose `writerId` comment states the
  `(updatedAt, writerId)` key, `:566-573`).
- was-sync `src/pushWrites.ts:88-240,466`: the `writerId` echo check, which
  becomes a fast path under the stamp comparison.
- was-client `src/Collection.ts:1735,1789`: the loop guard reading `updatedAt`,
  already slated by WAS-93.

Feed (WAS-172, WAS-176): `src/types.ts:1131`,
`src/requests/CollectionRequest.ts:936,1045`, `src/backends/postgres.ts:2892`,
`src/backends/filesystem.ts:4338,4353`.

Collection delete (WAS-174): `src/types.ts:792`,
`src/requests/CollectionRequest.ts:1144`, `src/backends/postgres.ts:1519`,
`src/backends/filesystem.ts:317,2403`; the Space listing in both backends
(tombstone flag).

Resolver (WAS-175, WAS-177): `src/lib/webvhController.ts` (`:385` refusal, head
record, document cache), `src/lib/webvhLogWrite.ts`, `src/zcap.ts`,
`src/lib/validateDid.ts`, `src/lib/clientAnnexClause.ts` (reads the resolved
document shape), `src/lib/serverIdentity.ts:344-387`, `src/plugin.ts`,
`src/serviceDescription.ts`, request classes that resolve a controller:
`SpaceRequest`, `CollectionRequest`, `ResourceRequest`, `RevocationRequest`,
`KeystoreRequest`.

Caches (invariant 10): `src/lib/policyCache.ts`, `src/requests/spaceContext.ts`,
`SpaceRequest.ts`, `SpacesRepositoryRequest.ts`, `BackendRequest.ts`,
`PolicyRequest.ts`, `CollectionRequest.ts`, `src/policy.ts`.

Space Metadata object (WAS-176 `replicas`): `src/lib/spaceProjection.ts:114` and
its callers in both backends (`filesystem.ts:1660-1841`,
`postgres.ts:4014-4441`), `SpaceRequest.ts:50`, `SpacesRepositoryRequest.ts:17`.

Unchanged consumers whose correctness now rests on a new assumption: the
`If-None-Match` 304 path (`notModified.ts`) assumes the replicated validator is
byte-identical on every replica; the import plan (`importPlan.ts`) assumes an
archived stamp is restored verbatim rather than re-minted; the client-annex
clause assumes the resolved document on a replica is the same document as on the
origin (it is, from the replicated log).

## 4. Interaction matrix

Columns: A replicated write arriving; B Collection tombstone; C immutable
Collection; D peer stamp ahead of local time; E Space with a registration; F
controller log is a replicated copy; G one-way replica; H Delete Space on one
replica.

| Flow                                   | A                                                                                       | B                                                                   | C                                                                        | D                              | E                                                                            | F                                                                                   | G                                                        | H                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Create Space (`POST /spaces/`, by id)  | n/a: a Space is created by the controller on each server                                | fine                                                                | fine                                                                     | fine                           | changed: registration needs the Space to exist first                         | changed: a `did:key` create only, as today; promotion later                         | fine                                                     | fine                                                           |
| Update Space Metadata (`PUT .../meta`) | changed: applied under LWW by stamp, verbatim; `type` immutable rule ran at origin      | fine                                                                | fine                                                                     | stalls pull                    | fine; `replicas` is server-derived and never written                         | changed: promotion to a peer-hosted DID resolves from the copy (WAS-177)            | fine                                                     | fine                                                           |
| Delete Space                           | refused: the apply path never deletes a Space                                           | fine                                                                | fine                                                                     | fine                           | changed: removes the registration                                            | changed: removes the log copy; other Spaces that DID controls lose their controller | fine                                                     | changed: per replica; peer's loop stops on 404 with one `warn` |
| Create Collection (`POST /space/S/`)   | changed: a replicated Collection Metadata object creates the Collection on apply        | changed: a create over a tombstone mints a new generation           | fine                                                                     | stalls pull                    | fine                                                                         | fine                                                                                | fine                                                     | fine                                                           |
| Update Collection Metadata             | changed: LWW verbatim; `encryption`/`revisions` transition checks ran at origin         | fine                                                                | changed: `revisions.immutable` is immutable once set                     | stalls pull                    | fine                                                                         | fine                                                                                | fine                                                     | fine                                                           |
| Delete Collection                      | changed: a replicated tombstone applies by stamp and cascades                           | changed: leaves a stamped tombstone                                 | fine                                                                     | stalls pull                    | fine                                                                         | refused by existing rule if it holds a `did.jsonl`? No: today allowed; unchanged    | fine                                                     | fine                                                           |
| Resource write                         | changed: applied iff stamp greater than held; else skipped                              | changed: refused 404 under a tombstoned Collection                  | changed: update refused; equal-digest create idempotent; else refused    | stalls pull                    | fine                                                                         | fine                                                                                | changed: a write on the replica never reaches the source | fine                                                           |
| Resource delete and re-create          | changed: tombstone by stamp; re-create continues the generation as today                | fine                                                                | changed: re-create over a tombstone needs an equal digest                | stalls pull                    | fine                                                                         | fine                                                                                | as above                                                 | fine                                                           |
| Resource `/meta` write                 | changed: LWW by the `/meta` record's own stamp                                          | fine                                                                | fine: `custom` stays writable                                            | stalls pull                    | fine                                                                         | fine                                                                                | as above                                                 | fine                                                           |
| Chunk write and delete                 | fine: not replicated (WAS-14); takes the stamp and validator                            | cascades as today                                                   | changed: a chunk under an immutable Resource follows the same rule       | fine                           | fine                                                                         | fine                                                                                | fine                                                     | fine                                                           |
| Governed log append (`meta/log`)       | changed: fast-forward apply; fork stalls with `warn`                                    | fine                                                                | fine                                                                     | stalls pull                    | fine                                                                         | fine                                                                                | fine                                                     | fine                                                           |
| `did.jsonl` append                     | changed: fast-forward apply with verification; fork stalls                              | fine                                                                | changed: an immutable Collection cannot host a log (append is an update) | stalls pull                    | fine                                                                         | changed: the wallet may append on the replica directly (DR); the copy then leads    | fine                                                     | fine                                                           |
| Update Space promotion to `did:webvh`  | fine                                                                                    | fine                                                                | fine                                                                     | fine                           | fine                                                                         | changed: the proposed controller may be peer-hosted if its log is replicated here   | fine                                                     | fine                                                           |
| Export Space                           | changed: statements attest stamp members; exported stamps are the origin's              | changed: tombstoned Collections are archived as tombstones          | fine                                                                     | fine                           | changed: the registration is not exported                                    | fine: the log copy exports as a Resource                                            | fine                                                     | fine                                                           |
| Import Space                           | changed: an archived stamp is restored verbatim, not re-minted                          | changed: restores tombstones                                        | changed: imports respect the digest rule? No: import bypasses, as today  | fine                           | changed: import never creates a registration                                 | fine                                                                                | fine                                                     | fine                                                           |
| Changes feed pull by a client          | changed: documents carry stamp members; a replicated write surfaces at a local position | fine: per-Collection feed is gone with the Collection               | fine                                                                     | fine                           | fine                                                                         | fine                                                                                | fine                                                     | fine                                                           |
| Policy write and read                  | changed: LWW by stamp, verbatim; cache dropped on apply                                 | fine: a Collection policy dies with the tombstone (WAS-127 applies) | fine                                                                     | stalls pull                    | fine                                                                         | fine                                                                                | fine                                                     | fine                                                           |
| Revocation submit                      | changed: the set unions on apply (WAS-178 read)                                         | fine                                                                | fine                                                                     | fine: no stamp on a revocation | fine                                                                         | changed: the submitted chain resolves the controller from the copy                  | fine                                                     | fine                                                           |
| Keystore ops (`/kms`)                  | fine: not replicated                                                                    | fine                                                                | fine                                                                     | fine                           | fine                                                                         | changed: a keystore promoted to a peer-hosted controller resolves from the copy     | fine                                                     | fine                                                           |
| Client-annex clause bounds             | fine: reads the invoked chain, not the write's origin                                   | fine                                                                | fine                                                                     | fine                           | fine: the registration sub-resource is a Space-scoped unsafe method, refused | fine: the resolved document is the same document                                    | fine                                                     | fine                                                           |
| Backend registration                   | fine: not replicated; `backends` stays per server                                       | fine                                                                | fine                                                                     | fine                           | fine: both are per-server Space state                                        | fine                                                                                | fine                                                     | fine                                                           |
| Registration create/delete (new)       | n/a                                                                                     | fine                                                                | fine                                                                     | fine                           | changed: controller-only; peer `/service` read; refusals (own id, `type`)    | fine                                                                                | changed: one registration, no counterpart                | removed with the Space                                         |

Cells to re-check at review: the Delete Collection / F cell (a Collection
holding a controller log can be deleted today; a replicated tombstone of it
removes the controller on the replica, same as locally) and the Import / C cell
(import bypasses the digest rule; decide whether it should).

## 5. Design

### 5.1 `revisions` descriptor (WAS-173)

`CollectionMetadata.revisions?: { resolution?: 'last-writer-wins', immutable?: boolean, merge?: object }`
in storage-core. Server-side: a `src/lib/revisions.ts` beside `encryption.ts`
with the shape check, the transition check (`resolution` and `immutable`
immutable once set, the same error class `encryption` uses), and the
governed-log derivation hook. `resolution` is a closed set with one value; an
unknown value is `invalid-request-body` (400). `merge` is served verbatim and
never read. `immutable` is enforced on both backends' Resource write paths: an
update of a live Resource is refused; a create over a tombstone or a repeat
create with an equal body `Digest` is a no-op answering the current `ETag`; a
different digest is refused. Chunks inherit the descriptor.

### 5.2 Origin id (WAS-171)

`StorageBackend.originId: string`, read from `store.json` (filesystem; a store
migration step mints it) or a store row (Postgres). `WAS_ORIGIN_ID` overrides
verbatim; a mismatch with the stored id refuses boot naming both. Charset
`[A-Za-z0-9_-]{1,64}`. Advertised on `/service` `instance`.

### 5.3 HLC stamp and validator (WAS-172)

A `src/lib/hlc.ts` with one clock per backend: `now()` returns `{ ms, counter }`
per the paper's send rule (`l = max(l, pt)`; `counter++` if `l` stood still,
else `0`); `observe({ ms, counter })` per the receive rule, refusing a stamp
more than `bound` ahead of `pt` (section 5.6). Minted inside the write's
critical section (the per-Space and per-Collection locks in
`filesystem.ts:2296-2317`, the row locks in Postgres).

Every versioned record stores `updatedAt` (ISO of `ms`), `updatedAtCounter`, and
`origin`. `EtagValidator` becomes `{ generation, ms, counter, origin }` and
`formatEtag` emits `"<generation>.<ms>.<counter>.<origin>"`. `version` and
`metaVersion` are removed from sidecars, rows, wire objects, and
`provenanceStatement.ts` claims, which attest the three stamp members instead.
The order key is `(ms, counter, origin)`, compared numerically then by plain
string.

### 5.4 Collection tombstones (WAS-174)

The Collection Metadata record gains a deleted marker and keeps its stamp and
generation; `deleteCollection` writes it instead of removing the record and
still cascades to Resources, chunks, policies and the governed log. The Space
listing excludes tombstones unless a query flag asks for them. A create over a
tombstone mints a new generation.

### 5.5 Apply path and pull loop (WAS-176)

`StorageBackend` gains `apply*` methods (Resource, Resource `/meta`, Collection
Metadata including the tombstone, Space Metadata, policy, log fast-forward,
revocation union), each taking the stamped representation and storing it
verbatim after the one comparison, under the same locks and container re-check
as a request-layer write, taking a fresh feed position, and dropping the same
cache entries. A `src/sync/` module runs one loop per registration: list the
peer's Space with tombstones, filter by the Collection list (Space-level state
and the controller's log Collection always included), pull each Collection's
changes feed under a per-peer opaque checkpoint, `GET` each representation,
apply. A 404 for the Space stops the loop with one `warn`.

The registration is a controller-only sub-resource of the Space (container rule,
no exception), per server, not replicated, not exported, removed with Delete
Space. Members: the peer's Space URL, the delegated pull capability, an optional
Collection list, a role (`source` in v1). Registering reads the peer's
`/service` for its origin id, refuses a peer advertising this server's own id,
and refuses a peer whose Space `type` set differs. The served Space Metadata
object carries a server-derived `replicas` member listing each registered peer's
Space URL and role, derived in `spaceProjection.ts` beside `backends`.

### 5.6 Clock bound

A received stamp whose `ms` exceeds local time by more than a configured bound
is not applied; the pull stalls at that position, the checkpoint does not
advance, and a `warn` names the peer. Proposed default: 60 s.

### 5.7 Sync key and peer verification (WAS-175)

A second Ed25519 key derived from `WAS_SERVER_KEY_SEED` with its own derivation
label, held beside the export key in `serverIdentity.ts`. Advertised on
`/service` `instance` as a `did:key`. The server signs sync invocations as
`{serverDid}#{key}` when the resolved server document lists the key under
`capabilityInvocation`, else as the `did:key`. `resolveServerDid` tolerates that
key under `capabilityInvocation` and still refuses the export key under any
relationship but `assertionMethod`.

Verifying a peer: `zcap.ts`'s resolver gains one bounded network path. When the
invoker's DID is a `did:webvh` with path `space:server:id` and it is the
controller of a delegated capability whose chain verified to the Space
controller, the log is fetched from `{host}/space/server/id/did.jsonl`, verified
like any log, cached per DID, re-fetched once when a signature names a key the
cached document lacks, with a size bound and a timeout. Any other foreign
`did:webvh` stays refused.

### 5.8 Controller resolution from a replicated log (WAS-177)

`parseSelfHostedWebvh` accepts a host that is a registered peer's host when the
log Collection it names is replicated here, and the rest of `webvhController.ts`
runs unchanged over the local copy. No network fetch.

### Wire-level decisions pending individual sign-off

Agreed with the maintainer on 2026-10-01: the names `revisions`, `resolution`,
`updatedAtCounter`, `origin`; the validator
`"<generation>.<ms>.<counter>.<origin>"` with `ms` the epoch integer;
`WAS_ORIGIN_ID` used verbatim; the order key `(ms, counter, origin)`. The rest
are proposals:

1. `revisions.resolution` values: `last-writer-wins`; reserved `keep-conflicts`.
   `revisions.immutable` boolean. `revisions.merge` object, verbatim.
2. The immutable-write refusal: error name and status (proposal:
   `resource-immutable`, 409).
3. The origin-id charset `[A-Za-z0-9_-]{1,64}` and its `/service` `instance`
   member name (proposal: `originId`).
4. The change-document stamp members: `updatedAtCounter` and `origin` beside
   `updatedAt`.
5. The Space listing query flag for tombstoned Collections (proposal:
   `?include=deleted`).
6. The registration sub-resource path (proposal: `/space/:spaceId/replicas`,
   `POST` to add, `GET` to list, `DELETE /space/:spaceId/replicas/:id`) and its
   members (`spaceUrl`, `capability`, `collections`, `role`).
7. The `replicas` member on the served Space Metadata object
   (`[{ url, role }]`).
8. The sync-key HKDF derivation label and its `/service` member name (proposal:
   `syncInvocationKey`).
9. The clock-bound setting (proposal: `WAS_REPLICATION_CLOCK_BOUND_MS`, default
   `60000`).
10. The read-only-switch problem type (WAS-179, later).

## 6. Alternatives rejected

1. `writerId` in the tie-break. Unreachable once the stamp carries a counter and
   origin, and the spec forbids it as a server input. Do-not-reopen.
2. A packed 64-bit stamp (the HLC paper's 48+16 bits). Exceeds JavaScript's safe
   integer range in JSON. Two members instead. Do-not-reopen.
3. A content-hash validator (CouchDB `_rev`) as the primary. Identical on every
   replica for free, but carries no time, so LWW would need a second field and
   its winner rule is depth-then-hash, not recency. The parent pointer it needs
   is the primitive `keep-conflicts` will store. Not do-not-reopen: a content
   hash may return beside the stamp for `keep-conflicts`.
4. The server DID, or the export key's `did:key`, as origin id. Absent on most
   deployments, embeds the host, changes on re-mint or seed rotation; nothing
   verifies a stamp, so a DID buys no authenticity. Do-not-reopen.
5. A client-declared clock. A write grant could mint a revision dated far in the
   future that no honest write beats (Cassandra's documented hazard).
   Do-not-reopen.
6. Push transport, or a sync-ingest endpoint. A second write path whose
   authorization must say "this caller may assert stamps". Pull only.
   Do-not-reopen for v1; revisit only with a receipt or witness design.
7. A vector checkpoint. Not needed while a client replicates against one server
   at a time; can be added inside the opaque value later. Not do-not-reopen.
8. Space tombstones. A Space on two servers is two URL identities, each deleted
   by its own root invocation; the registration dies with the Space, so nothing
   pulls a deleted Space back. Not do-not-reopen: add one if
   restore-from-replica into a re-created Space ever proves unwanted.
9. A per-Collection replica unit. Space-level state has no loop to ride, a
   deleted Collection is indistinguishable from a revoked grant, and a new
   sibling Collection is invisible. The Collection list on a Space registration
   gives the selectivity. Do-not-reopen for the unit; a cross-Space Collection
   mirror is a separate feature.
10. Registration as a Space Metadata member (replicated under LWW, but the two
    sides' records must differ), as a controller-document service entry (the
    server should not act on service entries, and it cannot carry the
    capability), or as operator config (the controller delegates, so the
    controller registers). Do-not-reopen.
11. Network resolution of user controllers from the original host. If that host
    is lost for good, a cached document can never refresh and the account can
    never rotate a key again, defeating disaster recovery. A replicated copy
    keeps the account alive on the surviving server. Do-not-reopen.
12. Excluding the `id` Collection from replication, with the wallet writing each
    replica's log itself. Rejected for the same DR reason and because the sync
    loop is no mechanism at all; may be rolled back if the replicated log causes
    problems.
13. Host-independent capability targets. Deferred, not rejected: future
    DID-relative URLs will cover several hosts under one target.

## 7. Test plan

- `test/hlc.test.ts`: frozen clock; two same-ms writes get counters 0 and 1; a
  clock step backwards does not lower `ms`; `observe` advances the clock and
  refuses a stamp past the bound.
- `test/etag-layout.test.ts` (or the existing per-route suites): the four-field
  validator on every record kind, `If-Match` round trip, 304 on `If-None-Match`,
  a hard delete and re-create minting a new generation.
- `test/origin-id.test.ts`: mint, verbatim env, mismatch refusal, charset,
  `/service` advertisement; a Postgres twin behind the flag.
- `test/revisions-api.test.ts`: defaults, unknown value refused, immutability of
  the descriptor, immutable Resource rules on plaintext and encrypted
  Collections, governed-log derivation.
- `test/collection-tombstone.test.ts`: tombstone after delete, listing flag,
  re-create generation, cascade, export and import of a tombstone.
- `test/replication.test.ts`: two in-process servers over separate data dirs and
  ports (`startTestServer` twice); register one as the other's source; write on
  the source; assert same bytes, `ETag`, `updatedAt` on the replica; pause the
  pull, write the same Resource on both, resume, assert convergence on the
  greater stamp; one-way registration leaks nothing back; a peer stamp past the
  bound stalls with a `warn`; Delete Space on the source stops the replica's
  loop; a `did.jsonl` fork stalls.
- `test/server-identity-api.test.ts`: the sync key advertised; `did:key` and
  `did:webvh` signing forms; `resolveServerDid` tolerates the sync key under
  `capabilityInvocation` and still refuses the export key there.
- `test/peer-webvh-resolution.test.ts`: the bounded fetch, re-fetch on a key
  miss, size and timeout refusals, and refusal of a non-`space:server:id` DID.
- `test/webvh-controller-replica.test.ts`: a controller minted on A resolves on
  B after a pull; a key retired on A stops authorizing on B after the next pull;
  a non-peer host stays refused.
- Provenance: `test/export-provenance` and `import-provenance` suites assert the
  stamp claims.
- Existing suites that must stay green: every `test/` suite,
  `pnpm conformance:local` after the suite gains the stamp and `revisions`
  cases.

## 8. Open questions

1. WAS-14, three items this design leaves to it: discovery of chunk and binary
   changes (a second feed or a per-parent chunk listing walk); chunk tombstones
   (stamped, or cascade-only through the parent); whole-stream consistency
   (tying a chunk's validity to the parent revision it was written under).
   Owner: WAS-14.
2. Tombstone retention. Never reaped in v1; a retention rule needs peers to
   report their position back. Owner: WAS-13.
3. Whether `keep-conflicts` accepts a stale `If-Match` write as a sibling on a
   single server (giving offline clients the conflict model before any second
   primary). Owner: the item that promotes `keep-conflicts`.
4. Pull cadence, and whether a peer may nudge with an unauthenticated "changes
   available" ping. Interval first. Owner: WAS-176.
5. A cross-Space controller log (log in Space T controlling Space S): a
   documented operator requirement that T be replicated too, or a check at
   registration time. Owner: WAS-177.
6. `createdBy` on a replicated write when the origin's DID does not resolve on
   the replica: stored verbatim and never resolved by the receiver, so not an
   issue under this design; confirm at review that no read path resolves it.
   Owner: WAS-176.
7. Import under an immutable Collection (matrix cell Import / C): whether import
   respects the digest rule or bypasses it as it does the envelope rule. Owner:
   WAS-173.
