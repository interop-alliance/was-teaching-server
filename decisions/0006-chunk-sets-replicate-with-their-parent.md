# 0006: A chunk set replicates with its parent revision, applied as one staged set

- Status: accepted
- Date: 2026-10-25
- Driving work: chunk replication for the pull loop
  (`designs/WAS-14-chunk-replication.md`, approved 2026-10-25). The pull loop
  replicated a chunked Resource's parent envelope and left its chunk bytes
  behind, so a replica server served an envelope it could not decrypt.
- Affects: was-teaching-server (`src/sync/replication.ts`, the chunk pull;
  `src/lib/replicaApply.ts`; both backends' staging verbs (`beginChunkStaging`,
  `stageChunk`, `listStagedChunks`, `reclaimStaging`) and the `chunks` option of
  `applyResource`; the staging layouts; `docs/replication.md`,
  `docs/changes-feed.md`); storage-core (two `ReplicaStallReason` members). The
  contract half, what a puller reads and in what order, is the spec repo's
  decision 0013.

## Context

A chunked Resource is a parent envelope plus a set of chunk bytes at indexed
sub-paths. The core `changes` profile's scope and the Encrypted Collections
profile's "Chunk lifecycle" both say a chunk write is invisible to the feed: the
client writes a pending envelope, then the chunks, then the finalizing parent,
and only the parent writes take a feed position. A replica server therefore
learns of a chunk set only through its parent's feed document.

The chunk set has to land on the replica server in a way a direct reader cannot
observe half-done. A reader of a chunked Resource decrypts the envelope over the
chunks it reads next, with no snapshot and no binding of a chunk to its parent
revision inside the ciphertext, so an envelope served over another revision's
chunks yields silent wrong plaintext or a not-found, and nothing retries it. Two
servers rewriting one stream must also converge on one server's whole set rather
than a per-chunk mix.

## Decision

A chunk set replicates with its parent revision and applies as one unit.

1. A chunk write takes no feed position and there is no `chunk` feed kind. The
   pull loop discovers a chunk set when the parent's `kind: resource` document
   applies, by reading the parent's chunk listing and each listed chunk.
2. A chunk delete leaves no tombstone. A removal replicates on the next parent
   write, when the listing no longer carries the index; a chunk-only mutation
   with no parent write stays where it was made.
3. The chunks are fetched into a staging area keyed by the registration and the
   parent's feed `etag`, and the parent is read last as the closing check. One
   apply under the parent's lock then decides last-writer-wins on the parent's
   stamp and, on a win, swaps the staged set in, removes every index the listing
   no longer carries, and writes the parent. Nothing live changes before the
   swap, and the parent reaches the replica server's feed only with its set. A
   loss or an equal stamp releases the staging and applies nothing.
4. The chunk set resolves with its parent revision, not per chunk. A held
   chunk's stamp never decides against an incoming set.
5. A source server's chunk `ETag` is opaque to the replica server, used for the
   conditional `GET` and the staging key only. Each applied chunk gets the
   replica server's own stamp and generation at the swap, as decision 0004
   requires of every record this server stores.
6. The chunk pull runs only for a registration whose source server listed the
   Encrypted Collections entry at registration (`pullsChunks` on the stored
   registration). A pull that cannot converge, or a source server request that
   keeps failing inside it, stalls the Collection after a bounded number of
   cycles, as `chunk-listing-obsolete` or `source-unavailable`.

## Rejected Alternatives

- A `chunk` kind in the `changes` feed, with a chunk write taking a feed
  position. Do not reopen. It contradicts both profiles' scope, needs chunk
  tombstones so a delete can replicate (turning a hard-deleted record into a
  versioned one on both backends and in the archive), and loses whole-stream
  consistency, since two servers rewriting a stream converge on a per-chunk mix.
  The chunk pull reads one extra document per changed Resource instead.
- Stamped chunk tombstones. Do not reopen, for the same reasons: a chunk delete
  is cascade-only or converges on the next parent write.
- Parent first, then the chunks into the live set. Do not reopen: a reader in
  its window gets silent wrong plaintext, a cut pull needs a durable marker in
  the loop state to resume, the parent's feed position has to be deferred or a
  downstream puller copies a torn set, and a stall leaves the torn set in place
  for as long as it lasts.
- Chunks before the parent, into the live set. The parent's last-writer-wins
  outcome is decided inside its apply, so a losing revision's chunks would land,
  and a reader between the chunk writes and the parent write decrypts the old
  envelope over new chunks.
- Per-chunk last-writer-wins, keeping a held chunk whose stamp is newer than the
  incoming one. It leaves a torn set when a client of the replica server is
  mid-protocol on its own revision, with nothing to detect it.
- A stored parent-revision member on each chunk record. A layout and archive
  change that is stale after every parent overwrite leaving the chunks alone.
  The staged apply needs no binding member.
- Parsing the source server's chunk `ETag` for its stamp. It would make this
  server's validator layout a cross-server requirement, for an equality no
  client consumes.

## Consequences

- A chunk-only mutation on the source server with no parent write does not reach
  a replica server until the next parent write. The Encrypted Collections write
  protocol always ends in one, so the gap is bounded by the client's own
  protocol.
- A chunk write made on the replica server under a parent the source server
  later rewrites is replaced by the source server's set at the swap, with the
  client's finalize failing its precondition. That is the race two clients of
  one server already have.
- A replicated chunk carries the replica server's validator, so a later pull's
  conditional `GET` for an unchanged index answers 200. The re-transfer costs
  only in the rare plaintext case of a parent rewritten with its chunks
  untouched, since an encrypted edit re-encrypts every chunk.
- Both backends gain a staging area that counts toward usage and is reclaimed at
  boot, on Delete Replica, and inside the Resource, Collection and Space
  deletes. The filesystem layout version and the Postgres schema move.
- A reader's own window, reading the envelope and the first chunks before a swap
  and the rest after it, remains. It exists on the source server whenever a
  client rewrites a stream under a reader; this decision removes only the
  windows replication would add.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. The Encrypted Collections profile drops the pending-then-finalize write
   protocol, so a chunk set no longer ends in a parent write.
2. A chunk framing binds each chunk to its parent revision inside the ciphertext
   (the hardened framing the profile's stream-integrity note says is planned
   upstream), so a torn or mixed set is detectable by the reader and a per-chunk
   feed could carry revision identity.
3. Chunk-only mutations gain a use that needs replication without a parent
   write.

If revisited, a per-chunk feed kind or a chunk tombstone is a new version of the
replication entry, and the staged apply stays the apply rule until the reader
can detect a torn set.
