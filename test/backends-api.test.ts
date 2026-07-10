/**
 * Space backend registration API tests (Vitest): POST / PUT / DELETE
 * `/space/:id/backends[/:backendId]`. Asserts the secret-bearing write vs.
 * sanitized read split, capability-only authorization, and that registration
 * records do not travel in a Space export.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Space backend registration (/backends)', () => {
  let fastify: FastifyInstance,
    backend: FileSystemBackend,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any

  // A registration whose connection carries secret grant material; the response
  // and listing must never echo `authorizationCode` / `refreshToken`.
  function sampleRegistration(id = 'gdrive-1') {
    return {
      id,
      name: 'My Google Drive',
      managedBy: 'external',
      provider: 'google-drive',
      storageMode: ['document', 'blob'],
      connection: {
        kind: 'oauth2',
        authorizationCode: 'super-secret-auth-code',
        refreshToken: 'super-secret-refresh-token',
        account: 'alice@example.com',
        scope: 'drive.file'
      }
    }
  }

  // The single server-configured filesystem backend, registered as `default`.
  const defaultBackendDescriptor = {
    id: 'default',
    name: 'Server Filesystem',
    managedBy: 'server',
    storageMode: ['document', 'blob'],
    persistence: 'durable',
    features: ['conditional-writes', 'changes-query', 'blinded-index-query']
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    backend = new FileSystemBackend({ dataDir })
    ;({ fastify, serverUrl } = await startTestServer({ backend }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  async function freshSpace(name: string): Promise<string> {
    const spaceId = crypto.randomUUID()
    await alice.was.createSpace({ id: spaceId, name, controller: alice.did })
    return spaceId
  }

  function backendsUrl(spaceId: string, backendId?: string): string {
    const base = `/space/${spaceId}/backends`
    return new URL(
      backendId ? `${base}/${backendId}` : base,
      serverUrl
    ).toString()
  }

  function assertNoSecrets(descriptor: any): void {
    assert.equal(descriptor.connection.authorizationCode, undefined)
    assert.equal(descriptor.connection.refreshToken, undefined)
    assert.equal(descriptor.authorizationCode, undefined)
    assert.equal(descriptor.refreshToken, undefined)
  }

  it('POST registers an external backend (201, sanitized descriptor)', async () => {
    const spaceId = await freshSpace('Register Space')
    const response = await alice.was.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    assert.equal(response.status, 201)
    assert.equal(
      response.headers.get('location'),
      backendsUrl(spaceId, 'gdrive-1')
    )
    assert.equal(response.data.id, 'gdrive-1')
    assert.equal(response.data.managedBy, 'external')
    assert.equal(response.data.provider, 'google-drive')
    assert.equal(response.data.connection.kind, 'oauth2')
    assert.equal(response.data.connection.status, 'registered')
    // Public connection metadata is surfaced; secrets are not.
    assert.equal(response.data.connection.account, 'alice@example.com')
    assert.equal(response.data.connection.scope, 'drive.file')
    assertNoSecrets(response.data)
  })

  it('GET /backends lists [default, registered] without secrets', async () => {
    const spaceId = await freshSpace('Listing Space')
    await alice.was.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    const response = await alice.was.request({
      url: backendsUrl(spaceId),
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.equal(response.data.length, 2)
    assert.deepStrictEqual(response.data[0], defaultBackendDescriptor)
    assert.equal(response.data[1].id, 'gdrive-1')
    assertNoSecrets(response.data[1])
  })

  it('POST a duplicate id yields id-conflict (409)', async () => {
    const spaceId = await freshSpace('Duplicate Space')
    await alice.was.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    let thrown: any
    try {
      await alice.was.request({
        url: backendsUrl(spaceId),
        method: 'POST',
        json: sampleRegistration()
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the duplicate-id POST to be rejected')
    assert.equal(thrown.response.status, 409)
    assert.equal(thrown.data.errors[0].pointer, '#/id')
  })

  it('POST id "default" is rejected (400)', async () => {
    const spaceId = await freshSpace('Reserved Id Space')
    let thrown: any
    try {
      await alice.was.request({
        url: backendsUrl(spaceId),
        method: 'POST',
        json: { ...sampleRegistration(), id: 'default' }
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the default-id POST to be rejected')
    assert.equal(thrown.response.status, 400)
    assert.equal(thrown.data.errors[0].pointer, '#/id')
  })

  it('POST missing provider or connection is rejected (400)', async () => {
    const spaceId = await freshSpace('Invalid Body Space')

    for (const [field, body] of [
      ['provider', { id: 'x', connection: { kind: 'oauth2' } }],
      ['connection', { id: 'x', provider: 'google-drive' }]
    ] as const) {
      let thrown: any
      try {
        await alice.was.request({
          url: backendsUrl(spaceId),
          method: 'POST',
          json: body
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, `expected missing ${field} to be rejected`)
      assert.equal(thrown.response.status, 400)
      assert.equal(thrown.data.errors[0].pointer, `#/${field}`)
    }
  })

  it('POST without auth headers is unauthorized (401)', async () => {
    const spaceId = await freshSpace('Unauthenticated Space')
    const response = await fetch(
      new URL(`/space/${spaceId}/backends`, serverUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sampleRegistration())
      }
    )
    assert.equal(response.status, 401)
  })

  it('POST by a non-controller is masked as not-found (404)', async () => {
    const spaceId = await freshSpace('Foreign Controller Space')
    let thrown: any
    try {
      await bob.was.request({
        url: backendsUrl(spaceId),
        method: 'POST',
        json: sampleRegistration()
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, "expected bob's POST to alice's space to be rejected")
    assert.equal(thrown.response.status, 404)
  })

  it('PUT updates an existing backend (204) and the change is reflected', async () => {
    const spaceId = await freshSpace('Update Space')
    await alice.was.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    const updated = sampleRegistration()
    updated.connection.account = 'alice-new@example.com'
    const putResponse = await alice.was.request({
      url: backendsUrl(spaceId, 'gdrive-1'),
      method: 'PUT',
      json: updated
    })
    assert.equal(putResponse.status, 204)

    const listing = await alice.was.request({
      url: backendsUrl(spaceId),
      method: 'GET'
    })
    const registered = listing.data.find((b: any) => b.id === 'gdrive-1')
    assert.equal(registered.connection.account, 'alice-new@example.com')
    assertNoSecrets(registered)
  })

  it('PUT creates a new backend at a chosen id (201)', async () => {
    const spaceId = await freshSpace('Upsert Create Space')
    const response = await alice.was.request({
      url: backendsUrl(spaceId, 'gdrive-2'),
      method: 'PUT',
      json: sampleRegistration('gdrive-2')
    })
    assert.equal(response.status, 201)
    assert.equal(
      response.headers.get('location'),
      backendsUrl(spaceId, 'gdrive-2')
    )
    assert.equal(response.data.id, 'gdrive-2')
    assertNoSecrets(response.data)
  })

  it('PUT whose body id does not match the URL id is rejected (400)', async () => {
    const spaceId = await freshSpace('Mismatch Space')
    let thrown: any
    try {
      await alice.was.request({
        url: backendsUrl(spaceId, 'gdrive-1'),
        method: 'PUT',
        json: sampleRegistration('different-id')
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the id-mismatch PUT to be rejected')
    assert.equal(thrown.response.status, 400)
    assert.equal(thrown.data.errors[0].pointer, '#/id')
  })

  it('DELETE deregisters a backend (204) and it no longer lists', async () => {
    const spaceId = await freshSpace('Delete Space')
    await alice.was.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    const deleteResponse = await alice.was.request({
      url: backendsUrl(spaceId, 'gdrive-1'),
      method: 'DELETE'
    })
    assert.equal(deleteResponse.status, 204)

    const listing = await alice.was.request({
      url: backendsUrl(spaceId),
      method: 'GET'
    })
    assert.deepStrictEqual(listing.data, [defaultBackendDescriptor])
  })

  it('registration records do not travel in a Space export', async () => {
    const src = await freshSpace('Export Source Space')
    await alice.was.request({
      url: backendsUrl(src),
      method: 'POST',
      json: sampleRegistration()
    })
    // Sanity: the record is present on the source.
    assert.equal((await backend.listBackends({ spaceId: src })).length, 1)

    const dst = await freshSpace('Export Target Space')
    const pack = await backend.exportSpace({ spaceId: src })
    await backend.importSpace({ spaceId: dst, tarStream: pack })

    // The registration did not travel: the target has no registered backends,
    // so its GET /backends reports only the server default.
    assert.deepStrictEqual(await backend.listBackends({ spaceId: dst }), [])
    const listing = await alice.was.request({
      url: backendsUrl(dst),
      method: 'GET'
    })
    assert.deepStrictEqual(listing.data, [defaultBackendDescriptor])
  })
})
