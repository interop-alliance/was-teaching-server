# Export and Import of a Space

This document covers how a Space is exported to an archive and imported from
one: the write invariants every backend keeps, the archive and its entries, the
checks the import plan applies, and how archived revocations are installed.
[ARCHITECTURE.md](../ARCHITECTURE.md) holds the layer map and the glossary.

## Backend write invariants

A backend offers no precondition primitive of its own to a client. The server
serializes the write and evaluates `If-Match` / `If-None-Match: *` atomically
with it, so every backend honors both unconditionally.

No write creates a container implicitly. Only a Space Metadata write creates a
Space, and only a Collection Metadata write or an import creates a Collection.
Every other write re-checks that its Space, and its Collection where it names
one, has a Metadata object (a tombstoned Collection has none). It does so under
the lock it holds against Delete Space and Delete Collection: the filesystem
backend's Space gate, or the Postgres `spaces` row. It is refused with a 404
otherwise. The request layer's own existence check runs before that lock, so a
write racing a delete would otherwise recreate the removed container. A
Space-scoped revocation insert is one of these writes, though its records live
outside the Space tree.

## The archive

Each backend's `exportSpace` builds the archive's entry tree out of its own
storage and hands it to `packSpaceArchive`. The per-Space archive codec itself
is the file-name dialect, the `manifest.yml` document and the packer. It lives
in `@interop/space-archive`, shared with the wallets that read a backup.
`src/lib/importTar.ts` reads the same dialect back. The codec is isomorphic and
resolves a streamx-based tar-stream `Pack`, which the backend wraps with
`Readable.from`.

The Export Space handler passes this server's Service Description to
`exportSpace`. The codec writes it into the archive verbatim as its
`service.json` entry beside `manifest.yml`, so an importer can read which
specification versions and feature set the contents were written under before it
writes anything. It is informational, and `importTar.ts` ignores it.

When the handler has an export attestor (the server has an identity), the
backend also passes the codec the `provenance.jsonl` statements that
`attestArchiveEntries` builds over its entry tree, and the `did.jsonl` log
snapshot. The layout under `space/` does not change, so the import walk is the
same either way. `lib/importProvenance.ts` judges the two root entries beside
it. How the statements are built and judged is described in
[server-identity-and-provenance.md](server-identity-and-provenance.md).

`test/space-archive-fixture.test.ts` pins this server's entry trees against the
archive fixture that the codec package checks in.

## The Space Metadata entry

The archive's `.space.<id>.json` entry is the stored Space Metadata object in
the filesystem backend's on-disk layout, with the server-derived `backends`
listing stamped on. `archivedSpaceMetadata` in `lib/spaceProjection.ts` builds
it, in the same module the served object is projected in.

On the way back in, an import reads that object's user-writable members only
under an invocation of the Space's root capability. That is decided off the
verified result (`verifiedRootInvocation` in `zcap.ts`): a dereferenced chain of
one link is the synthesized root alone. An import skips them under a delegated
chain. It never restores a server-derived member or `controller`.

`name` is restored when the archive carries one, by the same write Update Space
Metadata makes. An archive without a `name` leaves the destination's in place.
`type` is immutable once a Space exists, so it is checked rather than applied.
An archive naming a different set of types than the destination's is refused as
`invalid-import` (400) before anything is written. An archive whose `type`
breaks the shape rule Update Space enforces is treated as carrying none.

An entry that does not parse as a JSON object is treated as absent, so the rest
of the archive still imports. The outcome is the `spaceMetadata` member of the
returned `ImportStats`. Its value is `'restored'`, `'skipped'` (a delegated
chain, or a Space with no stored object to apply the entry over), or `'absent'`
when the archive carried no such entry.

## Collection tombstones in an archive

Export writes a tombstone as `.collection.<id>.json` directly in the archive's
Space directory, with no Collection directory, and the codec flags it on the
manifest. Members a delete cut short left on disk do not travel. How a tombstone
is stored is described in [filesystem-layout.md](filesystem-layout.md).

Import plans a tombstone apart from the live Collections. It refuses an archive
holding one id both ways as `invalid-import` (400). It writes the tombstone only
when the destination holds no record under the id, live or tombstoned. It keeps
the archived generation and takes a stamp from the importing store's clock.
`ImportStats` does not count it.

