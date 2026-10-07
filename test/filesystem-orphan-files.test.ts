/**
 * Enumerations follow the sidecar (Vitest, backend level, no server). A
 * representation file no live sidecar names is left behind by a crash: a
 * write torn before its sidecar, a delete torn after its tombstone, or a
 * content-type change torn before it removed the prior file. Reads already
 * ignore such a file, and so must every path that lists a directory: the
 * Collection listing, the Resource count quota, the changes feed, export,
 * the equality query, and the chunk listing. Delete Chunk finds a chunk the
 * same way. A Resource whose sidecar does not parse is left out of every
 * one of these paths, the unique-claim scan included.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
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
    // The Resource count is exact, so it counts two ids after the setup: the
    // two live Resources, and not the tombstone beside its orphan. Room for
    // those, plus one more.
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

  it('the Collection listing shows live Resources only, and counts them', async () => {
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
    assert.equal(listing.totalItems, 2)
  })

  it('a page judged short by orphans is filled from past them, and totalItems stays exact', async () => {
    // Keyset order is doc, gone, live, torn; `gone` and `torn` are judged out.
    const first = await backend.listCollectionItems({
      spaceId,
      collectionId,
      limit: 1
    })
    assert.deepEqual(
      first.items.map(item => item.id),
      ['doc']
    )
    assert.ok(first.next !== undefined)
    assert.equal(first.totalItems, 2)
    const cursor = new URL(first.next, 'http://localhost').searchParams.get(
      'cursor'
    )
    assert.ok(cursor !== null)
    const second = await backend.listCollectionItems({
      spaceId,
      collectionId,
      limit: 1,
      cursor
    })
    assert.deepEqual(
      second.items.map(item => item.id),
      ['live']
    )
    assert.equal(second.next, undefined)
    assert.equal(second.totalItems, 2)
  })

  it('the Resource count quota counts live Resources only', async () => {
    // Two live Resources against a quota of three: one more fits. Counting
    // the tombstone beside its orphan, or the torn write's file, would refuse
    // it.
    await writeJson({ resourceId: 'new', data: { tag: 'y' } })
  })

  it('Delete Resource removes the file its sidecar named and the file a crash left beside it', async () => {
    // `doc` is live as text, with its prior JSON file beside it.
    await backend.deleteResource({ spaceId, collectionId, resourceId: 'doc' })
    const representationsOf = async (resourceId: string): Promise<string[]> =>
      (await readdir(collectionDir)).filter(name =>
        name.startsWith(`r.${resourceId}.`)
      )
    // Nothing of the id outlives the delete, so its bytes leave the byte
    // quota's walk with it.
    assert.deepEqual(await representationsOf('doc'), [])
    assert.ok((await readdir(collectionDir)).includes('.tombstone.doc.json'))
    assert.equal(
      (await backend.listCollectionItems({ spaceId, collectionId })).totalItems,
      1
    )
  })

  it('a re-create over the torn delete reclaims the file left beside its tombstone', async () => {
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'gone',
      input: textInput('back')
    })
    assert.deepEqual(
      (await readdir(collectionDir))
        .filter(name => name.startsWith('r.gone.'))
        .sort(),
      [fileNameFor({ resourceId: 'gone', contentType: 'text/plain' })]
    )
    assert.ok(!(await readdir(collectionDir)).includes('.tombstone.gone.json'))
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
    assert.equal(listing.totalItems, 1)
    assert.deepEqual(
      listing.items.map(item => item.id.split('/').pop()),
      ['doc']
    )
  })

  it('a sidecar that does not parse leaves its Resource out of the changes feed, which pages the rest', async () => {
    const sidecarPath = path.join(collectionDir, '.meta.live.json')
    const stored = await readFile(sidecarPath)
    await writeFile(sidecarPath, '{not json')
    // Page one document at a time to the end of the feed.
    const resourceIds: string[] = []
    let afterPosition = 0
    for (;;) {
      const { documents, checkpoint } = await backend.changesSince({
        spaceId,
        collectionId,
        afterPosition,
        limit: 1
      })
      if (documents.length === 0 || checkpoint === null) {
        break
      }
      for (const document of documents) {
        if (document.kind === 'resource') {
          resourceIds.push(document.resourceId)
        }
      }
      afterPosition = checkpoint
    }
    assert.deepEqual(resourceIds.sort(), ['doc', 'gone'])

    // Restoring the bytes by hand gives the Resource no new position, so a
    // reader at the end of the feed sees nothing new. The rewrite that
    // repairs it takes a fresh position, which the reader then gets.
    await writeFile(sidecarPath, stored)
    const caughtUp = await backend.changesSince({
      spaceId,
      collectionId,
      afterPosition,
      limit: 100
    })
    assert.deepEqual(caughtUp.documents, [])
    await writeJson({ resourceId: 'live', data: { tag: 'z' } })
    const repaired = await backend.changesSince({
      spaceId,
      collectionId,
      afterPosition,
      limit: 100
    })
    assert.deepEqual(
      repaired.documents.map(document =>
        document.kind === 'resource' ? document.resourceId : document.kind
      ),
      ['live']
    )
  })

  it('a sidecar that does not parse leaves its Resource out of a unique claim, and fails its own write', async () => {
    const sidecarPath = path.join(collectionDir, '.meta.live.json')
    await writeFile(sidecarPath, '{not json')
    // `live` holds `tag: x`, but its damaged sidecar leaves it out of the
    // scan, so the claim is admitted.
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'claimant',
      input: {
        kind: 'json',
        contentType: 'application/json',
        data: { tag: 'x' }
      },
      uniqueIndexes: [{ name: 'tag', source: 'content', unique: true }]
    })
    // The damaged Resource's own write still fails on it.
    await assert.rejects(writeJson({ resourceId: 'live', data: { tag: 'y' } }))
  })

  /**
   * Writes chunk 0 of the live Resource, and resolves its chunk dir.
   * @returns {Promise<string>}
   */
  async function writeLiveChunk(): Promise<string> {
    await backend.writeChunk({
      spaceId,
      collectionId,
      resourceId: 'live',
      chunkIndex: 0,
      input: textInput('chunk')
    })
    return path.join(collectionDir, chunkDirName('live'))
  }

  it('Delete Chunk answers absent for a chunk file with no sidecar, and leaves it', async () => {
    const chunkDir = await writeLiveChunk()
    const orphan = await plantOrphan({ dir: chunkDir, resourceId: '1' })
    assert.equal(
      await backend.deleteChunk({
        spaceId,
        collectionId,
        resourceId: 'live',
        chunkIndex: 1
      }),
      false
    )
    await access(path.join(chunkDir, orphan))
  })

  it('Delete Chunk reclaims every file of the index, and the emptied chunk dir', async () => {
    const chunkDir = await writeLiveChunk()
    // A type change cut short before its prune left the prior file beside
    // the live one.
    await plantOrphan({ dir: chunkDir, resourceId: '0' })
    assert.equal(
      await backend.deleteChunk({
        spaceId,
        collectionId,
        resourceId: 'live',
        chunkIndex: 0
      }),
      true
    )
    await assert.rejects(access(chunkDir))
  })

  it('Delete Chunk cut short after removing the sidecar answers absent when retried', async () => {
    const chunkDir = await writeLiveChunk()
    // The first delete got as far as the sidecar.
    await rm(path.join(chunkDir, '.meta.0.json'))
    assert.equal(
      await backend.deleteChunk({
        spaceId,
        collectionId,
        resourceId: 'live',
        chunkIndex: 0
      }),
      false
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
    const chunkDir = await writeLiveChunk()
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
