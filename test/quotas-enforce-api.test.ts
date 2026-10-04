/**
 * Quota enforcement tests (Vitest). Two layers:
 *
 * - **API level** (full stack, in-process server): a Space configured with a
 *   finite `capacityBytes` accepts writes that fit and rejects oversized JSON
 *   and blob writes with `quota-exceeded` (507). These also guard the handler
 *   passthrough -- a backend 507 must surface as 507, not a wrapped 500.
 * - **Backend level** (`FileSystemBackend` directly): the streaming guard
 *   hard-caps a blob whose size is not declared up front (no `Content-Length`)
 *   and cleans up the partial file, and `importSpace` rejects a bulk import that
 *   would not fit.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import {
  QuotaExceededError,
  PayloadTooLargeError,
  ResourceNotFoundError
} from '../src/errors.js'
import {
  importArchive,
  openTempBackend,
  startTestServer,
  zcapClients
} from './helpers.js'

// 512 KiB cap; oversized payloads below exceed it outright (regardless of the
// small baseline usage from provisioning the Space + Collection).
const CAPACITY_BYTES = 512 * 1024
const OVERSIZED = 'x'.repeat(600 * 1024)

describe('Quota enforcement (API)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    backend: TempFileSystemBackend
  let alice: any, aliceCredentials: any
  const spaceId = `quota-enforce-${crypto.randomUUID()}`

  beforeAll(async () => {
    backend = await openTempBackend({ capacityBytes: CAPACITY_BYTES })
    ;({ fastify, serverUrl } = await startTestServer({
      backend
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Quota Enforce Space',
      controller: alice.did
    })
    aliceCredentials = await space.createCollection({
      id: 'credentials',
      name: 'Credentials'
    })
  })

  afterAll(async () => {
    await fastify.close()
  })

  it('accepts a write that fits under the quota', async () => {
    const result = await aliceCredentials.add({
      id: 'small',
      name: 'Fits comfortably'
    })
    assert.ok(result.id)
    assert.notEqual(await aliceCredentials.get(result.id), null)
  })

  it('rejects an oversized JSON write with quota-exceeded (507)', async () => {
    let thrown: any
    try {
      await aliceCredentials.put('too-big-json', {
        id: 'too-big-json',
        blob: OVERSIZED
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the oversized JSON write to be rejected')
    // 507 (not a wrapped 500) confirms the backend ProblemError passes through
    // the handler's catch unchanged.
    assert.equal(thrown.status, 507)
    assert.match(thrown.title, /Insufficient Storage/)
    // The rejected resource was not persisted.
    assert.equal(await aliceCredentials.get('too-big-json'), null)
  })

  it('rejects an oversized blob write with quota-exceeded (507)', async () => {
    const blob = new Blob([OVERSIZED], { type: 'text/plain' })
    let thrown: any
    try {
      await aliceCredentials.add(blob)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the oversized blob write to be rejected')
    assert.equal(thrown.status, 507)
    assert.match(thrown.title, /Insufficient Storage/)
  })
})

describe('Quota enforcement (backend)', () => {
  let backend: TempFileSystemBackend
  const spaceId = `quota-backend-${crypto.randomUUID()}`
  const collectionId = 'credentials'
  // Small enough that a ~300 KB resource overflows it, large enough that
  // provisioning the Space + Collection fits.
  const capacityBytes = 200_000

  beforeAll(async () => {
    backend = await openTempBackend({ capacityBytes })
    await backend.writeSpace({
      spaceId,
      spaceMetadata: {
        id: spaceId,
        type: ['Space'],
        controller: 'did:key:z6MkBackendTestController'
      }
    })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: {
        id: collectionId,
        type: ['Collection'],
        name: 'Credentials'
      }
    })
  })

  afterAll(async () => {
    await backend.close()
  })

  it('writes a small blob that fits', async () => {
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'small-blob',
      input: {
        kind: 'binary',
        contentType: 'application/octet-stream',
        stream: bufferStream(Buffer.alloc(1024, 0x61))
      }
    })
    const result = await backend.getResource({
      spaceId,
      collectionId,
      resourceId: 'small-blob'
    })
    assert.ok(result.resourceStream)
  })

  it('the streaming guard rejects an undeclared oversized blob and cleans up', async () => {
    // No `declaredBytes`, so the pre-flight cannot catch it -- the byte-counting
    // guard must abort mid-stream.
    await assert.rejects(
      backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'guarded',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          stream: bufferStream(Buffer.alloc(300_000, 0x61))
        }
      }),
      (err: unknown) => err instanceof QuotaExceededError
    )
    // The partial file was removed: the resource does not exist.
    await assert.rejects(
      backend.getResource({ spaceId, collectionId, resourceId: 'guarded' }),
      (err: unknown) => err instanceof ResourceNotFoundError
    )
  })

  it('books a streamed blob with no declared size against the quota', async () => {
    // Regression: a chunked-transfer body carries no `Content-Length`, so the
    // write reserved zero bytes and nothing credited what it wrote. Every write
    // inside the usage-cache TTL was then admitted against the same stale
    // snapshot, and the Space sailed past `capacityBytes`.
    // The bodies are sized well over half the capacity, so the second is
    // refused with room to spare: `du` measures allocated blocks, so the
    // Space's baseline (its dirs and description files) costs a few filesystem
    // blocks, and how many depends on the filesystem the temp dir lives on.
    const streamedBackend = await openTempBackend({ capacityBytes: 200_000 })
    const streamedSpace = `quota-streamed-${crypto.randomUUID()}`
    try {
      await streamedBackend.writeSpace({
        spaceId: streamedSpace,
        spaceMetadata: {
          id: streamedSpace,
          type: ['Space'],
          controller: 'did:key:z6MkStreamedQuotaController'
        }
      })
      await streamedBackend.writeCollection({
        spaceId: streamedSpace,
        collectionId,
        collectionMetadata: {
          id: collectionId,
          type: ['Collection'],
          name: 'Credentials'
        }
      })
      // No `declaredBytes` on either write: the first fits, the second must not.
      await streamedBackend.writeResource({
        spaceId: streamedSpace,
        collectionId,
        resourceId: 'streamed-one',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          stream: bufferStream(Buffer.alloc(120_000, 0x61))
        }
      })
      await assert.rejects(
        streamedBackend.writeResource({
          spaceId: streamedSpace,
          collectionId,
          resourceId: 'streamed-two',
          input: {
            kind: 'binary',
            contentType: 'application/octet-stream',
            stream: bufferStream(Buffer.alloc(120_000, 0x61))
          }
        }),
        (err: unknown) => err instanceof QuotaExceededError
      )
      // The refused write left nothing behind: only the first blob is stored,
      // so the Space holds one 120 KB body rather than two.
      await assert.rejects(
        streamedBackend.getResource({
          spaceId: streamedSpace,
          collectionId,
          resourceId: 'streamed-two'
        }),
        (err: unknown) => err instanceof ResourceNotFoundError
      )
    } finally {
      await streamedBackend.close()
    }
  })

  it('gives the reservation back when an import writes nothing', async () => {
    // Regression: `importSpace` discarded the reservation handle, so a
    // re-import of an unchanged archive -- every body skipped -- left the whole
    // archive size sitting in the usage snapshot, refusing unrelated writes
    // with 507 until the TTL expired.
    const sourceBackend = await openTempBackend({ prefix: 'was-test-src-' })
    // Capacity fits the archive twice (the stored copy plus the re-import's
    // reservation), but not three times, so an archive-sized write afterward
    // is refused if the reservation lingers. The spare 60 KB covers the
    // Space's own files and directories, which `du` counts in whole blocks on
    // an on-disk filesystem.
    const targetBackend = await openTempBackend({
      prefix: 'was-test-dst-',
      capacityBytes: 260_000
    })
    const importSpaceId = `quota-import-${crypto.randomUUID()}`
    const seed = async (backend: FileSystemBackend) => {
      await backend.writeSpace({
        spaceId: importSpaceId,
        spaceMetadata: {
          id: importSpaceId,
          type: ['Space'],
          controller: 'did:key:z6MkImportReleaseController'
        }
      })
      await backend.writeCollection({
        spaceId: importSpaceId,
        collectionId,
        collectionMetadata: {
          id: collectionId,
          type: ['Collection'],
          name: 'Credentials'
        }
      })
    }
    try {
      await seed(sourceBackend)
      await sourceBackend.writeResource({
        spaceId: importSpaceId,
        collectionId,
        resourceId: 'bulky',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          declaredBytes: 100_000,
          stream: bufferStream(Buffer.alloc(100_000, 0x61))
        }
      })
      await seed(targetBackend)
      await importArchive({
        backend: targetBackend,
        spaceId: importSpaceId,
        tarStream: await sourceBackend.exportSpace({ spaceId: importSpaceId })
      })
      // Re-import the same archive: every body is skipped, so the reservation
      // it took must come back rather than linger in the snapshot.
      await importArchive({
        backend: targetBackend,
        spaceId: importSpaceId,
        tarStream: await sourceBackend.exportSpace({ spaceId: importSpaceId })
      })
      // A write that fits the real usage must still be admitted immediately,
      // without waiting out the cache TTL.
      await targetBackend.writeResource({
        spaceId: importSpaceId,
        collectionId,
        resourceId: 'after-reimport',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          declaredBytes: 100_000,
          stream: bufferStream(Buffer.alloc(100_000, 0x61))
        }
      })
    } finally {
      await sourceBackend.close()
      await targetBackend.close()
    }
  })

  it('importSpace rejects a bulk import that exceeds the quota', async () => {
    // Stage an export from an unlimited backend that holds a ~300 KB resource,
    // then import it into a backend whose capacity cannot hold it.
    const source = await openTempBackend({ prefix: 'was-test-src-' })
    await source.writeSpace({
      spaceId,
      spaceMetadata: {
        id: spaceId,
        type: ['Space'],
        controller: 'did:key:z6MkBackendTestController'
      }
    })
    await source.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: {
        id: collectionId,
        type: ['Collection'],
        name: 'Credentials'
      }
    })
    await source.writeResource({
      spaceId,
      collectionId,
      resourceId: 'bulky',
      input: {
        kind: 'binary',
        contentType: 'application/octet-stream',
        stream: bufferStream(Buffer.alloc(300_000, 0x61))
      }
    })

    const small = await openTempBackend({
      prefix: 'was-test-dst-',
      capacityBytes: 100_000
    })

    await assert.rejects(
      importArchive({
        backend: small,
        spaceId,
        tarStream: await source.exportSpace({ spaceId })
      }),
      (err: unknown) => err instanceof QuotaExceededError
    )

    await source.close()
    await small.close()
  })
})

// A per-upload cap distinct from any cumulative quota: a single upload over
// this is 413, while smaller ones succeed even with no Space limit configured.
const MAX_UPLOAD_BYTES = 64 * 1024

describe('Upload cap (maxUploadBytes) (API)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    backend: TempFileSystemBackend
  let alice: any, aliceCredentials: any
  const spaceId = `upload-cap-${crypto.randomUUID()}`

  beforeAll(async () => {
    backend = await openTempBackend({ maxUploadBytes: MAX_UPLOAD_BYTES })
    // A per-upload cap but no cumulative Space quota: isolates 413 from 507.
    ;({ fastify, serverUrl } = await startTestServer({
      backend
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Upload Cap Space',
      controller: alice.did
    })
    aliceCredentials = await space.createCollection({
      id: 'credentials',
      name: 'Credentials'
    })
  })

  afterAll(async () => {
    await fastify.close()
  })

  it('accepts an upload under the cap', async () => {
    const result = await aliceCredentials.add({
      id: 'fits',
      name: 'Fits under the cap'
    })
    assert.ok(result.id)
    assert.notEqual(await aliceCredentials.get(result.id), null)
  })

  it('rejects an oversized JSON write with payload-too-large (413)', async () => {
    let thrown: any
    try {
      await aliceCredentials.put('too-big-json', {
        id: 'too-big-json',
        blob: OVERSIZED
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the oversized JSON write to be rejected')
    // 413 (not a wrapped 500) confirms the backend ProblemError passes through.
    assert.equal(thrown.status, 413)
    assert.match(thrown.title, /maximum upload size/i)
    assert.equal(await aliceCredentials.get('too-big-json'), null)
  })

  it('rejects an oversized blob write with payload-too-large (413)', async () => {
    const blob = new Blob([OVERSIZED], { type: 'text/plain' })
    let thrown: any
    try {
      await aliceCredentials.add(blob)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the oversized blob write to be rejected')
    assert.equal(thrown.status, 413)
    assert.match(thrown.title, /maximum upload size/i)
  })

  it('advertises maxUploadBytes in the quota report constraints', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}/quotas`,
      method: 'GET'
    })
    assert.equal(response.status, 200)
    const [entry] = (response.data as { backends: any[] }).backends
    assert.deepStrictEqual(entry.constraints, {
      maxUploadBytes: MAX_UPLOAD_BYTES
    })
  })
})

describe('Upload cap (maxUploadBytes) (backend)', () => {
  let backend: TempFileSystemBackend
  const spaceId = `upload-cap-backend-${crypto.randomUUID()}`
  const collectionId = 'credentials'

  beforeAll(async () => {
    backend = await openTempBackend({ maxUploadBytes: MAX_UPLOAD_BYTES })
    await backend.writeSpace({
      spaceId,
      spaceMetadata: {
        id: spaceId,
        type: ['Space'],
        controller: 'did:key:z6MkUploadCapController'
      }
    })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: {
        id: collectionId,
        type: ['Collection'],
        name: 'Credentials'
      }
    })
  })

  afterAll(async () => {
    await backend.close()
  })

  it('the streaming guard rejects an undeclared oversized blob and cleans up', async () => {
    // No `declaredBytes`, so the pre-flight cannot catch it -- the byte-counting
    // upload-cap guard must abort mid-stream.
    await assert.rejects(
      backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'guarded',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          stream: bufferStream(Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x61))
        }
      }),
      (err: unknown) => err instanceof PayloadTooLargeError
    )
    // The partial file was removed: the resource does not exist.
    await assert.rejects(
      backend.getResource({ spaceId, collectionId, resourceId: 'guarded' }),
      (err: unknown) => err instanceof ResourceNotFoundError
    )
  })
})

/** A single-chunk readable byte stream over a Buffer (objectMode off). */
function bufferStream(buffer: Buffer): Readable {
  return new Readable({
    read() {
      this.push(buffer)
      this.push(null)
    }
  })
}
