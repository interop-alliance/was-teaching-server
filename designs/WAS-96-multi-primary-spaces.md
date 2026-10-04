# WAS-96: Multi-primary Spaces (design)

- item: WAS-96
- status: approved
- approved: 2026-10-02
- wire-level decisions contained: listed in section 5 and individually signed
  off on 2026-10-01 and 2026-10-02 (open points in section 5.9, wire items below
  section 5.12); items 3, 10 and 14 of the wire list were closed by open points
  9, 11 and WAS-179; item 10 (the read-only-switch problem type) is WAS-179's to
  sign off
- decision records extracted: 2026-10-02. Contract-binding, in
  wallet-attached-storage-spec's decisions: 0009 (origin-stamped write
  identity), 0010 (the stamp validator and the local container segment), 0011
  (Collection tombstones, delete wins), 0012 (immutable Collection descriptors
  are creation-only), 0013 (replication is a pull-only companion spec); the spec
  roadmap items WASS-47 to WASS-51 carry them into spec text. Server-internal,
  in this repo's `decisions/`: 0003 (one server key for export and sync), 0004
  (stamps are minted only by this server), 0005 (the local validator segment and
  `replicas` on the Space object). Sections 5 and 6 cite them; the records hold
  the canonical text from here on
- reviewed: 2026-10-01, adversarial pass (six lenses plus a completeness
  critic); findings folded in place with a `Review 2026-10-01:` prefix, the
  review log is section 9, and the decisions left to the maintainer are the open
  points in section 5.9

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

Review 2026-10-01: the review found that three of the six decisions were
under-specified in ways that break convergence rather than merely leave gaps:
the stamp cannot serve as the validator of a representation that carries
server-derived members (invariant 18), the apply path has no discovery channel
for anything the JSON changes feed does not carry (section 5.10), and "verbatim"
apply of a container's Metadata object hands the peer authority over
`controller` and over the immutable descriptors (invariants 15 and 20). Each is
resolved below or carried as an open point in section 5.9.

## 2. Invariant inventory

Each entry: the ARCHITECTURE.md invariant, upheld or changed, how, and the doc
edit that records it.

1. Validator layout `"<generation>.<version>"` (`src/lib/etag.ts:1-24`,
   `EtagValidator` at `:33`). Changed. The per-record `version` and
   `metaVersion` counters are replaced by the origin stamp, and the origin id
   joins the validator because two origins can mint the same `(ms, counter)` for
   one Resource. Doc edit: the `etag.ts` section and the `etag.ts` header
   comment. Review 2026-10-01: the entry missed three validator moves that are
   not writes today (a backend registration, a governed-log append, and now a
   replica registration, each advancing `metaVersion` only). Those are
   invariant 18. The ARCHITECTURE sentences the doc edit must also reach: "The
   Space Metadata object's `metaVersion` also advances when a backend is
   registered"; "embedded ... as reserved `_generation` / `_version` members ...
   `meta_generation` / `meta_version` columns"; "storage exposes one validator
   pair per container, `metaGeneration` / `metaVersion`"; the governed-log
   entry's "its own generation/version `ETag`", "advance only the version
   counter" and "neither the log's version nor the Collection Metadata object's
   moves"; and the service-description entry's "the version counter used here".
   ARCHITECTURE also tells a client it "may read the trailing integer as the
   revision number"; that sentence is withdrawn, since the trailing segment is
   now the origin id (section 3, was-client `parseEtag`).

2. Generation minted when a record's counter starts, kept for its life; a hard
   delete removes the counter, so a re-create mints a new generation
   (`etag.ts:11-24`). Upheld, with "this server" replaced by "the creating
   write's origin". Two servers re-creating one id while partitioned mint two
   generations and the stamp picks the winner. How a generation is chosen stays
   an implementation detail the spec does not name. Doc edit: same section.

3. A Resource's `/meta` object is its own record, dropped by a soft delete.
   Upheld. The `/meta` object takes the same stamp members; a replicated
   tombstone drops it as a local one does. Review 2026-10-01: today the two
   records share one sidecar with one `updatedAt`, one `writerId` and one
   `epoch` (`src/lib/metaSidecar.ts:62-98`; the `/meta` write sets
   `updatedAt: now` and keeps `version`, `filesystem.ts:3696-3720`; Postgres
   dropped its separate `meta_updated_at` column, `postgresSchema.ts:303`), and
   the feed emits one `updatedAt` beside both counters. "Its own stamp"
   therefore needs two stamp sets in the sidecar and on the change document,
   which is open point 2 in section 5.9. Until it is decided, a `/meta` write on
   one replica would be compared against a content write on the other and skip
   it for good.

4. A hard delete of a Collection removes its record (`etag.ts:17-19`). Changed.
   Delete Collection leaves a stamped tombstone (WAS-174), still cascading to
   Resources and chunks. A Space is still hard-deleted. Doc edit: the `etag.ts`
   section, the Glossary's Collection entry. Review 2026-10-01: a tombstone is a
   stored record, and every existence check today reads "record present" as
   "Collection live": the container re-check (`filesystem.ts:385-410`,
   `postgres.ts:595`), the guarded create's `exists: prior !== undefined`
   (`filesystem.ts:2223-2237`, `postgres.ts:1240-1270`), Create Collection's
   `id-conflict` (`SpaceRequest.ts:414-418`), the count quota (`#collectionIds`,
   `filesystem.ts:1470-1482`; `COUNT(*)`, `postgres.ts:1256`), the listing's
   `totalItems`, import's `collectionExisted` (`filesystem.ts:1890`),
   `backendRegistry.ts:85`, `collectionContext.ts:60`, and
   `stampCollectionMetadata` keeping the prior `createdAt` / `createdBy`
   (`metadataWrite.ts:158-160`). Section 5.4 now states the rule: a tombstone
   reads as absent everywhere except the tombstone-aware listing and the apply
   path. The spec sentence "Deleting the Collection removes its Metadata object"
   (`spec.md:2254`) changes with it.

5. No write creates a container implicitly; every other write re-checks its
   container under the delete lock (ARCHITECTURE "backends" entry). Upheld. The
   apply path is one more writer and runs the same re-check, so a pull racing
   Delete Space writes nothing into a removed Space. Review 2026-10-01: the
   re-check tests existence, not identity. A controller that deletes a Space to
   cut off a bad source and re-creates it under the same id would have the
   in-flight page applied into the new Space. Section 5.5 now binds the
   registration to the Space's generation and has the apply path check both
   under the lock. ARCHITECTURE's "only a Collection Metadata write or an import
   creates a Collection" gains the apply path as a third creator.

6. The self-hosted `did:webvh` rule: resolution is a local storage read, never a
   network fetch; only a log this server stores
   (`src/lib/webvhController.ts:385-388`); the head record; the fast-forward
   `PUT`. Changed in one clause (WAS-177): a DID whose host is a registered peer
   and whose log Collection is replicated here resolves from the local copy
   through the same verify, cache, head-record and fast-forward path. Still no
   network fetch for a controller. Doc edit: the Controller and self-hosted
   `did:webvh` Glossary entries. Review 2026-10-01: the rule lives in the core
   spec's "Self-hosted histories" section (`spec.md:4263-4297`), not in the
   authz profile as the WAS-177 `touches` entry says. And the widening is of
   `parseSelfHostedWebvh` (`src/lib/validateDid.ts:80-125`), a synchronous
   `serverUrl`-only parser with callers the design did not list: the
   `invokerDid` read in `auth-header-hooks.ts:101-108` (else `createdBy` is
   silently dropped for a wallet's creates on the replica under its
   origin-hosted DID), two sites in `clientAnnexClause.ts` (`:743`, `:1003`,
   where an unparsed signer is skipped, so widening the resolver without the
   parser would switch the clause off on the replica), and
   `serverIdentity.ts:252`, which must not widen. Section 5.8 now scopes the
   widening to a registration rather than to a host.

7. `resolveServerDid` requires the export key under `assertionMethod` alone
   (`src/lib/serverIdentity.ts:344-387`). Upheld for the export key. Changed for
   the server document as a whole: a second, sync key may be listed under
   `capabilityInvocation` (WAS-175). The export key is still refused under any
   other relationship. Doc edit: the `serverIdentity.ts` section and the Server
   identity Glossary entry, whose "holds nothing else" sentence goes.

8. Network resolution of a foreign `did:webvh` is refused everywhere
   (`webvhController.ts:385`; WAS-162 context). Changed in one bounded form
   (WAS-175): a DID with path `space:server:id`, named as the invoker by a
   delegated capability whose chain verified to the Space controller, is fetched
   from its host, verified, cached, re-fetched once on a key miss, with a size
   bound and timeout. Every other foreign DID stays refused. Doc edit: the ZCap
   Structure section, "the `did:webvh` resolver on every path". Review
   2026-10-01: the gate as written cannot be placed. The verifier resolves the
   invoker's key (`getVerifier({ keyId })`,
   `@interop/http-signature-zcap-verify` `dist/index.js:109`) before it decodes
   the embedded capability (`:122` onward), and `createGetVerifier`
   (`src/zcap.ts:361-385`) sees only `keyId`. Placed there, the fetch is an
   unauthenticated outbound request to any host a request names. Section 5.7 now
   requires a pre-pass that decodes the `Capability-Invocation` header and
   verifies the delegation proofs before the key is resolved, and bounds the
   fetch further (scheme, port, redirects, address ranges, rate, cache size and
   TTL).

9. The container rule (`src/lib/containerRule.ts`): an unsafe method at a
   container URL is controller-only, with the listed exceptions. Upheld, and
   extended to the registration sub-resource, which is controller-only with no
   exception (WAS-176). Doc edit: the container rule paragraph, whose "all five
   handlers" count changes. Review 2026-10-01: the rule covers unsafe methods
   only; the registration's `GET` is made controller-only in section 5.5, since
   the record holds a delegated capability.

10. The Space Metadata cache and policy cache rest on a single-instance
    deployment: a write drops entries only in the process that made it
    (`src/config.default.ts:94-141`; ARCHITECTURE `spaceMetadataCache.ts`
    entry). Upheld as stated, and the apply path counts as a write: applying a
    Space Metadata object, a policy, or a `did.jsonl` log drops the same entries
    a request-layer write drops, including the webvh document cache keyed by log
    location. Doc edit: a sentence in that entry. Review 2026-10-01: the drop
    set also includes `forgetDeletedWebvhLocation`, which today runs only at the
    request layer (`CollectionRequest.ts:1157`, `SpaceRequest.ts:525`); an
    applied Collection tombstone calls it too. The document cache's revalidation
    compares the log Resource's `version` (`webvhController.ts:440-446`) and
    moves to the whole validator.

11. WAS-93's feed rules: a per-Collection feed position assigned in the write's
    critical section; the checkpoint is opaque and scoped to the issuing server.
    Upheld. A replicated write takes a fresh local position; the position is
    never replicated; no vector checkpoint. Doc edit: none beyond WAS-93's.
    Review 2026-10-01: changed in one respect. A position counter restarts when
    its Collection is re-created or its Space restored, and a checkpoint held
    from the previous life then silently skips the new life's first writes. The
    opaque checkpoint embeds the Collection's feed generation (the Space's is
    redundant, wire item 15); one from another generation is refused (400) and
    the reader restarts from the beginning. This goes to WAS-93's spec text and
    to the matrix row "Changes feed pull by a client".

