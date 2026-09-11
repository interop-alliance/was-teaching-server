/**
 * Regression tests for the two `FileSystemBackend` enumerations that read a
 * path a previous step already named, and so must tolerate it having been
 * removed in between: the per-Collection read inside the Resource count quota,
 * and the per-chunk `stat` inside `listChunks`. Both windows are too narrow to
 * race deterministically, so the removal is injected at the syscall instead: a
 * `stat` / `readdir` of the vanished path raises `ENOENT` exactly as the kernel
 * would. Anything other than `ENOENT` must still surface.
 */
import { it, describe, beforeEach, afterEach, vi } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// The paths the mocks below make vanish, as substrings of the real path. Set by
// a test, cleared in `afterEach`.
const vanished = vi.hoisted(() => ({ paths: [] as string[] }))

/**
 * True when `target` names a path a test has made vanish.
 */
const isVanished = vi.hoisted(
  () => (target: unknown) =>
    typeof target === 'string' &&
    ((
      globalThis as { __vanished?: { paths: string[] } }
    ).__vanished?.paths.some(fragment => target.includes(fragment)) ??
      false)
)

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    stat: async (target: never, ...rest: never[]) => {
      if (isVanished(target)) {
        throw enoent(String(target))
      }
      return actual.stat(target, ...rest)
    }
  }
})

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const promises = {
    ...actual.promises,
    readdir: async (target: never, ...rest: never[]) => {
      if (isVanished(target)) {
        throw enoent(String(target))
      }
      return (actual.promises.readdir as (...args: never[]) => unknown)(
        target,
        ...rest
      )
    }
  }
  return {
    ...actual,
    promises,
    default: { ...actual, promises }
  }
})

/**
 * An `ENOENT` shaped like the kernel's.
 * @param target {string}
 * @returns {NodeJS.ErrnoException}
 */
function enoent(target: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `ENOENT: no such file or directory, '${target}'`
  )
  err.code = 'ENOENT'
  return err
}

const { FileSystemBackend } = await import('../src/backends/filesystem.js')

const controller = 'did:key:z6MkIoFaultsTestController'

describe('FileSystemBackend I/O faults', () => {
  let dataDir: string
  const spaceId = 'io-faults-space'
  const collectionId = 'credentials'

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;(globalThis as { __vanished?: typeof vanished }).__vanished = vanished
    vanished.paths = []
  })

  afterEach(async () => {
    vanished.paths = []
    await rm(dataDir, { recursive: true, force: true })
  })

  /**
   * A backend over the suite's temp dir, with the given quota options.
   */
  const backendWith = async (
    options: ConstructorParameters<typeof FileSystemBackend>[0]
  ) => {
    const backend = new FileSystemBackend(options)
    await backend.writeSpace({
      spaceId,
      spaceDescription: { id: spaceId, type: ['Space'], controller }
    })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionDescription: {
        id: collectionId,
        type: ['Collection'],
        name: 'Credentials'
      }
    })
    return backend
  }

  it('a create survives a Collection removed mid count-quota enumeration', async () => {
    // Regression: the per-Collection `readdir` in `#countLiveResources` was
    // unguarded, so a Collection deleted between the Space listing and this
    // read failed an unrelated create with a raw `ENOENT` -- a 500 for a valid
    // write.
    const backend = await backendWith({ dataDir, maxResourcesPerSpace: 500 })
    await backend.writeCollection({
      spaceId,
      collectionId: 'doomed',
      collectionDescription: {
        id: 'doomed',
        type: ['Collection'],
        name: 'Doomed'
      }
    })
    // The Space listing still reports `doomed`; reading it raises ENOENT.
    vanished.paths = [path.join(spaceId, 'doomed')]
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'fresh',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } }
    })
  })

  it('listChunks omits a chunk removed while it runs', async () => {
    // Regression: the per-chunk `stat` had no `ENOENT` handling, so a chunk
    // deleted between the directory read and the stat escaped as a raw error
    // and rendered a 500 for a valid read.
    const backend = await backendWith({ dataDir })
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'chunked',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } }
    })
    for (const chunkIndex of [0, 1, 2]) {
      await backend.writeChunk({
        spaceId,
        collectionId,
        resourceId: 'chunked',
        chunkIndex,
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          declaredBytes: 16,
          stream: bufferStream(Buffer.alloc(16, 0x61))
        }
      })
    }
    // Chunk 1's representation file vanishes between the listing's directory
    // read and its stat.
    vanished.paths = ['r.1.']
    const listing = await backend.listChunks({
      spaceId,
      collectionId,
      resourceId: 'chunked'
    })
    assert.deepEqual(
      listing.chunks.map(chunk => chunk.index),
      [0, 2]
    )
    assert.equal(listing.count, 2)
  })
})

/**
 * A `Readable` over a whole buffer, for the binary write paths.
 * @param buffer {Buffer}
 * @returns {Readable}
 */
function bufferStream(buffer: Buffer): Readable {
  return new Readable({
    read() {
      this.push(buffer)
      this.push(null)
    }
  })
}
