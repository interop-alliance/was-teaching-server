/**
 * Update Space (`PUT /space/:spaceId/meta`) against a Space that changes
 * between the handler's unlocked read and its locked write (Vitest). A test
 * backend runs a queued interleaving before each `writeSpace`, so every race
 * lands deterministically inside that window.
 */
import { it, describe, beforeAll, afterAll, beforeEach } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { invalidateSpaceMetadata } from '../src/lib/spaceMetadataCache.js'
import {
  requestError,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'

type WriteSpaceOptions = Parameters<FileSystemBackend['writeSpace']>[0]

/**
 * A filesystem backend that runs the next queued interleaving before each
 * `writeSpace`, standing in for a concurrent writer that lands after the
 * handler's pre-read and before its write takes the lock. `churn`, when set,
 * runs before every one instead.
 */
class InterleavingBackend extends FileSystemBackend {
  interleavings: Array<() => Promise<void>> = []
  churn?: () => Promise<void>

  async writeSpace(options: WriteSpaceOptions) {
    await (this.churn ?? this.interleavings.shift())?.()
    return super.writeSpace(options)
  }

  /**
   * A write by the concurrent writer, which runs no interleaving of its own.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.controller {string}
   * @param [options.type] {string[]}
   * @param [options.name] {string}
   * @returns {Promise<void>}
   */
  async writeDirectly({
    spaceId,
    controller,
    type = ['Space'],
    name
  }: {
    spaceId: string
    controller: string
    type?: string[]
    name?: string
  }): Promise<void> {
    await super.writeSpace({
      spaceId,
      spaceMetadata: {
        id: spaceId,
        controller: controller as `did:${string}`,
        type,
        ...(name !== undefined && { name })
      }
    })
    invalidateSpaceMetadata({ storage: this, spaceId })
  }
}

describe('Update Space against a concurrently changing Space', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    backend: InterleavingBackend,
    alice: any,
    bob: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    backend = await InterleavingBackend.open({ dataDir })
    ;({ fastify, serverUrl } = await startTestServer({ backend }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  beforeEach(() => {
    backend.interleavings = []
    backend.churn = undefined
  })

  function putMeta({
    spaceId,
    body,
    headers
  }: {
    spaceId: string
    body: Record<string, unknown>
    headers?: Record<string, string>
  }): Promise<Response> {
    return responseOf(
      alice.was.request({
        url: `${serverUrl}/space/${spaceId}/meta`,
        method: 'PUT',
        json: { id: spaceId, controller: alice.did, ...body },
        ...(headers && { headers })
      })
    )
  }

  async function deleteSpace(spaceId: string): Promise<void> {
    await backend.deleteSpace({ spaceId })
    invalidateSpaceMetadata({ storage: backend, spaceId })
  }

  it("an update whose Space is re-created by another controller leaves the new controller's Space untouched", async () => {
    const spaceId = crypto.randomUUID()
    await backend.writeDirectly({ spaceId, controller: alice.did })
    backend.interleavings.push(async () => {
      await deleteSpace(spaceId)
      await backend.writeDirectly({ spaceId, controller: bob.did })
    })

    const response = await putMeta({ spaceId, body: { name: 'Stale' } })

    assert.equal(response.status, 404)
    const stored = await backend.getSpaceMetadata({ spaceId })
    assert.equal(stored!.controller, bob.did)
    assert.equal(stored!.name, undefined)
  })

  it('an update whose Space is deleted before the write is answered as a create', async () => {
    const spaceId = crypto.randomUUID()
    await backend.writeDirectly({
      spaceId,
      controller: alice.did,
      type: ['ExampleSpace', 'Space']
    })
    backend.interleavings.push(() => deleteSpace(spaceId))

    const response = await putMeta({ spaceId, body: { name: 'Again' } })

    assert.equal(response.status, 201)
    assert.equal(
      response.headers.get('location'),
      `${serverUrl}/space/${spaceId}/`
    )
    // Composed fresh, not from the deleted Space's type.
    const stored = await backend.getSpaceMetadata({ spaceId })
    assert.deepEqual(stored!.type, ['Space'])
    assert.equal(stored!.metaLocal, 0)
    assert.equal(stored!.updatedAtCounter, 0)
  })

  it('an update whose controller changes before the write is re-authorized against the new controller', async () => {
    const spaceId = crypto.randomUUID()
    await backend.writeDirectly({ spaceId, controller: alice.did })
    backend.interleavings.push(() =>
      backend.writeDirectly({ spaceId, controller: bob.did })
    )

    const response = await putMeta({ spaceId, body: { name: 'Stale' } })

    assert.equal(response.status, 404)
    const stored = await backend.getSpaceMetadata({ spaceId })
    assert.equal(stored!.controller, bob.did)
  })

  it('a header-less create that loses twice still gets no 412', async () => {
    const spaceId = crypto.randomUUID()
    backend.interleavings.push(
      () => backend.writeDirectly({ spaceId, controller: alice.did }),
      async () => {
        await deleteSpace(spaceId)
        await backend.writeDirectly({ spaceId, controller: alice.did })
      }
    )

    const response = await putMeta({ spaceId, body: { name: 'Mine' } })

    assert.equal(response.status, 204)
    const stored = await backend.getSpaceMetadata({ spaceId })
    assert.equal(stored!.name, 'Mine')
  })

  it("a create's If-None-Match naming another ETag is evaluated as sent", async () => {
    const spaceId = crypto.randomUUID()
    backend.interleavings.push(() =>
      backend.writeDirectly({ spaceId, controller: alice.did })
    )

    // The winner's ETag is not "stale.1", so the condition holds against it.
    const response = await putMeta({
      spaceId,
      body: { name: 'Conditional' },
      headers: { 'if-none-match': '"stale.1"' }
    })

    assert.equal(response.status, 204)
  })

  it("a create's If-None-Match: * that loses the race is still 412", async () => {
    const spaceId = crypto.randomUUID()
    backend.interleavings.push(() =>
      backend.writeDirectly({ spaceId, controller: alice.did })
    )

    const response = await putMeta({
      spaceId,
      body: { name: 'Guarded' },
      headers: { 'if-none-match': '*' }
    })

    assert.equal(response.status, 412)
  })

  it('a body without type is not refused when the Space is re-created with another type', async () => {
    const spaceId = crypto.randomUUID()
    await backend.writeDirectly({ spaceId, controller: alice.did })
    backend.interleavings.push(async () => {
      await deleteSpace(spaceId)
      await backend.writeDirectly({
        spaceId,
        controller: alice.did,
        type: ['ExampleSpace', 'Space']
      })
    })

    const response = await putMeta({ spaceId, body: { name: 'Untyped' } })

    assert.equal(response.status, 204)
    const stored = await backend.getSpaceMetadata({ spaceId })
    assert.deepEqual(stored!.type, ['ExampleSpace', 'Space'])
  })

  it('a Space that changes before every attempt is answered 503 with Retry-After', async () => {
    const spaceId = crypto.randomUUID()
    await backend.writeDirectly({ spaceId, controller: alice.did })
    // Every attempt loses, including the client's own retries of the 503.
    backend.churn = () =>
      backend.writeDirectly({ spaceId, controller: alice.did, name: 'Churn' })

    const err = await requestError(
      alice.was.request({
        url: `${serverUrl}/space/${spaceId}/meta`,
        method: 'PUT',
        json: { id: spaceId, controller: alice.did, name: 'Lost' }
      })
    )

    assert.equal(err.response.status, 503)
    assert.equal(err.response.headers.get('retry-after'), '1')
    assert.equal(err.data.type, 'about:blank')
    assert.equal(err.data.title, 'Service Unavailable')
    const stored = await backend.getSpaceMetadata({ spaceId })
    assert.equal(stored!.name, 'Churn')
  })
})
