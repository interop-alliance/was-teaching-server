# WSS-14: Chunk replication (design)

- item: WSS-14
- status: approved
- approved: 2026-10-25
- wire-level decisions contained: listed in section 5 under "Wire-level and
  layout decisions", all signed off
- decision records extracted:
  `decisions/0006-chunk-sets-replicate-with-their-parent.md` (the apply unit,
  the feed and tombstone rules, the opaque chunk `ETag`), and the spec repo's
  decision 0013, amended in place with the contract half (what a puller reads,
  in what order)

## 1. Problem and scope

A chunked Resource is a parent envelope plus a set of chunk bytes at indexed
sub-paths. The pull loop applied the parent's content, `/meta` record and policy
from the `changes` feed and left the chunks behind, so a replica server served
an envelope it could not decrypt. The item makes the replica server serve the
chunk set the source server served, byte for byte.

Three questions inherited from the multi-primary design are answered here:

1. Discovery. A chunk write takes no feed position. The loop reads the parent's
   chunk listing when the parent's own feed document applies, and reads each
   listed chunk.
2. Chunk tombstones. There are none. A chunk is hard-deleted and stays so. An
   individual chunk delete converges on the next parent write, when the listing
   no longer carries the index.
3. Whole-stream consistency. The set is applied as a consequence of the parent
   revision that won last-writer-wins (LWW), as the source server listed it at
   that moment. Two servers rewriting one stream converge on the winning
   parent's set, not on a per-chunk mix.

The design rests on the Encrypted Collections profile's write protocol
(`ec/spec.md`, "Chunk lifecycle"): a client writes the envelope with
`stream.pending`, writes the chunks, and finishes with a parent write carrying
`stream.chunks`. Only parent writes take a feed position. A chunk-only mutation
stays on the server it was made on until the parent is written again, with one
accepted exception: a chunk-only mutation made on the source server during a
chunk pull can be partly carried, since the pull reads some indexes before it
and some after, and the closing parent check cannot see it. The next parent
write converges it.

The reader's window matters here. A chunk's binding carries `v`, `epoch` and
`resource` only, each chunk is its own JWE under the same recipient key, and no
consumer retries a failed stream read. An envelope served over chunks of another
revision is therefore silent wrong plaintext, or a `NotFoundError` on a missing
index. The design removes every such window replication would add. It does not
remove the one the chunk model has everywhere: a reader whose stream read spans
a rewrite, on the source server as on the replica server.

Out of scope: a `chunk` kind in the `changes` feed; chunk tombstones; chunk
retention (WSS-13); write-time statements over a chunked Resource (WSS-184); the
stored content digest (WSS-195); any change to the chunk routes' authorization
or to the client's write plan.

## 2. Invariants

How the design meets each invariant it touches.

1. Stamps are minted only by this server for its own writes (`decisions/0004`).
   A chunk is a local record that follows its parent, not a replicated-identity
   record. The replica server mints each chunk's stamp and generation from its
   own clock at the swap, as for a chunk a local client writes. The source
   server's chunk `ETag` is opaque here, kept in the staging record only. So
   `decisions/0004`'s stamp rule and its `originId` refusal never see a chunk,
   and this server's four-segment `ETag` layout is no requirement on source
   servers.
2. The replication facet writes through the backend's `apply*` family only. The
   staging verbs join that family (section 5.3), and no source server record
   goes through `writeChunk`.
3. A chunk write takes no feed position and does not move its parent. A staged
   chunk takes none either. The parent takes its feed position only inside the
   swap, once its set is in place, so a downstream server pulling this replica
   never reads a partial set.
4. A chunk is hard-deleted and leaves no tombstone. A removal at the swap
   removes the record as `deleteChunk` does.
5. A chunk cannot outlive its parent. The tombstone apply and the boot reclaim
   remove a chunk directory stranded beside a Resource tombstone.
6. Each chunk carries its own strong validator. The replica server serves its
   own. No client revalidates a chunk cached from one server against another,
   since chunk URLs are host-bound.
7. The write-once rule of an `immutable` Collection is not evaluated on the
   apply path, as it is not for `applyResource`. Chunk applies and removals run
   verbatim there; nothing on the apply path raises a 409.
8. Quota and the upload cap apply to a chunk as to a Resource. The pre-check is
   the backend's (section 5.3), and the in-write 507 or 413 during staging stays
   authoritative. Either becomes the `quota-exceeded` stall with nothing live
   changed.
