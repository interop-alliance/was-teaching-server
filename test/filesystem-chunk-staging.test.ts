/**
 * The filesystem backend's chunk staging and swap (Vitest, backend level, no
 * server): `beginChunkStaging`, `stageChunk`, `listStagedChunks`,
 * `applyResource` with `chunks` and `reclaimStaging`, the boot reclaim that
 * finishes a torn swap, the removal of chunks and staging with a replicated
 * tombstone, and the quota and feed rules staging follows.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import path from 'node:path'
import { text } from 'node:stream/consumers'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { chunkDirName } from '@interop/space-archive'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { feedCounterFileName } from '../src/backends/filesystemStore.js'
import { QuotaExceededError } from '../src/errors.js'
import { openTempBackend } from '../src/testing.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import {
  binaryInput as sharedBinaryInput,
  frozenClock,
  pathExists,
  replicaRegistration
} from './helpers.js'
import type {
  ChunkStagingRun,
  ResourceInput,
  WriteStamp
} from '../src/types.js'

const spaceId = 'staging-space'
const collectionId = 'docs'
const resourceId = 'doc'
const replicaId = 'peer'

// A staged chunk declares its size, as a source server's response does.
function binaryInput(bytes: Buffer | string): ResourceInput {
  return sharedBinaryInput(bytes, { declaredBytes: Buffer.byteLength(bytes) })
}

const exists = pathExists

describe('FileSystemBackend: chunk staging and the swap', () => {
  const clock = frozenClock()
  let backend: TempFileSystemBackend
  let collectionDir: string
  const run: ChunkStagingRun = { replicaId, parentEtag: '"rev-b"' }

  // A source server stamp `offset` ms from the store's frozen physical time.
  function stampAt(offset: number): WriteStamp {
    return {
      updatedAt: new Date(clock.now + offset).toISOString(),
      updatedAtCounter: 0,
      originId: 'peer-origin'
    }
  }

  function stagingDir(id = resourceId): string {
    return path.join(collectionDir, `.staging${chunkDirName(id)}`)
  }

  function chunkDir(id = resourceId): string {
    return path.join(collectionDir, chunkDirName(id))
  }

  async function writeParentWithChunks(chunks: string[]): Promise<void> {
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId,
      input: binaryInput('parent-a')
    })
    for (const [index, body] of chunks.entries()) {
      await backend.writeChunk({
        spaceId,
        collectionId,
        resourceId,
        chunkIndex: index,
        input: binaryInput(body)
      })
    }
  }

  async function stage(
    chunkIndex: number,
    body: string | Buffer,
    options: { run?: ChunkStagingRun; id?: string } = {}
  ) {
    return backend.stageChunk({
      spaceId,
      replicaId,
      collectionId,
      resourceId: options.id ?? resourceId,
      run: options.run ?? run,
      chunkIndex,
      input: binaryInput(body),
      peerEtag: `"p${chunkIndex}"`
    })
  }

  async function applyWithChunks({
    stamp,
    staged,
    body = 'parent-b',
    target = backend
  }: {
    stamp: WriteStamp
    staged: number[]
    body?: string
    target?: FileSystemBackend
  }) {
    return target.applyResource({
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      generation: 'gen-b',
      stamp,
      resource: { deleted: false, input: binaryInput(body) },
      chunks: { run, staged }
    })
  }

  function runDir(of: ChunkStagingRun = run, id = resourceId): string {
    return path.join(
      stagingDir(id),
      of.replicaId,
      Buffer.from(of.parentEtag).toString('base64url')
    )
  }

  async function chunkBodies(
    target: FileSystemBackend = backend
  ): Promise<Record<number, string>> {
    const { chunks } = await target.listChunks({
      spaceId,
      collectionId,
      resourceId
    })
    const bodies: Record<number, string> = {}
    for (const { index } of chunks) {
      const { resourceStream } = await target.getChunk({
        spaceId,
        collectionId,
        resourceId,
        chunkIndex: index
      })
      bodies[index] = await text(resourceStream)
    }
    return bodies
  }

  async function parentBody(
    target: FileSystemBackend = backend
  ): Promise<string> {
    const { resourceStream } = await target.getResource({
      spaceId,
      collectionId,
      resourceId
    })
    return text(resourceStream)
  }

  beforeEach(async () => {
    backend = await openTempBackend({ physicalClock: clock.read })
    await backend.writeSpace({
      spaceId,
      spaceMetadata: {
        id: spaceId,
        type: ['Space'],
        controller: 'did:key:z6MkStagingTestController'
      }
    })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: { id: collectionId, type: ['Collection'] }
    })
    await backend.createReplica({
      spaceId,
      record: replicaRegistration({ id: replicaId, spaceId, collectionId }),
      pullsChunks: true
    })
    collectionDir = path.join(backend.dataDir, 'spaces', spaceId, collectionId)
  })

  afterEach(async () => {
    await backend.close()
  })

  it('swaps in the staged set, and removes the live chunks it does not list', async () => {
    await writeParentWithChunks(['a0', 'a1', 'a2'])
    const replacedBefore = await backend.getChunkMetadata({
      spaceId,
      collectionId,
      resourceId,
      chunkIndex: 1
    })
    assert.deepEqual(await stage(1, 'b1'), { outcome: 'applied' })
    assert.deepEqual(await stage(3, 'b3'), { outcome: 'applied' })
    // Nothing live changes until the swap.
    assert.deepEqual(await chunkBodies(), { 0: 'a0', 1: 'a1', 2: 'a2' })
    assert.equal(await parentBody(), 'parent-a')

    assert.deepEqual(
      await applyWithChunks({ stamp: stampAt(1000), staged: [1, 3] }),
      { outcome: 'applied' }
    )
    assert.deepEqual(await chunkBodies(), { 1: 'b1', 3: 'b3' })
    assert.equal(await parentBody(), 'parent-b')
    const parent = await backend.getResourceMetadata({
      spaceId,
      collectionId,
      resourceId
    })
    assert.equal(parent?.generation, 'gen-b')
    assert.equal(parent?.updatedAt, stampAt(1000).updatedAt)

    // A moved-in chunk has a fresh validator, minted by this store.
    const replacedAfter = await backend.getChunkMetadata({
      spaceId,
      collectionId,
      resourceId,
      chunkIndex: 1
    })
    assert.notEqual(replacedAfter?.generation, replacedBefore?.generation)
    assert.equal(replacedAfter?.originId, backend.originId)

    assert.equal(await exists(stagingDir()), false)
    const { documents } = await backend.changesSince({
      spaceId,
      collectionId,
      limit: 100
    })
    assert.deepEqual(
      documents.filter(
        document =>
          document.kind === 'resource' && document.resourceId === resourceId
      ).length,
      1
    )
    const last = documents.at(-1)
    assert.equal(last?.kind === 'resource' && last.resourceId, resourceId)
  })

  it('creates a Resource it does not hold with its set, and removes a whole set', async () => {
    assert.deepEqual(await stage(0, 'n0'), { outcome: 'applied' })
    assert.deepEqual(
      await applyWithChunks({ stamp: stampAt(1000), staged: [0] }),
      { outcome: 'applied' }
    )
    assert.deepEqual(await chunkBodies(), { 0: 'n0' })
    assert.equal(await parentBody(), 'parent-b')

    // A later revision with no chunks removes the set and its directory.
    const emptyRun = { replicaId, parentEtag: '"rev-c"' }
    assert.deepEqual(
      await backend.applyResource({
        spaceId,
        replicaId,
        collectionId,
        resourceId,
        generation: 'gen-b',
        stamp: stampAt(2000),
        resource: { deleted: false, input: binaryInput('parent-c') },
        chunks: { run: emptyRun, staged: [] }
      }),
      { outcome: 'applied' }
    )
    assert.deepEqual(await chunkBodies(), {})
    assert.equal(await exists(chunkDir()), false)
    assert.equal(await parentBody(), 'parent-c')
  })

  it('releases the staging and changes nothing live when the held stamp wins', async () => {
    await writeParentWithChunks(['a0', 'a1'])
    await stage(1, 'b1')
    const before = await backend.getResourceMetadata({
      spaceId,
      collectionId,
      resourceId
    })
    assert.deepEqual(
      await applyWithChunks({ stamp: stampAt(-1000), staged: [1] }),
      { outcome: 'skipped' }
    )
    assert.deepEqual(await chunkBodies(), { 0: 'a0', 1: 'a1' })
    assert.equal(await parentBody(), 'parent-a')
    assert.deepEqual(
      await backend.getResourceMetadata({ spaceId, collectionId, resourceId }),
      before
    )
    assert.deepEqual(
      await backend.listStagedChunks({
        spaceId,
        collectionId,
        resourceId,
        run
      }),
      []
    )
    assert.equal(await exists(stagingDir()), false)
  })

  it('refuses a key the staging does not hold, or one named twice', async () => {
    await writeParentWithChunks(['a0'])
    await stage(1, 'b1')
    for (const staged of [
      [1, 2],
      [1, 1]
    ]) {
      const result = await applyWithChunks({ stamp: stampAt(1000), staged })
      assert.equal(result.outcome, 'refused')
      assert.equal(
        result.outcome === 'refused' && result.reason,
        'container-refused'
      )
    }
    assert.deepEqual(await chunkBodies(), { 0: 'a0' })
    assert.equal(await parentBody(), 'parent-a')
    // The refusal releases the run's staging, so no staged bytes count
    // toward usage while the Collection stalls.
    assert.equal(await exists(stagingDir()), false)
    // A tombstone takes no chunk set.
    await assert.rejects(
      backend.applyResource({
        spaceId,
        replicaId,
        collectionId,
        resourceId,
        generation: 'gen-b',
        stamp: stampAt(1000),
        resource: { deleted: true, contentType: 'application/octet-stream' },
        chunks: { run, staged: [1] }
      })
    )
  })

  it('opens a run: drops the other runs of the registration, lists what it holds, and checks the quota', async () => {
    await writeParentWithChunks(['a0', 'a1'])
    const earlier: ChunkStagingRun = { replicaId, parentEtag: '"rev-a"' }
    await stage(0, 'old0', { run: earlier })
    await stage(1, 'b1')
    // Staging alone leaves the registration's other runs in place.
    assert.equal(await exists(runDir(earlier)), true)
    const open = { spaceId, replicaId, collectionId, resourceId, run }
    const listed = [
      { index: 0, size: 2 },
      { index: 1, size: 2 }
    ]
    assert.deepEqual(await backend.beginChunkStaging({ ...open, listed }), {
      staged: [{ index: 1, size: 2, peerEtag: '"p1"' }]
    })
    assert.equal(await exists(runDir(earlier)), false)
    assert.equal(await exists(runDir()), true)

    // A chunk over the upload cap is refused with nothing staged.
    const cap = backend.maxUploadBytes
    backend.maxUploadBytes = 1
    assert.partialDeepStrictEqual(
      await backend.beginChunkStaging({ ...open, listed }),
      { outcome: 'refused', reason: 'quota-exceeded' }
    )
    backend.maxUploadBytes = cap

    // Under a quota the Space fills, a set the size of the live one fits,
    // and a larger one is refused.
    const { usageBytes } = await backend.reportUsage({ spaceId })
    backend.capacityBytes = usageBytes
    assert.deepEqual(await backend.beginChunkStaging({ ...open, listed }), {
      staged: [{ index: 1, size: 2, peerEtag: '"p1"' }]
    })
    assert.partialDeepStrictEqual(
      await backend.beginChunkStaging({
        ...open,
        listed: [
          { index: 0, size: 2 },
          { index: 1, size: 64 * 1024 }
        ]
      }),
      { outcome: 'refused', reason: 'quota-exceeded' }
    )
    // The open run credits the live chunks the swap replaces, so the
    // same-size rewrite stages under the full quota.
    assert.deepEqual(await stage(0, 'B0'), { outcome: 'applied' })
    assert.deepEqual(await stage(1, 'B1'), { outcome: 'applied' })
    // The swap's parent write takes no credit under the gross check here.
    backend.capacityBytes = usageBytes + 4096
    assert.deepEqual(
      await applyWithChunks({ stamp: stampAt(1000), staged: [0, 1] }),
      { outcome: 'applied' }
    )
    assert.deepEqual(await chunkBodies(), { 0: 'B0', 1: 'B1' })

    // No registration, and no live Collection, open nothing.
    assert.deepEqual(
      await backend.beginChunkStaging({
        ...open,
        replicaId: 'no-such-peer',
        run: { replicaId: 'no-such-peer', parentEtag: '"x"' },
        listed: []
      }),
      { outcome: 'unregistered' }
    )
    assert.deepEqual(
      await backend.beginChunkStaging({
        ...open,
        collectionId: 'absent',
        listed: []
      }),
      { outcome: 'skipped' }
    )
  })

  it('opens a run for a listing of many chunks', async () => {
    await writeParentWithChunks(['a0'])
    const listed = Array.from({ length: 200_000 }, (_, index) => ({
      index,
      size: 1
    }))
    assert.deepEqual(
      await backend.beginChunkStaging({
        spaceId,
        replicaId,
        collectionId,
        resourceId,
        run,
        listed
      }),
      { staged: [] }
    )
  })

  it("forgets a run's quota credit when Delete Resource removes its staging", async () => {
    const size = 64 * 1024
    await writeParentWithChunks(['x'.repeat(size), 'y'.repeat(size)])
    const listed = [
      { index: 0, size },
      { index: 1, size }
    ]
    const open = { spaceId, replicaId, collectionId, resourceId, run }
    assert.deepEqual(await backend.beginChunkStaging({ ...open, listed }), {
      staged: []
    })
    // The open run credits the live set it replaces.
    backend.capacityBytes = (await backend.reportUsage({ spaceId })).usageBytes
    assert.deepEqual(await stage(0, Buffer.alloc(size, 1)), {
      outcome: 'applied'
    })
    await backend.deleteResource({ spaceId, collectionId, resourceId })
    // The live set is gone with the Resource, and so is the credit for it:
    // a stage under the same run has nothing to replace.
    backend.capacityBytes = (await backend.reportUsage({ spaceId })).usageBytes
    await assert.rejects(stage(1, Buffer.alloc(size, 2)), QuotaExceededError)
  })

  it('lists what a run staged, for the conditional reads of a re-run', async () => {
    await stage(2, 'second')
    await stage(0, 'zero')
    assert.deepEqual(
      await backend.listStagedChunks({
        spaceId,
        collectionId,
        resourceId,
        run
      }),
      [
        { index: 0, size: 4, peerEtag: '"p0"' },
        { index: 2, size: 6, peerEtag: '"p2"' }
      ]
    )
    // A re-read of an index replaces what was staged there.
    await backend.stageChunk({
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      run,
      chunkIndex: 2,
      input: binaryInput('2nd'),
      peerEtag: '"p2-new"'
    })
    assert.deepEqual(
      await backend.listStagedChunks({
        spaceId,
        collectionId,
        resourceId,
        run
      }),
      [
        { index: 0, size: 4, peerEtag: '"p0"' },
        { index: 2, size: 3, peerEtag: '"p2-new"' }
      ]
    )
    // Opening a run for a newer revision drops the registration's older run.
    const newer = { replicaId, parentEtag: '"rev-c"' }
    await backend.beginChunkStaging({
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      run: newer,
      listed: [{ index: 0, size: 2 }]
    })
    assert.deepEqual(
      await backend.listStagedChunks({
        spaceId,
        collectionId,
        resourceId,
        run
      }),
      []
    )
  })

  it('stages nothing under a registration the Space does not hold', async () => {
    const result = await backend.stageChunk({
      spaceId,
      replicaId: 'no-such-peer',
      collectionId,
      resourceId,
      run: { replicaId: 'no-such-peer', parentEtag: '"x"' },
      chunkIndex: 0,
      input: binaryInput('x'),
      peerEtag: '"x"'
    })
    assert.deepEqual(result, { outcome: 'unregistered' })
    assert.equal(await exists(stagingDir()), false)
  })

  it('reclaims staging by registration and by Resource', async () => {
    await stage(0, 'peer-x', { id: 'x' })
    // Another registration's run, staged with no registration check, as an
    // apply into a backend other than the control plane runs.
    await backend.stageChunk({
      spaceId,
      collectionId,
      resourceId: 'x',
      run: { replicaId: 'other', parentEtag: '"o"' },
      chunkIndex: 0,
      input: binaryInput('other-x'),
      peerEtag: '"o0"'
    })
    await stage(0, 'peer-y', { id: 'y' })

    assert.equal(
      await backend.reclaimStaging({ spaceId, replicaId: 'other' }),
      1
    )
    assert.deepEqual(
      await backend.listStagedChunks({
        spaceId,
        collectionId,
        resourceId: 'x',
        run
      }),
      [{ index: 0, size: 6, peerEtag: '"p0"' }]
    )
    assert.equal(
      await backend.reclaimStaging({ spaceId, collectionId, resourceId: 'x' }),
      1
    )
    assert.equal(await exists(stagingDir('x')), false)
    assert.equal(await exists(stagingDir('y')), true)
    assert.equal(await backend.reclaimStaging({ spaceId }), 1)
    assert.equal(await exists(stagingDir('y')), false)
  })

  it('reclaims nothing for a Resource with no staging, and makes no directory', async () => {
    assert.equal(
      await backend.reclaimStaging({
        spaceId,
        collectionId,
        resourceId: 'none',
        replicaId
      }),
      0
    )
    assert.equal(await exists(stagingDir('none')), false)
  })

  it('puts the set renamed aside back when a local write stands over a torn swap', async () => {
    await writeParentWithChunks(['a0', 'a1'])
    await stage(1, 'b1')
    const counterPath = path.join(
      collectionDir,
      feedCounterFileName(collectionId)
    )
    const counter = await readFile(counterPath)
    await rm(counterPath)
    await mkdir(counterPath)
    await assert.rejects(applyWithChunks({ stamp: stampAt(1000), staged: [1] }))
    await rm(counterPath, { recursive: true })
    await writeFile(counterPath, counter)
    // Torn between the two renames: the live set stands aside in `prior/`,
    // the new one is still in `next/`, and no chunk directory stands.
    await rename(chunkDir(), path.join(runDir(), 'next'))
    assert.equal(await exists(path.join(runDir(), 'prior')), true)
    assert.deepEqual(await chunkBodies(), {})

    // A local write of the parent lands before the swap is finished.
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId,
      input: binaryInput('parent-local')
    })
    assert.equal(await backend.reclaimStaging({ spaceId }), 1)
    assert.equal(await parentBody(), 'parent-local')
    assert.deepEqual(await chunkBodies(), { 0: 'a0', 1: 'a1' })
    assert.equal(await exists(stagingDir()), false)
  })

  it('finishes a swap torn before the parent sidecar at the next open', async () => {
    await writeParentWithChunks(['a0', 'a1'])
    await stage(0, 'b0')
    await stage(1, 'b1')
    await stage(2, 'b2')
    // The feed counter turned into a directory fails the parent's sidecar
    // write, after the directory swap.
    const counterPath = path.join(
      collectionDir,
      feedCounterFileName(collectionId)
    )
    const counter = await readFile(counterPath)
    await rm(counterPath)
    await mkdir(counterPath)
    await assert.rejects(
      applyWithChunks({ stamp: stampAt(1000), staged: [0, 1, 2] })
    )
    // The new set is in place under the old parent, and the run's manifest
    // stands, which is the swap flag.
    assert.deepEqual(await chunkBodies(), { 0: 'b0', 1: 'b1', 2: 'b2' })
    const manifest = JSON.parse(
      await readFile(path.join(runDir(), '.manifest.json'), 'utf8')
    )
    assert.deepEqual(Object.keys(manifest).sort(), [
      'parent',
      'parentEtag',
      'staged'
    ])
    assert.deepEqual(manifest.staged, [0, 1, 2])
    const torn = await backend.getResourceMetadata({
      spaceId,
      collectionId,
      resourceId
    })
    assert.notEqual(torn?.updatedAt, stampAt(1000).updatedAt)
    await rm(counterPath, { recursive: true })
    await writeFile(counterPath, counter)

    const reopened = await FileSystemBackend.open({
      dataDir: backend.dataDir,
      physicalClock: clock.read
    })
    try {
      assert.equal(await parentBody(reopened), 'parent-b')
      assert.deepEqual(await chunkBodies(reopened), {
        0: 'b0',
        1: 'b1',
        2: 'b2'
      })
      const parent = await reopened.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId
      })
      assert.equal(parent?.updatedAt, stampAt(1000).updatedAt)
      assert.equal(await exists(stagingDir()), false)
      const { documents } = await reopened.changesSince({
        spaceId,
        collectionId,
        limit: 100
      })
      const last = documents.at(-1)
      assert.equal(last?.kind === 'resource' && last.resourceId, resourceId)
    } finally {
      await reopened.close()
    }
  })

  it('discards an unswapped run at the next open', async () => {
    await writeParentWithChunks(['a0'])
    await stage(1, 'b1')
    const reopened = await FileSystemBackend.open({
      dataDir: backend.dataDir,
      physicalClock: clock.read
    })
    try {
      assert.equal(await exists(stagingDir()), false)
      assert.deepEqual(await chunkBodies(reopened), { 0: 'a0' })
    } finally {
      await reopened.close()
    }
  })

  it('removes the chunks and the staging with a replicated tombstone', async () => {
    await writeParentWithChunks(['a0', 'a1'])
    await stage(1, 'b1')
    assert.deepEqual(
      await backend.applyResource({
        spaceId,
        replicaId,
        collectionId,
        resourceId,
        generation: 'gen-b',
        stamp: stampAt(1000),
        resource: { deleted: true, contentType: 'application/octet-stream' }
      }),
      { outcome: 'applied' }
    )
    assert.equal(await exists(chunkDir()), false)
    assert.equal(await exists(stagingDir()), false)
  })

  it('removes a chunk directory stranded beside a tombstone', async () => {
    await writeParentWithChunks(['a0'])
    await backend.deleteResource({ spaceId, collectionId, resourceId })
    // A delete cut short between its tombstone and the chunk removal.
    await mkdir(chunkDir())
    await writeFile(path.join(chunkDir(), 'r.0.leftover.bin'), 'a0')
    const reopened = await FileSystemBackend.open({
      dataDir: backend.dataDir,
      physicalClock: clock.read
    })
    try {
      assert.equal(await exists(chunkDir()), false)
    } finally {
      await reopened.close()
    }
    // A replayed tombstone, an equal-stamp skip, clears one as well.
    await mkdir(chunkDir())
    const tombstone = await backend.readMetaSidecar({
      collectionDir,
      resourceId
    })
    assert.equal(tombstone?.deleted, true)
    await backend.applyResource({
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      generation: tombstone!.generation,
      stamp: {
        updatedAt: tombstone!.updatedAt,
        updatedAtCounter: tombstone!.updatedAtCounter,
        originId: tombstone!.originId
      },
      resource: { deleted: true, contentType: 'application/octet-stream' }
    })
    assert.equal(await exists(chunkDir()), false)
  })

  it('counts staged bytes toward usage, and credits the chunks a run replaces', async () => {
    const size = 64 * 1024
    await writeParentWithChunks([
      'x'.repeat(size),
      'y'.repeat(size),
      'z'.repeat(size)
    ])
    const before = (await backend.reportUsage({ spaceId })).usageBytes
    await stage(0, Buffer.alloc(size, 1))
    const after = (await backend.reportUsage({ spaceId })).usageBytes
    assert.ok(after - before >= size, `${after} - ${before} < ${size}`)

    // A quota equal to current usage: a same-size rewrite of the rest of
    // the stream still fits, since the swap frees what the run replaces.
    backend.capacityBytes = after
    await assert.rejects(
      backend.stageChunk({
        spaceId,
        replicaId,
        collectionId,
        resourceId: 'other',
        run,
        chunkIndex: 0,
        input: binaryInput(Buffer.alloc(size, 2)),
        peerEtag: '"o"'
      }),
      QuotaExceededError
    )
    assert.deepEqual(await stage(1, Buffer.alloc(size, 2)), {
      outcome: 'applied'
    })
    assert.deepEqual(await stage(2, Buffer.alloc(size, 3)), {
      outcome: 'applied'
    })
  })

  it('gives a staged chunk no feed position', async () => {
    await writeParentWithChunks(['a0'])
    const before = await backend.changesSince({
      spaceId,
      collectionId,
      limit: 100
    })
    await stage(1, 'b1')
    const after = await backend.changesSince({
      spaceId,
      collectionId,
      limit: 100
    })
    assert.deepEqual(after, before)
  })
})
