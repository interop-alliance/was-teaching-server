/**
 * Encryption-enforcement API tests (Vitest): the server's fail-closed structural
 * validation of content writes into an encrypted Collection (spec "Encryption
 * Scheme Registry"). When a Collection declares a recognized `encryption` scheme
 * (`edv`), a Resource write MUST be a conforming envelope of that scheme -- the
 * right media type (`application/jose+json`) carrying a structurally valid JWE.
 * A non-conforming write is rejected with `encryption-scheme-mismatch` (422), so
 * neither a buggy client nor a foreign writer can ever land server-visible
 * plaintext in an encrypted Collection. The server validates structure only and
 * never decrypts.
 *
 * These drive the wire contract directly via the signed `was.request()` escape
 * hatch (raw `HttpResponse` / raw errors), mirroring `encryption-marker-api`.
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

const JOSE = 'application/jose+json'
/** A minimal structurally-valid flattened JWE-JSON envelope. */
const envelope = { protected: 'eyJhbGciOiJkaXI', ciphertext: 'c1phertext' }

describe('Encryption enforcement API', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any
  const PORT = 7774
  const spaceId = `enc-enforce-space-${crypto.randomUUID()}`
  const edvCollection = 'vault'
  const plainCollection = 'plain'

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}`
    ;({ alice, bob } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })

    await alice.was.createSpace({
      id: spaceId,
      name: 'Encryption Enforce Space',
      controller: alice.did
    })
    // An encrypted Collection and a plaintext one, both owned by Alice.
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: edvCollection, name: 'Vault', encryption: { scheme: 'edv' } }
    })
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: plainCollection, name: 'Plain' }
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /** PUTs a raw body with an explicit content type to a Resource by id. */
  function putRaw(options: {
    who?: any
    collectionId: string
    resourceId: string
    body: unknown
    contentType: string
  }): Promise<any> {
    const { who = alice, collectionId, resourceId, body, contentType } = options
    return who.was.request({
      path: `/space/${spaceId}/${collectionId}/${resourceId}`,
      method: 'PUT',
      body: new TextEncoder().encode(
        typeof body === 'string' ? body : JSON.stringify(body)
      ),
      headers: { 'content-type': contentType }
    })
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

  it('accepts a conforming jose+json envelope on POST (create) into an edv Collection', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}/${edvCollection}/`,
      method: 'POST',
      body: new TextEncoder().encode(JSON.stringify(envelope)),
      headers: { 'content-type': JOSE }
    })
    assert.equal(response.status, 201)
  })

  it('accepts a conforming jose+json envelope on PUT (by id) into an edv Collection', async () => {
    const response = await putRaw({
      collectionId: edvCollection,
      resourceId: 'doc-put',
      body: envelope,
      contentType: JOSE
    })
    assert.equal(response.status, 204)
  })

  it('rejects a plaintext JSON body into an edv Collection (422 scheme-mismatch)', async () => {
    const err = await rejection(
      alice.was.request({
        path: `/space/${spaceId}/${edvCollection}/doc-plain`,
        method: 'PUT',
        json: { hello: 'world' }
      })
    )
    assert.equal(err.response.status, 422)
    assert.match(err.data.type, /#encryption-scheme-mismatch/)
  })

  it('rejects a wrong content type (octet-stream) into an edv Collection (422)', async () => {
    const err = await rejection(
      putRaw({
        collectionId: edvCollection,
        resourceId: 'doc-binary',
        body: envelope,
        contentType: 'application/octet-stream'
      })
    )
    assert.equal(err.response.status, 422)
    assert.match(err.data.type, /#encryption-scheme-mismatch/)
  })

  it('rejects the right content type but a non-envelope body (422)', async () => {
    const err = await rejection(
      putRaw({
        collectionId: edvCollection,
        resourceId: 'doc-malformed',
        body: { not: 'an envelope' },
        contentType: JOSE
      })
    )
    assert.equal(err.response.status, 422)
    assert.match(err.data.type, /#encryption-scheme-mismatch/)
  })

  it('a plaintext Collection still accepts any body (no enforcement)', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}/${plainCollection}/plain-doc`,
      method: 'PUT',
      json: { hello: 'world' }
    })
    assert.equal(response.status, 204)
  })

  it('ordering: an under-authorized writer into an edv Collection gets 404, not 422', async () => {
    // Bob does not control Alice's Space, so his invocation fails verification
    // first. The 422 gate runs only after auth, so he must never observe it (no
    // information leak about the target's encryption state).
    const err = await rejection(
      putRaw({
        who: bob,
        collectionId: edvCollection,
        resourceId: 'doc-bob',
        body: { hello: 'world' },
        contentType: 'application/json'
      })
    )
    assert.equal(err.response.status, 404)
  })

  it('scope: PUT .../meta on an edv Collection still accepts application/json', async () => {
    // Seed a Resource, then update its Metadata (a server-managed API document,
    // not a Resource content write) -- the encryption gate must not apply.
    await putRaw({
      collectionId: edvCollection,
      resourceId: 'doc-meta',
      body: envelope,
      contentType: JOSE
    })
    const response = await alice.was.request({
      path: `/space/${spaceId}/${edvCollection}/doc-meta/meta`,
      method: 'PUT',
      json: { custom: { name: 'labeled' } }
    })
    assert.equal(response.status, 204)
  })

  it('scope: PUT .../policy on an edv Collection still accepts application/json', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}/${edvCollection}/policy`,
      method: 'PUT',
      json: { type: 'PublicCanRead' }
    })
    assert.equal([200, 201, 204].includes(response.status), true)
  })
})