9. The clock bound stalls a Collection on a received stamp beyond it. A chunk
   carries no source server stamp, so `clock.observe` sees the parent's stamp
   only, once per chunk pull.
10. A Collection's Resources go to the server backend its `backend.id` selects.
    The staging lives on that backend. The registration is checked on the
    control plane once per chunk set, so a Delete Replica mid-pull ends the pull
    within one set.
11. Export carries a Resource's chunks and import restores them re-stamped.
    Export skips staging, and under the staged apply no torn set is ever held,
    so a replica server's `StorageAttestation` over `chunkedDigest` names a set
    the source server held.
12. The maximum-privacy rule. The chunk pull reads through the existing routes,
    and a masked 404 mid-pull (an expired or revoked grant included) is `retry`.
13. The pull capability is `GET`/`HEAD` only, any subset. The chunk pull uses
    `GET` alone: the listing, each chunk, and a conditional `GET` of the parent
    as the closing check.
14. The checkpoint advances only past a document whose apply finished. An
    incomplete chunk pull leaves the held parent at the old revision, so the
    document applies again next cycle and completion is detectable from durable
    state with no marker.
15. Data from the source server is checked before it is acted on. The chunk
    listing is untrusted input (section 5.1).
16. A key retired at the source server stops authorizing on the replica after
    the next pull. The controller-log Collection is pulled first in every cycle,
    and a failing request inside a chunk pull stalls that Collection instead of
    ending the cycle.
17. The loop stops within one apply of a stop signal. The chunk pull checks the
    signal between chunks and ends on the first `skipped` or `unregistered`
    apply.
18. Replica state is persisted inside a Collection's pull once the chunk pulls
    since the last write pass `REPLICA_STATE_PERSIST_BYTES` or
    `REPLICA_STATE_PERSIST_DOCUMENTS`, so a long first pull keeps its checkpoint
    across restarts.

## 3. Consumers

Changed:

- `src/sync/replication.ts`: the chunk pull of section 5.2 runs inside the
  Resource apply, before the `/meta` apply and before the checkpoint advances.
  The `/meta` apply still runs when the content apply is skipped.
- `src/sync/peerClient.ts`: `readStream` takes `ifNoneMatch` and answers 304 and
  404 as outcomes.
- `src/types.ts` `StorageBackend`, both backends: the staging verbs, the
  `chunks` option of `applyResource`, the staging layout and its boot reclaim,
  the layout version and the Postgres migration, the chunk-directory sweep on a
  torn tombstone apply. Delete Resource, Delete Collection, Delete Space and
  Delete Replica reclaim staging in their scope.
- `src/lib/replicaApply.ts`: `decideResourceApply` is reused for the
  pre-decision and inside the swap.
- `@interop/storage-core`: two `ReplicaStallReason` members.
- `docs/replication.md`, `docs/changes-feed.md`, `docs/filesystem-layout.md`,
  `docs/validators-and-stamps.md`, ARCHITECTURE.md ("Write stamp", the
  replication facet), `decisions/0004`: the chunk clauses above.
- The Encrypted Collections profile ("Chunk lifecycle") and the replication
  specification: one paragraph each, that a replicating server carries the chunk
  set with the parent write it surfaces, and that a chunk-only mutation stays
  where it was made.

Unchanged, now resting on a new assumption:

- `pws-client` `EdvCodec` reading a stream on a replica server assumes the set
  is complete once the envelope carries `stream.chunks`. It is, from the moment
  the envelope is visible.
- `src/lib/exportProvenance.ts` `chunkedDigest`: now digests replicated chunks;
  export's chunk walk reads `.chunks.`-prefixed directories only.
- `src/lib/backendMirror.ts`: `mirroringControlPlane` forwards any method, so
  the staging verbs reach the data backend with no change.
- The replica server's own feed, listing and chunk routes, read by a downstream
  server or a second registration: the parent appears in the feed only with its
  set.

## 4. Edge cases

How the existing flows behave under the chunk pull. Everything not listed is
unchanged.

- Pending stub write (`stream.pending`): the listing is empty or partial, and
  the chunks present at that moment are applied.
- Finalizing parent write: every listed chunk is read. All answer 200, since an
  edit re-encrypts the whole stream.
- Parent overwrite with unchanged chunks (plaintext): the chunks re-transfer,
  since a live chunk's validator is this server's own.
- `/meta`-only write on the source server: the feed document moves with an equal
  content stamp, the `/meta` apply runs, no listing is read.
