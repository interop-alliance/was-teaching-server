/**
 * Regression tests for the `FileSystemBackend`'s concurrency and I/O-failure
 * handling, at the backend level (no server): a container removal racing a
 * write, an enumeration whose directory is removed underneath it, a read racing
 * a delete, and the quota-cache invalidation order around a delete. Each case
 * is a race the backend must absorb rather than surface as a 500 -- or, for the
 * removals, must not leave behind as a structurally broken Space.
 */
import { it, describe, beforeEach, afterEach, vi } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm, readdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { ResourceNotFoundError } from '../src/errors.js'

const controller = 'did:key:z6MkRacesTestController'

describe('FileSystemBackend races', () => {
  let dataDir: string
  let backend: FileSystemBackend
  const spaceId = 'races-space'
  const collectionId = 'credentials'

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    backend = new FileSystemBackend({ dataDir })
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
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  /**
   * The Collection directory as it exists on disk.
   */
  const collectionDirEntries = async (): Promise<string[]> => {
    try {
      return await readdir(path.join(dataDir, 'spaces', spaceId, collectionId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  it('a Collection delete racing a Resource write leaves no phantom directory', async () => {
    // Regression: the delete serialized only on the description key while the
    // write recreated the Collection dir under its own per-Resource key, so the
    // dir came back holding Resources but no description -- listed by
    // `listCollections`, 404 on read, and still counted against the quota.
    const writes = Array.from({ length: 40 }, (_unused, index) =>
      backend
        .writeResource({
          spaceId,
          collectionId,
          resourceId: `doc-${index}`,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { index }
          }
        })
        .catch(() => undefined)
    )
    await backend.deleteCollection({ spaceId, collectionId })
    await Promise.all(writes)

    const description = await backend.getCollectionDescription({
      spaceId,
      collectionId
    })
    // Either the Collection is gone outright, or it exists WITH its
    // description. What must never happen is content with no description.
    if (description === undefined) {
      assert.deepEqual(
        await collectionDirEntries(),
        [],
        'Collection was deleted but its directory holds files'
      )
    }
  })

  it('a Space delete racing a Resource write leaves no unreachable Space directory', async () => {
    const writes = Array.from({ length: 40 }, (_unused, index) =>
      backend
        .writeResource({
          spaceId,
          collectionId,
          resourceId: `doc-${index}`,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { index }
          }
        })
        .catch(() => undefined)
    )
    await backend.deleteSpace({ spaceId })
    await Promise.all(writes)

    const description = await backend.getSpaceDescription({ spaceId })
    if (description === undefined) {
      const spaceDir = path.join(dataDir, 'spaces', spaceId)
      let entries: string[] = []
      try {
        entries = await readdir(spaceDir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err
        }
      }
      assert.deepEqual(
        entries,
        [],
        'Space was deleted but its directory holds data no route can reach'
      )
    }
  })

  it('an import takes each Resource lock, so it cannot interleave with a write', async () => {
    // Regression: `importSpace` did check-then-write per Resource with no
    // per-Resource lock, while every other write path holds one across its
    // existence probe, body write and sidecar bump. A concurrent PUT could
    // therefore bump the sidecar -- returning that `ETag` to its client --
    // while the archive's bytes landed underneath it, leaving a stored
    // validator that describes content that client never saw.
    //
    // Tested as the invariant rather than the interleaving: with a write to
    // `doc` in flight (holding its lock), an import that also carries `doc`
    // must not be able to write it.
    const sourceDir = await mkdtemp(path.join(tmpdir(), 'was-test-src-'))
    const sourceBackend = new FileSystemBackend({ dataDir: sourceDir })
    try {
      await sourceBackend.writeSpace({
        spaceId,
        spaceDescription: { id: spaceId, type: ['Space'], controller }
      })
      await sourceBackend.writeCollection({
        spaceId,
        collectionId,
        collectionDescription: {
          id: collectionId,
          type: ['Collection'],
          name: 'Credentials'
        }
      })
      await sourceBackend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'doc',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          declaredBytes: 8,
          stream: bufferStream(Buffer.alloc(8, 0x61))
        }
      })
      const archive = await sourceBackend.exportSpace({ spaceId })

      // A blob write whose body has not finished arriving: it holds `doc`'s
      // lock until the test lets the stream end.
      const slowBody = new Readable({ read() {} })
      const inFlight = backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'doc',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          stream: slowBody
        }
      })
      slowBody.push(Buffer.alloc(8, 0x62))
      await new Promise(resolve => setTimeout(resolve, 20))

      let importFinished = false
      const importRun = backend
        .importSpace({ spaceId, tarStream: archive })
        .then(() => {
          importFinished = true
        })
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(
        importFinished,
        false,
        'the import wrote a Resource while another write held its lock'
      )

      slowBody.push(null)
      await inFlight
      await importRun
    } finally {
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('a write right after a delete is not refused by a stale quota snapshot', async () => {
    // Regression: `deleteResource` dropped the cached usage BEFORE the removal,
    // so a concurrent write could re-measure the pre-delete tree and cache that
    // total for a full TTL -- refusing the client's follow-up write over space
    // the delete had just freed.
    const capped = new FileSystemBackend({ dataDir, capacityBytes: 200_000 })
    const validator = await capped.writeResource({
      spaceId,
      collectionId,
      resourceId: 'bulky',
      input: {
        kind: 'binary',
        contentType: 'application/octet-stream',
        declaredBytes: 100_000,
        stream: bufferStream(Buffer.alloc(100_000, 0x61))
      }
    })

    // Land a concurrent write inside the delete, BEFORE it has removed
    // anything: that write re-measures the tree and caches the pre-delete
    // total. The invalidation must therefore come after the removal, or that
    // stale snapshot outlives the delete and refuses the follow-up write.
    const sidecarRead = capped.readMetaSidecar.bind(capped)
    let raced = false
    vi.spyOn(capped, 'readMetaSidecar').mockImplementation(async options => {
      const sidecar = await sidecarRead(options)
      if (!raced) {
        raced = true
        await capped.writeResource({
          spaceId,
          collectionId,
          resourceId: 'tiny',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { a: 1 }
          }
        })
      }
      return sidecar
    })
    // A conditional delete, so its precondition read runs before the removal
    // and gives the racing write that window.
    await capped.deleteResource({
      spaceId,
      collectionId,
      resourceId: 'bulky',
      ifMatch: `"${validator.generation}.${validator.version}"`
    })
    vi.restoreAllMocks()

    // The freed bytes must be visible immediately, not after the cache TTL.
    await capped.writeResource({
      spaceId,
      collectionId,
      resourceId: 'replacement',
      input: {
        kind: 'binary',
        contentType: 'application/octet-stream',
        declaredBytes: 100_000,
        stream: bufferStream(Buffer.alloc(100_000, 0x61))
      }
    })
  })

  it('listCollectionItems surfaces an I/O failure rather than reporting an empty Collection', async () => {
    // Regression: every `readdir` error was swallowed and logged, so an
    // unreadable Collection answered 200 with `totalItems: 0` -- which a
    // replicating client reads as "every Resource was removed".
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'doc',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } }
    })
    // Pass the description in, as the request layer does once it has fetched it
    // (`CollectionRequest`): the Collection provably exists, so the only thing
    // that can fail below is the directory enumeration itself.
    const collectionDescription = await backend.getCollectionDescription({
      spaceId,
      collectionId
    })
    assert.ok(collectionDescription)
    const collectionDir = path.join(dataDir, 'spaces', spaceId, collectionId)
    await chmod(collectionDir, 0o000)
    try {
      await assert.rejects(
        backend.listCollectionItems({
          spaceId,
          collectionId,
          collectionDescription
        }),
        (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES'
      )
    } finally {
      await chmod(collectionDir, 0o755)
    }
  })

  it('a read that races a delete resolves 404, not a storage fault', async () => {
    // Regression: `openFileStream` rejected with a bare `Error` carrying no
    // code, so `handleError` rendered a 500 -- contradicting the comment that
    // justifies skipping the existence recheck on this path.
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'vanishing',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } }
    })
    const collectionDir = path.join(dataDir, 'spaces', spaceId, collectionId)
    const files = await readdir(collectionDir)
    const representation = files.find(name => name.startsWith('r.vanishing'))
    assert.ok(representation)
    // Land the delete in the exact window the read path leaves open: the read
    // looks the file up, reads the sidecar, then opens the stream. Removing the
    // file during the sidecar read means the lookup succeeded and the open is
    // what discovers the removal -- the case this path relies on the stream's
    // own `open` to surface.
    const sidecarRead = backend.readMetaSidecar.bind(backend)
    vi.spyOn(backend, 'readMetaSidecar').mockImplementation(async options => {
      const sidecar = await sidecarRead(options)
      await rm(path.join(collectionDir, representation), { force: true })
      return sidecar
    })
    await assert.rejects(
      backend.getResource({ spaceId, collectionId, resourceId: 'vanishing' }),
      (err: unknown) => err instanceof ResourceNotFoundError
    )
    vi.restoreAllMocks()
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
