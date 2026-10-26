# WAS-14: Chunk replication (design)

- item: WAS-14
- status: approved
- approved: 2026-10-25
- wire-level decisions contained: listed under "Wire-level and layout decisions"
  in section 5: the two stall-reason members (open point 6,
  `chunk-listing-obsolete` and `source-unavailable`) and the staging layout
  names (open point 2) and the stored registration member `pullsChunks` (open
  point 5) are signed off; nothing is pending. An earlier listing member was
  dropped (section 5.1), and the chunk `ETag` layout is not a cross-server
  requirement (open point 3, decided opaque)
- decision records extracted:
  `decisions/0006-chunk-sets-replicate-with-their-parent.md` (section 6 items 1,
  2 and 6 with the staged apply of section 5.4, minted 2026-10-25), and the spec
  repo's decision 0013 amended in place the same day with the contract half
  (open point 4); WASS-50's acceptance box revised with it
- reviewed: 2026-10-24, adversarial pass (six lenses plus a completeness
  critic); findings folded in place with a `Review 2026-10-24:` prefix, the
  review log is section 9; the open points in section 8 are all decided as of
  2026-10-25, and approval is the next step

## 1. Problem and scope

A chunked Resource replicates today without its chunks. The pull loop applies
the parent Resource's content, `/meta` record and policy from the `changes`
feed, and a chunked envelope lands on the replica server with an empty chunk
set. A reader on the replica server decrypts the envelope, learns
`stream.chunks`, and fails on the first `GET .../chunks/0`. The item makes the
replica server serve the chunk set the source server served, byte for byte.

The design inherits three questions from the multi-primary design (its section
8, open question 1) and answers them:

1. Discovery. A chunk write takes no feed position, so the feed does not say
   when a chunk changed. The design reads the parent's chunk listing when the
   parent's own feed document is applied, and reads each listed chunk with a
   conditional `GET`, so a chunk the replica server already holds costs no
   transfer when a chunk pull is run again.
2. Chunk tombstones. A chunk is hard-deleted and stays hard-deleted. An
   individual chunk delete does not replicate on its own. The chunk set
   converges on the next parent write, because the chunk pull removes a chunk
   the source server no longer lists.
3. Whole-stream consistency. The chunk set is applied as a consequence of the
   parent revision that won last-writer-wins (LWW), as the source server listed
   it at that moment. Two servers rewriting one stream converge on the winning
   parent's set, not on a per-chunk mix.

The design rests on the Encrypted Collections profile's own write protocol
(`ec/spec.md`, "Chunk lifecycle" and "Chunked envelopes"): a client writes the
envelope with `stream.pending`, writes the chunks, and finishes with a parent
write that carries `stream.chunks`. That final write is the one the feed
surfaces, and the spec says a client that mutates a Resource purely through its
chunks does not appear on the feed. The design keeps that contract. A chunk-only
mutation stays on the server it was made on until the parent is written again.

Review 2026-10-24: that last sentence has one exception. A chunk-only mutation
made on the source server while a chunk pull is in progress can be partly
carried, since the chunk pull reads some indexes before it and some after, and
the closing parent check of section 5.2 cannot see it (chunk writes do not move
the parent). The replica server then holds a set the source server never held at
one moment, until the next parent write. The acceptance is stated here rather
than hidden.