- Parent delete on the source server, including one racing a chunk pull: the
  tombstone apply removes the chunk directory. A listing or chunk 404 mid-pull
  is `retry`, and the feed serves the tombstone document on the next read.
- Chunk-only write or delete on the source server, no parent write: not
  discovered; converges on the next parent write. One mid-pull is partly carried
  (a write) or `retry` (a delete, 404 at that index).
- Two servers rewrite one stream concurrently: each replica server applies the
  winning parent and that origin's listed set; the loser's extra indexes are
  removed.
- Replica-server-local chunk write, then a source server parent write wins: the
  local chunk is overwritten or removed to match the listing. A local client's
  later chunk `PUT`s carry no parent precondition and can land after the swap;
  that race exists today between two clients of one server.
- Replica-server-local parent write wins: the decision is `skipped`, no set
  lands, local chunks stay.
- Parent rewritten on the source server between the listing read and the closing
  check: the closing `GET` answers another `ETag`, the pull is `retry`, the
  checkpoint holds, nothing landed.
- Chunk pull interrupted and run again: the held parent is still the old
  revision, the document applies again, and the staged chunks the listing still
  names under the same `etag` are kept without a request.
- Downstream server pulls a replica mid-pull, or two registrations on one Space
  serve the same revision: the parent is not in the feed until the swap, and the
  second arrival is an equal-stamp skip over a complete set.
- Two-way pair, the source server pulls its own revision back: equal stamp, no
  set lands, no removals.
- `immutable` Collection: chunks apply verbatim; a delete-and-re-create life
  lands as one live document and its set.
- Clock bound exceeded by the parent stamp: `clock-bound` stall at the swap,
  nothing live changed.
- Set larger than the remaining quota, or a chunk over the cap: `quota-exceeded`
  stall from the pre-check before anything is staged, or from the in-write check
  during staging, nothing live changed.
- Registration removed, Delete Space or Delete Collection on the replica
  mid-pull: the next registration or liveness check ends the pull, and the
  delete sweeps the staging.
- Server shutdown mid-pull: the pull ends within one chunk, and the re-run
  resumes from durable state.
- Resource rewritten on the source server faster than its chunk pull: every pull
  returns `retry` at the closing check; after `REPLICA_CHUNK_PULL_RETRY_LIMIT`
  consecutive cycles stuck on the document the Collection stalls as
  `chunk-listing-obsolete`, and the replica serves the last complete revision.
- One chunk request keeps failing (5xx, 429, a grant narrowed past chunk paths):
  the Collection stalls as `source-unavailable` after the same bounded retry,
  and the rest of the cycle goes on.
- Malformed listing: the Collection stalls as `source-unavailable`.
- Source server does not list the Encrypted Collections entry: `pullsChunks` is
  false, no chunk pull runs, parents apply as plain Resources, held chunks under
  them are left alone.
- `did.jsonl` Collection, or any Resource without chunks: one listing read
  answered with `count` 0 and nothing else.
- Export from the replica server: skips staging and never meets a torn set.
- `WAS_DEFAULT_BACKEND` switched between a chunk pull and its re-run: staging on
  the old backend is stranded until that backend's boot reclaim (WSS-219 owns
  the alias move).

## 5. Design

### 5.1 Discovery: the chunk listing with conditional reads

When the pull loop meets a live `kind: resource` document and the registration's
`pullsChunks` is true, it reads the parent's chunk listing on the source server
(`GET .../<resourceId>/chunks/`) with the pull capability. The listing says
which indexes exist, their sizes and their `etag`s.

The listing is untrusted input. Each `index` must be an integer in range by the
`parseChunkIndexSegment` rule, strictly ascending and unique. Each `size` must
be a non-negative integer, each `contentType` an ASCII media type of at most 128
characters, each `etag` a string. A listing that fails stalls the Collection as
`source-unavailable`. So does a feed document whose `etag` is not printable
ASCII of at most 160 characters, since that `ETag` keys the staging.

The listing is read under `REPLICATION_DOCUMENT_MAX_BYTES`, raised on
`bodyTooLarge` as the feed read is, and stalls as `quota-exceeded` if it still
does not fit. A Resource without chunks costs one listing read answered with
`count` 0; the rest of the chunk pull runs only for a non-empty listing or a
held set to remove.

The source server's chunk `ETag` is opaque to the replica server. It is used for
two things: the conditional `GET` of a re-run against what the run already
staged, and the staging record's key. A live chunk's validator is this server's
own, which no listing names, so a parent rewritten with its chunks untouched
re-transfers them. That case is rare, since an edit of an encrypted Resource
re-encrypts every chunk.

