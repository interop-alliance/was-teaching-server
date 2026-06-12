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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { QuotaExceededError, ResourceNotFoundError } from '../src/errors.js'
import { zcapClients } from './helpers.js'

// 512 KiB cap; oversized payloads below exceed it outright (regardless of the
// small baseline usage from provisioning the Space + Collection).
const CAPACITY_BYTES = 512 * 1024
const OVERSIZED = 'x'.repeat(600 * 1024)

describe('Quota enforcement (API)', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string
  let alice: any, aliceCredentials: any
  const PORT = 7793
  const spaceId = `quota-enforce-${crypto.randomUUID()}`

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}`
    ;({ alice } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir, capacityBytes: CAPACITY_BYTES })
    })
    await fastify.listen({ port: PORT })

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
    await rm(dataDir, { recursive: true, force: true })
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
  let dataDir: string
  let backend: FileSystemBackend
  const spaceId = `quota-backend-${crypto.randomUUID()}`
  const collectionId = 'credentials'
  // Small enough that a ~300 KB resource overflows it, large enough that
  // provisioning the Space + Collection fits.
  const capacityBytes = 200_000

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    backend = new FileSystemBackend({ dataDir, capacityBytes })
    await backend.writeSpace({
      spaceId,
      spaceDescription: {
        id: spaceId,
        type: ['Space'],
        controller: 'did:key:z6MkBackendTestController'
      }
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

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
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

  it('importSpace rejects a bulk import that exceeds the quota', async () => {
    // Stage an export from an unlimited backend that holds a ~300 KB resource,
    // then import it into a backend whose capacity cannot hold it.
    const sourceDir = await mkdtemp(path.join(tmpdir(), 'was-test-src-'))
    const source = new FileSystemBackend({ dataDir: sourceDir })
    await source.writeSpace({
      spaceId,
      spaceDescription: {
        id: spaceId,
        type: ['Space'],
        controller: 'did:key:z6MkBackendTestController'
      }
    })
    await source.writeCollection({
      spaceId,
      collectionId,
      collectionDescription: {
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

    const smallDir = await mkdtemp(path.join(tmpdir(), 'was-test-dst-'))
    const small = new FileSystemBackend({
      dataDir: smallDir,
      capacityBytes: 100_000
    })

    await assert.rejects(
      small.importSpace({
        spaceId,
        tarStream: await source.exportSpace({ spaceId })
      }),
      (err: unknown) => err instanceof QuotaExceededError
    )

    await rm(sourceDir, { recursive: true, force: true })
    await rm(smallDir, { recursive: true, force: true })
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
