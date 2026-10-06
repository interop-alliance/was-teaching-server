/**
 * Enumerations follow the sidecar (Vitest, backend level, no server). A
 * representation file no live sidecar names is left behind by a crash: a
 * write torn before its sidecar, a delete torn after its tombstone, or a
 * content-type change torn before it removed the prior file. Reads already
 * ignore such a file, and so must every path that lists a directory: the
 * Collection listing, the Resource count quota, the changes feed, export,
 * the equality query, and the chunk listing.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { chunkDirName, fileNameFor } from '@interop/space-archive'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { extractTarEntries } from '../src/lib/importTar.js'

const controller = 'did:key:z6MkOrphanFilesTestController'
const spaceId = 'orphan-space'
const collectionId = 'docs'

/**
 * A text body as a binary write input.
 * @param text {string}
 * @returns {{ kind: 'binary', contentType: string, stream: Readable }}
 */
function textInput(text: string): {
  kind: 'binary'
  contentType: string
  stream: Readable
} {
  return {
    kind: 'binary',
    contentType: 'text/plain',
    stream: Readable.from([Buffer.from(text)])
  }
}

describe('FileSystemBackend: enumerations ignore files no live sidecar names', () => {
  let dataDir: string
  let backend: FileSystemBackend
  let collectionDir: string

  /**
   * Writes a JSON Resource.
   * @param options {object}
   * @param options.resourceId {string}
   * @param options.data {object}
   * @returns {Promise<void>}
   */
  async function writeJson({
    resourceId,
    data
  }: {
    resourceId: string
    data: Record<string, unknown>
  }): Promise<void> {
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId,
      input: { kind: 'json', contentType: 'application/json', data }
    })
  }

  /**
   * Puts a JSON file on disk under the name a Resource of that id would have,
   * with no sidecar change: the file a crash leaves behind.
   * @param options {object}
   * @param options.dir {string}
   * @param options.resourceId {string}
   * @returns {Promise<string>}   the file's name
   */
  async function plantOrphan({
    dir,
    resourceId
  }: {
    dir: string
    resourceId: string
  }): Promise<string> {
    const fileName = fileNameFor({
      resourceId,
      contentType: 'application/json'
    })
    await writeFile(path.join(dir, fileName), JSON.stringify({ tag: 'x' }))
    return fileName
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-orphan-'))
    // Room for the three Resources the setup writes, plus one more.
    backend = await FileSystemBackend.open({
      dataDir,
      maxResourcesPerSpace: 3
    })
    collectionDir = path.join(dataDir, 'spaces', spaceId, collectionId)
    await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: { id: collectionId, type: ['Collection'] }
    })

    // One healthy Resource.
    await writeJson({ resourceId: 'live', data: { tag: 'x' } })
    // A delete torn after its tombstone: the file is back beside it.
    await writeJson({ resourceId: 'gone', data: { tag: 'x' } })
    await backend.deleteResource({ spaceId, collectionId, resourceId: 'gone' })
    await plantOrphan({ dir: collectionDir, resourceId: 'gone' })
    // A content-type change torn before it removed the prior file.
    await writeJson({ resourceId: 'doc', data: { tag: 'x' } })
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'doc',
      input: textInput('now text')
    })
    await plantOrphan({ dir: collectionDir, resourceId: 'doc' })
    // A write torn before its sidecar.
    await plantOrphan({ dir: collectionDir, resourceId: 'torn' })

    // Reopen, so no cached quota figure predates the orphans.
    await backend.close()
    backend = await FileSystemBackend.open({
      dataDir,
      maxResourcesPerSpace: 3
    })
  })

  afterEach(async () => {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('the Collection listing shows live Resources only, and counts each id once from file names', async () => {
    const listing = await backend.listCollectionItems({
      spaceId,
      collectionId
    })
    assert.deepEqual(
      listing.items.map(item => [item.id.split('/').pop(), item.contentType]),
      [
        ['doc', 'text/plain'],
        ['live', 'application/json']
      ]
    )
    // The count reads no sidecar: `doc` counts once for its two files, the
    // sidecarless `torn` not at all, and `gone`, whose delete was cut short
    // beside its old file, still counts, though no page lists it.
    assert.equal(listing.totalItems, 3)
  })

  it('the Resource count quota counts live Resources only', async () => {
    // Two live Resources against a quota of three: one more fits. Counting
    // the orphans (four ids with files) would refuse it.
    await writeJson({ resourceId: 'new', data: { tag: 'y' } })
  })

  it('the changes feed reports the torn delete as a tombstone, and the torn type change by its new type', async () => {
    const { documents } = await backend.changesSince({
      spaceId,
      collectionId,
      afterPosition: 0,
      limit: 100
    })
    const resources = new Map(
      documents
        .filter(document => document.kind === 'resource')
        .map(document => [document.resourceId, document])
    )
    assert.deepEqual([...resources.keys()].sort(), ['doc', 'gone', 'live'])
    assert.equal(resources.get('gone')?.deleted, true)
    assert.equal(resources.get('doc')?.deleted, false)
    assert.equal(resources.get('doc')?.contentType, 'text/plain')
    assert.equal(resources.get('live')?.deleted, false)
  })

  it('export carries no orphan file', async () => {
    const entries = await extractTarEntries(
      await backend.exportSpace({ spaceId })
    )
    const representations = [...entries.keys()]
      .map(name => path.basename(name))
      .filter(name => name.startsWith('r.'))
      .sort()
    assert.deepEqual(
      representations,
      [
        fileNameFor({ resourceId: 'doc', contentType: 'text/plain' }),
        fileNameFor({ resourceId: 'live', contentType: 'application/json' })
      ].sort()
    )
  })

  it('the equality query matches live Resources only', async () => {
    const page = await backend.queryByEquality({
      spaceId,
      collectionId,
      query: { equals: [{ tag: 'x' }] },
      indexes: [{ name: 'tag', source: 'content', unique: false }]
    })
    assert.ok('documents' in page)
    assert.deepEqual(
      page.documents.map(document => document.id),
      ['live']
    )
  })

  it('a sidecar that does not parse leaves its Resource out of the listing instead of failing it', async () => {
    await writeFile(path.join(collectionDir, '.meta.live.json'), '{not json')
    const listing = await backend.listCollectionItems({
      spaceId,
      collectionId
    })
    assert.deepEqual(
      listing.items.map(item => item.id.split('/').pop()),
      ['doc']
    )
  })

  it('the chunk listing shows live chunks only', async () => {
    await backend.writeChunk({
      spaceId,
      collectionId,
      resourceId: 'live',
      chunkIndex: 0,
      input: { kind: 'json', contentType: 'application/json', data: {} }
    })
    await backend.writeChunk({
      spaceId,
      collectionId,
      resourceId: 'live',
      chunkIndex: 0,
      input: textInput('chunk')
    })
    const chunkDir = path.join(collectionDir, chunkDirName('live'))
    // The prior representation of chunk 0, and a chunk 1 torn before its
    // sidecar.
    await plantOrphan({ dir: chunkDir, resourceId: '0' })
    await plantOrphan({ dir: chunkDir, resourceId: '1' })

    const listing = await backend.listChunks({
      spaceId,
      collectionId,
      resourceId: 'live'
    })
    assert.equal(listing.count, 1)
    assert.deepEqual(
      listing.chunks.map(chunk => [chunk.index, chunk.contentType]),
      [[0, 'text/plain']]
    )
  })
})
