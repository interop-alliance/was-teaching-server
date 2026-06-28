/**
 * Encryption-marker API tests (Vitest): the server's accept / validate /
 * persist / set-once handling of a Collection's client-side `encryption` marker
 * (spec "Encrypted Collections"). The server never decrypts -- it stores the
 * marker opaquely, validates only its shape, and enforces set-once immutability.
 *
 * These assert the server's wire contract directly (status codes, problem
 * `type`s, the echoed Description) via the signed `was.request()` escape hatch
 * (raw `HttpResponse` / raw errors), mirroring `wire-contract-api.test.ts` --
 * the high-level handles hide exactly those details. End-to-end coverage through
 * the high-level client lives in `@interop/was-client`'s own EDV integration
 * suite and the `conformance/` marker test.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

describe('Encryption marker API', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any
  const PORT = 7773
  const spaceId = `enc-marker-space-${crypto.randomUUID()}`

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}`
    ;({ alice } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })

    await alice.was.createSpace({
      id: spaceId,
      name: 'Encryption Marker Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /** Reads a Collection Description over the wire (raw JSON). */
  async function describe(collectionId: string): Promise<any> {
    const response = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'GET'
    })
    return response.data
  }

  /** Captures the raw error from a `was.request()` rejection. */
  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
      assert.fail('expected the request to be rejected')
    } catch (err) {
      return err
    }
  }

  it('persists and echoes the marker on create', async () => {
    const collectionId = 'vault'
    const response = await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Vault', encryption: { scheme: 'edv' } }
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual(response.data.encryption, { scheme: 'edv' })
    assert.deepStrictEqual((await describe(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('omits the marker for a plaintext collection (no encryption sent)', async () => {
    const collectionId = 'plain'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Plain' }
    })
    assert.equal((await describe(collectionId)).encryption, undefined)
  })

  it('preserves unknown extra marker fields opaquely (forward-compat)', async () => {
    const collectionId = 'forward'
    const marker = { scheme: 'edv', recipients: [{ id: 'k1', type: 'X' }] }
    const response = await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: marker }
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual((await describe(collectionId)).encryption, marker)
  })

  it('rejects a marker object without a string scheme (400)', async () => {
    const err = await rejection(
      alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: 'bad-noscheme', encryption: { foo: 1 } }
      })
    )
    assert.equal(err.response.status, 400)
    // The http-client layer pre-parses the problem+json body onto `err.data`.
    assert.match(err.data.type, /#invalid-request-body/)
    assert.equal(err.data.errors?.[0]?.pointer, '#/encryption')
  })

  it('rejects a non-object marker (400)', async () => {
    const err = await rejection(
      alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: 'bad-string', encryption: 'edv' }
      })
    )
    assert.equal(err.response.status, 400)
  })

  it('allows declaring a marker on an existing plaintext collection (absent -> present)', async () => {
    const collectionId = 'late-declare'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Late' }
    })
    const put = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    assert.equal(put.status, 204)
    assert.deepStrictEqual((await describe(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('allows re-sending the same marker (same -> same is a no-op)', async () => {
    const collectionId = 'idempotent'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    const put = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    assert.equal(put.status, 204)
  })

  it('rejects changing an existing marker scheme (409 encryption-immutable)', async () => {
    const collectionId = 'immutable'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    const err = await rejection(
      alice.was.request({
        path: `/space/${spaceId}/${collectionId}`,
        method: 'PUT',
        json: { id: collectionId, encryption: { scheme: 'other' } }
      })
    )
    assert.equal(err.response.status, 409)
    assert.match(err.data.type, /#encryption-immutable/)
    // The stored marker is unchanged.
    assert.deepStrictEqual((await describe(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('leaves an existing marker untouched when an update omits encryption', async () => {
    const collectionId = 'untouched'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    // A name-only update must not clear the marker.
    await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, name: 'Renamed' }
    })
    const desc = await describe(collectionId)
    assert.equal(desc.name, 'Renamed')
    assert.deepStrictEqual(desc.encryption, { scheme: 'edv' })
  })
})