12. `writerId` MUST NOT be an input to any server decision (spec, "Resource data
    model"). Upheld. The order key is `(ms, counter, origin)`; `writerId` is
    served verbatim as today. The spec's client-side `(updatedAt, writerId)`
    tie-break sentence is revised to say clients pick the winner by the stamp
    order. Doc edit: spec only. Review 2026-10-01: the revised sentence does not
    cover a local edit that has no server stamp yet (`@interop/social-core`
    `remotePayloadWins`, used from was-sync `conflictHandler.ts:45,317`), which
    still orders by `(updatedAt, writerId)`. The spec text keeps that rule for
    the unstamped-local case and names the stamp order for the stamped one.

13. `createdBy` is server-verified, record-on-create-only
    (`src/requests/ResourceRequest.ts:159`, `src/lib/metadataWrite.ts:75`).
    Upheld. A replicated write carries the origin's verified value, stored
    verbatim, since the origin verified the creating invocation and the receiver
    holds nothing better. The receiver does not resolve that DID. Doc edit: the
    createdBy sentence in the Glossary gains "or the origin's". Review
    2026-10-01: no read path resolves it (open question 6 closed), but see
    invariant 14 for what export signs.

14. Export provenance attests `version` / `metaVersion` as claims
    (`src/lib/provenanceStatement.ts:26-43`). Changed. The claim members become
    the stamp members, and a replicated Resource's statement is signed by the
    exporting server over the origin's stamp. Import compares the same members.
    Doc edit: the `provenanceStatement.ts` and `exportProvenance.ts` entries,
    plus the `importProvenance.ts` entry and the Provenance statement Glossary
    entry, which name the version members. Review 2026-10-01: signing
    `createdBy` for a record this server did not verify launders a peer's claim
    into a statement an importer judges `verified` and keeps. A statement for a
    record whose `origin` is not the exporting server omits `createdBy` from its
    claims (open point 11 in section 5.9 for the member rule).

15. The governed-log and `encryption` transition checks run on every Collection
    Metadata write (ARCHITECTURE `governedLog.ts` entry;
    `src/lib/encryption.ts`). Upheld at the origin only. The apply path stores a
    replicated Collection Metadata object verbatim, because a lagging receiver
    cannot re-run a transition against its own stale state without false
    refusals. Doc edit: a sentence in the `governedLog.ts` entry. Review
    2026-10-01: "ran at the origin" holds per write, not for the merge of two. A
    first set of `encryption` on B and a concurrent full-replacement `PUT`
    without it on A (a `custom` edit) both pass their origin's check, and LWW
    converges on A's object with `encryption` gone on both. The same holds for
    `revisions.immutable` and for two different first sets. Section 5.5 now
    merges the immutable members forward rather than replacing them (open point
    4 for the rule's shape). Separately, the served object is not the stored
    one: `collectionContext.ts:59-69` merges the derived `encryption` with
    `history.resource` built from `serverUrl`, so a verbatim store of the served
    object would make the replica refuse the log's guarded create as
    `encryption-immutable` and serve the peer's URL. The apply input is the
    stored projection (section 5.5).

16. `did.jsonl` only grows: fast-forward `PUT`, verify-on-append, head record
    (`src/lib/webvhLogWrite.ts`). Upheld. The apply path uses the same
    fast-forward rule; a replicated log that is not a fast-forward of the local
    one stalls that Resource with a `warn`. A log replicated from a peer that is
    not the DID's host still verifies against its SCID. Review 2026-10-01: a
    peer log that is a strict prefix of the local one is a no-op, not a stall
    (the source that recovers after a disaster-recovery append on the replica
    serves exactly that). A fork is permanent on both sides, by the head record
    and the fast-forward rule, and any holder of a write grant on the Collection
    can create one (a create is not verified; two different `did.jsonl` or
    genesis lines on A and B both land). "Stalls that Resource" is replaced by
    the per-Collection stall of section 5.11, with a durable reason. Also: today
    the log never reaches the feed at all (section 5.10).

17. The service description is built per `serverUrl` with a content-hash `ETag`.
    Upheld. Two new `instance` members (origin id, sync key) change the hash as
    `serverDid` does. Review 2026-10-01: the spec says a client "MUST NOT gate
    any behavior" on `instance` (`spec.md:1105`), and registration gates on the
    origin id. Open point 9 decides where the id is advertised. Doc edit: the
    `serviceDescription.ts` entry's `instance` member list.

Entries added by the review (2026-10-01):

18. A strong validator moves with the representation (ARCHITECTURE `etag.ts`
    entry), including on a derived-member change that is not a write: backend
    registration (`#bumpSpaceMetaVersion`, `filesystem.ts:5016`,
    `postgres.ts:3436`), a governed-log append (`postgres.ts:1501`; "leaves
    `updatedAt` untouched"), and now a replica registration. Changed. With the
    counter gone, moving the validator by minting a stamp turns a local
    bookkeeping change into a write that wins LWW on every peer over a real
    earlier edit (a rename at t1 lost to a backend registration at t2), and not
    moving it serves a 304 over changed `backends`, `replicas` or derived
    `encryption`. Neither is acceptable. Open point 1 in section 5.9 picks the
    mechanism; the recommended one keeps the four-field stamp as the replication
    order and adds a local component to a container Metadata object's served
    validator. Consequence for section 3: served container Metadata objects are
    not byte-identical across replicas (`backends`, `replicas`,
    `history.resource`), so the byte-equality claim is scoped to Resources.

19. The Space Metadata object's server-derived members are ignored in a write
    body and never stored (Glossary, Space entry); the governed `encryption`
    member is never stored (ARCHITECTURE `governedLog.ts`). Upheld. The apply
    path takes the stored projection, not the served object: it strips `url`,
    `linkset`, `backends`, `replicas`, `createdBy` on the Space object (keeping
    `createdBy` on a Resource), and the derived `encryption` on a governed
    Collection. The Glossary's server-derived list gains `replicas`.

20. The proposed controller must resolve before it is stored, or the Space is
    deadlocked (Glossary, self-hosted `did:webvh`); a controller change is
    authorized by the old controller. Changed by the review: `controller` is
    per-server state and is not replicated at all, like Create Space. The
    controller promotes each replica itself, authorized by the stored `did:key`
    there, and the proposed DID must resolve on that replica before it is
    stored, as today. The apply path writes `name` only (and `type` is checked
    equal at registration). Without this, a compromised or merely different
    source would take over the replica Space on the next pull, or deadlock it
    with a DID whose log has not arrived, and the controller could not remove
    the registration that did it, since that is controller-only. Open point 3.

21. Access-control policies carry no validator, no `updatedAt`, and are
    hard-deleted (`src/types.ts:1256-1271`); they are not Resources and not in
    the feed. Changed. "LWW by stamp" in the matrix was ungrounded. A policy
    gains the stamp members and a deleted marker, so a deleted public-read
    policy does not come back from a peer that still holds it. Open point 6.

22. Reserved path segments (spec "Reserved Path Segment Registry", mirrored in
    `src/lib/validateId.ts:67`, storage-core `common.ts:334`, was-client
    `internal/reserved.ts`, drift-guarded). Changed: `replicas` joins the
    Space-level registry, and `zcaps` must too (the existing
    `/space/:spaceId/zcaps/revocations/:id` route and WAS-178's read collide
    with a Collection named `zcaps`). Without the reservation, the client-annex
    clause's fourth shape (`clientAnnexClause.ts:616-617`) admits a
    ladder-signed `GET` of a registration record. Open point 9 covers the name
    itself.

23. The per-Collection uniqueness of `plaintext.indexes[].unique` and of unique
    blinded attributes is enforced atomically at write time
    (`src/lib/equalityIndex.ts`; `ResourceRequest.ts:144-162`). Changed: upheld
    per origin only. Two partitioned creates claiming one unique value both
    land, and the converged Collection holds both. Same for `immutable`: two
    partitioned creates of one id with different digests both land and LWW keeps
    one. Recorded as a limitation in section 5.1 and in the spec text.

24. Quotas (`maxCollectionsPerSpace`, `maxResourcesPerSpace`, `capacityBytes`)
    and `maxUploadBytes` are enforced on every create and write
    (`filesystem.ts:257-275`, `:2247`; `postgres.ts:1254-1264`). Upheld on the
    apply path: a replica smaller than its source refuses the apply, and the
    refusal is a durable per-Collection stall naming the quota (section 5.11),
    not a skip and not a bypass. Tombstoned Collections do not count toward the
    Collection quota (invariant 4).

25. The store layout file holds only `version` and is private to the backend
    (ARCHITECTURE `filesystemStore.ts`). Changed: it also holds the origin id
    and the HLC high-water mark (section 5.2, 5.3), and `writeStoreVersion`
    preserves members it does not own.

26. Two facets sit outside the route structure with no auth hooks and no storage
    access (AGENTS.md). Changed: the sync loop is a third facet, with storage
    access and outbound network, and AGENTS.md names it.

## 3. Consumer enumeration

Method: `grep -rn` across `src/` and `test/` for `formatEtag`, `etagOf`,
`metadataEtagOf`, `newGeneration`, `resolveGeneration`, `metaVersion`,
`meta_version`, `_version`, `log_version`, `generation`,
`parseWritePreconditions`, `updatedAt`, `changesSince`, `isJsonContentType`,
`deleteCollection`, `getCollectionMetadata`, `createdBy`, `webvhController`,
`parseSelfHostedWebvh`, `resolveServerDid`, `spaceProjection`,
`spaceMetadataCache`, `policyCache`, `writePolicy`; plus the storage-core
`src/was.ts` exports and the sibling-repo sites below. Run 2026-10-01, re-run
and widened at review the same day (the first run named `mintGeneration` and
`parseEtag`, which do not exist in this repo; `etag.ts` exports `newGeneration`,
`resolveGeneration`, `etagOf`, `metadataEtagOf`, `storedMetadataFromFile`,
`embedMetadataValidator`, `stripMetadataValidator`).

Validator and stamp (WAS-172):

- `src/lib/etag.ts`: `EtagValidator`, `formatEtag`, `etagOf`, `metadataEtagOf`,
  `parseWritePreconditions`, `newGeneration`, `resolveGeneration`, the
  embed/strip pair.
- `src/lib/preconditions.ts`: the atomic evaluation both backends call.
- `formatEtag` callers: `src/requests/ChunkRequest.ts:133`,
  `SpacesRepositoryRequest.ts:352`, `SpaceRequest.ts:336,458`,
  `CollectionRequest.ts:233,608,677,780`, `ResourceRequest.ts:173,569`,
  `src/lib/metaSidecar.ts:25`.
- `etagOf` callers (added at review): `ChunkRequest.ts:231,298`;
  `ResourceRequest.ts:262,331,422`; `notModified.ts:88`;
  `CollectionRequest.ts:1065-1066`; `postgres.ts:1480,1940,2262,2441,2614,2816`;
  `filesystem.ts:2563,3323,3680`; `webvhLogWrite.ts:112`;
  `serverIdentity.ts:205`.
- `parseWritePreconditions` callers: `ChunkRequest.ts` (3),
  `CollectionRequest.ts` (3), `ResourceRequest.ts` (5), `SpaceRequest.ts` (2).
- Stored layouts: `src/backends/filesystem.ts` (sidecars, `.space.<id>.json`,
  `.collection.<id>.json`, chunk sidecars), `src/backends/postgresSchema.ts` and
  `postgres.ts` (`version`, `meta_version`, `meta_generation` columns).
- The governed log's own validator (added at review): `log_generation` /
  `log_version` (`postgresSchema.ts:250-258`), the stored
  `{ body, generation, version }` record, `governedLog.ts:126`
  (`unchangedLogValidator`), `importTar.ts:102-108` (requires a positive integer
  `version` on an archived log).
- Derived-member validator bumps (added at review; invariant 18):
  `#bumpSpaceMetaVersion` (`filesystem.ts:4998,5016-5040,5121`;
  `postgres.ts:3417,3436,3520`), the governed-log append
  (`filesystem.ts:2586-2600`, `postgres.ts:1501`).
- Projections: `src/lib/spaceProjection.ts`, `src/lib/metadataWrite.ts`,
  `src/lib/metaSidecar.ts`, `src/requests/collectionContext.ts`,
  `src/requests/notModified.ts`.
- Provenance: `src/lib/provenanceStatement.ts:26-43` (`version`, `metaVersion`
  claims), `exportProvenance.ts`, `importProvenance.ts`, `importTar.ts`.
- The webvh document cache (added at review): `webvhController.ts:315-330`
  (`readLog` returns `version`), `:440-446` (`reviseEntry` compares it).
- The filesystem write order (added at review): `#writeResourceLocked` writes
  the representation (`filesystem.ts:2930`), then the sidecar (`:2966`); the
  sidecar becomes the commit point (section 5.3).
- `src/types.ts`: `MetadataValidatorParts`, `ChunkMetadata`, the
  `StorageBackend` write return types, `changesSince` (`:1102-1124`).
- Tests reading `metaVersion` or validator layout: `test/changes-query-api`,
  `collection-api`, `encryption-enforce-api`, `resource-api`, `space-meta-race`,
  `spaces-api`, `storage-backend-contract`, `storage`; and (added at review)
  `test/helpers.ts:189-225` (`assertEtagVersion`, `etagGeneration`, regex
  `^"([A-Za-z0-9]+)\.\d+"$`, 68 call sites including `backends-api` and
  `governed-log-api`), `chunks.test.ts:279`, `export-import-api.test.ts:454`,
  `exportProvenance.test.ts`, `filesystem-backend-races.test.ts:357`,
  `importTar.test.ts:430`, `storage-contract-postgres.test.ts:236-329`,
  `space-archive-fixture.test.ts`.
- storage-core `src/was.ts`: `SpaceMetadata` (`:31`), `CollectionMetadata`
  (`:260`), `ResourceMetadata.writerId` (`:487`), `ChangesCheckpoint` (`:496`),
  `ChangeDocument` (`:520`, whose `writerId` comment states the
  `(updatedAt, writerId)` key, `:566-573`), `ServiceDescription.instance`
  (`:905-917`), `generator.origin` (`:222-227`, a Web origin on the same
  Collection Metadata object as the new top-level `origin`).
- was-sync `src/pushWrites.ts:88-240,466`: the `writerId` echo check, which
  becomes a fast path under the stamp comparison; `:242` (`hasAck`, which reads
  the parsed revision).
- was-client `src/Collection.ts:1735,1789`: the loop guard reading `updatedAt`,
  already slated by WAS-93.

Sibling-repo consumers the first run missed (added at review; each is a
`touches` gap on WAS-96 or WAS-172 for the maintainer to record on the roadmap):

- was-client `src/sync/port.ts:204-215`: the exported `parseEtag` reads the
  digits after the last `.` as the revision; it feeds `WriteAck.version` and
  `MasterState.version` (`:322-343,353-356,447-448,522`). Under the new layout
  the last segment is the origin id, so it returns `undefined`, or a constant
  number for an all-digit `WAS_ORIGIN_ID`.
- wallet-core `src/sync/push.ts:85-87,207` (`replica.version > 0` chooses
  `If-Match` over `If-None-Match: *`) and `src/sync/remint.ts:132`
  (`version === 0` means never pushed): with `version` always 0, every update is
  a 412 and every acked envelope is re-minted. dcw stores the same `version` /
  `metaVersion` columns (`app/model/schema.ts:126-127`).
- was-sync `src/syncedDocSchema.ts:54,60-61,76`: a persisted RxDB schema at
  `version: 0` with `required: ['id', 'updatedAt', 'version']`; changing it
  touches databases already on users' devices (byoe-ecosystem
  `LEARNINGS.md:566-578`). `conflictHandler.ts:105-106` (`statesEqual` on
  `version` / `metaVersion`; an echoed own write must not compare equal),
  `feedPrimaryPort.ts:48`, `wasReplication.ts:46-56`, `changesQuery.ts:43`.
  Persisted by freewallet `src/stores/browserStore.ts` and was-react
  `src/storage/localStore.ts`.
- `@interop/space-archive` `src/archive/metadataFile.ts:24`
  (`EMBEDDED_VALIDATOR_MEMBERS = ['_generation', '_version']`), its two
  checked-in fixtures (`space-archive.tar`, `space-archive-provenance.tar`, the
  latter carrying signed `version` / `metaVersion` claims that must be
  re-signed), and the absence of a file-name form for a Collection tombstone.
- `@interop/wallet-backup` `src/migrate/archiveSurvey.ts:140-175` registers
  every Collection directory as a live app Collection, so a tombstone in an
  archive would be resurrected on migration.
- wallet-core's account-log invariants: the chain-head pin is keyed by Space id,
  not host (`src/webvh/verifyLog.ts:84`); the account pointer carries one `host`
  (`ARCHITECTURE.md:332`); the host is derived from the DID string
  (`src/clientAnnex/log.ts:918`). A wallet that read the source's head and then
  talks to a lagging replica refuses the rollback; a DR append on the replica
  while the source lives forks the account; after losing the source, the keyring
  pointer still names it. Section 8 carries this as open question 8.
- `@interop/was-conformance-suite` 0.26.0 `encryption-descriptor-api.js:405`
  asserts `typeof doc.metaVersion === 'number'`, and the exact-shape asserts in
  `collection-api.ts:331-343` and `client-spaces.ts:225-235` break on the new
  members.
- The encrypted-collections profile: the chunk listing's `version` member
  (`ec/spec.md:1096-1100`, emitted at `ChunkRequest.ts:396`), `metaVersion` at
  `ec/spec.md:496,577,1469`, and the governed `revisions` derivation, which the
  profile's `state` schema (`WasEpochConfiguration`) has no slot for.

Feed (WAS-172, WAS-176): `src/types.ts:1131`,
`src/requests/CollectionRequest.ts:936,1045`, `src/backends/postgres.ts:2892`,
`src/backends/filesystem.ts:4338,4353`; and (added at review) the JSON filter,
`filesystem.ts:4400-4432` (`isJsonContentType`) and `postgres.ts:2927`
(`AND is_json`), which keeps `did.jsonl` (`text/jsonl`), every binary Resource
and their tombstones out of the feed. Section 5.10.

Collection delete (WAS-174): `src/types.ts:792`,
`src/requests/CollectionRequest.ts:1144`, `src/backends/postgres.ts:1519`,
`src/backends/filesystem.ts:317,2403`; the Space listing in both backends
(tombstone flag); and the existence-check sites listed under invariant 4.

Resolver (WAS-175, WAS-177): `src/lib/webvhController.ts` (`:385` refusal, head
record, document cache), `src/lib/webvhLogWrite.ts`, `src/zcap.ts`,
`src/lib/validateDid.ts` (`parseSelfHostedWebvh` and its callers under invariant
6), `src/lib/clientAnnexClause.ts` (reads the resolved document shape),
`src/lib/serverIdentity.ts:344-387`, `src/plugin.ts`,
`src/serviceDescription.ts`, request classes that resolve a controller:
`SpaceRequest`, `CollectionRequest`, `ResourceRequest`, `RevocationRequest`,
`KeystoreRequest`; `@interop/http-signature-zcap-verify` `dist/index.js:109`
(the `getVerifier` call order, invariant 8).

Caches (invariant 10): `src/lib/policyCache.ts`, `src/requests/spaceContext.ts`,
`SpaceRequest.ts`, `SpacesRepositoryRequest.ts`, `BackendRequest.ts`,
`PolicyRequest.ts`, `CollectionRequest.ts`, `src/policy.ts`.

Policies (invariant 21): `src/types.ts:1256-1271`, `src/policy.ts`,
`PolicyRequest.ts`, both backends' policy files and rows.

Space Metadata object (WAS-176 `replicas`): `src/lib/spaceProjection.ts:114` and
its callers in both backends (`filesystem.ts:1660-1841`,
`postgres.ts:4014-4441`), `SpaceRequest.ts:50`, `SpacesRepositoryRequest.ts:17`.

Backend registry (added at review): `src/lib/backendRegistry.ts:85-97,112`. A
replicated Collection Metadata object may name a `backend` registration the
replica lacks, and each data-plane adapter is its own `StorageBackend` with no
`store.json` to carry an origin id. Section 5.5.

Unchanged consumers whose correctness now rests on a new assumption: the
`If-None-Match` 304 path (`notModified.ts`) assumes a Resource's replicated
validator is byte-identical on every replica (scoped to Resources at review;
container Metadata validators carry a local component, invariant 18); the import
plan (`importPlan.ts`) assumes stamps are re-minted on import (reversed at
review from "restored verbatim", open point 5); the client-annex clause depends
on `parseSelfHostedWebvh` accepting the replicated DID (invariant 6), not on the
resolved document alone.

## 4. Interaction matrix

Columns: A replicated write arriving; B Collection tombstone; C immutable
Collection; D peer stamp ahead of local time; E Space with a registration; F
controller log is a replicated copy; G one-way replica; H Delete Space on one
replica.

Review 2026-10-01: cells corrected at review are marked `(rev)`.

| Flow                                   | A                                                                                                       | B                                                                                                                                                                                            | C                                                                                 | D                                   | E                                                                                                                                              | F                                                                                                                   | G                                                        | H                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Create Space (`POST /spaces/`, by id)  | (rev) per server by the controller; `controller` is never applied, `type` must match at registration    | fine                                                                                                                                                                                         | fine                                                                              | fine                                | changed: registration needs the Space to exist first, under the same id as peer's                                                              | changed: a `did:key` create only, as today; promotion later, per replica                                            | fine                                                     | fine                                                                          |
| Update Space Metadata (`PUT .../meta`) | (rev) `name` applied under LWW; `controller`, `type` and server-derived members stripped                | fine                                                                                                                                                                                         | fine                                                                              | stalls pull                         | fine; `replicas` is server-derived, moves the local validator component only                                                                   | changed: promotion to a peer-hosted DID resolves from the copy (WAS-177), done per replica                          | fine                                                     | fine                                                                          |
| Delete Space                           | refused: the apply path never deletes a Space                                                           | fine                                                                                                                                                                                         | fine                                                                              | fine                                | changed: removes the registration (stored inside the Space, atomic with it)                                                                    | changed: removes the log copy; other Spaces that DID controls lose their controller                                 | fine                                                     | (rev) per replica; peer's loop backs off and records the error, never zombies |
| Create Collection (`POST /space/S/`)   | changed: a replicated Collection Metadata object creates the Collection on apply                        | (rev) a create over a tombstone mints a new generation, finishes any unfinished cascade, reads the tombstone as absent for `id-conflict`, quota, `If-None-Match: *`, `createdAt`/`createdBy` | fine                                                                              | stalls pull                         | fine                                                                                                                                           | fine                                                                                                                | fine                                                     | fine                                                                          |
| Update Collection Metadata             | (rev) LWW on the stored projection; immutable members merge forward, two different first sets stall     | fine                                                                                                                                                                                         | changed: `revisions.immutable` is immutable once set                              | stalls pull                         | fine                                                                                                                                           | fine                                                                                                                | fine                                                     | fine                                                                          |
| Delete Collection                      | (rev) tombstone applies by stamp and cascades; delete-wins over a newer member write (stated exception) | changed: leaves a stamped tombstone; cascade completion is detectable and resumable                                                                                                          | fine                                                                              | stalls pull                         | fine                                                                                                                                           | allowed today, unchanged; a replicated tombstone of a log Collection removes the controller on the replica too      | fine                                                     | fine                                                                          |
| Resource write                         | (rev) applied iff stamp greater than held, and the GET's `ETag` equals the feed's stamp; else skipped   | (rev) refused under a tombstone; the refusal advances the checkpoint (delete-wins)                                                                                                           | changed: update refused; equal-digest create idempotent; else refused; per origin | stalls pull                         | fine                                                                                                                                           | fine                                                                                                                | changed: a write on the replica never reaches the source | fine                                                                          |
| Resource delete and re-create          | changed: tombstone by stamp; re-create continues the generation as today                                | fine                                                                                                                                                                                         | changed: re-create over a tombstone needs an equal digest                         | stalls pull                         | fine                                                                                                                                           | fine                                                                                                                | as above                                                 | fine                                                                          |
| Resource `/meta` write                 | changed: LWW by the `/meta` record's own stamp (open point 2)                                           | (rev) a `/meta` stamped after a Resource tombstone is skipped while the tombstone holds                                                                                                      | fine: `custom` stays writable                                                     | stalls pull                         | fine                                                                                                                                           | fine                                                                                                                | as above                                                 | fine                                                                          |
| Chunk write and delete                 | fine: not replicated (WAS-14); takes the stamp and validator                                            | cascades as today                                                                                                                                                                            | changed: a chunk under an immutable Resource follows the same rule                | fine                                | fine                                                                                                                                           | fine                                                                                                                | fine                                                     | fine                                                                          |
| Governed log append (`meta/log`)       | (rev) fast-forward apply; prefix is a no-op; fork stalls the Collection with a durable reason           | fine                                                                                                                                                                                         | fine                                                                              | stalls pull                         | fine                                                                                                                                           | fine                                                                                                                | fine                                                     | fine                                                                          |
| `did.jsonl` append                     | (rev) same as the governed log, with verification; discovered through section 5.10, not the JSON feed   | fine                                                                                                                                                                                         | changed: an immutable Collection cannot host a log (append is an update)          | stalls pull                         | fine                                                                                                                                           | changed: the wallet may append on the replica directly (DR); the copy then leads; a fork is permanent               | fine                                                     | fine                                                                          |
| Update Space promotion to `did:webvh`  | (rev) not replicated; each replica is promoted by its controller                                        | fine                                                                                                                                                                                         | fine                                                                              | fine                                | fine                                                                                                                                           | changed: the proposed controller may be peer-hosted if its log is replicated here under a registration              | fine                                                     | fine                                                                          |
| Export Space                           | changed: statements attest stamp members; `createdBy` omitted for a foreign `origin`                    | changed: tombstoned Collections are archived as tombstones (codec change)                                                                                                                    | fine                                                                              | fine                                | changed: the registration is not exported                                                                                                      | fine: the log copy exports as a Resource                                                                            | fine                                                     | fine                                                                          |
| Import Space                           | (rev) stamps re-minted on import, shape-checked (open point 5)                                          | changed: restores tombstones                                                                                                                                                                 | (rev) import bypasses the digest rule as it does the envelope rule (open q. 7)    | (rev) n/a once stamps are re-minted | changed: import never creates a registration                                                                                                   | fine                                                                                                                | fine                                                     | fine                                                                          |
| Changes feed pull by a client          | changed: documents carry stamp members; a replicated write surfaces at a local position                 | (rev) the checkpoint embeds the Collection generation; a re-create restarts the reader                                                                                                       | fine                                                                              | fine                                | fine                                                                                                                                           | fine                                                                                                                | fine                                                     | fine                                                                          |
| Policy write and read                  | (rev) stamped and tombstoned (invariant 21); LWW on apply; cache dropped                                | fine: a Collection policy dies with the tombstone (WAS-127 applies)                                                                                                                          | fine                                                                              | stalls pull                         | fine                                                                                                                                           | fine                                                                                                                | fine                                                     | fine                                                                          |
| Revocation submit                      | (rev) not replicated in v1 (open point 10)                                                              | fine                                                                                                                                                                                         | fine                                                                              | fine: no stamp on a revocation      | fine                                                                                                                                           | changed: the submitted chain resolves the controller from the copy                                                  | fine                                                     | fine                                                                          |
| Keystore ops (`/kms`)                  | fine: not replicated                                                                                    | fine                                                                                                                                                                                         | fine                                                                              | fine                                | fine                                                                                                                                           | changed: a keystore promoted to a peer-hosted controller resolves from the copy                                     | fine                                                     | fine                                                                          |
| Client-annex clause bounds             | fine: reads the invoked chain, not the write's origin                                                   | fine                                                                                                                                                                                         | fine                                                                              | fine                                | fine: the registration sub-resource is a Space-scoped unsafe method, refused                                                                   | (rev) needs the annex log's auxiliary Space registered too (open q. 5); the pull delegation cannot be ladder-signed | fine                                                     | fine                                                                          |
| Backend registration                   | (rev) not replicated; a Collection naming a backend the replica lacks is stalled with a reason          | fine                                                                                                                                                                                         | fine                                                                              | fine                                | fine: both are per-server Space state, each moving the local validator component                                                               | fine                                                                                                                | fine                                                     | fine                                                                          |
| Registration create/delete (new)       | n/a                                                                                                     | fine                                                                                                                                                                                         | fine                                                                              | fine                                | (rev) controller-only incl. `GET`; peer controller must equal local; refusals (own id, `type`, `server` Space, differing id, non-read actions) | fine                                                                                                                | changed: one registration, no counterpart                | removed with the Space                                                        |
| Unique index / immutable create (new)  | (rev) both partitioned writes land; uniqueness and write-once hold per origin only (invariant 23)       | fine                                                                                                                                                                                         | as A                                                                              | fine                                | fine                                                                                                                                           | fine                                                                                                                | fine                                                     | fine                                                                          |
| Quota refusal on apply (new)           | (rev) durable per-Collection stall naming the quota (invariant 24)                                      | tombstones do not count                                                                                                                                                                      | fine                                                                              | fine                                | fine                                                                                                                                           | fine                                                                                                                | fine                                                     | fine                                                                          |

The two cells flagged for re-check in the draft are resolved: Delete Collection
/ F stays as today (a log Collection can be deleted, locally or by a replicated
tombstone), and Import / C stays a bypass, carried as open question 7.

## 5. Design

Extracted 2026-10-02. The canonical text of each rule below now lives in a
decision record, and this section is its working derivation: 5.1 and open point
4 in spec decision 0012; 5.2, the import and process rules of 5.3 and open
points 5, 12 and 14 in this repo's decision 0004; the stamp and order key of 5.3
and open points 2, 6 and 9 in spec decision 0009; the validator of 5.3, open
point 1 and wire items 11 and 15 in spec decision 0010; 5.4 and wire items 5, 12
and 16 in spec decision 0011; 5.5, 5.8, 5.10, 5.11, 5.12 and open points 3, 7,
8, 10 and 15 in spec decision 0013; 5.7 and wire item 8 in this repo's decision
0003; open point 13 and wire items 7 and 11 in this repo's decision 0005.

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

Review 2026-10-01: `immutable` holds per origin. Two partitioned creates of one
id with different digests both pass their origin's check and LWW keeps one; a
reader on the losing side saw bytes a write-once Collection later changed. An
update stamped before the `immutable` flag arrived but applied after it is
stored (the origin admitted it), not refused. Both go into the spec text as
limitations of the descriptor under replication. The governed-log derivation
needs a slot in the log's `state` schema, which the encrypted-collections
profile defines as `WasEpochConfiguration` with `encryption` as "the only member
a profile governs" (`spec.md:2842-2846`); the profile is a `touches` entry for
WAS-173.

### 5.2 Origin id (WAS-171)

`StorageBackend.originId: string`, read from `store.json` (filesystem) or a
store row (Postgres). `WAS_ORIGIN_ID` overrides verbatim; a mismatch with the
stored id refuses boot naming both. Charset `[A-Za-z0-9_-]{1,64}`. Advertised on
`/service`.

Review 2026-10-01: "a store migration step mints it" does not work with the
runner. An empty data dir is stamped at the current version and runs no step
(`filesystemStore.ts:157-160`); `writeStoreVersion` rewrites the file as
`{ version }` after every step (`:244-247`, `:185`), erasing anything a step
wrote; and a step receives no env. The mint is instead part of `init()`: under
the store lock, on every boot, read `store.json`; if it carries no origin id,
persist `WAS_ORIGIN_ID` when set, else a minted id; if it carries one, compare
with the env when set and refuse on mismatch. `writeStoreVersion` preserves the
members it does not own. The Postgres twin does the same in its migration
transaction under the advisory lock. A cloned data directory carries its origin
id with it; the admin guide says a restored clone that will run beside its
source must boot with a fresh `WAS_ORIGIN_ID`, and the pull loop refuses a
received stamp whose `origin` equals the local id (the cheapest duplicate
detection; a third server pulling from two clones is not detected, and is a
documented operator error). Data-plane backend adapters
(`backendRegistry.ts:112`) share the hosting server's origin id; they mint no
stamps of their own.

### 5.3 HLC stamp and validator (WAS-172)

A `src/lib/hlc.ts` with one clock per backend: `now()` returns `{ ms, counter }`
per the paper's send rule (`l = max(l, pt)`; `counter++` if `l` stood still,
else `0`); `observe({ ms, counter })` per the receive rule, refusing a stamp
more than `bound` ahead of `pt` (section 5.6). Minted inside the write's
critical section (the per-Space and per-Collection locks in
`filesystem.ts:2296-2317`, the row locks in Postgres).

Every versioned record stores `updatedAt` (ISO of `ms`), `updatedAtCounter`, and
`originId` (named `origin` in the draft; renamed at open point 9).
`EtagValidator` becomes `{ generation, ms, counter, origin }` and `formatEtag`
emits `"<generation>.<ms>.<counter>.<origin>"`. `version` and `metaVersion` are
removed from sidecars, rows, wire objects, and `provenanceStatement.ts` claims,
which attest the three stamp members instead. The order key is
`(ms, counter, origin)`, compared numerically then by plain string.

Review 2026-10-01, four amendments:

- Monotonic per record. The clock is in memory, so after a restart (or an NTP
  step) it can stand below a stamp this server already stored, after `observe`
  pushed it up to 60 s ahead or a fast peer did. A local write would then carry
  a lower stamp than the one it overwrites, the request path does not compare
  stamps, and every peer holding the higher stamp skips the newer bytes for
  good. The mint is `max(hlc.now(), held + one counter tick)` under the record's
  lock, after `observe(held)`, and the backend persists a high-water mark of `l`
  in `store.json` / the store row on a cadence (every mint that advances `ms`
  past the last persisted mark by more than a second) and seeds `l` from it at
  boot.
- One minting process per origin. Two processes over one Postgres store share
  one origin id and would mint identical `(ms, 0, origin)` for two successive
  writes to one record, giving different bytes the same strong validator and
  letting peers dedup the second away. v1 requires a single server process per
  store (recorded in ARCHITECTURE beside the cache entries, which already rest
  on it). Open point 12 records the alternative.
- Two stamp sets per Resource (invariant 3): the content record's and the
  `/meta` record's. `epoch` and `writerId` belong to the content record. The
  sidecar, the change document and the provenance statement carry both. Open
  point 2 names the members.
- Commit point. On the filesystem backend the representation lands before the
  sidecar (`#writeResourceLocked`, `filesystem.ts:2930` then `:2966`); a crash
  between them serves new bytes under the old validator, and a peer holding that
  validator never re-pulls. The sidecar, which holds the stamp and the feed
  position in one write, is the commit point: the representation is written
  under a name the sidecar then points at (or the sidecar carries a digest a
  read checks), so a torn write reads as the prior revision. The apply path
  writes in the same order.

A received stamp (apply, and import if it ever keeps one) is shape-checked
before it is stored: `ms` and `updatedAtCounter` safe non-negative integers,
`origin` within the charset. An `origin` that fails the check would otherwise
break the `ETag` header or the validator parser on every later read.

### 5.4 Collection tombstones (WAS-174)

The Collection Metadata record gains a deleted marker and keeps its stamp and
generation; `deleteCollection` writes it instead of removing the record and
still cascades to Resources, chunks, policies and the governed log. The Space
listing excludes tombstones unless a query flag asks for them. A create over a
tombstone mints a new generation.

Review 2026-10-01, four amendments:

- A tombstone reads as absent. Every existence check listed under invariant 4
  (the container re-check, `If-None-Match: *`, `id-conflict`, the Collection
  quota, `totalItems`, import's `collectionExisted`, the backend registry and
  Collection context reads, and the `createdAt` / `createdBy` carry-over) treats
  a tombstoned Collection as absent. Only the tombstone-aware listing and the
  apply path see it.
- The cascade is resumable. Today the Metadata file lives inside the directory
  `rm -r` removes (`filesystem.ts:2425-2434`); a tombstone needs a selective
  removal that is not atomic. The tombstone is written first; a tombstone with
  members still present is an unfinished cascade, detectable from durable state
  alone; it is finished at boot, on any touch of the Collection, before a create
  over the tombstone writes its new generation, and by the apply path even when
  the incoming stamp equals the held one. Postgres does the whole delete in one
  transaction. A retried `DELETE` after a torn cascade answers 404 (absent) and
  the next touch finishes the work.
- A generation change is a delete plus a create. A source that deletes and
  re-creates a Collection before the replica pulls shows the replica only the
  new live record; the stamp comparison would apply it as an ordinary update and
  leave the old members alive under the new Collection. An applied Collection
  Metadata object whose generation differs from the held one is applied as
  tombstone-then-create, cascade included, when its creating stamp (the stamp of
  the record's first write under that generation, carried with the generation)
  is greater than the held generation's creating stamp; otherwise it is skipped.
  "Whatever the stamps" would not terminate: two replicas that each re-created
  the Collection during a partition would swap generations every cycle,
  cascading the members away each time. The creating stamp is stored beside the
  generation (one more sidecar and row member, internal).
- Delete wins. The cascade removes members whose stamps are newer than the
  tombstone (a write on B at t11 against a delete on A at t10), and a member
  write refused under a tombstone advances the checkpoint rather than stalling.
  This is a stated exception to greater-stamp-wins, the same one Cassandra and
  Riak document for container deletes, and the spec's replication section says
  so. A controller who wants the member back re-creates the Collection and the
  Resource.

### 5.5 Apply path and pull loop (WAS-176)

`StorageBackend` gains `apply*` methods (Resource, Resource `/meta`, Collection
Metadata including the tombstone, Space Metadata, policy, log fast-forward),
each taking the stamped representation and storing it after the one comparison,
under the same locks and container re-check as a request-layer write, taking a
fresh feed position, and dropping the same cache entries. A `src/sync/` module
runs one loop per registration: enumerate the peer's Space through the discovery
channel of section 5.10 (Space-level state and the controller's log Collection
always included, the Collection list filtering the rest), pull each Collection's
changes feed under a per-peer opaque checkpoint, `GET` each representation,
apply.

The registration is a controller-only sub-resource of the Space (container rule,
no exception; `GET` controller-only too), per server, not replicated, not
exported, stored inside the Space's own directory or row so it dies atomically
with Delete Space. Members: the peer's Space URL (`fromSpace`), the local
Space's URL (`toSpace`), the delegated pull capability, an optional Collection
list (`[{ id }]`), a role (`source` in v1); wire item 6. Its runtime state is
served at a `status` sub-resource, not on the record. The served Space Metadata
object carries a server-derived `replicas` member listing each registered peer's
Space URL and role, derived in `spaceProjection.ts` beside `backends`.

Review 2026-10-01, the apply rule restated per kind (replacing "verbatim"):

- Input is the stored projection. The puller `GET`s the served object and strips
  what the request layer would ignore (invariant 19): on the Space object `url`,
  `linkset`, `backends`, `replicas`, `createdBy`, and `controller` and `type`
  (invariant 20); on a governed Collection the derived `encryption`. `createdBy`
  on a Resource is kept.
- Space Metadata: `name` under LWW. Nothing else.
- Collection Metadata: LWW on the stored projection, with the immutable members
  (`encryption`, `revisions.resolution`, `revisions.immutable`) merged forward:
  a member the incoming object omits and the local one holds is kept; two
  different set values are a fork and stall the Collection (section 5.11). A
  Collection whose `backend` names a registration the replica lacks stalls the
  same way, naming the backend; v1 does not translate backend ids.
- Resource and `/meta`: LWW per record on its own stamp. The content `GET`'s
  `ETag` must equal the stamp the feed named, else the apply is retried next
  cycle (the content and `/meta` are two reads, and the members set by the
  content write come from `/meta`). A `/meta` stamped after a Resource tombstone
  is skipped while the tombstone holds.
- Collection tombstone: section 5.4.
- Policy: LWW on its stamp, tombstone included (invariant 21).
- Governed log and `did.jsonl`: fast-forward; a prefix is a no-op; a fork stalls
  the Collection.
- Revocations: not replicated in v1 (open point 10).

Registration checks, restated: the controller registers; the peer Space's
Metadata object is read through the pull capability and its `controller` must
equal the local Space's (else a holder of any readable pull capability could
register another user's Space as their own source and read it through root
invocations on the copy); its `type` set must equal the local one; its Space id
need not equal the local one (decided 2026-10-02: the registration itself is the
mapping section 5.8 reads, so a Space minted with a server-assigned id on one
host replicates into a differently named Space on another); the capability's
chain must root in that peer Space and its `allowedAction` lie within
`{GET, HEAD}`; the peer's origin id must not be this server's; the local Space
must not be the `server` Space (its controller is the admin and the plugin
refuses to boot over a changed one). The record is stored only after these pass.
The stored capability is served back to its controller only.

Loop lifecycle: boot enumerates stored registrations and starts one loop each (a
crash between the store and the first cycle is healed by the next boot). The
registration carries the Space's generation; the apply path checks registration
presence and generation under the Space lock on every batch, so a loop that
outlives Delete Space, or a registration that survives a re-create under the
same id, applies nothing. A peer error does not stop the loop: a 404 (which the
masked denial also answers for an unresolvable key, an expired grant, or a
transient failure to fetch this server's log) backs off exponentially to a cap,
which the `status` sub-resource shows as `backing-off` with `nextPullAt`.
Nothing stops permanently; the controller deletes the registration to stop it.

### 5.6 Clock bound

A received stamp whose `ms` exceeds local time by more than a configured bound
is not applied; the pull stalls at that position, the checkpoint does not
advance, and a `warn` names the peer. Proposed default: 60 s.

Review 2026-10-01: the bound does not compound across hops, since each receiver
checks against its own physical time. A stall under the bound clears itself as
local time catches up; the durable stall record of section 5.11 names the reason
so an operator can tell it from a fork.

### 5.7 Sync key and peer verification (WAS-175)

Decided 2026-10-02 (wire item 8), replacing the draft's second key: the one seed
key serves both roles. The admin lists it in the server log under
`assertionMethod` and `capabilityInvocation`; the server signs sync invocations
as `{serverDid}#{key}`, and a controller delegates the pull capability to
`serverDid`, never to a bare key. There is no `did:key` signing form and no
`/service` member for the key. `resolveServerDid` requires `assertionMethod`,
permits `capabilityInvocation`, and still refuses the other relationships.
Replication requires the identity; a registration without it is refused.

Verifying a peer: `zcap.ts`'s resolver gains one bounded network path. When the
invoker's DID is a `did:webvh` with path `space:server:id` and it is the
controller of a delegated capability whose chain verified to the Space
controller, the log is fetched from `{host}/space/server/id/did.jsonl`, verified
like any log, cached per DID, re-fetched once when a signature names a key the
cached document lacks, with a size bound and a timeout. Any other foreign
`did:webvh` stays refused.

Review 2026-10-01, the gate and the bounds restated (invariant 8):

- Order. The key hook runs before the capability is decoded, so "whose chain
  verified" cannot be checked there. The route's verify path adds a pre-pass:
  decode the `Capability-Invocation` header, verify each delegation proof and
  the chain's root against the Space controller, and only then let the key
  resolver fetch, for exactly the DID the verified chain's last link names as
  controller. A request that fails the pre-pass never causes a fetch.
- Host bound. The fetch is `https` only, default port only, follows no redirect,
  refuses loopback, private, link-local and metadata address ranges after
  resolution, and is rate-limited per host and per DID. A fresh `#fragment`
  forces at most one re-fetch per DID per bound interval.
- Cache. Bounded in size, entries expire on a TTL and revalidate the way the
  controller cache does (WAS-75's revalidation), so a sync key the admin retires
  from the server log stops verifying on every peer within one TTL rather than
  persisting until a key miss. The `did:key` signing form is bound to the seed,
  so retiring a stolen sync key means rotating the seed, which also rotates the
  export key; the admin guide says so.
- A controller delegating to a server DID may point at any host; the bounds
  above limit what that host can cause, and the delegation is what the
  controller chose. The pull capability is read-only by the registration check
  in section 5.5.

### 5.8 Controller resolution from a replicated log (WAS-177)

`parseSelfHostedWebvh` accepts a host that is a registered peer's host when the
log Collection it names is replicated here, and the rest of `webvhController.ts`
runs unchanged over the local copy. No network fetch.

Review 2026-10-01: "a registered peer's host" is too wide, and the local
`(spaceId, collectionId)` the DID names could be another user's Space on this
server (a stranger creating Space `S` here and registering any source on host A
would squat Alice's `did:webvh:...:A:space:S:id`). The mapping goes through the
registration: a DID with host `H` and path `space:S:C` resolves here iff some
registration on a local Space `X` names the peer Space URL `https://H/space/S/`
(`X` need not be `S`, section 5.5), and the copy is read from `X`'s Collection
`C`. The parser gains a lookup against the registration set (an async read,
cached beside the Space Metadata cache), and every caller under invariant 6 gets
the widened result except `serverIdentity.ts`.

### 5.9 Open points for the maintainer (review 2026-10-01)

Each is a decision only the maintainer can make, either wire-level or a design
fork. The recommendation is first.

1. Derived members and the validator (invariant 18). Recommended: a container
   Metadata object's served `ETag` carries a fifth, local segment,
   `"<generation>.<ms>.<counter>.<origin>.<local>"`, a per-server counter
   advanced by a backend or replica registration and by a governed-log append;
   the four-field stamp stays the replication order and is what `If-Match`
   compares on Resources. Alternatives: (b) drop `backends` and `replicas` from
   the Metadata object and serve them only at their sub-resources, reversing the
   earlier decision to carry `backends` there; (c) mint a stamp on a derived
   change, rejected (loses real writes). Decided 2026-10-01: the fifth, local
   segment. Resources keep the four-field form; a container Metadata object's
   `If-Match` compares all five.
2. Two stamp sets on a Resource (invariant 3). Recommended member names for the
   `/meta` record: `metaUpdatedAt`, `metaUpdatedAtCounter`, `metaOrigin`, beside
   the content record's three, on the sidecar, the change document and the
   provenance statement. Also: whether a `/meta` write keeps clearing `writerId`
   (spec "declare-or-clear at both levels") now that `writerId` is a
   content-record member; recommended: a `/meta` write no longer touches it.
   Decided 2026-10-01: the `/meta` record's stamp and generation are one nested
   object, `meta: { updatedAt, updatedAtCounter, originId, generation }`, on the
   sidecar, the change document, the provenance statement and the served `/meta`
   object; the flat `metaGeneration` / `metaVersion` members go (no migration,
   data wipe assumed). The content record's `updatedAt` stays the top-level
   member. A `/meta` write no longer touches `writerId`, which belongs to the
   content record; the spec's "declare-or-clear" rule for Update Resource
   Metadata is withdrawn.
3. `controller` is per-server (invariant 20). Recommended as stated. The
   alternative, replicating a promotion with a resolve-before-apply rule and an
   ordering guarantee on the log, is more machinery for the one flow (promote
   once, pull everywhere) that the per-replica promotion already covers. Decided
   2026-10-01: per-server, not replicated; the apply path writes `name` only.
4. Forward merge of immutable members (invariant 15). Recommended: absent
   incoming keeps local; differing set values stall as a fork. Alternative:
   stall on any difference. Decided 2026-10-01: (a), plus two prevention rules
   so the fork is unreachable rather than a UX path. First, the immutable
   members (`encryption`, `revisions.resolution`, `revisions.immutable`) are
   creation-only: declared in the write that creates the Collection (the guarded
   create, the first `PUT .../meta`, or the governed-log guarded create), and
   refused on an existing Collection that lacks them; the spec sentence
   "declaring it on a Collection that lacks one is allowed" (`spec.md:5291`) is
   withdrawn. Checked 2026-10-01: the App Connect flow creates a private
   Collection governed and encrypted from birth (freewallet `processZcaps.ts` to
   `provisionEncryptedCollection`); the late declaration survives only as
   fallbacks, the `edv` branch of was-client `sync/provisioning.ts` (no wallet
   caller passes `edv`) and was-react `markCollectionEncrypted` (skipped
   whenever a descriptor exists), both to be removed, with dcw's sync smoke test
   checked for the `edv` default. wallet-core and freewallet need no change.
   Second, a replica registration reads each listed Collection's Metadata object
   from the peer and is refused when an immutable member differs from the local
   one, as the Space `type` is checked. `encryption.version` merges by `max`. A
   differing set value that still arrives is an invariant violation: it stalls
   the Collection with a `warn`, and is not expected in practice.
5. Import stamps. Recommended: re-mint on import, origin the importing server,
   as `updatedAt` is re-stamped today (`space-archive-fixture.test.ts`), and
   `observe` nothing. The draft said "restored verbatim", which is the
   client-declared clock alternative 5 rejects: a delegated importer could land
   a stamp dated far ahead that stalls every peer's pull of that Collection
   permanently. Trade-off: a restored backup's records beat concurrent peer
   writes, which is what importing asks for. Decided 2026-10-01: re-mint on
   import, origin the importer; the archived stamps are read for provenance
   only. The wallet's restore flow warns when the destination Space has
   registrations.
6. Policy stamps (invariant 21). Recommended: the policy document gains the
   three stamp members and a `deleted` marker, same names as a Resource; the
   policy `ETag` becomes the four-field validator. The members are wire. Decided
   2026-10-01: as recommended. The stored policy gains the three stamp members,
   a generation and a `deleted` tombstone marker; `GET /policy` serves the
   four-field `ETag` and the stamp members as server-derived members the write
   body ignores; `PUT` and `DELETE` take `If-Match` / `If-None-Match: *`; a
   tombstoned policy reads as absent everywhere except the replication listing
   and the apply path.
7. Discovery channel (section 5.10). Recommended: a replication listing. Decided
   2026-10-01: against the recommendation, alternative (b). The `changes`
   profile is widened (WAS-182): every Resource regardless of content type, and
   the non-Resource kinds (Collection Metadata, policies, governed log) under a
   `kind` discriminator consumers filter on. Leaving binary Resources out of the
   feed was an oversight, not a design choice.
8. Stall granularity and record (section 5.11). Recommended as stated. Decided
   2026-10-01: per Collection, as stated.
9. Names. `replicas` is already used by a spec ednote for per-Collection backend
   replicas (`spec.md:3955-3975`); recommended: keep `replicas` for the
   Space-level registration and rename the ednote's concept when it lands.
   Decided 2026-10-01: confirmed; `backends` is the natural name for the
   ednote's per-Collection concept. `origin` sits beside `generator.origin` (a
   Web origin) on the same Collection Metadata object; recommended: keep, since
   one is nested. Decided 2026-10-01: the stamp member is renamed `originId`, on
   every record, the change document, the provenance statement and the nested
   `meta` object; the order key is written `(ms, counter, originId)`. `originId`
   on `instance` is gated on by registration, which the spec forbids
   (`spec.md:1105`); recommended: advertise it on the core
   `https://w3id.org/pws` `specs` entry instead (or a replication profile
   entry), not on `instance`. Decided 2026-10-01: on the core `specs` entry; the
   sync key stays on `instance`, since nothing gates on it. `zcaps` and
   `replicas` join the reserved registry (invariant 22). Decided 2026-10-01:
   confirmed; `zcaps` is a registry omission independent of this design.
10. Revocations. Capability targets are host-bound, so a revocation stored on A
    names a capability that can only ever be invoked at A; unioning it into B
    revokes nothing there and lets a peer inject unverified records.
    Recommended: drop the union from v1 (WAS-178 then stands alone as a read, or
    is withdrawn); key retirement through the log is the cross-replica revoke.
    Decided 2026-10-01: dropped from v1; revocations are per replica, like
    grants. WAS-178 stays as a plain read for the wallet.
11. Provenance `createdBy` for a foreign origin (invariant 14). Recommended:
    omit the member from the statement's claims when `origin` is not the
    exporting server; import then strips `createdBy` on that object as it does
    for `unattested`. Alternative: attest it under a distinct member
    (`replicatedCreatedBy`) that import keeps unverified. Decided 2026-10-01:
    (a) for v1, as a transitional rule. The lasting answer is a write-time
    creation statement (`createdBy`, `createdAt`, generation, signed once by the
    creating origin and carried with the record) beside a per-revision
    statement, filed as WAS-184; once a record carries one, export forwards it
    instead of omitting the member.
12. One process per origin (section 5.3). Recommended: document the requirement.
    Alternative: a per-process origin suffix, which makes the origin id no
    longer a store property. Decided 2026-10-02: document the requirement, in
    ARCHITECTURE beside the cache entries that already rest on it and in the
    admin guide; the multi-process question is parked as WAS-185.
13. Topology disclosure. The served `replicas` member tells any reader of the
    Space Metadata object (an app's read grant, the client-annex third shape's
    `GET /space/<S>/meta` branch) every host holding the user's data, while the
    registration itself is controller-only. Recommended: open point 1's
    alternative (b), serving `replicas` at its sub-resource only, which also
    removes one derived member from the validated object. If `replicas` stays on
    the object, record the disclosure as accepted (wire item 7). Decided
    2026-10-01: `replicas` stays on the object, symmetric with `backends`, and
    the disclosure is accepted: the object's readers are the controller's own
    sessions or a holder of a Space-wide grant the controller chose to issue,
    who already reads the data itself.
14. Existing records at upgrade. Section 5.3 removes `version` from sidecars and
    rows but names no store migration step, and a booted data dir would hold
    records with no stamp. Under the greenfield stance the recommended answer is
    to refuse such a store at boot (a `STORE_MIGRATIONS` entry that fails naming
    the layout) rather than stamp old records; the maintainer may choose a
    stamping step instead. The same applies to a Collection already named
    `replicas` or `zcaps`, hidden once the segment is reserved. Decided
    2026-10-02: refuse at boot. The layout version is bumped and the new step
    throws `StoreVersionError` over a store holding any Space (both backends);
    no stamping, no renaming. An empty store is stamped at the new version and
    boots.
15. A `features` token for replication on the core `/service` entry, so a
    registration can refuse a peer that does not serve the replication listing
    (a pre-upgrade peer answers 404, which section 5.5 would back off on with no
    recorded cause), and so the spec can say which of the stamp members and the
    four-field validator are core requirements for a server that never
    replicates. Recommended: a token beside the origin id (open point 9), and
    the stamp members and validator as core, since a client's dedup rule reads
    them. Decided 2026-10-02: no token. `originId` is core (it feeds export
    signing as well as replication) and sits on the core `specs` entry, and the
    stamp members, the four-field validator and the widened feed (WAS-182) are
    baseline requirements of the core spec version. Replication itself is a
    separate specification with its own versioning, since it will be learned
    from and iterated: the server lists a `https://w3id.org/pws/replication`
    entry (version `0.1`) in `specs`, and listing it is the claim that the
    `replicas` registration sub-resource, the pull loop and the apply path are
    served. The registration check reads the peer's entry at a version this
    server speaks together with its `originId`, and refuses a peer lacking
    either, with a recorded reason. A change to what the loop accepts is a new
    version of that entry.

### 5.10 Discovery channel (review 2026-10-01)

The draft discovered everything through the Collection's changes feed. The feed
carries JSON Resources only (`filesystem.ts:4400-4432`, `postgres.ts:2927`), so
`did.jsonl` (`text/jsonl`), binary Resources and their tombstones, Collection
Metadata writes (which the spec makes "invisible to replication",
`spec.md:2236-2239`), policies, and the governed log are never seen. The
controller's log, the one Collection the design always replicates, was
unreachable. The listing items of List Collections carry `id`, `url`, `name`
only (`spec.md:1821-1823`), so a listing walk cannot tell what changed either.

Decided 2026-10-01 (open point 7): the `changes` profile itself is widened
(WAS-182). Every Resource write and tombstone takes a feed position whatever its
content type, with a `contentType` member on the change document; a Collection
Metadata write, a Collection or Resource `/policy` write or tombstone, and a
governed-log append each take a feed position too, and every change document
carries a `kind` member that existing consumers (was-sync, dcw, was-react)
filter on. The feed stays per Collection, so the checkpoint is per Collection
and matches the stall unit of section 5.11. Space-level state has no Collection
feed to ride: Space Metadata `name`, the Space policy and Collection tombstones
are discovered by the tombstone-aware Space listing and conditional `GET`s of
the Space's `meta` and `policy`; the Space policy's tombstone must be readable
with its stamp by the pull loop (WAS-183). Chunk bytes stay with WAS-14, which
decides between a chunk kind in the feed and a per-parent listing walk.
Declined: a separate replication listing under the Space (a second channel and a
second checkpoint discipline for the same records), and a per-cycle `GET` of
each `meta`, `policy` and `meta/log` plus a listing walk (one request per record
per cycle, and blind to a binary tombstone).

Per-cycle cost is one feed page per Collection that changed plus one `GET` per
changed record, and nothing for a Collection whose feed is unchanged. Two
further costs the review sized: the widened `parseSelfHostedWebvh` adds one
cached registration lookup to every request that carries a `did:webvh` key id
(section 5.8), and the apply path's registration check holds the Space lock once
per batch, not per record.

### 5.11 Stall rule and checkpoint (review 2026-10-01)

The draft said a fork "stalls that Resource" while the checkpoint is a single
per-Collection position; one cannot skip one Resource. Rule: a stall is per
Collection. The checkpoint holds, the reason (clock bound, fork, quota,
unresolvable backend, container refusal) and the position are recorded with the
registration durably and served to the controller at the registration's `status`
sub-resource (wire item 6), and the loop retries that Collection each cycle
while the others continue. A clock-bound stall clears itself. A fork, a quota,
or a backend stall clears when the controller removes the cause (deletes the
conflicting record, raises the quota, registers the backend) or deletes the
registration. A refusal under a Collection tombstone is a skip, not a stall
(section 5.4).

The per-peer checkpoint is stored on the registration, per Collection, written
only after every apply it covers is durable, and embeds the peer Collection's
generation (invariant 11). On a generation change the reader restarts that
Collection from the beginning.

### 5.12 Grants per replica (review 2026-10-01)

Capability targets are host-bound (decision 6), so every grant a wallet holds
names one server's URL and verifies nowhere else. "A controller delegates once
per replica" covers every kind, and the wallet repos' items inherit this
inventory: the generation delegation to the client annex (clause shape 1), each
app's Collection grant, the annex and transient-session grants, the unlock-Space
management capability and the session reads and exports minted from it (shapes 4
and 5), the bridge grants (shape 2), the backup-export grant, and the pull
capability itself. On the replica each is minted anew against the replica's URL,
needs the replica's own annex log (open question 5), and is revoked there
separately, since revocations are per replica (open point 10); the annex garbage
collector's re-point-then-revoke runs per host. Until the wallet has re-minted
on a replica, only root invocations by enrolled-client keys work there, which is
what the replicated controller log buys (alternative 11). DID-relative targets
(alternative 13) are what would collapse this to one grant.

### Wire-level decisions pending individual sign-off

Agreed with the maintainer on 2026-10-01: the names `revisions`, `resolution`,
`updatedAtCounter`, `originId` (renamed from `origin` at open point 9); the
validator `"<generation>.<ms>.<counter>.<origin>"` with `ms` the epoch integer;
`WAS_ORIGIN_ID` used verbatim; the order key `(ms, counter, origin)`. The rest
are proposals:

1. `revisions.resolution` values: `last-writer-wins`; reserved `keep-conflicts`.
   `revisions.immutable` boolean. `revisions.merge` object, verbatim. Decided
   2026-10-02: as proposed.
2. The immutable-write refusal: error name and status (proposal:
   `resource-immutable`, 409). Decided 2026-10-02: `resource-immutable` (409)
   for a write refused by `revisions.immutable`, and `revisions-immutable` (409)
   for a change to a set `resolution` or `immutable`, the counterpart of
   `encryption-immutable`.
3. The origin-id charset `[A-Za-z0-9_-]{1,64}` and its `/service` member name
   and placement (decided: `originId` on the core `specs` entry, open point 9).
4. The change-document stamp members: `updatedAtCounter` and `originId` beside
   `updatedAt`, and the `/meta` record's three (open point 2).
5. The Space listing query flag for tombstoned Collections (proposal:
   `?include=deleted`). Decided 2026-10-02: as proposed; the same flag reads a
   policy tombstone (wire item 12).
6. The registration sub-resource path (proposal: `/space/:spaceId/replicas`,
   `POST` to add, `GET` to list, `DELETE /space/:spaceId/replicas/:id`) and its
   members (`spaceUrl`, `capability`, `collections`, `role`, plus the served
   `lastError`, `stalls` records of section 5.11), and `replicas` and `zcaps` in
   the reserved registry. Decided 2026-10-02: path `/space/:spaceId/replicas`
   (`GET` lists, `POST` adds) and `/space/:spaceId/replicas/:replicaId` (`GET`,
   `DELETE`; no `PUT` in v1), every method controller-only. The record is a
   directed edge the controller writes and reads back unchanged under its own
   `ETag`: `id` (client-supplied, URL-safe, `id-conflict` on a duplicate),
   `fromSpace` (the peer Space's canonical URL, where data comes from),
   `toSpace` (the local Space's canonical URL), `capability`, `collections` (an
   array of `{ id }` objects, absent meaning all, with room for per-Collection
   conditions later) and `role` (`source`). Runtime state is served at
   `GET /space/:spaceId/replicas/:replicaId/status`, controller-only and
   uncacheable: `state` (`idle | pulling | backing-off | stalled`),
   `lastPullAt`, `lastSuccessAt`, `nextPullAt`, and `collections`, each
   `{ id, state, lastAppliedAt, stall? }` with `state` from
   `synced | syncing | stalled | skipped` and `stall` as
   `{ reason, since, detail }`. No `lastError`; an errors feed can join the
   status endpoint later. `replicas` and `zcaps` join the reserved registry and
   `replicas` the Space linkset.
7. The `replicas` member on the served Space Metadata object
   (`[{ url, role }]`), or its removal from the object in favor of the
   sub-resource (open point 13). Decided 2026-10-02: stays on the object, as
   `[{ fromSpace, toSpace, role }]`, the registration's own vocabulary, with no
   registration `id` and nothing dynamic; derived beside `backends` and moving
   the Space Metadata `ETag`'s local segment on add and delete.
8. The sync-key HKDF derivation label and its `/service` member name (proposal:
   `syncInvocationKey`). Decided 2026-10-02: neither. There is no second key and
   no `/service` member. The one seed key is listed in the server log under
   `assertionMethod` and `capabilityInvocation`; `resolveServerDid` and the
   import statement check require `assertionMethod` and permit
   `capabilityInvocation`, still refusing `capabilityDelegation`,
   `authentication` and `keyAgreement`. The pull capability's `controller` is
   `serverDid`, so the wallet learns no key and the admin rotates the key in the
   log without re-delegation. Replication therefore requires a server identity:
   a registration on a server with no advertised `serverDid`, or whose log does
   not list the key under `capabilityInvocation`, is refused naming that, and
   the `did:key` signing fallback of section 5.7 is withdrawn.
9. The clock-bound setting (proposal: `WAS_REPLICATION_CLOCK_BOUND_MS`, default
   `60000`). Decided 2026-10-02: as proposed, with the default a constant in
   `config.default.ts`; the replication spec recommends the 60 s default.
10. The read-only-switch problem type (WAS-179, later).
11. (review) The local validator segment on container Metadata objects (open
    point 1). Decided 2026-10-02: a non-negative integer counter per container
    record, reset to `0` by a stamped write and incremented by each
    derived-member change (backend or replica registration and removal on a
    Space, governed-log append on a Collection); never replicated, never served
    as a member, outside the replication order.
12. (review) The policy document's stamp members and `deleted` marker (open
    point 6). Decided 2026-10-02: `GET /policy` at all three levels serves
    `updatedAt`, `updatedAtCounter`, `originId` as server-derived members a
    `PUT` body ignores, the generation inside the `ETag` only; the policy
    section reserves those names and `deleted`. A `DELETE` stores
    `{ deleted: true }` plus the stamp, with no `type`; a `PUT` over it mints a
    new generation; a `DELETE` of an absent policy stays 204 and writes nothing.
    A tombstone is 404, byte-identical to absent, unless read with
    `GET /policy?include=deleted` under a capability, which answers it 200 with
    its `ETag` (the same flag as the Collection listing, wire item 5). `PUT` and
    `DELETE` take `If-Match` / `If-None-Match: *`.
13. (review) The change document's `kind` values and `contentType` member (open
    point 7, WAS-182). Decided 2026-10-02: `kind` is a required closed set,
    `resource` (a Resource or its tombstone, `data` inline when JSON),
    `collection-metadata` (the Collection Metadata object or its tombstone),
    `policy` (a Collection or Resource policy or its tombstone, with a `target`
    member naming the policy's URL, since a policy has no id of its own) and
    `log` (the governed log); a consumer skips a `kind` it does not know, so a
    later chunk kind is additive. `contentType` is always present on
    `kind: resource`, a tombstone carrying the last-known type. The stamp
    members `updatedAt`, `updatedAtCounter`, `originId` replace `version` and
    the nested `meta` object replaces `metaVersion`; `etag` and `metaEtag` stay.
    `_deleted` is renamed `deleted`, the one name for a tombstone on every
    object in the design (the feed document, the Collection listing item, the
    policy); was-sync maps it to RxDB's `_deleted` at its boundary. Refined
    2026-10-04: a `collection-metadata` or `log` document carries the record's
    absolute URL as its `id` (`.../meta`, `.../meta/log`), and every document
    carries the record's `generation` as a top-level member beside the stamp.
    The `policy` kind ships with the stamped policies (WAS-183); whether it
    keeps `target` or carries its URL as `id` like the other non-Resource kinds
    is open there.
14. (review) The provenance statement's `createdBy` rule for a foreign origin
    (open point 11).
15. (review) The checkpoint's embedded generation (opaque, so internal, but it
    changes WAS-93's refusal text: a checkpoint from another generation is
    refused and the reader restarts). Decided 2026-10-02: the Collection feed
    generation alone, as WAS-93 already encodes
    (`{ feed, generation, position }`); the Space generation is redundant, since
    a re-created Space re-creates its Collections under fresh feed generations.
    The refusal stays `invalid-request-body` (400) and the reader restarts; no
    new problem type.
16. (review) The Collection tombstone's archive form in `@interop/space-archive`
    (a file-name dialect change). Decided 2026-10-02: the same
    `.collection.<id>.json` file, its body the stored tombstone (`deleted: true`
    plus the stamp, `_generation` embedded) with no `space/<id>/` directory, and
    `deleted: true` on the manifest's Collection entry. Always exported;
    imported only when the destination has no record under that id, re-stamped
    like everything else, so a restored tombstone deletes that Collection on
    peers at the next pull (point 5's rule applied to deletes; the restore
    warning covers it). In the same dialect change `_version` leaves every
    Metadata file and the stamp members are stored bare, `_generation` staying
    embedded.

## 6. Alternatives rejected

Extracted 2026-10-02: alternatives 1 to 5 are recorded with revisit criteria in
spec decision 0009 (3 is the one not marked do-not-reopen); 6 to 12, 14 and 15,
and the deferral of 13, in spec decision 0013; 8 (no Space tombstones) also in
spec decision 0011. The list stays as the derivation.

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
   Do-not-reopen. Review 2026-10-01: import restoring archived stamps verbatim
   was this alternative by another door; open point 5.
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
    keeps the account alive on the surviving server. Do-not-reopen. Review
    2026-10-01: "alive" is scoped. The copy keeps the controller resolvable, so
    root invocations by enrolled-client keys work on the surviving server; every
    delegated grant is host-bound and dead there until re-minted (section 5.12).
12. Excluding the `id` Collection from replication, with the wallet writing each
    replica's log itself. Rejected for the same DR reason and because the sync
    loop is no mechanism at all; may be rolled back if the replicated log causes
    problems.
13. Host-independent capability targets. Deferred, not rejected: future
    DID-relative URLs will cover several hosts under one target.
14. (review 2026-10-01) Replicating `controller` with a resolve-before-apply
    rule. Rejected in favor of per-replica promotion (open point 3); the
    compromised-source takeover and the deadlock on an absent log are the
    reasons.
15. (review 2026-10-01) `did:webvh`'s own portable move (a moved log whose
    current id is self-hosted, `spec.md:4318-4320`, `did-method-webvh`
    `method.ts:109`) as the disaster-recovery mechanism instead of a replicated
    log. Not weighed in the draft; deferred, not rejected. It would move the
    account rather than copy it, and interacts with wallet-core's single-host
    account pointer (open question 8). Recorded so the next pass weighs it.

## 7. Test plan

- `test/hlc.test.ts`: frozen clock; two same-ms writes get counters 0 and 1; a
  clock step backwards does not lower `ms`; `observe` advances the clock and
  refuses a stamp past the bound; (review) a restarted clock behind a stored
  stamp mints above the held stamp; the high-water mark is persisted and seeded.
- `test/etag-layout.test.ts` (or the existing per-route suites): the four-field
  validator on every record kind, `If-Match` round trip, 304 on `If-None-Match`,
  a hard delete and re-create minting a new generation; (review) the local
  segment on a container Metadata object moves on a backend registration and a
  log append while the stamp does not; a received stamp of bad shape is refused.
- `test/origin-id.test.ts`: mint, verbatim env, mismatch refusal, charset,
  `/service` advertisement; a Postgres twin behind the flag; (review) a kill
  between the id write and the version stamp keeps the id; a fresh dir mints;
  `writeStoreVersion` preserves the id.
- `test/revisions-api.test.ts`: defaults, unknown value refused, immutability of
  the descriptor, immutable Resource rules on plaintext and encrypted
  Collections, governed-log derivation.
- `test/collection-tombstone.test.ts`: tombstone after delete, listing flag,
  re-create generation, cascade, export and import of a tombstone; (review) a
  tombstone reads as absent for `id-conflict`, `If-None-Match: *`, the quota and
  the container re-check; a torn cascade is finished on the next touch;
  `forgetDeletedWebvhLocation` runs on an applied tombstone.
- `test/replication.test.ts`: two in-process servers over separate data dirs and
  ports (`startTestServer` twice); register one as the other's source; write on
  the source; assert same bytes, `ETag`, `updatedAt` on the replica (Resources;
  container Metadata objects compare on the four-field stamp); pause the pull,
  write the same Resource on both, resume, assert convergence on the greater
  stamp; one-way registration leaks nothing back; a peer stamp past the bound
  stalls with a `warn`; Delete Space on the source backs the replica's loop off
  and records the error; a `did.jsonl` fork stalls the Collection with a durable
  reason and the sibling Collections continue; (review) a delete and re-create
  on the source before the pull cascades on the replica; a newer member write
  loses to the tombstone; a `/meta` edit on one side does not skip a content
  write on the other; a replicated Space object changes `name` only; a
  registration naming a Space with another controller is refused; a registration
  with a write-capable capability is refused; a loop outliving Delete Space and
  re-create applies nothing; boot restarts loops; a policy deleted on the source
  is deleted on the replica.
- `test/server-identity-api.test.ts`: the sync key advertised; `did:key` and
  `did:webvh` signing forms; `resolveServerDid` tolerates the sync key under
  `capabilityInvocation` and still refuses the export key there.
- `test/peer-webvh-resolution.test.ts`: the bounded fetch, re-fetch on a key
  miss, size and timeout refusals, and refusal of a non-`space:server:id` DID;
  (review) no fetch for a request whose chain fails the pre-pass; refusal of
  `http`, a non-default port, a redirect, a private address; the rate limit;
  cache TTL revalidation drops a retired key.
- `test/webvh-controller-replica.test.ts`: a controller minted on A resolves on
  B after a pull; a key retired on A stops authorizing on B after the next pull;
  a non-peer host stays refused; (review) a stranger's same-id Space on B does
  not resolve the victim's DID; a prefix log from the source is a no-op.
- Provenance: `test/export-provenance` and `import-provenance` suites assert the
  stamp claims and (review) the `createdBy` omission for a foreign origin;
  `space-archive-fixture.test.ts` re-pinned against the republished fixtures.
- (review) Seams the plan needs: `createApp` takes an injectable physical clock
  per server, so two in-process servers can disagree by more than the bound, and
  an injectable fetcher for the peer-log fetch of section 5.7, whose host bound
  (`https`, default port, no loopback) otherwise keeps the pre-pass and the
  fetch out of `test/` entirely. The replication, tombstone and HLC apply tests
  get a Postgres twin behind the same flag as `origin-id.test.ts`; both backends
  implement every apply method.
- (review) Two-way registration: a partitioned delete-and-re-create on both
  sides converges on one generation and stays there.
- Existing suites that must stay green: every `test/` suite,
  `pnpm conformance:local` after the suite gains the stamp and `revisions`
  cases.

## 8. Open questions

1. WAS-14, three items this design leaves to it: discovery of chunk and binary
   changes (binary Resources now ride the widened feed of section 5.10; a chunk
   kind in that feed or a per-parent listing walk is WAS-14's to pick); chunk
   tombstones (stamped, or cascade-only through the parent); whole-stream
   consistency (tying a chunk's validity to the parent revision it was written
   under). Owner: WAS-14.
2. Tombstone retention. Never reaped in v1; a retention rule needs peers to
   report their position back. Owner: WAS-13.
3. Whether `keep-conflicts` accepts a stale `If-Match` write as a sibling on a
   single server (giving offline clients the conflict model before any second
   primary). Owner: the item that promotes `keep-conflicts`.
4. Pull cadence, and whether a peer may nudge with an unauthenticated "changes
   available" ping. Interval first. Owner: WAS-176.
5. A cross-Space controller log (log in Space T controlling Space S): a
   documented operator requirement that T be replicated too, or a check at
   registration time. Review 2026-10-01: widened. Every chain a replica verifies
   needs every log it references, which for a wallet account includes the
   client-annex DID's log in the `DelegatedClientsSpace` auxiliary Space;
   without that registration every annex and transient-session invocation on the
   replica fails. And the pull delegation itself cannot be ladder-signed (none
   of the clause's five shapes admits a server-DID grantee), so the wallet signs
   it with an enrolled client's key; freewallet's registration flow records
   both. Owner: WAS-177 and the freewallet item.
6. Resolved at review: no read path resolves `createdBy`. The export rule is
   invariant 14.
7. Import under an immutable Collection (matrix cell Import / C): whether import
   respects the digest rule or bypasses it as it does the envelope rule. Owner:
   WAS-173. Decided 2026-10-03: bypasses, pending maintainer confirmation.
   Import is skip-not-overwrite, so it never changes a stored Resource: an
   archived body that differs from the stored one is skipped, not refused, and
   counted in `resourcesSkipped` (pinned in `test/revisions-api.test.ts`).
   Checked at implementation: import does not bypass the envelope rule here.
   `assertImportBodiesFit` runs the fail-closed envelope check on every staged
   body, so the premise "as it does the envelope rule" does not hold for this
   server.
8. (review 2026-10-01) wallet-core's account on more than one host: the
   chain-head pin keyed by Space id, the single `host` in the account pointer,
   and the DID-derived host in the annex log (section 3). A lagging replica
   reads as a rollback to a wallet that saw the source's head; a DR append while
   the source lives forks the account permanently; after the source is lost the
   keyring pointer still names it. Owner: a wallet-core item the maintainer
   files; alternative 15 is the other shape. Section 5.12 inventories the grants
   that item must re-mint per replica.
9. (review 2026-10-01) Delete Space's own ordering tear (revocations removed
   before the Space directory, `filesystem.ts:1365-1372`; a crash between leaves
   a live Space whose revoked grants verify again) is an existing bug, filed as
   its own item (WAS-180).
10. (review 2026-10-01) WAS-176 and WAS-177 block each other on the roadmap. The
    loop runs without the resolver, so the WAS-176 edge is the one to drop; left
    for the maintainer, since the roadmap is outside this pass.

## 9. Review log (2026-10-01)

Six lenses (consumer completeness, interaction matrix, adversary walk, invariant
audit, torn-state discipline, contract blast radius) plus a completeness critic.
79 raw findings, deduplicated to the entries folded above. By class, with where
each landed:

- Convergence-breaking under-specification: derived-member validator moves
  (invariant 18, open point 1); shared `updatedAt` between content and `/meta`
  (invariant 3, open point 2); no discovery channel for non-JSON Resources,
  Collection Metadata, policies, logs (section 5.10); policies without stamps
  (invariant 21); HLC not persisted and not ordered above the held stamp, and
  two processes per origin (section 5.3); the generation-change-as-delete rule
  and delete-wins (section 5.4); checkpoint not tied to the generation
  (invariant 11).
- Authority leaks through "verbatim" apply: `controller` (invariant 20),
  immutable descriptors regressing (invariant 15), server-derived members stored
  (invariant 19), `createdBy` laundered into signed provenance (invariant 14),
  unverified revocations (open point 10).
- Registration and resolver binding: the confused-deputy registration, the
  `server` Space, same-id, read-only capability, controller-only `GET` (section
  5.5); host-keyed resolver squat (section 5.8); the peer fetch placed before
  chain verification, with no host, redirect, address, rate or cache bounds
  (section 5.7).
- Torn states: the Collection tombstone cascade, the origin-id mint, the
  filesystem commit point, the registration's lifetime against Delete Space,
  loop restart at boot, the stall record and the checkpoint's durability
  (sections 5.2 to 5.5, 5.11).
- Blast radius the `touches` lists missed: was-client `parseEtag` and acks;
  wallet-core push and remint; dcw's schema; was-sync's persisted RxDB schema
  and `statesEqual`; was-react; `@interop/space-archive` codec and fixtures;
  `@interop/wallet-backup`; wallet-core's single-host account invariants; the
  encrypted-collections profile; the conformance suite's exact-shape asserts;
  storage-core's `ServiceDescription.instance`; the spec's `instance` gating
  rule, reserved registry, "replicas" ednote, Collection delete sentence, and
  the self-hosted rule's true location (section 3; for the maintainer to apply
  to the roadmap `touches` fields).
- Limitations recorded rather than fixed: uniqueness and `immutable` per origin
  (invariant 23); duplicate origin ids from a cloned data dir (section 5.2); a
  `did.jsonl` fork is permanent (invariant 16); every delegated grant is per
  replica (section 5.12).
- Completeness critic, after the fold: a non-terminating generation swap under
  two-way registration (section 5.4, creating stamp); the listing's cursor unit
  against the per-Collection stall (section 5.10); the per-replica grant
  inventory and the scope of alternative 11 (section 5.12); topology disclosure
  through `replicas` (open point 13); test seams for clock skew and the peer
  fetch, and Postgres twins (section 7); upgrade of existing records,
  reserved-id shadowing and a replication feature token (open points 14, 15).
  Dismissed: forward-merge oscillation (monotone), `lastError` privacy
  (controller-only), a replica reading the Space (inherent to the grant).

Dropped at verification (already handled by the doc or not grounded): the stamp
ping-pong between two replicas (an echoed stamp compares equal and is skipped);
compounding of the clock bound across hops (each hop checks its own physical
time); transitive stamp laundering (same reason); a peer rotating the account's
keys through its log copy (verify-on-append and the SCID make that a freeze, not
a rotate, covered by the fork rule); the ETag/304 path with equal stamps and
different generations (only reachable through the HLC regression now closed).