### 5.2 The chunk pull, in order

The chunk pull fetches first and writes last. Nothing live changes until the
whole set and the parent are on the replica server, and they land in one
critical section. For one live `resource` document:

1. Decide LWW against the held content record (a tombstone included) with
   `decideResourceApply`, before reading anything from the source server. If the
   held revision wins or is equal, skip to step 7. An equal stamp means the
   replica already holds this revision with its set, since the two land
   together.
2. Read the source server's listing and validate it. A 404 is `retry`: the
   parent is no longer live there, and the feed serves the tombstone document on
   the next read from the held checkpoint.
3. Open the staging run with `beginChunkStaging` (section 5.3). It makes the
   quota pre-check and reports what the run already holds, with the source
   server's `ETag` for each staged index. A set that does not fit stalls as
   `quota-exceeded` with nothing staged.
4. Read each listed chunk the run does not already hold under the listed `etag`
   through `readStream`, `REPLICA_CHUNK_PULL_CONCURRENCY` at a time, and write
   each to staging with `stageChunk`. The first failure stops new reads and
   waits for those in flight, so what they staged serves the re-run. A 404 is
   `retry`. The stop signal is checked between chunks.
5. Read the parent last. Inline `data` is taken from the feed document; a binary
   parent is read through `readStream`. Its served `ETag` must equal the feed
   document's `etag`, else `retry`: the parent was rewritten during the pull and
   the staged chunks may belong to the newer revision. This closing check is a
   `GET`, so a `GET`-only pull capability suffices.
6. One backend call, `applyResource` with `chunks`, under the parent's lock: the
   registration check, `clock.observe`, the LWW decision again under the lock,
   and on a win the swap of section 5.3. On a loss or an equal stamp (a local
   write landed since step 1) the staging is released and the result is
   `skipped`.
7. The `/meta` apply runs and the checkpoint advances.

`retry` keeps the checkpoint on this document and marks the Collection
`syncing`. The next cycle re-reads the feed from the held checkpoint and runs
the chunk pull again over the staging the earlier run left. A `refused` or
thrown error from a staging verb or the apply goes through the existing stall
mapping (507 and 413 to `quota-exceeded`, a 404 to `container-refused`) and the
two reasons below.

The retry is bounded. The loop state keeps, per Collection, a count of
consecutive cycles that ended in `retry` on the same feed document, reset by any
other outcome or a move of the checkpoint, and not persisted. At
`REPLICA_CHUNK_PULL_RETRY_LIMIT` the Collection stalls as
`chunk-listing-obsolete`: the source server rewrites the Resource faster than
the pull completes. A request to the source server that keeps failing inside a
chunk pull (a 5xx, a 429, a masked 404) stalls the Collection as
`source-unavailable` under the same count, with the URL and status of the last
failure in the stall `detail`. Either stall is retried each cycle like every
other stall and clears on the first chunk pull that passes. A failed request
outside a chunk pull (the feed page, the Space listing) ends the cycle as it
does today.

Within a cycle the controller-log Collection is pulled first, then the rest in
the source server's listing order. A Space with a `did:key` controller hoists
nothing.

### 5.3 The staging verbs and the swap

Four verbs join `StorageBackend`, beside the `chunks` option of `applyResource`.
All take the registration's `replicaId`.

- `beginChunkStaging({ spaceId, replicaId, collectionId, resourceId, run, listed })`
  opens the run for one chunk pull, under the parent's lock. It checks that the
  registration stands and the Collection is live, drops the same registration's
  staging of the Resource under any other parent `ETag`, finishes a swap of the
  Resource a fault left torn (filesystem only), makes the quota pre-check, and
  resolves what the run already holds, by index with the source server's `ETag`
  each was read under. The pre-check tests each listed size against the upload
  cap and the set's net growth (the listed sizes, less what the run already
  staged, less the live chunks the swap frees, plus the filesystem backend's own
  headroom) against the remaining capacity. A set that does not fit is `refused`
  as `quota-exceeded` with nothing staged. The check is advisory; the in-write
  check stays authoritative.
- `stageChunk({ spaceId, replicaId, collectionId, resourceId, run, chunkIndex, input, peerEtag })`
  writes one chunk's bytes to the run's staging under the upload cap and the
  quota, crediting the live chunks at the indexes the run has staged so far. It
  checks the registration and the Collection's liveness under the parent's lock
  and transfers outside it, so several chunks of one run may be staged at once.
  The parent need not be held: a first-time replication stages under no parent
  record. A staged chunk takes no feed position and is served by nothing.
  `retry` means the staging was removed during the transfer.
