/**
 * The filesystem backend's byte-quota pre-flight measures a Space with `du`
 * and caches the total for `QUOTA_USAGE_CACHE_TTL` ms (Vitest, backend level,
 * no server). Two rules of that cache are pinned here, since nothing else
 * observes them: writes that find the entry expired at the same time share
 * one running measurement, and a delete while a measurement runs forgets it,
 * so a total read before the delete never fills the cache. `du` is
 * intercepted at `child_process.execFile`, the one seam the measurement
 * crosses; the wrapper keeps the `promisify.custom` hook the backend binds at
 * module load.
 */
import { it, describe, beforeEach, afterEach, vi } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { QUOTA_USAGE_CACHE_TTL } from '../src/config.default.js'

const du = vi.hoisted(() => ({
  calls: 0,
  // While set, every `du` waits on it before running.
  gate: undefined as Promise<void> | undefined
}))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const original = actual.execFile as typeof actual.execFile & {
    [promisify.custom]: (...args: unknown[]) => Promise<unknown>
  }
  const execFile = function (...args: unknown[]) {
    return (original as (...args: unknown[]) => unknown)(...args)
  } as unknown as typeof actual.execFile & {
    [promisify.custom]: (...args: unknown[]) => Promise<unknown>
  }
  execFile[promisify.custom] = async (file: unknown, ...rest: unknown[]) => {
    if (file === 'du') {
      du.calls++
      await du.gate
    }
    return original[promisify.custom](file, ...rest)
  }
  return { ...actual, execFile }
})

const controller = 'did:key:z6MkUsageCacheTestController'
const spaceId = 'usage-cache'
const collectionId = 'docs'

describe('FileSystemBackend: the byte-quota usage cache', () => {
  let dataDir: string
  let backend: FileSystemBackend

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
   * Holds every `du` until the returned release is called.
   * @returns {() => void}
   */
  function holdDu(): () => void {
    let release!: () => void
    du.gate = new Promise<void>(resolve => {
      release = resolve
    })
    return () => {
      du.gate = undefined
      release()
    }
  }

  /**
   * Resolves once `du` has been invoked `count` times.
   * @param count {number}
   * @returns {Promise<void>}
   */
  async function duCalled(count: number): Promise<void> {
    while (du.calls < count) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  /**
   * Expires whatever the cache holds by moving `performance.now`, the clock
   * `LruCache` times its TTL off, past that TTL, then waits out the 1 ms for
   * which `lru-cache` reuses its last clock reading.
   * @returns {Promise<void>}
   */
  async function expireCache(): Promise<void> {
    const later = performance.now() + QUOTA_USAGE_CACHE_TTL + 1
    vi.spyOn(performance, 'now').mockReturnValue(later)
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-usage-cache-'))
    backend = await FileSystemBackend.open({
      dataDir,
      capacityBytes: 1024 * 1024
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
    // The seed write measures and caches; the cases below start from there.
    await writeJson('seed')
    du.calls = 0
  })

  afterEach(async () => {
    du.gate = undefined
    vi.restoreAllMocks()
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('two writes racing an expired entry run one measurement', async () => {
    await expireCache()
    const release = holdDu()
    const writes = Promise.all([writeJson('first'), writeJson('second')])
    await duCalled(1)
    // The second write has arrived while the first's `du` is held; it must
    // be waiting on that one rather than running its own.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(du.calls, 1)
    release()
    await writes
    assert.equal(du.calls, 1)
    const listing = await backend.listCollectionItems({ spaceId, collectionId })
    assert.equal(listing.totalItems, 3)
  })

  // Each kind of free that bytes come back through: a Resource delete and a
  // chunk delete. `prepare` stores what `free` removes.
  const frees = [
    {
      kind: 'Resource',
      prepare: async () => {},
      free: () =>
        backend.deleteResource({ spaceId, collectionId, resourceId: 'seed' })
    },
    {
      kind: 'chunk',
      prepare: async () => {
        const input = {
          kind: 'json' as const,
          contentType: 'application/json',
          data: {}
        }
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          input
        })
        await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          chunkIndex: 0,
          input
        })
      },
      free: () =>
        backend.deleteChunk({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          chunkIndex: 0
        })
    }
  ]

  for (const { kind, prepare, free } of frees) {
    it(`a ${kind} delete while a measurement runs forgets it, so the next write measures again`, async () => {
      await prepare()
      du.calls = 0
      await expireCache()
      const release = holdDu()
      const write = writeJson('during')
      await duCalled(1)
      // Frees bytes mid-measurement: the running `du` read the tree before
      // this, so its total must not be cached.
      await free()
      release()
      await write
      assert.equal(du.calls, 1)
      // A measurement that had filled the cache would make this write hit it.
      await writeJson('after')
      assert.equal(du.calls, 2)
    })
  }
})
