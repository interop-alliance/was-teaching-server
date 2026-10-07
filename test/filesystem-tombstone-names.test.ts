/**
 * The filesystem backend keeps a Resource tombstone under its own name,
 * `.tombstone.<id>.json`, beside the live sidecar's `.meta.<id>.json` (Vitest,
 * backend level, no server). Liveness is then in the directory listing: the
 * Collection listing's `totalItems` and the Resource count quota count the
 * ids with a live sidecar name and a representation file, opening no sidecar
 * outside the page. A crash between the two steps of a delete or a re-create
 * leaves both names, which every path resolves to the body with the higher
 * `feedPosition`, and the next write or delete of the id clears. The count
 * quota shares one measurement between creates that find its cache entry
 * expired at the same time.
 */
import { it, describe, beforeEach, afterEach, vi } from 'vitest'
import assert from 'node:assert'
import fs from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { fileNameFor, metaSidecarFileName } from '@interop/space-archive'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { QUOTA_USAGE_CACHE_TTL } from '../src/config.default.js'
import { extractTarEntries } from '../src/lib/importTar.js'
import { tombstoneSidecarFileName } from '../src/lib/metaSidecar.js'
import { ResourceNotFoundError } from '../src/errors.js'

const controller = 'did:key:z6MkTombstoneNamesTestController'
const spaceId = 'tombstone-names'
const collectionId = 'docs'

