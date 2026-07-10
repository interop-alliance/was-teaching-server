/**
 * Per-Collection backend resolver tests.
 * Proves that a Collection may now *select* a registered `external` backend and
 * that its **data plane** (resource bytes) is routed to that backend's adapter,
 * while the server `default` backend keeps the control plane. The provider
 * adapter is injected via `createApp({ providers })` -- here a fake `test-provider`
 * provider whose adapter is a second `FileSystemBackend` over its own dir, so a
 * routed Resource lands there and not in the default dir (zero Google
 * dependency). Also covers fail-closed behavior and the registration allowlist
 * (`WAS_ENABLED_BACKENDS`).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { BackendProviderRegistry } from '../src/types.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Per-Collection backend resolver (selectable registered backends)', () => {
  let fastify: FastifyInstance,
    defaultBackend: FileSystemBackend,
    providerBackend: FileSystemBackend,
    serverUrl: string,
    dataDir: string,
    providerDir: string,
    alice: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-default-'))
    providerDir = await mkdtemp(path.join(tmpdir(), 'was-test-provider-'))
    defaultBackend = new FileSystemBackend({ dataDir })
    providerBackend = new FileSystemBackend({ dataDir: providerDir })
    // A fake `test-provider` whose adapter is a second filesystem backend over
    // its own dir, so a Resource routed to it lands there, not in the default dir.
    const providers: BackendProviderRegistry = new Map([
      ['test-provider', () => providerBackend]
    ])
    ;({ fastify, serverUrl } = await startTestServer({
      backend: defaultBackend,
      providers
    }))
    ;({ alice } = await zcapClients({ serverUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
    await rm(providerDir, { recursive: true, force: true })
  })

  function url(relativePath: string): string {
    return new URL(relativePath, serverUrl).toString()
  }

  async function freshSpace(name: string): Promise<string> {
    const spaceId = crypto.randomUUID()
    await alice.was.createSpace({ id: spaceId, name, controller: alice.did })
    return spaceId
  }

  async function registerBackend(
    spaceId: string,
    id: string,
    provider = 'test-provider'
  ) {
    return alice.was.request({
      url: url(`/space/${spaceId}/backends`),
      method: 'POST',
      json: {
        id,
        provider,
        managedBy: 'external',
        connection: { kind: 'inmem' }
      }
    })
  }

  it("routes a selecting Collection's resource data to the registered backend", async () => {
    const spaceId = await freshSpace('Resolver Space')
    await registerBackend(spaceId, 'mem-1')

    // Create a Collection that selects the registered backend.
    const collectionId = 'photos'
    const createCol = await alice.was.request({
      url: url(`/space/${spaceId}/${collectionId}`),
      method: 'PUT',
      json: { id: collectionId, backend: { id: 'mem-1' } }
    })
    assert.equal(createCol.status, 201)
    assert.deepStrictEqual(createCol.data.backend, { id: 'mem-1' })

    // PUT a Resource into it.
    const resourceId = 'r1'
    const putRes = await alice.was.request({
      url: url(`/space/${spaceId}/${collectionId}/${resourceId}`),
      method: 'PUT',
      json: { hello: 'world' }
    })
    assert.equal(putRes.status, 204)

    // The bytes landed in the provider backend, NOT the default backend.
    const fromProvider = await providerBackend.getResource({
      spaceId,
      collectionId,
      resourceId
    })
    assert.equal(fromProvider.storedResourceType, 'application/json')
    let defaultThrew: unknown
    try {
      await defaultBackend.getResource({ spaceId, collectionId, resourceId })
    } catch (err) {
      defaultThrew = err
    }
    assert.ok(defaultThrew, 'resource must NOT exist in the default backend')

    // GET reads it back through the API (proving the read also resolves).
    const getRes = await alice.was.request({
      url: url(`/space/${spaceId}/${collectionId}/${resourceId}`),
      method: 'GET'
    })
    assert.equal(getRes.status, 200)
    assert.deepStrictEqual(getRes.data, { hello: 'world' })

    // GET .../backend echoes the external descriptor (resolved from the record).
    const backendRes = await alice.was.request({
      url: url(`/space/${spaceId}/${collectionId}/backend`),
      method: 'GET'
    })
    assert.equal(backendRes.status, 200)
    assert.equal(backendRes.data.id, 'mem-1')
    assert.equal(backendRes.data.provider, 'test-provider')
  })

  it('the default Collection path still writes to the default backend (unchanged)', async () => {
    const spaceId = await freshSpace('Default Path Space')
    const collectionId = 'notes'
    // No `backend` selection -> defaults to the server `default`.
    await alice.was.request({
      url: url(`/space/${spaceId}/${collectionId}`),
      method: 'PUT',
      json: { id: collectionId }
    })
    const resourceId = 'd1'
    await alice.was.request({
      url: url(`/space/${spaceId}/${collectionId}/${resourceId}`),
      method: 'PUT',
      json: { kind: 'default' }
    })

    // Lands in the default backend; never touches the provider backend.
    const fromDefault = await defaultBackend.getResource({
      spaceId,
      collectionId,
      resourceId
    })
    assert.equal(fromDefault.storedResourceType, 'application/json')
    let providerThrew: unknown
    try {
      await providerBackend.getResource({ spaceId, collectionId, resourceId })
    } catch (err) {
      providerThrew = err
    }
    assert.ok(providerThrew, 'resource must NOT exist in the provider backend')
  })

  it('a selection whose provider has no factory fails closed (409) at data-plane', async () => {
    const spaceId = await freshSpace('No Factory Space')
    // Registration is permissive (no allowlist), so an unknown provider records
    // fine; it is only the *data plane* that fails closed (no adapter factory).
    await registerBackend(spaceId, 'orphan-1', 'no-such-provider')
    const collectionId = 'docs'
    const createCol = await alice.was.request({
      url: url(`/space/${spaceId}/${collectionId}`),
      method: 'PUT',
      json: { id: collectionId, backend: { id: 'orphan-1' } }
    })
    // The selection itself is accepted (the backend is registered).
    assert.equal(createCol.status, 201)

    let thrown: any
    try {
      await alice.was.request({
        url: url(`/space/${spaceId}/${collectionId}/r1`),
        method: 'PUT',
        json: { x: 1 }
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the data-plane write to fail closed')
    assert.equal(thrown.response.status, 409)
  })

  it('selecting an unknown backend id is rejected at Collection write (409 unsupported-backend)', async () => {
    const spaceId = await freshSpace('Unknown Id Space')
    let thrown: any
    try {
      await alice.was.request({
        url: url(`/space/${spaceId}/docs`),
        method: 'PUT',
        json: { id: 'docs', backend: { id: 'does-not-exist' } }
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the unknown-backend selection to be rejected')
    assert.equal(thrown.response.status, 409)
    assert.equal(thrown.data.errors[0].pointer, '#/backend')
  })
})

describe('Backend registration allowlist (WAS_ENABLED_BACKENDS)', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-allowlist-'))
    // Only `test-provider` may be registered.
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir }),
      enabledBackendProviders: ['test-provider']
    }))
    ;({ alice } = await zcapClients({ serverUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  function backendsUrl(spaceId: string): string {
    return new URL(`/space/${spaceId}/backends`, serverUrl).toString()
  }

  async function freshSpace(name: string): Promise<string> {
    const spaceId = crypto.randomUUID()
    await alice.was.createSpace({ id: spaceId, name, controller: alice.did })
    return spaceId
  }

  it('accepts a provider on the allowlist (201)', async () => {
    const spaceId = await freshSpace('Allowed Provider Space')
    const response = await alice.was.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: {
        id: 'mem-1',
        provider: 'test-provider',
        managedBy: 'external',
        connection: { kind: 'inmem' }
      }
    })
    assert.equal(response.status, 201)
    assert.equal(response.data.provider, 'test-provider')
  })

  it('rejects a provider not on the allowlist at POST (409, #/provider)', async () => {
    const spaceId = await freshSpace('Disallowed Provider Space')
    let thrown: any
    try {
      await alice.was.request({
        url: backendsUrl(spaceId),
        method: 'POST',
        json: {
          id: 'gd-1',
          provider: 'gdrive',
          managedBy: 'external',
          connection: { kind: 'oauth2' }
        }
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the disallowed provider to be rejected')
    assert.equal(thrown.response.status, 409)
    assert.equal(thrown.data.errors[0].pointer, '#/provider')
  })
})