A live archived Collection imported over a destination tombstone also keeps its
archived generation, as every imported record does. It is the one create over a
tombstone that does not mint a new generation, and its stamp still sorts above
the tombstone's. An archive with a `deleted: true` body inside a Collection
directory is refused as `invalid-import` (400).

## The import plan's checks

The plan builder (`lib/importTar.ts`) applies to an archived Collection Metadata
object the shape check a Collection Metadata write applies. It uses the same
parser (`parseCollectionMetadataBody` in `lib/collectionMetadataBody.ts`). The
members checked are `name`, `encryption`, `plaintext`, `generator`, `revisions`
and `epoch`, and then the `plaintext` and `encryption` exclusion. A member added
to the live write's shape check is checked on import too. The `revisions`
transition against the archived log is checked apart, as described in
[governed-logs-and-revisions.md](governed-logs-and-revisions.md).

An archived policy file must name a non-empty string `type`, as Update Policy
requires. A Collection whose archive carries a governing log may carry neither
`encryption` nor `plaintext` on its Metadata object, the rule a log's guarded
create applies. A break of any of these refuses the import as `invalid-import`
(400) before anything is written.

The envelope check over the archived Resources derives the effective
`encryption` the way `getCollectionOrThrow` does, the governing log's head
first. Where the Collection exists at the destination, it uses the destination
Collection's stored log, else its Metadata object. Where the import creates the
Collection, it uses the archived log's head, else the archived object. A stored
log is read through `parseStoredGoverningLog`, the reader
`deriveGovernedDescriptors` uses, so a log that does not parse is a
`StorageError` (500) on both paths. An import into or of a log-governed
Collection therefore checks its Resources as a live write is checked.

## Archived revocations

The archive carries the Space-scoped zcap revocation records. Import Space
installs them last, one by one through `insertRevocation`, after the backend's
`importSpace` has written the rest of the archive. A chain may carry a link
signed by a `did:webvh` whose history log the archive itself restores, so a
chain verified before that write would not resolve. The restored data is
therefore readable before its revocations land.

On a restore into a server that holds no record of a revocation, a revoked grant
whose chain still verifies can read for the moment the installation takes. It
can read for longer when the request dies between the two phases. Importing the
same archive again closes that gap: the data import skips what the destination
holds, and so does the revocation install.

Each record passes two checks. First, its capability chain verifies under the
destination Space, through the same `verifyRevocationChain` the revocation route
runs. Second, the import's own invocation could have submitted that revocation
on the route, under the route's dual-root rule. This second check stops a holder
of a Space-subtree `POST` grant from installing arbitrary
`(delegator, capabilityId)` records.

Under the dual-root rule, a root invocation is the Space controller's and may
revoke anything delegated from the Space. An invoker the verified chain names as
a controller may revoke its own grant or one below it. A delegated capability
may revoke when its target reaches the revocation URL by the zcap library's
attenuation rule with `POST` among its actions. A `POST` grant on the whole
Space does so, and a `POST` grant on the import URL alone does not. The
invocation's facts come off the verified result (`verifiedInvocation` in
`zcap.ts`), not off the header.

The record's `meta` is rebuilt server-side: the delegator from the proof, the
destination Space's URL as `rootTarget`, `created` now, and `expires` the
capability's plus one day (the shared `revocationRecordFor`).

A record that fails either check, or names a root capability, is skipped with
one `warn` line and the import goes on. A revocation is a fact about a chain
rooted in a Space URL. A chain that does not root in the destination Space could
not be invoked there. An unverifiable record is also what a forged archive would
carry, and there is no un-revoke. A record whose capability has already expired
is skipped with no log line and no verification, since the chain could not
verify and the record would reach its GC horizon within a day. So is a second
record of one capability, and one the store already holds. Any other error the
verifier raises over an archived record is a skip too. A server-side fault met
while verifying or storing is thrown as its 5xx.

The plan builder reads only each record's `capability` (`archivedRevocations`).
It refuses an archive carrying more than `IMPORT_MAX_REVOCATIONS` records as
`invalid-import` (400), since each one costs a chain verification.

A revocation whose chain's first link was signed by a `did:webvh` controller is
restored only into a Space that already carries that controller, since the chain
roots in the destination's controller. A restore of a promoted Space therefore
puts the log back and promotes the Space before it imports. See
[webvh-controllers.md](webvh-controllers.md) for promotion.
