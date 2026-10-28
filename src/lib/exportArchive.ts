/**
 * Export Space across the server backends. Each backend builds the archive
 * entry tree of a Space from its own store (`exportSpaceEntries`); this
 * module packs one tree into the archive (`packExportArchive`, which both
 * backends' `exportSpace` call for a Space they hold whole) and composes the
 * tree of a Space whose Collections span several server backends
 * (`exportSpaceArchive`, which Export Space calls). The control plane's tree
 * carries every Space-level file and every Collection directory with its
 * Metadata object, policies and governing log; a Collection selecting
 * another server backend has its Resources, sidecars and chunk directories
 * taken from that backend's tree, less the copy of the Metadata object it
 * holds (lib/backendMirror.ts). The provenance statements are signed over
 * the composed tree, so each exported object gets one wherever it was read
 * from.
 */
import { Readable } from 'node:stream'
import {
  ARCHIVE_REVOCATIONS_DIR,
  collectionMetadataFileName,
  packSpaceArchive
} from '@interop/space-archive'
import type {
  ArchiveDirectory,
  ArchiveEntry,
  ArchiveFile
} from '@interop/space-archive'
import { SpaceNotFoundError } from '../errors.js'
import { attestArchiveEntries } from './exportProvenance.js'
import { parseJsonObjectBytes } from './jsonBytes.js'
import type { ExportAttestor } from './exportProvenance.js'
import type { ServerBackends } from './serverBackends.js'
import type { ServiceDescription, StorageBackend } from '../types.js'

/**
 * Packs an entry tree as the Space's export archive: one signed statement
 * per exported object when there is an attestor, then the tar stream.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.entries {ArchiveEntry[]}   the Space's top-level entries,
 *   in pack order
 * @param [options.service] {ServiceDescription}   written verbatim as the
 *   archive's `service.json`; absent when the caller had none to declare
 * @param [options.attestor] {ExportAttestor}   the server's signing
 *   identity; with one, the archive carries `provenance.jsonl` and the
 *   `did.jsonl` log snapshot
 * @returns {Promise<Readable>}
 */
export async function packExportArchive({
  spaceId,
  entries,
  service,
  attestor
}: {
  spaceId: string
  entries: ArchiveEntry[]
  service?: ServiceDescription
  attestor?: ExportAttestor
}): Promise<Readable> {
  const provenance =
    attestor === undefined
      ? undefined
      : await attestArchiveEntries({ spaceId, entries, attestor })
  // `packSpaceArchive` resolves a tar-stream `Pack`, a streamx readable;
  // Export Space hands its callers a Node `Readable`.
  const pack = await packSpaceArchive({
    spaceId,
    entries,
    service,
    provenance,
    didLog: attestor?.didLog
  })
  return Readable.from(pack)
}

/**
 * The `backend.id` an exported Collection directory's own Metadata file
 * names, read from the control plane's entry so the selection costs no second
 * read of the object. `undefined` for a directory with no such file, or one
 * that names none, which is the default.
 * @param options {object}
 * @param options.entry {ArchiveDirectory}   the Collection directory
 * @returns {Promise<string | undefined>}
 */
async function archivedBackendId({
  entry
}: {
  entry: ArchiveDirectory
}): Promise<string | undefined> {
  const metadataFile = entry.files.find(
    (file): file is ArchiveFile =>
      !('files' in file) && file.name === collectionMetadataFileName(entry.name)
  )
  if (metadataFile === undefined) {
    return undefined
  }
  const bytes =
    'bytes' in metadataFile ? metadataFile.bytes : await metadataFile.read()
  const { backend } = parseJsonObjectBytes(Buffer.from(bytes)) ?? {}
  const id = (backend as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Completes a Collection directory from the tree of the server backend its
 * Metadata object selects: the control plane's files, then the files only
 * that backend holds. The control plane's files win on a shared name, so the
 * Metadata object's copy stays behind. The directory itself when the
 * Collection selects the control plane, or the backend holds none of it.
 * @param options {object}
 * @param options.entry {ArchiveDirectory}   the control plane's directory
 * @param options.backend {StorageBackend | undefined}   the other server
 *   backend the Collection selects, if any
 * @param options.treeOf {(backend: StorageBackend) => Promise<ArchiveEntry[]>}
 * @returns {Promise<ArchiveDirectory>}
 */
async function completedFromBackend({
  entry,
  backend,
  treeOf
}: {
  entry: ArchiveDirectory
  backend: StorageBackend | undefined
  treeOf: (backend: StorageBackend) => Promise<ArchiveEntry[]>
}): Promise<ArchiveDirectory> {
  if (backend === undefined) {
    return entry
  }
  const held = (await treeOf(backend)).find(
    (candidate): candidate is ArchiveDirectory =>
      'files' in candidate && candidate.name === entry.name
  )
  if (held === undefined) {
    return entry
  }
  const names = new Set(entry.files.map(file => file.name))
  const metadataFile = collectionMetadataFileName(entry.name)
  const files = [
    ...entry.files,
    ...held.files.filter(
      file => file.name !== metadataFile && !names.has(file.name)
    )
  ].sort((left, right) => left.name.localeCompare(right.name))
  return { name: entry.name, files }
}

/**
 * Exports a Space whose Collections may span the server backends: the
 * control plane's tree, with each Collection directory of a Collection that
 * selects another server backend completed from that backend's tree.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param [options.service] {ServiceDescription}
 * @param [options.attestor] {ExportAttestor}
 * @returns {Promise<Readable>}
 * @throws {SpaceNotFoundError}   the control plane holds no such Space
 */
export async function exportSpaceArchive({
  serverBackends,
  spaceId,
  service,
  attestor
}: {
  serverBackends: ServerBackends
  spaceId: string
  service?: ServiceDescription
  attestor?: ExportAttestor
}): Promise<Readable> {
  const control = serverBackends.controlPlane
  const entries = await control.exportSpaceEntries({
    spaceId,
    serverBackends: serverBackends.describeAll()
  })
  // Each other backend's tree is read once, on the first Collection it
  // serves; a backend holding no copy of the Space serves none.
  const trees = new Map<StorageBackend, Promise<ArchiveEntry[]>>()
  const treeOf = (backend: StorageBackend): Promise<ArchiveEntry[]> => {
    let tree = trees.get(backend)
    if (tree === undefined) {
      tree = backend.exportSpaceEntries({ spaceId }).catch(err => {
        if (err instanceof SpaceNotFoundError) {
          return []
        }
        throw err
      })
      trees.set(backend, tree)
    }
    return tree
  }
  const composed: ArchiveEntry[] = []
  for (const entry of entries) {
    // A Space-level file, and the revocations directory, which only the
    // control plane holds, travel as they are.
    if (!('files' in entry) || entry.name === ARCHIVE_REVOCATIONS_DIR) {
      composed.push(entry)
      continue
    }
    const backend = serverBackends.resolveOther(
      await archivedBackendId({ entry })
    )
    composed.push(await completedFromBackend({ entry, backend, treeOf }))
  }
  return packExportArchive({ spaceId, entries: composed, service, attestor })
}
