/**
 * Collection app-attribution API tests (Vitest): the server's accept /
 * validate / persist / echo handling of the OPTIONAL `generator` and
 * `generatorOrigin` members of a Collection Description (spec "Collection Data
 * Model"). Both are assertions by the Space controller -- writable at create
 * AND on update (so a wallet can backfill an existing Collection), stored
 * verbatim, never verified by the server and never an authorization input --
 * in contrast to the server-observed, read-only `createdBy`, which these
 * writes must leave untouched.
 *
 * These assert the server's wire contract directly (status codes, problem
 * `type`s, the echoed Description) via the signed `was.request()` escape hatch
 * (raw `HttpResponse` / raw errors), mirroring
 * `encryption-descriptor-api.test.ts` -- the high-level handles hide exactly
 * those details.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Collection generator attribution API', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any
  const spaceId = `generator-space-${crypto.randomUUID()}`
  const generator = 'did:key:zAppKeyExample'
  const generatorOrigin = 'https://app.example.com'

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    await alice.was.createSpace({
      id: spaceId,
      name: 'Generator Attribution Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /** Reads a Collection Description over the wire (raw JSON). */
  async function readDesc(collectionId: string): Promise<any> {
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

  it('persists and echoes both members on create', async () => {
    const collectionId = 'app-notes'
    const response = await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'App Notes', generator, generatorOrigin }
    })
    assert.equal(response.status, 201)
    assert.equal(response.data.generator, generator)
    assert.equal(response.data.generatorOrigin, generatorOrigin)
    // The create response and a subsequent Get Collection agree.
    const desc = await readDesc(collectionId)
    assert.equal(desc.generator, generator)
    assert.equal(desc.generatorOrigin, generatorOrigin)
  })

  it('omits both members when the create sent neither', async () => {
    const collectionId = 'unattributed'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Unattributed' }
    })
    const desc = await readDesc(collectionId)
    assert.equal(desc.generator, undefined)
    assert.equal(desc.generatorOrigin, undefined)
  })

  it('stamps attribution onto an existing collection that lacked it (backfill)', async () => {
    const collectionId = 'backfill'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Backfill' }
    })
    const put = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, generator, generatorOrigin }
    })
    assert.equal(put.status, 204)
    const desc = await readDesc(collectionId)
    assert.equal(desc.generator, generator)
    assert.equal(desc.generatorOrigin, generatorOrigin)
    // The backfill left the rest of the Description alone.
    assert.equal(desc.name, 'Backfill')
  })

  it('overwrites a stored value when an update supplies a new one', async () => {
    const collectionId = 'reattributed'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, generator, generatorOrigin }
    })
    const put = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: {
        id: collectionId,
        generator: 'did:key:zOtherApp',
        generatorOrigin: 'https://other.example.com'
      }
    })
    assert.equal(put.status, 204)
    const desc = await readDesc(collectionId)
    assert.equal(desc.generator, 'did:key:zOtherApp')
    assert.equal(desc.generatorOrigin, 'https://other.example.com')
  })

  it('preserves stored attribution when an update supplies only a name', async () => {
    const collectionId = 'name-only-update'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Before', generator, generatorOrigin }
    })
    const put = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, name: 'After' }
    })
    assert.equal(put.status, 204)
    const desc = await readDesc(collectionId)
    assert.equal(desc.name, 'After')
    assert.equal(desc.generator, generator)
    assert.equal(desc.generatorOrigin, generatorOrigin)
  })

  it('creates a collection by id with attribution (PUT create branch)', async () => {
    const collectionId = 'put-created'
    const put = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, generator, generatorOrigin }
    })
    assert.equal(put.status, 201)
    const desc = await readDesc(collectionId)
    assert.equal(desc.generator, generator)
    assert.equal(desc.generatorOrigin, generatorOrigin)
  })

  it('leaves the server-observed createdBy untouched by an attribution write', async () => {
    const collectionId = 'provenance'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, generator, generatorOrigin }
    })
    assert.equal((await readDesc(collectionId)).createdBy, alice.did)
    await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: {
        id: collectionId,
        generator: 'did:key:zOtherApp',
        generatorOrigin: 'https://other.example.com'
      }
    })
    const desc = await readDesc(collectionId)
    assert.equal(desc.createdBy, alice.did)
    assert.equal(desc.generator, 'did:key:zOtherApp')
  })

  describe('validation', () => {
    /** POSTs a create with the given body members and returns the raw error. */
    async function postRejection(json: Record<string, unknown>): Promise<any> {
      return rejection(
        alice.was.request({
          path: `/space/${spaceId}/`,
          method: 'POST',
          json
        })
      )
    }

    it('rejects a non-string generator (400)', async () => {
      const err = await postRejection({
        id: 'bad-generator-object',
        generator: { id: 'did:key:zApp' }
      })
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-request-body/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/generator')
    })

    it('rejects an empty-string generator (400)', async () => {
      const err = await postRejection({
        id: 'bad-generator-empty',
        generator: ''
      })
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/generator')
    })

    it('rejects a generator that is not a DID (400)', async () => {
      const err = await postRejection({
        id: 'bad-generator-url',
        generator: 'https://app.example.com'
      })
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-request-body/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/generator')
    })

    it('rejects a generatorOrigin carrying a path (400)', async () => {
      const err = await postRejection({
        id: 'bad-origin-path',
        generatorOrigin: 'https://app.example.com/app'
      })
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-request-body/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/generatorOrigin')
    })

    it('rejects a generatorOrigin with a trailing slash (400)', async () => {
      const err = await postRejection({
        id: 'bad-origin-slash',
        generatorOrigin: 'https://app.example.com/'
      })
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/generatorOrigin')
    })

    it('rejects an empty or non-string generatorOrigin (400)', async () => {
      for (const generatorOrigin of ['', 'app.example.com', 42]) {
        const err = await postRejection({
          id: `bad-origin-${String(generatorOrigin)}`,
          generatorOrigin
        })
        assert.equal(err.response.status, 400)
        assert.equal(err.data.errors?.[0]?.pointer, '#/generatorOrigin')
      }
    })

    it('rejects an invalid value on update too, leaving the stored one intact', async () => {
      const collectionId = 'update-validated'
      await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, generator, generatorOrigin }
      })
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/${collectionId}`,
          method: 'PUT',
          json: { id: collectionId, generator: 'not-a-did' }
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/generator')
      const desc = await readDesc(collectionId)
      assert.equal(desc.generator, generator)
      assert.equal(desc.generatorOrigin, generatorOrigin)
    })
  })
})