- `listStagedChunks({ spaceId, collectionId, resourceId, run })` is a plain read
  of what a run holds.
- `reclaimStaging({ spaceId, collectionId?, resourceId?, replicaId? })` removes
  the staging the loop no longer owns: every run at boot, a registration's on
  Delete Replica, and a Resource's, Collection's or Space's inside the matching
  delete. A run whose swap was done but whose parent record was never written is
  finished rather than removed.

The swap, `applyResource` with `chunks: { run, staged }`, runs under the
parent's lock in one critical section. On a win it removes every live index not
in `staged`, moves the staged chunks into place with a stamp from this store's
clock and a fresh generation each, writes the parent, takes its feed position,
and releases the run. The listing is staged whole, since the source server
cannot match a live chunk's validator, so `staged` is the set and every other
live index goes.

Filesystem order: the parent's file is written into the run, the manifest is
written (its presence is the swap flag), the staged chunks move into `next/`,
the live chunk directory is renamed to `prior/` and `next/` takes its place (two
renames, since a non-empty directory cannot be replaced by one), the parent's
file moves into the Collection directory, and the parent's sidecar is written as
the commit point. Every step can be run again over what a cut-short run left, so
the same code finishes a torn swap at boot or at the next open of a run for the
Resource. A torn swap is finished only if the manifest's parent stamp still wins
over the held parent. Reads take no lock, so a reader between the directory swap
and the sidecar gets a chunk of the new set under the prior parent; the window
is two renames and one sidecar write.

Postgres: one transaction, the parent row `FOR UPDATE`, the staged rows copied
into `chunks` with an `INSERT ... SELECT` inside the database, and the feed
position update last. No manifest, since there is no torn state to detect.

Quota under staging is net. The pre-check and the in-write check during staging
credit the live chunks the swap will free, so a replica server with its source
server's quota can replace its largest stream in place. Usage on both backends
includes staging.

There is no per-chunk LWW. A held chunk's stamp never decides against an
incoming set; the swap replaces the set as a whole with what the source server
listed under the winning revision. A per-chunk rule would leave a torn set when
a replica-local client's in-progress chunks were fresher than the incoming
revision's.

### 5.4 Layouts

Filesystem: `.staging.chunks.<encodedResourceId>/` in the Collection directory,
beside `.chunks.<encodedResourceId>/` under the same id encoding, so Delete
Resource and the reclaim find it by the same derivation and the listings, the
feed and export skip it as they skip `.chunks.`. Under it one run directory per
`<replicaId>/<base64url(parentEtag)>/`, so Delete Replica reclaims one
directory. A run directory mirrors the live chunk directory: one representation
file per staged chunk with a `.meta.<index>.json` sidecar (`contentType`,
`size`, `peerEtag`, `fileName`), plus `.manifest.json` (`parentEtag`, `staged`,
`parent`), `next/`, `prior/` and `parent/` during the swap. The layout version
is 6, with a no-op migration, so an earlier server refuses the store.

Postgres: a `chunk_staging` table with the `chunks` columns less `generation`
and `version`, plus `replica_id`, `parent_etag` and `peer_etag`; primary key
(space, collection, resource, replica, parent `ETag`, index); a cascading
foreign key to `collections`. There is no key to `resources` or `replicas`: no
parent row exists on a first-time replication, and a Postgres backend that is
not the control plane holds no `replicas` rows, so Delete Replica and Delete
Resource call `reclaimStaging`. The same migration step adds
`pulls_chunks boolean NOT NULL` to `replicas`, existing rows `false`.

Both backends reclaim every staging run at `open()`, finishing a torn swap
first. No loop owns staging at boot, and the next chunk pull stages again what
the restart removed.

### 5.5 What does not change

The chunk routes and their authorization, the `changes` feed, export and import,
and the client's write plan. The server still never reassembles a stream and
never reads inside a chunk. The live chunk record layout on both backends is
unchanged; staging sits beside it.

### Wire-level and layout decisions (all signed off 2026-10-25)

1. The filesystem `.staging.chunks.<encodedResourceId>/` directory with its
   `<replicaId>/<base64url(parentEtag)>/` run directories and `.manifest.json`,
   and the Postgres `chunk_staging` table with `peer_etag` and no manifest row
   (section 5.4).
