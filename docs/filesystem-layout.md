# Storage Layout: the Filesystem Backend and its Postgres Twin

This document covers how the filesystem backend lays out its data root, versions
that layout, settles the store's origin id and clock mark, and handles sidecars,
Resource tombstones, crash leftovers and Collection tombstones, with the
Postgres counterpart of each. [ARCHITECTURE.md](../ARCHITECTURE.md) holds the
layer map and the glossary. Archive export and import of this layout are in
[export-import.md](export-import.md).

## store.json and layout versions

The `src/backends/filesystemStore.ts` module holds the filesystem backend's
storage layout version. The data root holds `store.json`, whose integer
`version` names the layout, beside `spaces/`, `keystores/` and
`space-revocations/`.

`STORE_MIGRATIONS` is an ordered, append-only list of migration functions,
version `n` being entry `n - 1`, like `MIGRATIONS` in `postgresSchema.ts`. The
backend's async factory, `FileSystemBackend.open()`, applies pending steps in
order under a lock and rewrites `store.json` after each one, so every step must
be idempotent.

Each runner creates its own `store.lock.<nonce>` file and withdraws if it then
sees another live one. A lock file whose heartbeat stopped, or whose holder is
gone from this host, is ignored and removed.

An empty data dir is stamped at the current version. A data dir that holds data
but no `store.json` predates the stamp and is at the baseline layout, so it is
taken as version 0 and every step runs over it, the baseline step stamping it
first. Startup is refused when `store.json` names a version newer than the code
knows.

The version is private to the backend: it is not exported, not stored in any
Space, and not served. The Postgres backend's `applyMigrations` refuses the same
way, with the same `StoreVersionError`, when its `schema_migrations` table
records a version newer than `MIGRATIONS` knows.

### Version 2: the write-stamp layout

Its step refuses a data dir that holds any Space, with `StoreVersionError`,
since a record written before stamps carries none and there is no stamping step.
The refusal repeats on every boot until the dir is wiped. An empty data dir
passes and is stamped at the new version. The Postgres backend refuses a
populated pre-stamp schema the same way. The write stamp is described in
[validators-and-stamps.md](validators-and-stamps.md).

### Version 3: the policy-stamp layout

An access-control policy carries a write stamp and a generation, and its delete
leaves a tombstone. Its step refuses a data dir that holds any policy file, on
the same terms. Postgres schema migration 12 refuses a `policies` table that
holds any row the same way, then adds the stamp, generation, `deleted` and
`feed_position` columns. Policy records are described in
[validators-and-stamps.md](validators-and-stamps.md).

### Version 4: the feed-position layout

A policy file carries its own feed position and the feed counter file holds a
`records` map. Its step refuses a data dir that holds any feed counter file or
any Collection- or Resource-level policy file, with `StoreVersionError`, on
every boot and with no conversion step. A Space policy alone passes. An empty
data dir is stamped at version 4. Postgres is unchanged. The feed counter file
is described in [changes-feed.md](changes-feed.md).

### Version 5: Resource tombstones under their own name

