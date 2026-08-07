/**
 * Backend-agnostic packer for a Space export archive: turns an ordered entry
 * tree into the UBC v0.1 tarball (`manifest.yml`, the `space/<spaceId>/` tree,
 * and the top-level `revocations/` block). Both storage backends describe the
 * same archive dialect -- the filesystem backend's on-disk file names, built by
 * `resourceFileName.ts` -- so an archive exported from one imports into the
 * other; this module is the single home for the packing itself, and it derives
 * the manifest from the very tree it packs so the two can never drift apart.
 *
 * Byte acquisition is the only thing that differs per backend, so a file entry
 * either carries its `bytes` inline (small JSON dot-files) or a `read()` thunk
 * called at pack time (a Resource representation or a chunk, fetched one at a
 * time so an export never holds a whole Space in memory). Entry ORDER is the
 * caller's: the packer walks the tree exactly as given.
 */
import * as tar from 'tar-stream'
import YAML from 'yaml'
import type { Readable } from 'node:stream'
import { buildExportManifest, EXPORT_ENTRY_MTIME } from './exportManifest.js'

/**
 * One file in an export archive: its bytes inline, or a `read()` thunk resolved
 * at pack time.
 */
export type ArchiveFile = { name: string } & (
  { bytes: Buffer } | { read: () => Promise<Buffer> }
)

/**
 * One directory in an export archive (a Collection dir, or a Resource's
 * `.chunks.<encId>/` subdirectory), holding its entries in archive order.
 */
export interface ArchiveDirectory {
  name: string
  files: ArchiveEntry[]
}

/** Either kind of archive entry, at any level of the tree. */
export type ArchiveEntry = ArchiveFile | ArchiveDirectory

/**
 * Resolves one file entry's bytes, calling its `read()` thunk only when the
 * bytes are not carried inline.
 * @param file {ArchiveFile}
 * @returns {Promise<Buffer>}
 */
async function archiveFileBytes(file: ArchiveFile): Promise<Buffer> {
  return 'bytes' in file ? file.bytes : await file.read()
}

/**
 * Flattens a directory's entries into the relative paths the manifest lists,
 * in tree order: a nested directory (a chunk directory) expands to its
 * `<dirName>/<fileName>` children, mirroring the pack order below.
 * @param entries {ArchiveEntry[]}
 * @returns {string[]}
 */
function flattenEntryNames(entries: ArchiveEntry[]): string[] {
  return entries.flatMap(entry =>
    'files' in entry
      ? flattenEntryNames(entry.files).map(name => `${entry.name}/${name}`)
      : [entry.name]
  )
}

/**
 * Packs one directory: its own directory entry, then each child (recursing into
 * a nested chunk directory).
 * @param options {object}
 * @param options.pack {tar.Pack}
 * @param options.target {string}   the directory's archive path (no trailing slash)
 * @param options.entries {ArchiveEntry[]}
 * @returns {Promise<void>}
 */
async function packDirectory({
  pack,
  target,
  entries
}: {
  pack: tar.Pack
  target: string
  entries: ArchiveEntry[]
}): Promise<void> {
  const mtime = EXPORT_ENTRY_MTIME
  pack.entry({ name: `${target}/`, type: 'directory', mtime })
  for (const entry of entries) {
    if ('files' in entry) {
      await packDirectory({
        pack,
        target: `${target}/${entry.name}`,
        entries: entry.files
      })
      continue
    }
    pack.entry(
      { name: `${target}/${entry.name}`, mtime },
      await archiveFileBytes(entry)
    )
  }
}

/**
 * Packs a Space export archive from the caller's ordered entry tree: the
 * `manifest.yml` describing it, the `space/` and `space/<spaceId>/` directory
 * entries, every top-level entry (a Space-level file, or a Collection directory
 * with its files and chunk directories), then the Space-scoped zcap revocations
 * under a top-level `revocations/` dir.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.entries {ArchiveEntry[]}   the Space's top-level entries, in
 *   the order they are packed (the manifest mirrors it)
 * @param [options.revocations] {ArchiveFile[]}   the Space's zcap revocation
 *   records; no `revocations/` block is emitted when there are none
 * @returns {Promise<Readable>}   the tar-stream pack
 */
export async function packSpaceArchive({
  spaceId,
  entries,
  revocations = []
}: {
  spaceId: string
  entries: ArchiveEntry[]
  revocations?: ArchiveFile[]
}): Promise<Readable> {
  const manifest = buildExportManifest({
    spaceId,
    entries: entries.map(entry =>
      'files' in entry
        ? { name: entry.name, files: flattenEntryNames(entry.files) }
        : { name: entry.name }
    ),
    revocationFiles: revocations.map(file => file.name)
  })

  // Fixed mtime on every entry so the archive is byte-reproducible (see
  // EXPORT_ENTRY_MTIME).
  const mtime = EXPORT_ENTRY_MTIME
  const pack = tar.pack()
  pack.entry({ name: 'manifest.yml', mtime }, YAML.stringify(manifest))
  pack.entry({ name: 'space/', type: 'directory', mtime })
  pack.entry({ name: `space/${spaceId}/`, type: 'directory', mtime })

  for (const entry of entries) {
    const entryTarget = `space/${spaceId}/${entry.name}`
    if ('files' in entry) {
      await packDirectory({ pack, target: entryTarget, entries: entry.files })
      continue
    }
    pack.entry({ name: entryTarget, mtime }, await archiveFileBytes(entry))
  }

  if (revocations.length > 0) {
    pack.entry({ name: 'revocations/', type: 'directory', mtime })
    for (const file of revocations) {
      pack.entry(
        { name: `revocations/${file.name}`, mtime },
        await archiveFileBytes(file)
      )
    }
  }

  pack.finalize()
  return pack
}