2. `pullsChunks`, a boolean on the stored registration (`StoredReplica`, beside
   `spaceGeneration`), not on the wire `ReplicaRegistration`. Set at
   registration from the source server's `/service` listing the Encrypted
   Collections entry, and not read again per cycle. Postgres `pulls_chunks`,
   filesystem `pullsChunks` read as `false` when absent. A registration made
   before this landed pulls no chunks until it is made again. Not replicated and
   not exported.
3. Two members of the `ReplicaStallReason` union in `@interop/storage-core`:
   `chunk-listing-obsolete` and `source-unavailable`, both reached by the
   bounded retry of section 5.2. The replication specification says a stall
   reason a reader does not recognize means stalled for an unrecognized reason.

No new response member, no new error name, no new feed `kind`. A source server's
chunk `ETag` is opaque, with no layout required. Chunk replication is part of
replication `0.1` with no version bump: a chunk-replicating puller against a
source server that does not replicate chunks reads listings every server serves,
and the reverse behaves as before.

## 6. Alternatives rejected

Items 1, 2 and 3 are canonical in `decisions/0006` with their revisit criteria.

1. A `chunk` kind in the `changes` feed. It contradicts the core `changes`
   profile's scope and the profile's "Chunk lifecycle", needs chunk tombstones,
   and loses whole-stream consistency.
2. Stamped chunk tombstones. Stands or falls with item 1.
3. Parent first, then the chunks into the live set. A reader in its window gets
   silent wrong plaintext, a cut pull needs a durable marker to resume, and a
   downstream puller copies a torn set unless the feed position is deferred.
4. Chunks first into the live set, then the parent. A losing revision's chunks
   would land, and a reader decrypts the old envelope over new chunks.
5. A stored parent-revision member on each chunk record. A layout and archive
   change, stale after every parent overwrite that leaves the chunks alone, and
   unneeded under the staged apply.
6. Per-chunk LWW. Leaves a torn set (section 5.3).
7. Parsing the source server's chunk `ETag` for its stamp and generation. It
   would make this server's layout a cross-server requirement, need a stamp
   parser and a `decisions/0004` amendment, and halt on any source server whose
   `ETag`s do not parse, for an equality no client consumes.
8. A `HEAD` per chunk before each `GET`, or a `HEAD` as the closing check. It
   doubles the requests for the chunks that did change, which is nearly all of
   them, and the transport sends `GET` only.
9. `skipped` on a 404 mid-pull. It drops the rest of a pull on a chunk-only
   delete, an expired grant, or a delete racing the pull.
10. A plain pull-on-equal-stamp as the resumption rule. A source server pulling
    its own revision back from a partial replica would run removals against its
    own set.
11. Staged bytes counted gross, with a replica quota larger than its source
    server's by its largest stream. A replica configured like its source server
    could never replace a set larger than half its quota.
12. A per-cycle re-read of `/service` for `pullsChunks`. A server dropping the
    profile after registration is not a realistic case; re-registration covers
    it.
13. Re-pulling the controller-log Collection between the chunk pulls of a long
    Collection. It complicates the loop for a bound the operator sets with the
    cycle interval; the log Collection is pulled first in every cycle and
    nothing more.
14. Documenting a quiet-period convergence rule instead of
    `chunk-listing-obsolete`. It leaves the operator blind, since the Collection
    reads `syncing` and `lastSuccessAt` stays fresh.

## 7. Tests

`test/chunk-replication-api.test.ts` holds the two-server cases under the
helper's default `GET`-only pull capability: a chunked Resource replicates with
the replica's own chunk `ETag`s; a re-run keeps staged chunks and moves only
what is missing; removal converges on the next parent write and not on a
chunk-only delete; revision binding and the closing check under a parent
rewritten mid-pull; concurrent rewrites converge on the winning set; the quota
pre-check and the in-write refusal leave the previous revision served; a delete
or a chunk-only delete racing the pull; a downstream chain of three servers; a
two-way pair echo; a `/meta`-only write; an `immutable` Collection; the clock
bound; the tombstone cascade and the stranded chunk directory; the staging crash
cases and the boot reclaim; export from the replica importing on a third server;
the bounded retry and both stall reasons.
`test/filesystem-chunk-staging.test.ts` holds the filesystem swap and torn-swap
cases. `test/postgres-replica-apply.test.ts` holds the Postgres apply
comparisons, `test/storage-backend-contract.ts` enumerates the staging verbs,
`test/chunks.test.ts` keeps the feed invisibility case, and
`pnpm conformance:local` runs with no suite change.