A Resource tombstone is stored as `.tombstone.<id>.json` (see
[Resource tombstones](#resource-tombstones)). Its step walks every Collection
dir and refuses a data dir holding any `.meta.<id>.json` whose body carries
`deleted: true`, with `StoreVersionError`, on every boot and with no conversion
step. A sidecar that does not parse is not a tombstone. An empty data dir, or
one with no such sidecar, is stamped at version 5. Postgres is unchanged: its
liveness is the `deleted` column.

## The origin id and the clock mark

`store.json` also carries the store's origin id as its `originId` member (see
the Origin id entry in the [ARCHITECTURE.md](../ARCHITECTURE.md) glossary).
`open()` settles it on every boot, under the same lock, and it is not a
migration step. A store with no id takes `WAS_ORIGIN_ID` when set, else a minted
one, and writes it before any step runs. A stored id is kept, and a set
`WAS_ORIGIN_ID` that differs from it refuses startup with `StoreOriginIdError`,
naming both.

`store.json` also carries `clockHighWater`, the high-water mark of the store's
hybrid logical clock in epoch milliseconds (see
[validators-and-stamps.md](validators-and-stamps.md)). The clock raises it at
runtime, and a lower value never replaces a stored higher one. It is not a
migration step either.

Every rewrite of `store.json` keeps the id, the high-water mark, and any member
this code does not know.

The Postgres twin is the single row of the `store` table (column `origin_id`,
beside `clock_high_water`), settled by `applyMigrations` in the same
transaction, under its advisory lock.

Each backend exposes the id as `StorageBackend.originId`, and a data-plane
backend adapter carries the hosting server's id, handed to it through the
`BackendProvider` options.

## Opening a backend

Both primary backends are obtained only from a static async `open()` (their
constructors are protected), which resolves once the migrations have run and the
id is settled. A backend in hand is therefore never half-built, and the id is a
plain member with no "not yet" state.

The plugin opens the default backend itself and, when it owns the backend, wires
only `close()`. `start.ts` passes the Postgres backend as a function, which the
plugin calls at registration with the Fastify logger once its other options are
validated. The plugin refuses a backend with no origin id, after wiring
`close()`.

## Sidecars and representation files

The filesystem backend finds a live Resource or chunk through its
`.meta.<id>.json` sidecar, which records the basename of the representation file
the write created as `fileName`. Reads and writes open that name, with no
directory listing and no re-derivation from `contentType`, so a change in how
`fileNameFor` derives a name cannot strand a stored file. A representation file
no sidecar names is not a Resource. `fileName` is server-local: a tombstone has
none, export strips it, and import records the file it writes.

### Resource tombstones

Delete Resource leaves a tombstone: the delete's stamp, the generation, the
`feedPosition`, the last-known `contentType` and `deleted: true`. It is stored
as `.tombstone.<id>.json`, beside where the live sidecar was. The name has the
same fixed prefix and fixed suffix as the live sidecar's, so a Resource id that
holds a dot stays unambiguous. Chunk sidecars have no tombstone name, since
Delete Chunk leaves no tombstone.

Liveness is therefore in the directory listing: one `readdir` yields both kinds,
told apart by prefix. The name is local to this backend. An archive carries a
tombstone under the live sidecar's name, as it always has, and import writes it
under the tombstone name.

Delete Resource writes the tombstone first, then removes the live sidecar, then
the one file the live sidecar named, then the chunk directory. It lists nothing.
A create over a tombstone writes the live sidecar, then removes the tombstone. A
content write of a live Resource rewrites the live sidecar, as before, and
removes nothing.

A crash between those two steps leaves both names for one id. Every path that
reads a sidecar by id reads both names and takes the one with the higher
`feedPosition` as the Resource's state. Each step writes its new body at a
position above the old one's, so the higher position is the newer body. The next
write or delete of the id removes the other name.

A read opens only the names that can stand. A read by id with no listing in hand
opens both. The directory scans hand the read the names their listing holds, so
an id with one name costs one open, and an id with no live sidecar name is left
out with no open at all. A chunk dir holds no tombstone, so a chunk read opens
the live name alone.

A read takes no lock, so one that lands between the two steps can find neither
name. It then reads the id as absent, which every reader treats as it treats a
tombstone.

### Counting live Resources

The Collection listing's `totalItems` counts the ids that have both a live
sidecar name and a representation file in the directory listing. It opens no
sidecar, except the page the listing serves. An id with both names is resolved
by reading those two sidecars, and only those. A tombstone, a file beside a
tombstone, and a file with no sidecar do not count.

The byte quota caches its `du` figure per Space in an `LruCache`
(`@interop/lru-memoize`) for a short time, counted from the start of the
measurement, and re-measures when the entry expires. Writes that find the entry
expired at the same time share one running measurement, and a rejected
measurement is not cached. A Space whose `du` takes close to the TTL gets few
cache hits, which this backend accepts: it is built for a readable layout, not
throughput.

### Reads

Reads take no lock. A read that finds its file gone reads the sidecar again and
follows a changed one. An unchanged sidecar over a missing file is absent (404)
when its container no longer stands -- the Collection is tombstoned, or a
chunk's parent Resource is -- since a container delete removes its members in no
fixed order. Otherwise it is a `StorageError` (500).

A read racing Delete Space can still answer 500: the Space dir is removed in no
fixed order, and no tombstone is left for the read to find.

### Delete Chunk

Delete Chunk finds the chunk from its sidecar, as a read does, and removes the
sidecar before the file it names. A read racing it finds the sidecar gone and
answers 404. A retried delete that was cut short between the two removals
answers 404 too.

## Crash cases

A crash can leave a file no live sidecar names. The cases are bytes written
before their sidecar, the prior file of a write cut short before its prune, and
the file of a delete cut short after its tombstone. Such a file is detected from
names alone: its id has a tombstone or no sidecar, or a live sidecar that names
another file.

A write removes only the file the prior sidecar named, so such a file stays in
place beside a live sidecar. It is reclaimed by the next Delete Resource of the
id, or by the next write that creates the Resource over a tombstone, a content
write or a replicated one. Either already holds the per-Resource lock, and once
its sidecar is committed it lists the directory and removes every file of the id
but the one it names, which for the delete is none, so no byte of a deleted id
stays in the byte quota's walk. A content write of a live Resource, and a create
of an id with no sidecar, list nothing. A file beside a live sidecar therefore
stays until the id is deleted, and a file with no sidecar and no tombstone stays
until a write of the id lands on the same name or its Collection is deleted.
Delete Chunk removes every representation file of the index the same way. Delete
Chunk of an index with no sidecar answers 404 and leaves its file in place.

The changes feed, export, the equality and unique-claim scans, and the chunk
listing keep a file only when its id's sidecar is live and names it
(`#liveRepresentationEntries`), so they agree with the reads. A tombstone beside
such a file is a tombstone in the feed, read once for both roles. Export
archives a live Resource's sidecar from the object it was judged by, so it reads
each sidecar once.

The Collection listing judges files the same way, but reads only the sidecars it
needs to fill the page. Its `totalItems` counts the rest from the names in the
listing (see [Counting live Resources](#counting-live-resources)), so a file
with no sidecar and a file beside a tombstone are not counted. The count does
not check that the file is the one the sidecar names. A live sidecar naming a
file that is gone, with another file of the id beside it, is damage no committed
write leaves, and it counts the way a damaged sidecar does (see below).

## Damaged sidecars

A sidecar that does not parse leaves its Resource out of every path that lists a
directory and reads the sidecars it lists, with a `warn` line. That covers the
listing page, the chunk listing, export, the changes feed, the equality and
blinded-index queries, the unique-claim scans a write runs, and the check a new
unique index declaration runs. The name-based count opens no sidecar, so a
damaged sidecar outside the listing page still counts in `totalItems`.

Sidecar writes are atomic (`atomicWriteFile`), so such a sidecar is disk damage
or a hand edit, not a torn write. The damaged Resource's own reads and writes
still fail on it, unless the id's other name stands and parses. Then the damaged
name is read as absent, with a `warn` line, the other name alone is the
Resource's state, and the next write or delete of the id removes the damaged
file as it would a stale pair. One damaged file must not take down every unique
write and the whole feed of its Collection, or the Resource it sits beside.

The cost is that a unique value the damaged Resource holds is not defended while
its sidecar stands damaged. A write of another Resource may take the value, and
the damaged Resource then has to be rewritten under another one. A rewrite is
the repair either way: it runs the unique claims again and takes a fresh feed
position, while a sidecar restored by hand takes none.

## Collection tombstones

Delete Collection leaves a tombstone in both backends. See the Collection
tombstone entry in the [ARCHITECTURE.md](../ARCHITECTURE.md) glossary for what
it holds and how a create over it behaves.

### The filesystem backend

The filesystem backend keeps the tombstone as the Collection's
`.collection.<id>.json`, now holding only `deleted: true`, the stamp, and
`_generation`, in the Collection dir. It writes the tombstone first, durably,
then removes every other entry of the dir.

A tombstone beside other entries is a delete cut short, detected from the disk
alone. It is finished in four places:

- `open()` finishes every such delete at boot.
- A read of the Collection (`getCollectionMetadata`) finishes it on the
  exclusive side of the Space gate.
- A retried delete finishes it and answers 404.
- A create or an import over the tombstone finishes it before writing the new
  life.

A Collection dir with no Metadata file (a create cut short) is no Collection: a
delete removes it whole and answers 204, as for an id never used.

`deleteCollection` resolves `deleted`, `already-deleted` or `absent`, and the
handler answers 204, 404 and 204.

Every reader of the Metadata file goes through one low-level reader that returns
the tombstone, and every other path treats it as absent, so a new call site is
safe by default.

### The Postgres backend

The Postgres backend deletes in one transaction: member rows and policies go,
and the `collections` row stays with `deleted` set (schema migration 10),
`metadata` NULL, the log and feed columns cleared, and the generation and stamp
columns kept.

### External backends and Delete Space

A Collection on a registered external backend keeps its tombstone in the primary
store, where its Metadata object lives. Delete Space stays a hard delete and
takes the tombstones with it. Tombstones are never reaped.

How export and import carry a tombstone is described in
[export-import.md](export-import.md).