Review 2026-10-24: the review also found that the facts the earlier draft built
its window argument on were wrong. A chunk left over from the previous revision
at a listed index decrypts without error, because the chunk binding carries `v`,
`epoch` and `resource` only and each chunk is its own JWE under the same
recipient key (`ec/spec.md` "pws binding", the stream-integrity note,
minimal-cipher's index-only `caad`). A missing chunk raises `NotFoundError`, not
`EncryptionError`, and no consumer retries either (section 9, finding 3). So any
state in which a replica server serves an envelope over chunks of another
revision is silent wrong plaintext for a reader. That reopened the apply
ordering as open point 2, decided the same day for the staged apply (section
5.4).

Out of scope: a `chunk` kind in the `changes` feed (section 6); chunk tombstones
(section 6); chunk retention (WAS-13); write-time statements over a chunked
Resource (WAS-184, whose bullet was revised on 2026-10-24 to mint at the parent
write); the stored content digest (WAS-195); any change to the chunk routes'
authorization or to the client's write plan.

## 2. Invariant inventory

Each entry: the invariant, upheld or changed, how, and the doc edit.

1. Stamps are minted only by this server for its own writes; a replicated record
   carries the source server's stamp and generation verbatim (`decisions/0004`,
   ARCHITECTURE.md "replication facet"). Changed for chunks, in two ways. First,
   section 5.3 drops per-chunk LWW, so a replicated chunk may be overwritten by
   one carrying an older stamp, and its generation may change without a hard
   delete. The stamp-ordering sentence appears at
   `docs/validators-and-stamps.md` ("the new stamp therefore sorts above the one
   it replaces", generation "kept for the record's life"), `docs/replication.md`
   (the apply rule and its three exceptions), `src/lib/replicaApply.ts` (the
   header's list of exceptions), ARCHITECTURE.md's Glossary ("Write stamp"), and
   `decisions/0004` ("the greater stamp wins on every replica server"; the
   refusal of a received stamp whose `originId` is the local one). Each gains a
   chunk clause. Second, decided 2026-10-24 (open point 3): a replicated chunk
   does not carry the source server's stamp or generation at all. The replica
   server mints both from its own clock at the swap, as for a chunk a local
   client writes, and keeps the source server's chunk `ETag` only as an opaque
   string in the staging record. Chunks are therefore local records that follow
   their parent, not replicated-identity records, and `decisions/0004` is
   untouched for them: its stamp rule and its `originId` refusal never see a
   chunk. The layout `"<generation>.<ms>.<counter>.<originId>"` stays this
   server's own and is not a requirement on source servers. Doc edit: the five
   sites above gain the chunk clause that a chunk's stamp is local and orders
   nothing across servers.
2. The replication facet writes replicated records through the backend's
   `apply*` methods only, and no source server record goes through `writeChunk`
   (AGENTS.md "Architecture"). Upheld. `stageChunk`, `applyResourceWithChunks`
   and `reclaimStaging` join the `apply*` family on `StorageBackend` (section
   5.3). `test/storage-backend-contract.ts` enumerates every `apply*` method on
   both backends and gains the new ones. Doc edit: ARCHITECTURE.md's replication
   facet entry names them.
3. A chunk write takes no feed position and does not move its parent
   (`docs/changes-feed.md`, core `spec.md` "Scope" of the `changes` profile,
   `ec/spec.md` "Chunk lifecycle"). Changed in one respect. Review 2026-10-24:
   `docs/replication.md` says "an applied record takes a local feed position, so
   it appears in this server's own `changes` feed and a third server can pull it
   from here". If the parent takes that position before its chunks are in place,
   a downstream server pulls the parent, reads a partial listing, and is never
   signalled again, since chunk applies take no position (section 9, finding 2).
   The parent's feed position on the replica server must be taken only when its
   chunk set is complete. Under the staged apply of open point 2 that is where
   the parent is written, in the swap of section 5.3. A staged chunk takes none.
   Doc edit: `docs/replication.md`'s sentence gains "once its chunk set is
   complete".
4. A chunk is hard-deleted and leaves no tombstone (`docs/filesystem-layout.md`,
   `docs/validators-and-stamps.md` "A hard delete (a chunk, a Space) removes the
   record"). Upheld. A removal on apply removes the sidecar and representation
   as `deleteChunk` does, and a replicated chunk's generation dies with it. Doc
   edit: `docs/replication.md` says an individual chunk delete converges on the
   next parent write.
5. A chunk cannot outlive its parent: Delete Resource cascades, and a chunk
   write under an absent or tombstoned parent is refused (`ec/spec.md` "Chunk
   lifecycle", `filesystem.ts` `softDelete`, both backends' `writeChunk`).
   Upheld, with one existing gap the design makes reachable. Review 2026-10-24:
   the filesystem tombstone apply writes the tombstone sidecar first and removes
   the chunk directory last; a crash between the two strands the directory, a
   replay is an equal-stamp skip, `#reclaimBesideTombstone` clears
   representation files only, and export walks every `.chunks.*` directory
   without checking the parent (section 9, finding 12). The tombstone apply and
   the reclaim gain the chunk directory. Doc edit: `docs/filesystem-layout.md`
   "Crash cases".
6. Each chunk carries its own strong validator, independent of the parent's and
   of its siblings' (`ec/spec.md` "Store chunk operation"). Upheld. The replica
   server serves its own validator for a replicated chunk (open point 3). Review
   2026-10-24: no client revalidates a chunk cached from one server against
   another, since chunk URLs are host-bound, so cross-server equality has no
   consumer.
7. The write-once rule of an `immutable` Collection is decided inside the
   write's critical section (`docs/governed-logs-and-revisions.md`). Changed, as
   the apply path already changes it. Review 2026-10-24: the apply path
   evaluates no write-once rule (`docs/replication.md`: "the write-once rule ...
   not evaluated, since the origin server admitted the write"; `applyResource`
   on both backends has no such branch), and the only chunk write-once check
   throws `ResourceImmutableError` (409), which `stallOfError` maps to no stall
   reason, so it would end the cycle for every Collection of the registration.
   Chunk applies and removals therefore run verbatim under `immutable`, as
   `applyResource` does. Delete and re-create are allowed under write-once, so
   "the parent cannot change" was false. Doc edit: none beyond this doc; the
   apply-path sentence already covers it.
8. Quota and the upload bound apply to a chunk as to a Resource (`ec/spec.md`
   "Store chunk operation", `docs/request-pipeline.md`). Upheld, with the
   pre-check of section 5.2 corrected. Review 2026-10-24: the filesystem checks
   gross headroom against a `du` snapshot cached for `QUOTA_USAGE_CACHE_TTL` (20
   s) with no credit for the file being replaced; Postgres books a net delta. A
   chunk `GET` carries no `Content-Length`, so the stream is bounded by the
   backend's upload guards, not by `declaredBytes`. A 507 or 413 from the
   backend becomes the existing `quota-exceeded` stall.
9. The clock bound: a received stamp beyond the bound stalls the Collection
   (`docs/replication.md` "Stalls and backoff", multi-primary design 5.6).
   Upheld. A chunk carries no source server stamp (open point 3), so
   `guardApply` observes the parent's stamp only, once per chunk pull, as it
   does for any Resource apply.
10. A replicated Collection's Resources go to the server backend its
    `backend.id` selects, after the registration check on the control plane
    (ARCHITECTURE.md replication facet). Upheld, with one bound tightened.
    Review 2026-10-24: on a backend other than the control plane the verdict is
    taken once per feed page and applies run with no `replicaId`, so a Delete
    Replica mid-pull never yields `unregistered` and the transfer runs to the
    end of the page (section 9, finding 8). The chunk pull re-checks the
    registration before each chunk fetch (`stageChunk` checks it under the
    lock). WAS-221 holds the general version of this gap.
11. Export carries a Resource's chunks and import restores them, re-stamped
    (`docs/export-import.md`). Upheld, with an exposure named. Review
    2026-10-24: a replica server's export signs a `StorageAttestation` over
    `chunkedDigest` of the set as held. If that set is torn (any state the open
    points leave reachable), the statement names a digest the source server
    never held, and an importing server judges it `verified`. Under the staged
    apply no torn set is ever held, and export skips staging directories. Doc
    edit: none.
12. The maximum-privacy rule: an under-authorized chunk request is a plain
    `not-found` (ARCHITECTURE.md "Denial reasons"). Upheld. The chunk pull reads
    through the existing listing, chunk and parent routes, and no response body
    changes. Review 2026-10-24: a `capability-expired` or revoked pull grant
    also answers 404 mid-pull, which is one reason a 404 is `retry` (section
    5.2), as the `/meta` 404 is today.
13. The pull capability is `GET`/`HEAD` only, and a registration admits any
    subset (`src/sync/registration.ts` `PULL_ACTIONS`, `docs/replication.md`
    "Registrations"). Upheld. Review 2026-10-24: the earlier draft's closing
    `HEAD` would fail under a `GET`-only grant, which is the test helper's
    default, and `PeerFetch` and `PeerClient.request` carry no method at all
    (section 9, finding 4). The chunk pull uses `GET` only: the listing, each
    chunk, and a conditional `GET` of the parent as the closing check.
14. The checkpoint advances only past a document whose apply finished
    (`docs/replication.md` "The pull loop"). Changed in intent, and the central
    finding of the review. Review 2026-10-24: under the earlier draft a chunk
    pull cut after the parent applied (a 507, `clock-bound`, a source server
    timeout, a restart) could not run again, because the re-read document met an
    equal-stamp parent and `decideResourceApply` answers one `skipped` for
    "equal" and "held wins"; the checkpoint then advanced past a torn set
    (section 9, finding 1). The design must make completion detectable from
    durable state. Decided for the staged apply (open point 2): the parent is
    not written until the set is in place, so an incomplete chunk pull leaves
    the held parent at the old revision and the next cycle pulls the chunks
    again. Parent first would have needed a durable pull-owed marker in the loop
    state, and a plain pull-on-equal was unsafe (a source server pulling its own
    revision back from a partial replica server would run removals against its
    own set).

15. (Critic 2026-10-24) Data from the source server is checked before it is
    acted on, as the registration checks the source server's Space and
    Collection objects. New entry: the chunk listing is untrusted input. Each
    `index` is validated by the `parseChunkIndexSegment` rule (an integer in
    `[0, MAX_CHUNK_INDEX]`, strictly ascending, unique) and each `size` must be
    a non-negative integer; a malformed listing stalls the Collection rather
    than throwing. Today `String(chunkIndex)` on the filesystem would store a
    file no route can address and import refuses, and a non-integer index on
    Postgres raises a driver error. Doc edit: `docs/replication.md`.
16. (Critic 2026-10-24) A key retired at the source server stops authorizing on
    the replica after the next pull (`docs/replication.md` "Where a replicated
    log lives"). Changed in bound. Collections are pulled in the source server's
    listing order and a chunk pull adds a chunk count times `maxUploadBytes` of
    transfer per Resource, so the controller-log Collection's pull can wait
    behind every chunk pull ahead of it, and a single failing chunk request ends
    the whole cycle before it. The loop pulls the controller-log Collection
    first in every cycle (`peerCollectionSelector` already identifies it; open
    point 7, decided 2026-10-25, no interleaving within a cycle), and a failing
    source server request inside a chunk pull stalls that Collection instead of
    ending the cycle (open point 6). Doc edit: `docs/replication.md` "The pull
    loop".
17. (Critic 2026-10-24) The loop stops within one apply of a stop signal
    (`stop()` waits for running cycles; the `onClose` hook relies on it).
    Changed in bound unless the chunk pull checks. `unregister` and
    `unregisterSpace` set `stopped` and clear the timer, but `#pull` is never
    handed the loop, so nothing between chunks observes it; a Delete Space
    mid-pull keeps fetching every remaining chunk into skipped applies, and a
    `SIGTERM` waits for the whole chunk pull. The chunk pull checks the stop
    signal between chunks and ends on the first `skipped` or `unregistered`
    apply. Doc edit: `docs/replication.md` "The pull loop" (the shutdown bound).
18. (Critic 2026-10-24) Replica state is persisted after each Collection's pull
    and at the end of a cycle (`writeReplicaState`). Changed in bound. A
    Collection whose first chunked pull takes longer than the gap between
    restarts never saves its checkpoint and starts over each time. The loop
    persists state after each pulled Resource. Doc edit: `docs/replication.md`
    "The pull loop".

## 3. Consumer enumeration

Produced by `grep -n -i chunk` over `src/`, `docs/`, `test/` and the two spec
checkouts, plus the two maps of the sync facet and the chunk surface taken on
2026-10-23. Review 2026-10-24: extended by the review's grep over
`getChunkMetadata`, `listChunks`, the Postgres `chunks` table, the
`applyResource` call sites, `readStream`, the usage accounting, `backendMirror`,
the replica state and status types, and the export and import paths. Entries
added by the review are marked.

Changed:

- `src/sync/replication.ts` `#applyResourceChange`: for a live document, runs
  the chunk pull of section 5.2 around the parent content apply, before
  `#applyResourceMeta` and before the checkpoint advances. (Review) The `/meta`
  apply still runs when the content apply is skipped, as today; a `/meta`-only
  write moves the feed document with an equal content stamp and pulls no chunks.
- `src/sync/peerClient.ts`: `readStream` gains an `ifNoneMatch` option and a 304
  outcome, as `read` has today, and (review) a 404 outcome, since it expects
  `[200]` today and would throw. No `HEAD`; `PeerFetch` carries no method.
- `src/types.ts` `StorageBackend`: `stageChunk`, `applyResourceWithChunks`,
  `reclaimStaging` (section 5.3). `ChunkListing` is unchanged.
- `src/backends/filesystem.ts` and `src/backends/postgres.ts`: the three new
  methods, the staging layout and its boot reclaim, the layout version bump and
  the Postgres migration (section 5.3), the replica server-minted chunk identity
  of open point 3, and (review) the tombstone apply's chunk-directory ordering
  and reclaim (invariant 5). Delete Resource, Delete Collection, Delete Space
  and Delete Replica sweep staging in their scope.
- (Review) `src/lib/etag.ts`: unchanged. The earlier draft needed a
  stamp-from-validator parser, which does not exist; open point 3 removed the
  need.
- `src/lib/replicaApply.ts`: `decideResourceApply` reused for the pre-decision
  of step 2 and inside the swap; the header's list of records that follow other
  rules gains chunks.
- `docs/replication.md`: (review) the apply rules are prose, not a table; the
  chunk paragraph joins them. The sentence "Revocations, backend registrations,
  keystores and chunks are not replicated" drops chunks and gains the
  chunk-only-mutation caveat. The sentence "an applied record takes a local feed
  position" gains the chunk-set condition (invariant 3).
- `docs/changes-feed.md`: the sentence that a chunk write takes no feed position
  stays, with a pointer to how replication discovers chunks.
- (Review) `docs/validators-and-stamps.md`, ARCHITECTURE.md Glossary "Write
  stamp", `decisions/0004`: the chunk clause of invariant 1.
- (Review) `docs/filesystem-layout.md`: the staging directory, its manifest, and
  "Crash cases" for a torn swap and the chunk directory on a torn tombstone
  apply.
- The Encrypted Collections profile, "Chunk lifecycle": a sentence that a
  replicating server carries the chunk set with the parent write it surfaces,
  and that a chunk-only mutation stays where it was made except as section 1
  states. (Review) The profile now lives at the spec repo's `ec/spec.md`
  (checkout `portable-web-spaces-spec`); the `encrypted-collections-spec`
  checkout is a copy. Written 2026-10-25 at approval, and the item is filed
  where that repo's AGENTS.md routes profile work.
- The replication specification (core spec companion, WASS-50): the chunk apply
  rule, as one paragraph. (Review) WASS-50's acceptance and the spec repo's
  decision 0013 ("Chunk bytes are not replicated in v1"; chunks under "Not
  replicated") say the opposite of this design; both are amended in place at
  approval (open point 4, decided).
- (Review) ROADMAP.md, the multi-primary umbrella item's context: "chunks
  (WAS-14) do not replicate" becomes "chunks replicate under WAS-14".
- `test/replication-api.test.ts`: section 7. (Review) It has no Postgres
  variant; `test/postgres-replica-apply.test.ts` holds the Postgres apply
  comparisons and gains the chunk ones; `test/storage-backend-contract.ts`
  enumerates `apply*` methods.

(Review) New consumer the draft did not list: the replica server's own served
feed, listing and chunk routes, read by a downstream server or by a second
registration on the same Space. Their meaning changes: the parent they serve
must not appear in the feed until its chunk set is complete (invariant 3).

Unchanged, now resting on a new assumption:

- `was-client` `EdvCodec` reading a stream on a replica server assumes the chunk
  set is complete once the envelope carries `stream.chunks`. (Review) Under the
  staged apply it is, from the moment the envelope is visible. The remaining
  window is the one the chunk model has everywhere: a reader whose stream read
  spans a swap, as on the source server it spans a client's rewrite, gets
  `NotFoundError` on a missing index and silent wrong plaintext on a replaced
  one, and nothing in was-client, was-sync, freewallet or dcw retries either.
- `src/lib/exportProvenance.ts` `chunkedDigest`: unchanged, now digesting
  replicated chunks on a replica server export; export's chunk walk appends
  `.chunks.`-prefixed directories only, so staging is skipped.
- `src/lib/importTar.ts` and both backends' chunk import: unchanged; import
  re-stamps as today.
- Postgres `#applyResourceRecord`: unchanged; it already removes the chunk rows
  on a tombstone. The filesystem tombstone apply is listed under Changed.
- `test/chunks.test.ts`: unchanged; the feed invisibility case stays.
- (Review) `src/lib/backendMirror.ts`: `mirroringControlPlane` is a Proxy that
  forwards any method, so the new `apply*` methods reach the data backend with
  no change. `restampFeedFromControlPlane` touches `collection-metadata` and
  `log` documents only.

## 4. Interaction matrix

Rows are the existing flows. Columns: the chunk pull, the chunk set's binding to
the parent revision (the single swap of section 5.3), and the convergence of
chunk removals. Each cell is fine, changed (how), or refused (where). Review
2026-10-24: rows corrected or added by the review are marked; cells written
before the staged apply was decided were updated to it.

| Flow                                                                                         | Chunk pull                                                                                                                                                                                                                                                                                                                                                  | Binding to the parent revision                                                                                                                          | Removal convergence                                                                                            |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Pending stub write (envelope with `stream.pending`)                                          | changed: reads an empty or partial listing; chunks present at that moment are applied                                                                                                                                                                                                                                                                       | fine                                                                                                                                                    | fine: nothing to remove on a first life                                                                        |
| Finalizing parent write (`stream.chunks`)                                                    | changed: the chunk pull fetches every listed chunk; all answer 200, since an edit re-encrypts the whole stream                                                                                                                                                                                                                                              | fine: all chunks were listed under this revision                                                                                                        | fine                                                                                                           |
| Parent overwrite with unchanged chunks (rare, plaintext chunks)                              | changed: one listing read, one conditional `GET` per chunk, all 304, one conditional `GET` of the parent                                                                                                                                                                                                                                                    | fine                                                                                                                                                    | fine                                                                                                           |
| (review) `/meta`-only write on the source server                                             | fine: the feed document moves with an equal content stamp; the `/meta` apply runs and no chunk pull does                                                                                                                                                                                                                                                    | fine                                                                                                                                                    | fine                                                                                                           |
| (review) Parent delete (tombstone) on the source server, including one racing a chunk pull   | fine: tombstone apply removes the chunk directory as today; no chunk pull. A delete racing a chunk pull answers the listing or a chunk with 404; the chunk pull returns `retry`, and the feed, which holds one document per record, serves the tombstone on the next read                                                                                   | fine                                                                                                                                                    | fine                                                                                                           |
| Chunk-only write on the source server, no parent write                                       | fine: not discovered, by the profile's contract; converges on the next parent write                                                                                                                                                                                                                                                                         | fine                                                                                                                                                    | fine                                                                                                           |
| (review) Chunk-only write on the source server during a chunk pull                           | changed: partly carried (section 1); the closing parent check cannot see it; converges on the next parent write                                                                                                                                                                                                                                             | fine                                                                                                                                                    | fine                                                                                                           |
| (review) Chunk delete on the source server, no parent write, including one mid-pull          | changed: a mid-pull 404 at that index is `retry`; the re-run's listing lacks the index and the removal runs                                                                                                                                                                                                                                                 | fine                                                                                                                                                    | changed: removed on the replica server at the next parent apply, or at the re-run                              |
| Two servers rewrite one stream concurrently                                                  | changed: each replica server applies the winning parent and that origin's listed set                                                                                                                                                                                                                                                                        | fine: a losing revision's set never lands; the swap decides under the lock                                                                              | changed: the loser's extra indexes are removed                                                                 |
| Replica-server-local chunk write, then a source server parent write wins                     | changed: the local chunk is overwritten or removed to match the source server's listing                                                                                                                                                                                                                                                                     | (review) accepted window: a local client's later chunk `PUT`s carry no parent precondition and can land after the swap; pre-existing single-server race | changed: the local chunk-only mutation loses                                                                   |
| Replica-server-local parent write wins over the source server's                              | fine: parent decision is `skipped`, no set lands, local chunks stay                                                                                                                                                                                                                                                                                         | fine                                                                                                                                                    | fine                                                                                                           |
| Parent rewritten on the source server between the listing read and the closing check         | changed: the closing conditional `GET` of the parent answers 200 with another `ETag`; the chunk pull returns `retry` and the checkpoint holds                                                                                                                                                                                                               | fine                                                                                                                                                    | fine: nothing landed                                                                                           |
| (review) Chunk pull interrupted (stall, restart, source server error) and run again          | changed: the held parent is still the old revision, so the document applies again and the chunk pull re-runs, reusing staged chunks through the conditional `GET`                                                                                                                                                                                           | fine                                                                                                                                                    | fine                                                                                                           |
| (review) Downstream server pulls a replica server that is mid-pull                           | changed: the parent is not in the replica server's feed until the swap, so the downstream server never sees a partial set                                                                                                                                                                                                                                   | fine                                                                                                                                                    | fine                                                                                                           |
| (review) Two registrations on one Space serve the same revision                              | changed: the second arrival is an equal-stamp skip; safe only because the first arrival was complete (the row above)                                                                                                                                                                                                                                        | fine                                                                                                                                                    | fine                                                                                                           |
| (review) Two-way pair: the source server pulls its own revision back from its replica server | fine: equal stamp, no set lands, no removals                                                                                                                                                                                                                                                                                                                | fine                                                                                                                                                    | fine                                                                                                           |
| (review) `immutable` Collection                                                              | changed: chunks apply verbatim, as `applyResource` applies there; no 409 is raised on the apply path                                                                                                                                                                                                                                                        | fine                                                                                                                                                    | changed: removals run; a delete-and-re-create life on the source server lands as one live document and its set |
| Collection on a server backend other than the control plane                                  | fine: chunk applies go to the parent's `dataBackend`                                                                                                                                                                                                                                                                                                        | fine                                                                                                                                                    | fine                                                                                                           |
| Clock bound exceeded by the parent stamp                                                     | refused: `clock-bound` stall at the swap, the Collection holds at this document; nothing live changed. A chunk carries no source server stamp (open point 3)                                                                                                                                                                                                | fine                                                                                                                                                    | fine                                                                                                           |
| (review) Chunk set larger than the remaining quota, or a chunk over the cap                  | refused: `quota-exceeded` stall from the pre-check of section 5.2, before anything is staged; a 507 or 413 during staging stalls likewise, with nothing live changed                                                                                                                                                                                        | fine                                                                                                                                                    | fine                                                                                                           |
| (review) Registration removed mid-pull                                                       | refused: `unregistered` ends the loop on the control plane; on another backend the per-chunk registration re-check of invariant 10 ends the chunk pull within one chunk                                                                                                                                                                                     | fine                                                                                                                                                    | fine                                                                                                           |
| (review) Pull grant expired or revoked mid-pull                                              | changed: the masked 404 is `retry`, and the cycle ends as it does today on a denied read                                                                                                                                                                                                                                                                    | fine                                                                                                                                                    | fine                                                                                                           |
| Export from the replica server                                                               | fine: export skips staging and never meets a torn set                                                                                                                                                                                                                                                                                                       | fine                                                                                                                                                    | fine                                                                                                           |
| (review) `did.jsonl` Collection                                                              | fine: a log Resource has no chunks; one listing read answered with `count` 0 and no parent check (section 5.1 gates the rest on a non-empty listing)                                                                                                                                                                                                        | fine                                                                                                                                                    | fine                                                                                                           |
| (decided) Source server does not list the Encrypted Collections entry                        | fine: recorded at registration; no chunk pull runs, parents apply as plain Resources, held chunks under them are left alone                                                                                                                                                                                                                                 | fine                                                                                                                                                    | fine                                                                                                           |
| Collection tombstone on the source server                                                    | fine: the Collection apply removes everything beneath it                                                                                                                                                                                                                                                                                                    | fine                                                                                                                                                    | fine                                                                                                           |
| (critic) Resource rewritten on the source server faster than its chunk pull                  | changed: every chunk pull fails the closing check and returns `retry`; the Collection stays `syncing`, never `synced`, and `lastSuccessAt` stays fresh; the replica server serves the last complete revision; after `REPLICA_CHUNK_PULL_RETRY_LIMIT` consecutive cycles stuck on the document it stalls as `chunk-listing-obsolete` (open point 6, decided) | fine                                                                                                                                                    | fine                                                                                                           |
| (critic) Delete Space or Delete Collection on the replica server mid-pull                    | changed: the next `stageChunk` finds no live parent or no registration and the chunk pull ends there (invariant 17); the delete sweeps the staging                                                                                                                                                                                                          | fine                                                                                                                                                    | fine                                                                                                           |
| (critic) Server shutdown mid-pull                                                            | changed: the chunk pull observes the stop signal between chunks and ends within one chunk (invariant 17); the re-run resumes from durable state                                                                                                                                                                                                             | fine                                                                                                                                                    | fine                                                                                                           |
| (critic) One chunk request keeps failing (5xx, 429, a grant narrowed past chunk paths)       | changed: stalls that Collection as `source-unavailable` after the bounded retry (open point 6, decided) instead of ending the cycle, so the controller-log Collection, pulled first, still updates                                                                                                                                                          | fine                                                                                                                                                    | fine                                                                                                           |
| (critic) Malformed source server listing (bad index, bad size, 2^31 entries)                 | refused: validated per invariant 15; the Collection stalls                                                                                                                                                                                                                                                                                                  | fine                                                                                                                                                    | fine                                                                                                           |
| (critic) `WAS_DEFAULT_BACKEND` switched between a chunk pull and its re-run                  | changed: a Collection under the `default` alias resolves to the other backend; a partial or staged set on the old backend is stranded until that backend's reclaim. WAS-219 owns the alias move                                                                                                                                                             | fine                                                                                                                                                    | fine                                                                                                           |

## 5. Design

### 5.1 Discovery: the chunk listing with conditional reads

When the pull loop meets a live `kind: resource` document, and the registration
records that the source server lists the Encrypted Collections entry
(`pullsChunks`, open point 5), it reads the parent's chunk listing on the source
server, `GET .../<resourceId>/chunks/`, with the pull capability. The listing
says which indexes exist and their sizes; it carries no validator, and the
design adds none. The loop then reads each listed chunk with a conditional
`GET`, sending `If-None-Match` with the validator it holds for that index. A 304
means the replica already holds that chunk, and no bytes move. A 200 carries the
bytes and the chunk's `ETag`.

Review 2026-10-24, decided the same day (open point 3): the served `ETag` is an
opaque string to the replica server. The earlier draft said the loop parses the
generation and stamp from it "as it does for Collection Metadata, policies and
logs"; that was false, those take the stamp from the served body or the feed
document, and no stamp parser exists. The four-segment layout is this server's
own, and the profile allows a chunk `ETag` such as `"1"` or a content hash, so
parsing it would have made the layout a cross-server requirement. The replica
server uses the source server's string for two things only: the `If-None-Match`
of the conditional `GET`, and the staging record's key so a re-run can answer
304 for an index already staged. At the swap it mints each chunk's stamp and
generation from its own clock. A live replicated chunk therefore carries the
replica server's validator, and a later chunk pull's conditional `GET` for an
unchanged index answers 200, which costs a re-transfer only in the rare
plaintext case of a parent rewritten with its chunks untouched.

Revised 2026-10-24: the earlier draft put an `etag` member on each listing entry
so an unchanged chunk could be skipped without a request. The maintainer pointed
out that an edit of an encrypted Resource re-encrypts the whole stream, so every
chunk changes on every parent write and the steady-state saving is close to
nothing. What a comparator still buys is a re-run that does not re-transfer what
the replica server already holds, and the conditional `GET` provides that with
no change to any wire shape.

Review 2026-10-24, two bounds. The listing is read through `readJson` under
`REPLICATION_DOCUMENT_MAX_BYTES` (4 MiB), and the listing is not paginated; a
Resource with roughly sixty thousand chunks would fail the read and end the
cycle. The chunk pull raises `maxBytes` for the listing as the feed read does on
`bodyTooLarge`, and stalls the Collection with `quota-exceeded` if the listing
still does not fit. And a Resource without chunks costs one listing read
answered with `count` 0 and nothing else: the parent check and the rest of the
chunk pull run only for a non-empty listing or a held set to remove, so a
plaintext or log Collection pays one extra request per document, not three.

Critic 2026-10-24: the listing is validated before any of it is used (invariant
15): indexes by the `parseChunkIndexSegment` rule, strictly ascending and
unique, sizes as non-negative integers, and the count bounded by what the quota
pre-check admits. A listing that fails stalls the Collection.

Cost per changed chunked Resource: one listing read, one `GET` per listed chunk
(200 for a changed chunk, 304 for a held one), and one conditional `GET` of the
parent. A Resource whose feed document is a tombstone costs nothing.

### 5.2 The chunk pull, in order

Decided 2026-10-24 by the maintainer, after the review: the staged apply. The
chunk pull fetches first and writes last, so nothing live changes until the
whole set and the parent are on the replica server, and they land in one
critical section.

For one live `resource` document, inside `#applyResourceChange`:

1. Read the source server's listing and validate it (invariant 15). A 404 is
   `retry`: the parent is no longer live on the source server, and the feed,
   which holds one document per record at the position of its latest write,
   serves the tombstone document on the next read from the held checkpoint.
   (Review: the earlier draft's `skipped`-on-404 rested on a livelock that
   cannot happen, and would have advanced past a chunk-only delete, an expired
   grant, or a delete racing the chunk pull.)
2. Read the held parent's content stamp and generation (`getResourceMetadata`)
   and decide LWW against the document's with `decideResourceApply`, before any
   check that can stall. If the held revision wins or is equal, skip to step 7.
   An equal stamp means the replica server already holds this revision with its
   set, since the two land together in step 6, so no pull-owed marker is needed.
   (Review: a quota stall taken before this decision would hold the checkpoint
   on a document that would have been skipped.)
3. Quota pre-check, net per index: each listed `size` less the held live size at
   that index, summed, plus one chunk of headroom on the filesystem, since its
   in-write check is gross against a `du` snapshot cached for 20 s. Each listed
   `size` is also checked against the data backend's `maxUploadBytes`. If the
   set cannot fit, or a chunk exceeds the cap, stall the Collection with
   `quota-exceeded` with nothing staged. The check is advisory; the in-write 507
   or 413 during staging remains authoritative, and stalls with nothing live
   changed.
4. For each listed index, after checking the loop's stop signal and re-checking
   the registration on the control plane (invariants 17 and 10), `GET` the chunk
   through `readStream` with `If-None-Match` set to the held live chunk's
   validator, when one is held, or to the matching staged chunk's source server
   `ETag` when staging from an earlier run of this chunk pull holds the index. A
   304 marks the index as kept (live) or already staged. A 200 is written to
   staging through `stageChunk` (section 5.3), which counts the bytes toward
   usage. A 404 is `retry`.
5. Read the parent last. Inline `data` is taken from the feed document; a binary
   parent is read through `readStream` as today. Its served `ETag` must equal
   the feed document's `etag`, else `retry`: the parent was rewritten during the
   chunk pull and the staged chunks may belong to the newer revision. This read
   is the closing check, and it is a `GET`, so a `GET`-only pull capability
   suffices. (Review: this replaces the `HEAD`, which the transport cannot send
   and such a grant would refuse.)
6. One backend call, `applyResourceWithChunks` (section 5.3), under the parent's
   lock: the registration check, `clock.observe`, the LWW decision again under
   the lock, and if the incoming revision wins: the live indexes neither kept
   nor staged are removed, the staged chunks are moved into place, the parent is
   written, its feed position is taken, and the staging for this chunk pull is
   released. If the held revision wins or is equal (a local write landed between
   steps 2 and 6), the staging is discarded and the result is `skipped`. No pin,
   no separate chunk apply.
7. `#applyResourceMeta` runs, as it does today after a skipped content apply
   too, and the checkpoint advances. The loop persists its state here, after
   each pulled Resource (invariant 18).

A `/meta`-only write on the source server moves the feed document with an equal
content stamp: step 2 skips to step 7 and no listing is read.

`retry` keeps the checkpoint on this document and marks the Collection
`syncing`, as a content `ETag` mismatch does today. The next cycle re-reads the
feed from the held checkpoint and pulls the chunks again; staging left by the
earlier run is keyed by the feed `etag` and reused through the conditional `GET`
of step 4, so the re-run moves only what is missing. A `refused` or thrown error
from `stageChunk` or `applyResourceWithChunks` goes through `#applyStep` and
becomes the stall its reason names, with the existing mapping (507 and 413 to
`quota-exceeded`, a 404 to `container-refused`) and the two new reasons of open
point 6; nothing on the apply path raises a 409.

The retry is bounded (open point 6, decided 2026-10-25). The loop state keeps,
per Collection, a count of consecutive cycles that ended in `retry` on the same
feed document, reset by any other outcome or by a move of the checkpoint. When
the count reaches `REPLICA_CHUNK_PULL_RETRY_LIMIT` (a constant in
`config.default.ts`, not persisted beyond the loop state, so a restart starts
the count over), the Collection stalls as `chunk-listing-obsolete`: the chunk
listing the pull read is obsolete by the closing check, cycle after cycle,
because the source server rewrites the Resource faster than the pull completes.
The checkpoint holds on the document and the replica server serves the last
complete revision. A stalled Collection is retried each cycle like every other
stall, so the stall clears itself on the first chunk pull that passes its
closing check.

A request to the source server that fails inside a chunk pull (a 5xx, a 429, a
masked 404 from a grant narrowed past the chunk paths) stalls the Collection
rather than ending the cycle, after the same bounded retry under the same count,
as `source-unavailable`. The stall `detail` names the URL and the status of the
last failure. The rest of the cycle goes on, and the controller-log Collection
is pulled first in every cycle (invariant 16, open point 7). A failed request
outside a chunk pull (the feed page, the Space listing) ends the cycle as it
does today.

The loop does not fetch chunks in parallel in v1. One stream at a time keeps the
memory bound at one `maxUploadBytes` per Collection, the same as the parent
read.

### 5.3 The apply methods and no per-chunk LWW

Three methods join `StorageBackend`; the earlier draft's `applyChunk` and
`applyChunkRemoval`, and the parent pin they carried, are gone.

- `stageChunk({ spaceId, replicaId, collectionId, resourceId, parentEtag, chunkIndex, contentType, peerEtag, input })`.
  Writes the bytes to the registration's staging for this parent revision, keyed
  by `replicaId`, the parent's feed `etag` and the index, with a small staging
  record carrying `contentType` and the source server's `ETag` as an opaque
  string (the key of the conditional `GET` on a re-run). It runs under the
  parent's lock only long enough to check that the parent is live and the
  registration stands, so a Delete Space or Delete Replica mid-pull ends the
  chunk pull at the next chunk; the transfer itself is not under the lock. It
  counts the bytes toward usage, and a 507 or 413 here changes nothing live. The
  chunk's stamp and generation are minted at the swap, not here.
- `applyResourceWithChunks({ spaceId, replicaId, collectionId, resourceId, generation, stamp, createdAt?, createdBy?, writerId?, resource, chunks: { parentEtag, kept: number[], staged: number[] } })`.
  Under the parent's lock, in one critical section: the registration check,
  `clock.observe` on the parent's stamp, the LWW decision as `applyResource`
  makes it. On a win: every live index not in `kept` or `staged` is removed as
  `deleteChunk` removes it; each staged index is moved into place; the parent is
  written as `applyResource` writes it, and its feed position is taken; the
  staging for `parentEtag` is released. On a loss or an equal stamp the staging
  is released and the result is `skipped`. Each moved chunk gets a stamp from
  the replica server's clock and a fresh generation, as a local chunk write
  would (open point 3). Filesystem order: the staged directory is swapped in
  under the lock (two renames, since a non-empty directory cannot be replaced by
  one), then the parent's sidecar, which is the commit point. The staging
  manifest (below) names the parent revision and the swap, so a crash between
  the swap and the sidecar is detected at boot and finished. Postgres: one
  transaction; the parent row `FOR UPDATE`, the chunk rows moved by key rather
  than copied, and the feed position update last, so the Collection row lock is
  held for the key moves and not for any byte copy.
- `reclaimStaging({ spaceId, collectionId?, resourceId?, replicaId? })`. Removes
  staging the loop no longer owns: at boot for every registration, on Delete
  Replica for that registration, and inside Delete Resource, Delete Collection
  and Delete Space for their scope. A manifest whose parent revision the live
  parent already carries, with the swap done and the sidecar missing, is
  finished rather than removed.

The staging layout, both backends, signed off 2026-10-25 (open point 2's
sign-off items). On the filesystem, a `.staging.chunks.<encodedResourceId>/`
directory beside `.chunks.<encodedResourceId>/` in the Collection directory,
with the same id encoding, so Delete Resource and `reclaimStaging` find it by
the same derivation; export, the Collection listing and the changes feed skip
the prefix as they skip `.chunks.`, and it cannot be mistaken for a Collection.
Under it one run directory per key, `<replicaId>/<encodedParentEtag>/`, two
levels so Delete Replica reclaims one directory and the `ETag`'s characters
never meet the replica id. A run directory mirrors the live chunk directory, the
index's representation file plus a `.meta.<index>.json` sidecar carrying
`contentType`, `size` and `peerEtag` (the source server's opaque `ETag`), so the
swap moves the kept files in and renames directories with no per-file rewrite.
One `.manifest.json` per run directory carries `parentEtag`, `kept`, `staged`
and a `swapped` flag set under the lock before the parent sidecar is written;
boot reclaim reads it to finish or discard a torn swap. The layout version bumps
by one with a no-op migration, so a downgrade is refused. On Postgres, a
`chunk_staging` table with the `chunks` columns less `generation` and `version`
(minted at the swap), plus `replica_id`, `parent_etag` and `peer_etag`; primary
key (space, collection, resource, replica, parent `ETag`, index); foreign keys
cascading from `resources` and from `replicas` on (space, replica), so Delete
Resource and Delete Replica reclaim with no code. No manifest row: the swap is
one transaction, so there is no torn state to detect at boot, and the loop
re-derives `kept` and `staged` from the source server's listing on every run.
One forward migration step adds the table. Usage on both backends includes
staging.

Quota under staging: the pre-check of step 3 is net, and the in-write check
during staging is told the bytes the swap will free (the held live sizes of the
indexes being replaced), so a replica server with its source server's quota can
replace its largest stream in place. The alternative, staged bytes counted gross
and a replica provisioned larger than its source server by its largest stream,
was rejected as a deployment trap.

No per-chunk LWW. The earlier draft kept a held chunk whose stamp was newer than
the incoming one. That rule leaves a torn set: a client of the replica server,
mid-protocol, has written chunks for its coming envelope L but not the finalize;
the source server's revision A applies over the client's stub; the chunk pull
meets the client's fresher chunk at some index and keeps it; the client's
finalize then fails its `If-Match` on the stub and the write is over. The
replica server would serve A's envelope over the client's chunk until the next
parent write, with nothing to detect it. Under the staged apply the question
does not arise: the swap replaces the set as a whole with what the source server
listed under the winning revision, whatever the held chunks' stamps. The chunk
set resolves with its parent revision, not per chunk, which retires the sentence
the item inherited from the multi-primary design that chunks "resolve per chunk
under LWW". One race remains and is accepted as pre-existing: the same client's
remaining chunk `PUT`s carry no parent precondition and can land after the swap;
its finalize then fails and the replica server serves A's envelope over those
chunks. That race exists today between two clients of one server.

### 5.4 The apply ordering (decided 2026-10-24)

Canonical since approval in
`decisions/0006-chunk-sets-replicate-with-their-parent.md`; the contract half
(discovery through the listing, conditional reads, parent last, opaque chunk
`ETag`) is the spec repo's decision 0013 as amended 2026-10-25.

First decided 2026-10-24 by the maintainer as parent first, over the atomic set
apply. That decision rested on two premises the review found false (section 1):
that a reader in the window gets an `EncryptionError`, and that the wallet
retries it. A reader gets silent wrong plaintext, or `NotFoundError`, and
nothing retries. Three further findings compounded it: a cut chunk pull could
not run again without a durable marker (invariant 14), the replica server's feed
surfaced the parent before its set unless the feed position was deferred
(invariant 3), and a stall left a torn set in place for as long as the stall
lasted. Reopened as open point 2 and decided the same day for the staged apply
of sections 5.2 and 5.3.

What the staged apply buys. Findings 1, 2, 3, 5, 7 and 12 of section 9 stop
applying: a cut chunk pull re-runs because the held parent is still the old
revision; the parent reaches the replica server's feed only with its set; a
stall or a 404 mid-pull leaves nothing torn; removals and the `immutable` rows
need no special case; there is no pin and no separate chunk apply; export never
meets a torn set.

What it does not buy, per the critic. A reader's stream read is `count` separate
requests with no snapshot, so a reader that read the envelope and chunks `0..k`
before the swap reads the new revision's chunks after it. That window is the
reader's whole read, on the replica server as on the source server whenever a
client rewrites a stream under a reader. The staged apply removes the windows
replication adds; it does not remove the one the chunk model has. The hardened
framing the profile's stream-integrity note anticipates is what would.

Constraints the critic placed on the staging design, each absorbed in section
5.3: the staging directory cannot sit beside the Collections (every Space
subdirectory counts as a live Collection) and must not escape the quota; a
staged manifest naming the parent revision is needed to finish a run torn
between the swap and the parent sidecar; the Postgres swap moves rows by key so
the transaction and the Collection row lock stay short; usage includes staging;
staging is keyed by `replicaId` so two registrations on one Space do not
interleave, and Delete Replica sweeps it; a `WAS_DEFAULT_BACKEND` switch between
a chunk pull and its re-run strands staging on the old backend, which that
backend's boot reclaim removes (WAS-219 owns the alias move).

Parent first, for the record: it would have needed a durable pull-owed marker in
the loop state, the parent's feed position deferred to the chunk pull's end, and
the export statement skipped while a marker stood, and would still have left a
direct reader of the replica server a window of one chunk pull, and of the whole
stall under a stall. Section 6 items 6 and 8 record the rejection and the
reversal.

### 5.5 What does not change

The chunk routes, their authorization, the `changes` feed, export and import,
and the client's write plan. The server still never reassembles a stream and
never reads inside a chunk. The live chunk record layout on both backends does
not change; the staged apply adds a staging area beside it (section 5.3).

### Wire-level and layout decisions (all signed off 2026-10-25)

Review 2026-10-24: the earlier "none" was wrong on one count and the review
added another. The chunk `ETag` question (open point 3) was decided the same day
with no wire requirement: a source server's chunk `ETag` is opaque to the
replica server.

1. Open point 2 (decided for the staged apply; names signed off 2026-10-25): the
   filesystem `.staging.chunks.<encodedResourceId>/` directory with its
   `<replicaId>/<encodedParentEtag>/` run directories and `.manifest.json`, and
   the Postgres `chunk_staging` table with `peer_etag`, no manifest row (section
   5.3).
2. Open point 5 (decided; name signed off 2026-10-25): `pullsChunks`, a boolean
   on the stored registration (`StoredReplica`, beside `spaceGeneration`), not
   on the wire `ReplicaRegistration` the controller sends and reads back, so no
   wire change. Set at registration from the source server's `/service` listing
   the Encrypted Collections entry. Postgres: a `pulls_chunks boolean NOT NULL`
   column on `replicas`, in the migration step that adds `chunk_staging`,
   existing rows defaulting to `false`; filesystem: a `pullsChunks` member of
   the stored replica record, under the layout version bump staging already
   takes, absent read as `false`. A registration made before this lands pulls no
   chunks until it is made again. Not replicated and not exported, as the record
   is not.
3. Open point 6 (decided 2026-10-25, names signed off): two new members of the
   `ReplicaStallReason` union in `@interop/storage-core` (a closed union on the
   wire of the replica status API). `chunk-listing-obsolete` is a chunk pull
   that cannot converge: the chunk listing it read is obsolete by the time of
   the closing check, cycle after cycle. `source-unavailable` is a request to
   the source server that keeps failing inside a chunk pull. Both follow a
   bounded retry, counted in consecutive cycles stuck on one feed document
   (`REPLICA_CHUNK_PULL_RETRY_LIMIT` in `config.default.ts`).

No new response member, no new error name, no new feed `kind`. The one text
change outside this repo is the sentence in the profile's "Chunk lifecycle"
(section 3), which describes behavior and adds no wire shape, plus the
replication specification's paragraph and the in-place amendment of decision
0013 (open point 4).

## 6. Alternatives rejected

Items 1, 2 and 6, with the staged apply of section 5.4, are canonical in
`decisions/0006-chunk-sets-replicate-with-their-parent.md` since approval
(2026-10-25); the text here is kept for the review trail.

1. A `chunk` kind in the `changes` feed, with a chunk write taking a feed
   position. Do not reopen. It contradicts the core `changes` profile's Scope
   and the Encrypted Collections profile's "Chunk lifecycle", both of which say
   a chunk write is invisible to the feed. It also needs chunk tombstones so a
   chunk delete can replicate, which turns a hard-deleted record into a
   versioned one on both backends and in the archive, and it loses whole-stream
   consistency: two servers rewriting a stream converge on a per-chunk mix. The
   chunk pull reads one extra document per changed Resource instead. Revisit
   criteria: the profile drops the pending-then-finalize write protocol; or
   chunk-only mutations gain a use that needs replication; or a chunk framing
   binds each chunk to its parent revision inside the ciphertext (the hardened
   framing the profile's stream-integrity note says is planned upstream in EDV),
   so a per-chunk feed could carry revision identity and a mixed set would be
   detectable.
2. Stamped chunk tombstones. Do not reopen for the same reasons as 1: a chunk
   delete is cascade-only or converges on the next parent write. Revisit
   criteria: as 1. Decided 2026-10-24: items 1 and 2 stand or fall together and
   become one `decisions/` record at approval.
3. A stored parent-revision member on each chunk record (the "additive member on
   the chunk record" the multi-primary design floated). Rejected: it needs a
   layout and archive change, and a stored member would be stale after every
   parent overwrite that leaves the chunks alone. Under the staged apply no
   binding member or pin is needed at all.
4. A per-entry validator (`etag`) on the List Chunks response, so an unchanged
   chunk is skipped without a request. Rejected 2026-10-24: an edit of an
   encrypted Resource re-encrypts every chunk, so the skip would almost never
   fire in steady state, and the one case it serves, a re-run, is covered by a
   conditional `GET` per chunk at no wire cost. Also rejected: a `HEAD` per
   chunk before each `GET`, which doubles the requests for the chunks that did
   change, which is nearly all of them.
5. Chunks before the parent, written into the live set. Rejected: the parent's
   LWW outcome is decided inside its apply, so a losing revision's chunks would
   land. Review 2026-10-24: also rejected on the mirror of finding 3, since a
   reader between the chunk writes and the parent write decrypts the old
   envelope over new chunks without error.
6. Parent first, then the chunks into the live set. Chosen on 2026-10-24 and
   reversed the same day after the review (section 5.4). Do not reopen: a reader
   in its window gets silent wrong plaintext, a cut chunk pull needs a durable
   marker to resume, and a downstream puller copies a torn set unless the feed
   position is deferred. Revisit criteria: a chunk framing that binds each chunk
   to its parent revision, so a torn set is detectable by the reader. The staged
   apply was first rejected for v1 for its staging layout; that rejection's
   revisit criterion ("a consumer that cannot tolerate the window") was met by
   every chunked reader, and it is now the design.
7. Parallel chunk fetches. Rejected for v1 on memory bounds; the chunk pull is
   sequential like the rest of the pull loop.
8. (Review) A plain pull-on-equal-stamp as the resumption rule. Rejected: an
   source server pulling its own revision back from a partial replica server
   would run removals against its own set. The staged apply needs no resumption
   rule, since an equal stamp means the set landed with the parent.
9. (Review) Staged bytes counted gross, with deployment guidance that a
   replica's quota exceeds its source server's by its largest stream. Rejected:
   a replica configured like its source server could never replace a set larger
   than half its quota, a trap no operator would expect. The pre-check and the
   in-write check during staging credit the indexes the swap will free (section
   5.3).
10. (Review) `skipped` on a 404 mid-pull. Rejected: the livelock it was meant to
    avoid cannot happen, and it drops the rest of a chunk pull on a chunk-only
    delete, an expired grant, or a delete racing the chunk pull.
11. (Decided 2026-10-25) Re-pulling the controller-log Collection between the
    chunk pulls of a long Collection, so a key change lands within one chunk
    rather than one cycle. Rejected: it complicates the loop for a bound the
    operator sets with the cycle interval, and the remedy for a compromised key
    is revocation on the source server and a shorter cycle. The log Collection
    is pulled first in every cycle (open point 7) and nothing more.

## 7. Test plan

All in `test/replication-api.test.ts`, following the two-server shape with
`injectPeerFetch`. Review 2026-10-24: that file has no Postgres variant; the
Postgres apply comparisons live in `test/postgres-replica-apply.test.ts` and
gain the chunk cases, and `test/storage-backend-contract.ts` gains the new
`apply*` methods in its registration enumeration. Every two-server case runs
under the helper's default `GET`-only pull capability.

1. A chunked Resource replicates: the source holds a parent with three chunks
   written through raw `PUT`s under `application/octet-stream`, and after one
   pull the replica server serves the same bytes and content type for each
   chunk, and the same listing, with the parent and its set visible together (a
   reader under a `faults` hold on the swap sees either the old envelope and set
   or the new). Each replica chunk's `ETag` is the replica server's own and
   differs from the source server's (open point 3). Proves invariants 1, 3,
   6, 13.
2. A re-run moves no held bytes: a chunk pull interrupted after two of three
   chunks (through the `faults` seam) runs again on the next pull, and the
   `peerFetch` seam records a 304 for each staged index (the conditional `GET`
   carries the staged chunk's source server `ETag`) and a 200 for the third; the
   previous revision is served whole until the swap. Proves invariant 14 and the
   re-run row of the matrix.
3. Removal converges: delete chunk 1 on the source, rewrite the parent, pull;
   the replica server lists two chunks. Then delete chunk 2 with no parent
   write, pull; the replica server still lists two. Proves invariants 4 and 5
   and the chunk-only rows of the matrix.
4. Revision binding: hold the replica server's pull, write revision B of the
   parent on the source after revision A's chunks, then let the pull run with a
   `faults` hold between the listing read and the first chunk read. Assert no
   chunk of revision A is ever served, the chunk pull returns `retry` at the
   parent read, and the replica server converges on B's set. Proves step 5 and
   the swap.
5. Concurrent rewrite: both servers rewrite the whole stream with different
   chunk counts while paused; after pulls both ways, both serve the winning
   parent and its chunk set, and the loser's extra index is absent. Proves
   whole-stream consistency.
6. Parent moved mid-pull: the parent is rewritten on the source between the
   listing read and the closing check (through a `faults` hold); the chunk pull
   returns `retry`, the Collection reports `syncing`, the checkpoint holds, and
   the next pull converges on the new revision's set.
7. Quota: a replica server quota smaller than the net listed set stalls with
   `quota-exceeded` before anything live changes, and the replica server still
   serves the previous revision and its chunks; raising the quota clears the
   stall and the next pull applies both. A second case: a replica server whose
   quota holds the old set but a listed chunk exceeds its `maxUploadBytes`
   stalls the same way. A third: a Postgres replica at 70 of 100 units with a
   50-unit stream accepts a same-size rewrite, since the net is zero. Proves
   invariant 8 and step 3.
8. (Review) Delete racing a chunk pull: the parent is tombstoned on the source
   between the feed read and the listing read (`faults` hold); the chunk pull
   returns `retry`, and the next pull applies the tombstone from the feed and
   leaves no chunk directory. Proves the 404 rule.
9. (Review) Chunk-only delete mid-pull: index 1 is deleted on the source between
   the listing read and its `GET`; the chunk pull returns `retry`, and the next
   pull converges on the two remaining indexes.
10. (Review) Downstream chain: three servers A, B, C with C pulling B. C's pull
    runs while B is mid-pull (`faults` hold on B's chunk pull); C sees nothing
    new, or sees the old revision. After B completes and C pulls again, C serves
    the new revision and its full set. Proves invariant 3.
11. (Review) Two-way pair echo: the source server pulls its own revision back
    from the replica while the replica server's chunk pull is incomplete; the
    source server's set is untouched. Proves section 6 item 8.
12. (Review) `/meta`-only write on the source replicates its `custom` and
    `/meta` stamp with no chunk read.
13. (Review) `immutable` Collection: a delete-and-re-create life with fewer
    chunks on the source lands on the replica server as the new life and its set
    alone, with no 409 and no stall.
14. Clock bound: a parent stamp an hour ahead stalls with `clock-bound` after
    the set is staged, and nothing live changes; a chunk carries no source
    server stamp to observe (open point 3).
15. Tombstone cascade: a replicated parent tombstone leaves no chunk directory
    or rows on the replica server. (Review) The filesystem case also kills
    between the tombstone sidecar and the directory removal (`faults` or a
    direct call) and asserts the replay or boot reclaim removes the directory.
16. (Review) Staging: a crash after staging and before the swap leaves the old
    revision served whole and the re-run swaps; a crash between the filesystem
    directory swap and the parent sidecar is finished at boot from the manifest;
    staging left by an abandoned chunk pull (registration deleted, Resource
    deleted) is removed by the delete and at boot; a second registration staging
    the same Resource at the same time does not interleave; usage includes
    staged bytes and a same-size rewrite of a stream fits under the source
    server's quota on both backends.
17. Export from the replica server carries the replicated chunks and the archive
    imports on a third server. Proves invariant 11.
18. `test/chunks.test.ts`: the feed invisibility case and the listing cases stay
    green unchanged.
19. Conformance: `pnpm conformance:local` stays green with no suite change.

## 8. Open questions

1. Resolved 2026-10-24: WAS-184's bullet now mints a chunked Resource's revision
   statement at each parent write over the chunk set as it stands, has a chunk
   write remove the stored statement, and has a replica server mint its own when
   the chunk pull completes. Under the staged apply that moment is the swap.
2. Decided 2026-10-24: the staged apply (sections 5.2 to 5.4). Parent first
   would have kept a window of silent wrong plaintext for a direct reader, one
   chunk pull long and indefinite under a stall, and needed a durable pull-owed
   marker and a deferred feed position. Layout names signed off 2026-10-25
   (section 5.3), with the Postgres manifest row dropped since the transaction
   leaves no torn state; the quota credit during staging stands over a larger
   replica quota.
3. Decided 2026-10-24: a source server's chunk `ETag` is opaque to the replica
   server, used for the conditional `GET` and the staging key only, and the
   replica server mints its own stamp and generation for each chunk at the swap.
   The alternative, making this server's four-segment layout normative in the
   replication specification and storing the source server's identity verbatim,
   would have needed a stamp parser, a `decisions/0004` amendment, the clock
   bound on chunk stamps, and a halt on any source server whose chunk `ETag`s do
   not parse, for an equality no client consumes. This retires the inherited
   sentence that "a puller fetching chunk bytes with a plain `GET` learns the
   stamp from the `ETag` alone"; the WAS-14 roadmap item's context says so.
4. Decided 2026-10-24: decision 0013 is amended in place. Its two chunk
   sentences ("Chunk bytes are not replicated in v1"; chunks in the
   not-replicated list) were a scoping deferral to this item, not a design
   position, and the record's decisions proper (pull-only transport, a companion
   specification, a per-server Space registration) stand. The dated amendment
   carries the contract half of this design: a puller discovers a chunk set by
   reading the parent's chunk listing when the parent's feed document applies,
   reads each chunk with a conditional `GET` and the parent last, a chunk-only
   mutation does not replicate until the parent is written, and a source
   server's chunk `ETag` is opaque with no layout required. The staging apply is
   server-internal and stays out. WASS-50's acceptance box drops chunks from its
   not-replicated list and gains the chunk paragraph. Chunk replication is part
   of replication `0.1`, with no version bump: a chunk-replicating puller
   against a source server that does not replicate chunks reads chunk listings
   every server serves, and the reverse behaves as before, so no source server
   needs refusing. A new superseding record was considered and declined as
   heavier than the change. To file at approval.
5. Decided 2026-10-25: the chunk pull is gated on the source server listing the
   Encrypted Collections entry in its `/service`, checked once at registration,
   when the registration checks already read that document for the replication
   entry. The result is kept on the stored registration as `pullsChunks` (signed
   off 2026-10-25, listed under the layout decisions; a stored member, not a
   wire one). When the source server does not list the profile, no chunk pull
   runs for that registration: the parent applies as a plain Resource, no
   listing is read, and chunks the replica server holds under that parent are
   left alone, since a server with no chunk endpoints holds no chunks and
   whatever is held is a local write. A listing 404 then keeps its one meaning,
   the parent is gone. Without the gate a source server without the profile
   answers the listing with the reserved segment's 404 (this server) or a 405
   (another implementation), and every chunk pull would retry without end. A
   per-cycle re-read of `/service` was considered and declined: a server
   dropping the profile after registration is not a realistic scenario, and
   re-registration covers it.
6. Decided 2026-10-25: two new `ReplicaStallReason` members, both reached by a
   bounded retry counted in consecutive cycles stuck on one feed document
   (`REPLICA_CHUNK_PULL_RETRY_LIMIT` in `config.default.ts`; a cycle count
   rather than a wall-clock bound, so nothing is persisted and a restart starts
   over). `chunk-listing-obsolete`: a Resource rewritten on the source server
   faster than its chunk pull fails every closing check and returns `retry`
   without end, while the Collection reads `syncing` and `lastSuccessAt` stays
   fresh, so an operator cannot tell it from progress. `source-unavailable`: a
   request to the source server that keeps failing inside a chunk pull (a 5xx, a
   429 from rate limiting under thousands of chunk `GET`s, a grant narrowed past
   the chunk paths) ended the cycle under the earlier draft, which blocked every
   Collection behind it, the controller's log included; it now stalls that
   Collection alone. The alternative for the first, documenting that a replica
   server converges only after a quiet period at least as long as the chunk pull
   with no new member, was declined as leaving the operator blind. The
   replication specification's `0.1` text gains one sentence: a stall reason a
   reader does not recognize means stalled for an unrecognized reason. The
   activity itself is named the "chunk pull" throughout this doc (renamed from
   "walk" the same day); the document it starts from is the chunk listing.
7. Decided 2026-10-25: the controller-log Collection is pulled first in every
   cycle (invariant 16). `#pull` orders the selected Collections with the one
   hosting the local Space's controller log first, then the rest in the source
   server's listing order as today; `peerCollectionSelector` already identifies
   it, so it is a sort key and no new lookup. No wire effect; one sentence in
   `docs/replication.md` "The pull loop". A Space with a `did:key` controller
   hoists nothing. Interleaving the log Collection between the chunk pulls of a
   long Collection was considered and declined (section 6 item 11).

## 9. Review log (2026-10-24)

Six reviewers (consumer completeness, interaction matrix, adversary walk,
invariant audit, torn-state discipline, cross-repo contract) plus a completeness
critic. Findings, consolidated and in severity order, with where each was
folded:

1. A chunk pull cut after the parent applied never ran again: the equal-stamp
   skip ended it and the checkpoint advanced past a torn set. All six reviewers.
   Invariant 14, section 5.4, open point 2, section 6 item 8.
2. The replica server's feed surfaced the parent before its set; a downstream
   server or a second registration copied a torn set and was never re-signalled.
   Five reviewers. Invariant 3, section 3 (new consumer), the matrix, section
   5.4.
3. The window was silent wrong plaintext, not an `EncryptionError`, and no
   consumer retries. Three reviewers. Section 1, section 3, section 5.4, open
   point 2.
4. The closing `HEAD` could not be sent and a `GET`-only grant refuses it. Four
   reviewers. Invariant 13, section 5.2 step 7.
5. The `skipped`-on-404 rule rested on a livelock that cannot happen and dropped
   the rest of a chunk pull on a chunk-only delete or an expired grant. Five
   reviewers. Section 5.2 step 1 and 5, section 6 item 9, the matrix.
6. The `immutable` row cited a rule the apply path does not evaluate, and a 409
   would end the cycle. Four reviewers. Invariant 7, the matrix.
7. The quota pre-check was undecidable, over-counted a re-encrypted set, modeled
   neither backend's accounting, and ignored the per-chunk cap. Four reviewers.
   Invariant 8, section 5.2 step 3.
8. A registration removed mid-pull on a non-control-plane backend never ended
   the chunk pull. Three reviewers. Invariant 10, the matrix.
9. No stamp parser exists, the chunk `ETag` layout would become a cross-server
   requirement, and both backends' chunk write paths keep the held generation.
   Three reviewers. Invariant 1, section 5.1, open point 3.
10. A chunk-only mutation on the source server during a chunk pull partly leaks.
    One reviewer. Section 1, the matrix.
11. Decision 0013 and WASS-50 say chunks do not replicate (amended in place at
    approval, open point 4); the profile moved to
    `portable-web-spaces-spec/ec/spec.md`. One reviewer. Section 3, open
    point 4, the item's `touches`.
12. Postgres removal lacked the parent lock; a torn filesystem tombstone apply
    strands the chunk directory; a torn filesystem chunk apply serves new bytes
    under the old validator. One reviewer. Invariant 5, section 5.3.
13. A replica server's export statement over a torn set is judged `verified` on
    import. One reviewer. Invariant 11.
14. Step 3's "nothing below runs" would have skipped the `/meta` apply. One
    reviewer. Section 3, section 5.2 step 8, the matrix.
15. The chunk pull was not gated on chunked Resources or on the source server
    serving chunk endpoints; the listing read is bounded at 4 MiB. Two
    reviewers. Section 5.1, open point 5 (decided 2026-10-25: a
    registration-time check).
16. The test plan named a Postgres variant that does not exist and missed the
    contract-test enumeration. One reviewer. Section 7.

Completeness critic, classes nobody hunted:

17. A running chunk pull cannot be cancelled: a stop signal, Delete Space or
    Delete Replica is observed only between cycles. Invariant 17, section 5.2,
    the matrix.
18. Loop state is saved only when a Collection's pull ends, so a long first
    chunk pull never checkpoints across restarts. Invariant 18, section 5.2.
19. A Resource rewritten faster than its chunk pull never converges and status
    reads healthy. The matrix, open point 6.
20. One failing request to the source server ends the cycle and blocks every
    Collection behind it, which delays key retirement without bound. Invariant
    16, open point 6, open point 7.
21. The source server's listing is untrusted and unvalidated. Invariant 15,
    section 5.1.
22. Staged variant: no safe default location for the staging directory, quota
    double-counting, boot reclaim of directories, Postgres cascade and WAL and
    usage, overlapping registrations, the `default` alias move. Section 5.4,
    open point 2.
23. Staged variant: the "rename-length window" claim was wrong (the reader's
    read is the window), and a crash between swap and parent write needs a
    staged manifest to detect. Section 5.4, open point 2.

Dropped as already handled or out of bounds: forged chunk stamps or a foreign
`originId` (no path compares chunk stamps); a replica server client poisoning
chunks (the next chunk pull repairs it); a source server serving a 304 for a
chunk it does not hold or a body larger than declared (within trust in the
source server and the stream guards); a `/meta` write moving the pin (it
compares the content stamp).
