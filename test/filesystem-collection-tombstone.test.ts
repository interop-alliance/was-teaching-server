/**
 * The filesystem backend's Collection tombstone layout and its resumable
 * delete cascade. Delete Collection replaces the Collection's Metadata file
 * with a tombstone first, then removes every other entry of the Collection
 * dir. A process killed in between leaves the tombstone beside members. Each
 * case sets that torn state up on disk directly (the tombstone written, the
 * old members copied back) and checks that boot, a read, a retried delete,
 * a re-create, and an import over the tombstone each finish the cascade, with
 * no old member readable under a re-created Collection. A directory left
 * without a Metadata file is no Collection, and a delete removes it whole.
 */
import { it, describe, beforeEach, afterEach, vi } from 'vitest'
import assert from 'node:assert'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { collectBytes } from '@interop/space-archive'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { importArchive } from './helpers.js'

const controller = 'did:key:z6MkTombstoneTestController'
const spaceId = 'tombstone-space'
const collectionId = 'notes'

describe('FileSystemBackend Collection tombstones', () => {
  let dataDir: string
  let backend: FileSystemBackend
  let collectionDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-tombstone-'))
    // One Collection and one Resource fill the count quotas, so a torn
    // cascade still counted would refuse the next create.
    backend = await FileSystemBackend.open({
      dataDir,
      maxCollectionsPerSpace: 1,
      maxResourcesPerSpace: 1
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
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'old',
      input: {
        kind: 'json',
        contentType: 'application/json',
        data: { life: 'old' }
      }
    })
    await backend.writePolicy({
      spaceId,
      collectionId,
      policy: { type: 'PublicCanRead' }
    })
  })

  afterEach(async () => {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /**
   * Deletes the Collection, then copies its old members back beside the
   * tombstone: the state a process killed mid-cascade leaves.
   */
  async function tearCascade(): Promise<void> {
    const saved = await mkdtemp(path.join(tmpdir(), 'was-tombstone-saved-'))
    try {
      await cp(collectionDir, saved, { recursive: true })
      assert.equal(
        await backend.deleteCollection({ spaceId, collectionId }),
        'deleted'
      )
      for (const name of await readdir(saved)) {
        if (name !== `.collection.${collectionId}.json`) {
          await cp(path.join(saved, name), path.join(collectionDir, name), {
            recursive: true
          })
        }
      }
    } finally {
      await rm(saved, { recursive: true, force: true })
    }
    assert.ok((await readdir(collectionDir)).length > 1)
  }

  it('keeps the tombstone as the Collection Metadata file, with only its marker, stamp and generation', async () => {
    const live = await backend.getCollectionMetadata({ spaceId, collectionId })
    await backend.deleteCollection({ spaceId, collectionId })
    assert.deepEqual(await readdir(collectionDir), [
      `.collection.${collectionId}.json`
    ])
    const stored = JSON.parse(
      await readFile(
        path.join(collectionDir, `.collection.${collectionId}.json`),
        'utf8'
      )
    )
    assert.deepEqual(Object.keys(stored).sort(), [
      '_generation',
      'deleted',
      'originId',
      'updatedAt',
      'updatedAtCounter'
    ])
    assert.equal(stored.deleted, true)
    assert.equal(stored._generation, live?.metaGeneration)
  })

  it('a torn cascade is not listed, read, or counted while it waits', async () => {
    await tearCascade()
    const listing = await backend.listCollections({ spaceId })
    assert.equal(listing.totalItems, 0)
    assert.deepEqual(listing.items, [])
    // Not counted by the usage breakdown.
    const usage = await backend.reportUsage({
      spaceId,
      includeCollections: true
    })
    assert.deepEqual(usage.usageByCollection, [])
    // Not counted by either count quota: a new Collection and a Resource in
    // it fit under limits of one.
    await backend.writeCollection({
      spaceId,
      collectionId: 'other',
      collectionMetadata: { id: 'other', type: ['Collection'] }
    })
    await backend.writeResource({
      spaceId,
      collectionId: 'other',
      resourceId: 'fresh',
      input: {
        kind: 'json',
        contentType: 'application/json',
        data: { life: 'new' }
      }
    })
    // Read as absent, its old Resource included.
    assert.equal(
      await backend.getCollectionMetadata({ spaceId, collectionId }),
      undefined
    )
    assert.equal(
      await backend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId: 'old'
      }),
      undefined
    )
  })

  it('boot finishes a torn cascade', async () => {
    await tearCascade()
    await backend.close()
    backend = await FileSystemBackend.open({ dataDir })
    assert.deepEqual(await readdir(collectionDir), [
      `.collection.${collectionId}.json`
    ])
  })

  it('a read of the Collection finishes a torn cascade', async () => {
    await tearCascade()
    assert.equal(
      await backend.getCollectionMetadata({ spaceId, collectionId }),
      undefined
    )
    assert.deepEqual(await readdir(collectionDir), [
      `.collection.${collectionId}.json`
    ])
  })

  it('a retried delete answers already-deleted and finishes a torn cascade', async () => {
    await tearCascade()
    assert.equal(
      await backend.deleteCollection({ spaceId, collectionId }),
      'already-deleted'
    )
    assert.deepEqual(await readdir(collectionDir), [
      `.collection.${collectionId}.json`
    ])
  })

  it('a re-create finishes a torn cascade before its new life starts', async () => {
    await tearCascade()
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: { id: collectionId, type: ['Collection'] },
      ifNoneMatch: '*'
    })
    assert.deepEqual(await readdir(collectionDir), [
      `.collection.${collectionId}.json`
    ])
    assert.equal(
      await backend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId: 'old'
      }),
      undefined
    )
    assert.equal(await backend.getPolicy({ spaceId, collectionId }), undefined)
    assert.deepEqual(
      (await backend.listCollectionItems({ spaceId, collectionId })).items,
      []
    )
  })

  it('an import over a torn tombstone finishes the cascade before the new life', async () => {
    const source = 'tombstone-source'
    await backend.writeSpace({
      spaceId: source,
      spaceMetadata: { id: source, type: ['Space'], controller }
    })
    await backend.writeCollection({
      spaceId: source,
      collectionId,
      collectionMetadata: { id: collectionId, type: ['Collection'] }
    })
    const archive = await collectBytes(
      await backend.exportSpace({ spaceId: source })
    )
    await tearCascade()
    const stats = await importArchive({
      backend,
      spaceId,
      tarStream: Readable.from([archive])
    })
    assert.equal(stats.collectionsCreated, 1)
    assert.deepEqual(await readdir(collectionDir), [
      `.collection.${collectionId}.json`
    ])
    assert.equal(
      await backend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId: 'old'
      }),
      undefined
    )
    assert.equal(await backend.getPolicy({ spaceId, collectionId }), undefined)
  })

  /**
   * Runs `action` once, right after the backend's first listing of `dir`
   * resolves, and hands the backend the listing taken before it. This lands
   * a write at a chosen point between two steps of one backend call.
   */
  function afterFirstListingOf(dir: string, action: () => Promise<void>): void {
    const readdir = fs.promises.readdir.bind(fs.promises) as (
      ...args: unknown[]
    ) => Promise<unknown>
    let fired = false
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (
      ...args: unknown[]
    ) => {
      const listing = await readdir(...args)
      if (!fired && args[0] === dir) {
        fired = true
        await action()
      }
      return listing
    }) as unknown as typeof fs.promises.readdir)
  }

  /**
   * Runs `run` against a second backend with no count quotas, over its own
   * data dir, holding one Space under `source`.
   */
  async function withUnlimitedBackend(
    run: (options: {
      unlimited: FileSystemBackend
      sourceDir: string
    }) => Promise<void>
  ): Promise<void> {
    const otherDir = await mkdtemp(path.join(tmpdir(), 'was-tombstone-export-'))
    const unlimited = await FileSystemBackend.open({ dataDir: otherDir })
    try {
      for (const id of [source, target]) {
        await unlimited.writeSpace({
          spaceId: id,
          spaceMetadata: { id, type: ['Space'], controller }
        })
      }
      await run({
        unlimited,
        sourceDir: path.join(otherDir, 'spaces', source)
      })
    } finally {
      vi.restoreAllMocks()
      await unlimited.close()
      await rm(otherDir, { recursive: true, force: true })
    }
  }

  const source = 'export-source'
  const target = 'export-target'
  const collectionMetadata = { id: collectionId, type: ['Collection'] }

  it('an export carries the tombstone it listed when a create lands before the pack', async () => {
    await withUnlimitedBackend(async ({ unlimited, sourceDir }) => {
      await unlimited.writeCollection({
        spaceId: source,
        collectionId,
        collectionMetadata
      })
      await unlimited.deleteCollection({ spaceId: source, collectionId })
      // A live Collection sorted after the tombstone: export lists its dir
      // once the tombstone is already in the entry tree.
      await unlimited.writeCollection({
        spaceId: source,
        collectionId: 'zzz',
        collectionMetadata: { id: 'zzz', type: ['Collection'] }
      })
      afterFirstListingOf(path.join(sourceDir, 'zzz'), async () => {
        await unlimited.writeCollection({
          spaceId: source,
          collectionId,
          collectionMetadata
        })
      })
      const archive = await collectBytes(
        await unlimited.exportSpace({ spaceId: source })
      )
      vi.restoreAllMocks()

      const stats = await importArchive({
        backend: unlimited,
        spaceId: target,
        tarStream: Readable.from([archive])
      })
      assert.equal(stats.collectionsCreated, 1)
      assert.equal(
        await unlimited.getCollectionMetadata({
          spaceId: target,
          collectionId
        }),
        undefined
      )
    })
  })

  it('an export carries the live Collection it listed when a delete lands before the pack', async () => {
    await withUnlimitedBackend(async ({ unlimited, sourceDir }) => {
      await unlimited.writeCollection({
        spaceId: source,
        collectionId,
        collectionMetadata
      })
      afterFirstListingOf(path.join(sourceDir, collectionId), async () => {
        await unlimited.deleteCollection({ spaceId: source, collectionId })
      })
      const archive = await collectBytes(
        await unlimited.exportSpace({ spaceId: source })
      )
      vi.restoreAllMocks()

      const stats = await importArchive({
        backend: unlimited,
        spaceId: target,
        tarStream: Readable.from([archive])
      })
      assert.equal(stats.collectionsCreated, 1)
      assert.ok(
        await unlimited.getCollectionMetadata({
          spaceId: target,
          collectionId
        })
      )
    })
  })

  it('a read racing a delete still running logs no interrupted-delete warning', async () => {
    await tearCascade()
    const warn = vi.spyOn(backend.logger, 'warn')
    // The read sees the tombstone beside members; the delete then removes
    // them before the read takes the Space gate.
    afterFirstListingOf(collectionDir, async () => {
      for (const name of await readdir(collectionDir)) {
        if (name !== `.collection.${collectionId}.json`) {
          await rm(path.join(collectionDir, name), { recursive: true })
        }
      }
    })
    try {
      assert.equal(
        await backend.getCollectionMetadata({ spaceId, collectionId }),
        undefined
      )
      assert.equal(warn.mock.calls.length, 0)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('a Metadata file that does not parse fails only the listing page that holds it', async () => {
    await backend.close()
    backend = await FileSystemBackend.open({
      dataDir,
      maxCollectionsPerSpace: 3,
      maxResourcesPerSpace: 5
    })
    await writeFile(
      path.join(collectionDir, `.collection.${collectionId}.json`),
      '{ not json'
    )

    // The count quotas still count it as a live Collection, so a create and
    // a Resource write elsewhere in the Space go through.
    await backend.writeCollection({
      spaceId,
      collectionId: 'other',
      collectionMetadata: { id: 'other', type: ['Collection'] }
    })
    await backend.writeResource({
      spaceId,
      collectionId: 'other',
      resourceId: 'fresh',
      input: {
        kind: 'json',
        contentType: 'application/json',
        data: { life: 'new' }
      }
    })

    // `aaa` sorts before `notes`, so a page of one does not hold the
    // unparseable Collection.
    await backend.writeCollection({
      spaceId,
      collectionId: 'aaa',
      collectionMetadata: { id: 'aaa', type: ['Collection'] }
    })
    const firstPage = await backend.listCollections({ spaceId, limit: 1 })
    assert.deepEqual(
      firstPage.items.map(item => item.id),
      ['aaa']
    )
    assert.equal(firstPage.totalItems, 3)
    await assert.rejects(backend.listCollections({ spaceId }), SyntaxError)
  })

  it('a delete of a directory left without a Metadata file removes it', async () => {
    const orphanDir = path.join(dataDir, 'spaces', spaceId, 'orphan')
    await mkdir(orphanDir)
    await writeFile(
      path.join(orphanDir, 'r.stray.application%2Fjson.json'),
      '{}'
    )
    assert.equal(
      await backend.deleteCollection({ spaceId, collectionId: 'orphan' }),
      'absent'
    )
    await assert.rejects(readdir(orphanDir), { code: 'ENOENT' })
  })
})