describe('FileSystemBackend: Resource tombstones under their own name', () => {
  let dataDir: string
  let backend: FileSystemBackend
  let collectionDir: string

  /**
   * Opens the backend over `dataDir`, closing any open one first, so no
   * cached quota figure carries over.
   * @returns {Promise<void>}
   */
  async function reopen(): Promise<void> {
    await backend.close()
    backend = await FileSystemBackend.open({
      dataDir,
      maxResourcesPerSpace: 1000
    })
  }

  /**
   * Writes a JSON Resource.
   * @param resourceId {string}
   * @returns {Promise<void>}
   */
  async function writeJson(resourceId: string): Promise<void> {
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId,
      input: {
        kind: 'json',
        contentType: 'application/json',
        data: { id: resourceId }
      }
    })
  }

  /**
   * The path of a file in the Collection dir.
   * @param fileName {string}
   * @returns {string}
   */
  function inCollection(fileName: string): string {
    return path.join(collectionDir, fileName)
  }

  /**
   * Leaves the state a crash between the steps of a delete leaves: the
   * tombstone written, the live sidecar and its file still in place.
   * @param resourceId {string}
   * @returns {Promise<void>}
   */
  async function crashInsideDelete(resourceId: string): Promise<void> {
    const representation = fileNameFor({
      resourceId,
      contentType: 'application/json'
    })
    const sidecar = await readFile(
      inCollection(metaSidecarFileName(resourceId))
    )
    const bytes = await readFile(inCollection(representation))
    await backend.deleteResource({ spaceId, collectionId, resourceId })
    await writeFile(inCollection(metaSidecarFileName(resourceId)), sidecar)
    await writeFile(inCollection(representation), bytes)
  }

  /**
   * Leaves the state a crash between the steps of a re-create over a
   * tombstone leaves: the new live sidecar written, the tombstone still in
   * place.
   * @param resourceId {string}
   * @returns {Promise<void>}
   */
  async function crashInsideRecreate(resourceId: string): Promise<void> {
    await backend.deleteResource({ spaceId, collectionId, resourceId })
    const tombstone = await readFile(
      inCollection(tombstoneSidecarFileName(resourceId))
    )
    await writeJson(resourceId)
    await writeFile(
      inCollection(tombstoneSidecarFileName(resourceId)),
      tombstone
    )
  }

  /**
   * The sidecar names the Collection dir holds for one id.
   * @param resourceId {string}
   * @returns {Promise<string[]>}
   */
  async function sidecarNamesOf(resourceId: string): Promise<string[]> {
    const names = new Set([
      metaSidecarFileName(resourceId),
      tombstoneSidecarFileName(resourceId)
    ])
    return (await readdir(collectionDir)).filter(name => names.has(name)).sort()
  }

  /**
   * Counts the sidecar reads `run` makes, by id, through the backend's one
   * sidecar read.
   * @param run {() => Promise<void>}
   * @returns {Promise<string[]>}   the id of each read, in call order
   */
  async function sidecarReadsDuring(
    run: () => Promise<void>
  ): Promise<string[]> {
    const reads: string[] = []
    const read = backend.readMetaSidecar.bind(backend)
    vi.spyOn(backend, 'readMetaSidecar').mockImplementation(async options => {
      reads.push(options.resourceId)
      return read(options)
    })
    try {
      await run()
    } finally {
      vi.restoreAllMocks()
    }
    return reads
  }

  /**
   * The `deleted` flag of each changes-feed document of one Resource, from
   * the start of the feed.
   * @param resourceId {string}
   * @returns {Promise<boolean[]>}
   */
  async function feedDeletedFlagsOf(resourceId: string): Promise<boolean[]> {
    const { documents } = await backend.changesSince({
      spaceId,
      collectionId,
      afterPosition: 0,
      limit: 100
    })
    return documents.flatMap(document =>
      document.kind === 'resource' && document.resourceId === resourceId
        ? [document.deleted]
        : []
    )
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-tombstone-names-'))
    collectionDir = path.join(dataDir, 'spaces', spaceId, collectionId)
    backend = await FileSystemBackend.open({
      dataDir,
      maxResourcesPerSpace: 1000
    })
    await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: { id: collectionId, type: ['Collection'] }
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('stores a tombstone as .tombstone.<id>.json, a dotted id included', async () => {
    await writeJson('index.html')
    await backend.deleteResource({
      spaceId,
      collectionId,
      resourceId: 'index.html'
    })
    assert.deepEqual(await sidecarNamesOf('index.html'), [
      tombstoneSidecarFileName('index.html')
    ])
    const tombstone = JSON.parse(
      await readFile(
        inCollection(tombstoneSidecarFileName('index.html')),
        'utf8'
      )
    )
    assert.equal(tombstone.deleted, true)
    assert.equal(typeof tombstone.feedPosition, 'number')
    assert.equal(tombstone.fileName, undefined)
    assert.deepEqual(
      (await readdir(collectionDir)).filter(name => name.startsWith('r.')),
      []
    )

    // A re-create writes the live sidecar and removes the tombstone.
    await writeJson('index.html')
    assert.deepEqual(await sidecarNamesOf('index.html'), [
      metaSidecarFileName('index.html')
    ])
  })

  it('lists a Collection larger than a page with totalItems exact, reading no sidecar outside the page', async () => {
    const ids = Array.from(
      { length: 25 },
      (_, index) => `doc-${String(index).padStart(2, '0')}`
    )
    for (const resourceId of ids) {
      await writeJson(resourceId)
    }
    // Outside the first page: a tombstone with the file a delete cut short
    // left beside it, a file with no sidecar, and a re-create cut short
    // (both names, the live one newer).
    await crashInsideDelete('doc-20')
    await rm(inCollection(metaSidecarFileName('doc-20')))
    await writeFile(
      inCollection(
        fileNameFor({ resourceId: 'doc-99', contentType: 'application/json' })
      ),
      '{}'
    )
    await crashInsideRecreate('doc-15')

    let totalItems = 0
    let pageIds: string[] = []
    const reads = await sidecarReadsDuring(async () => {
      const page = await backend.listCollectionItems({
        spaceId,
        collectionId,
        limit: 10
      })
      totalItems = page.totalItems
      pageIds = page.items.map(item => item.id.split('/').pop()!)
    })
    assert.deepEqual(pageIds, ids.slice(0, 10))
    // 25 written, one deleted; the file with no sidecar does not count.
    assert.equal(totalItems, 24)
    // The page and the one extra entry that tells a next page follows, plus
    // the one id outside the page that holds both names.
    assert.deepEqual(reads.sort(), [...ids.slice(0, 11), 'doc-15'].sort())
  })

  it('the count quota on a create reads no sidecar', async () => {
    for (const resourceId of ['a', 'b', 'c']) {
      await writeJson(resourceId)
    }
    await backend.deleteResource({ spaceId, collectionId, resourceId: 'b' })
    // A fresh backend holds no cached count, so the create measures.
    await reopen()
    const reads = await sidecarReadsDuring(() => writeJson('fresh'))
    // Only the create's own read of the id it writes.
    assert.ok(reads.length > 0)
    assert.ok(reads.every(resourceId => resourceId === 'fresh'))
  })

  it('two creates racing an expired count cache entry run one measurement', async () => {
    await writeJson('seed')
    const spaceDir = path.join(dataDir, 'spaces', spaceId)
    // Expire the entry the seed's create cached.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + QUOTA_USAGE_CACHE_TTL + 1)
    // The measurement enumerates the Space dir; hold its first listing long
    // enough for the second create to arrive while it runs.
    const listDir = fs.promises.readdir.bind(fs.promises)
    let measurements = 0
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (
      dir: fs.PathLike,
      options?: unknown
    ) => {
      if (dir === spaceDir) {
        measurements++
        if (measurements === 1) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      return listDir(dir, options as any)
    }) as typeof fs.promises.readdir)
    await Promise.all([writeJson('first'), writeJson('second')])
    vi.restoreAllMocks()
    assert.equal(measurements, 1)
    const listing = await backend.listCollectionItems({ spaceId, collectionId })
    assert.equal(listing.totalItems, 3)
  })

  it('a delete cut short resolves to its tombstone, and the next write clears the stale sidecar', async () => {
    await writeJson('keep')
    await writeJson('torn')
    await crashInsideDelete('torn')
    assert.deepEqual(await sidecarNamesOf('torn'), [
      metaSidecarFileName('torn'),
      tombstoneSidecarFileName('torn')
    ])

    await assert.rejects(
      backend.getResource({ spaceId, collectionId, resourceId: 'torn' }),
      ResourceNotFoundError
    )
    assert.equal(
      await backend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId: 'torn'
      }),
      undefined
    )
    const listing = await backend.listCollectionItems({ spaceId, collectionId })
    assert.deepEqual(
      listing.items.map(item => item.id.split('/').pop()),
      ['keep']
    )
    assert.equal(listing.totalItems, 1)
    assert.deepEqual(await feedDeletedFlagsOf('torn'), [true])

    // Export carries the id once, as its tombstone, under the live
    // sidecar's name, as an archive always has.
    const entries = await extractTarEntries(
      await backend.exportSpace({ spaceId })
    )
    const names = [...entries.keys()].map(name => path.basename(name))
    assert.ok(names.every(name => !name.startsWith('.tombstone.')))
    const archived = [...entries].flatMap(([name, entry]) =>
      path.basename(name) === metaSidecarFileName('torn') ? [entry] : []
    )
    assert.equal(archived.length, 1)
    assert.equal(JSON.parse(String(archived[0]?.body)).deleted, true)
    assert.ok(
      !names.includes(
        fileNameFor({ resourceId: 'torn', contentType: 'application/json' })
      )
    )

    // The re-create writes the live sidecar and removes the tombstone, and
    // reclaims nothing it names.
    await writeJson('torn')
    assert.deepEqual(await sidecarNamesOf('torn'), [
      metaSidecarFileName('torn')
    ])
    const read = await backend.getResource({
      spaceId,
      collectionId,
      resourceId: 'torn'
    })
    read.resourceStream.destroy()
  })

  it('a re-create cut short resolves to its live sidecar, and the next delete clears the stale tombstone', async () => {
    await writeJson('torn')
    await crashInsideRecreate('torn')
    assert.deepEqual(await sidecarNamesOf('torn'), [
      metaSidecarFileName('torn'),
      tombstoneSidecarFileName('torn')
    ])

    const metadata = await backend.getResourceMetadata({
      spaceId,
      collectionId,
      resourceId: 'torn'
    })
    assert.equal(metadata?.contentType, 'application/json')
    const listing = await backend.listCollectionItems({ spaceId, collectionId })
    assert.equal(listing.totalItems, 1)
    assert.deepEqual(await feedDeletedFlagsOf('torn'), [false])

    // Export carries the id once, as its live sidecar.
    const entries = await extractTarEntries(
      await backend.exportSpace({ spaceId })
    )
    const archived = [...entries].flatMap(([name, entry]) =>
      path.basename(name) === metaSidecarFileName('torn') ? [entry] : []
    )
    assert.equal(archived.length, 1)
    assert.equal(JSON.parse(String(archived[0]?.body)).deleted, undefined)

    await backend.deleteResource({ spaceId, collectionId, resourceId: 'torn' })
    assert.deepEqual(await sidecarNamesOf('torn'), [
      tombstoneSidecarFileName('torn')
    ])
  })

  it('a content write over a re-create cut short clears the stale tombstone', async () => {
    await writeJson('torn')
    await crashInsideRecreate('torn')
    await writeJson('torn')
    assert.deepEqual(await sidecarNamesOf('torn'), [
      metaSidecarFileName('torn')
    ])
  })

  it('a damaged tombstone beside a live sidecar is read as absent, and the next write removes it', async () => {
    await writeJson('doc')
    await writeFile(inCollection(tombstoneSidecarFileName('doc')), '{not json')
    const read = await backend.getResource({
      spaceId,
      collectionId,
      resourceId: 'doc'
    })
    read.resourceStream.destroy()
    const listing = await backend.listCollectionItems({ spaceId, collectionId })
    assert.deepEqual(
      listing.items.map(item => item.id.split('/').pop()),
      ['doc']
    )
    assert.equal(listing.totalItems, 1)
    await writeJson('doc')
    assert.deepEqual(await sidecarNamesOf('doc'), [metaSidecarFileName('doc')])
  })

  it('a damaged live sidecar beside a tombstone is read as deleted, and a lone damaged one still fails', async () => {
    await writeJson('doc')
    await backend.deleteResource({ spaceId, collectionId, resourceId: 'doc' })
    await writeFile(inCollection(metaSidecarFileName('doc')), '{not json')
    await assert.rejects(
      backend.getResource({ spaceId, collectionId, resourceId: 'doc' }),
      ResourceNotFoundError
    )
    assert.deepEqual(await feedDeletedFlagsOf('doc'), [true])
    // The re-create overwrites the damaged name and removes the tombstone.
    await writeJson('doc')
    assert.deepEqual(await sidecarNamesOf('doc'), [metaSidecarFileName('doc')])

    await writeJson('lone')
    await writeFile(inCollection(metaSidecarFileName('lone')), '{not json')
    await assert.rejects(
      backend.getResource({ spaceId, collectionId, resourceId: 'lone' }),
      SyntaxError
    )
  })

  it('a planted file beside a tombstone is neither listed nor counted', async () => {
    await writeJson('live')
    await writeJson('gone')
    await backend.deleteResource({ spaceId, collectionId, resourceId: 'gone' })
    await writeFile(
      inCollection(
        fileNameFor({ resourceId: 'gone', contentType: 'text/plain' })
      ),
      'left behind'
    )
    await reopen()
    const listing = await backend.listCollectionItems({ spaceId, collectionId })
    assert.deepEqual(
      listing.items.map(item => item.id.split('/').pop()),
      ['live']
    )
    assert.equal(listing.totalItems, 1)
    // The count quota agrees: with room for exactly two, one more fits and a
    // second does not.
    await backend.close()
    backend = await FileSystemBackend.open({ dataDir, maxResourcesPerSpace: 2 })
    await writeJson('another')
    await assert.rejects(writeJson('one-too-many'))
  })
})
