/**
 * Collection Metadata full-replacement tests (Vitest): the two members whose
 * behavior under an omitting `PUT .../meta` is not plain clearing.
 *
 * `PUT` of a Collection Metadata object is a full replacement, so a writable
 * member the request omits is cleared (spec "Update (or Create by Id)
 * Collection"). Two members qualify that here. An omitting update keeps the
 * stored `backend` selection, as that spec section requires, rather than
 * repointing the data plane at the server default. And `custom` is cleared by omission on an encrypted Collection as
 * much as on a plaintext one -- an absent value is the absence of
 * annotations, not a malformed encryption envelope.
 *
 * These drive the server through the `was.request()` escape hatch rather than
 * the high-level handles: the point is the wire behavior of one `PUT`, and the
 * assertions read the stored object back over the same wire.
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

describe('Collection Metadata full replacement', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    providerDir: string,
    providerBackend: FileSystemBackend,
    alice: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    providerDir = await mkdtemp(path.join(tmpdir(), 'was-test-provider-'))
    providerBackend = new FileSystemBackend({ dataDir: providerDir })
    // A fake provider whose adapter is a second filesystem backend over its
    // own dir, so a Resource routed to it demonstrably lands elsewhere.
    const providers: BackendProviderRegistry = new Map([
      ['test-provider', () => providerBackend]
    ])
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir }),
      providers
    }))
    ;({ alice } = await zcapClients({ serverUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
    await rm(providerDir, { recursive: true, force: true })
  })

  /** Provisions a fresh Space and returns its id. */
  async function freshSpace(): Promise<string> {
    const spaceId = `replace-space-${crypto.randomUUID()}`
    await alice.was.request({
      path: '/spaces/',
      method: 'POST',
      json: { id: spaceId, name: 'Replacement Space', controller: alice.did }
    })
    return spaceId
  }

  /** Reads a Collection Metadata object over the wire (raw JSON). */
  async function readMeta(spaceId: string, collectionId: string): Promise<any> {
    const response = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    return response.data
  }

  describe('`backend` survives an update that omits it', () => {
    it('keeps a registered selection, and the Resources stay reachable', async () => {
      const spaceId = await freshSpace()
      await alice.was.request({
        path: `/space/${spaceId}/backends`,
        method: 'POST',
        json: {
          id: 'mem-1',
          provider: 'test-provider',
          managedBy: 'external',
          connection: { kind: 'inmem' }
        }
      })

      const created = await alice.was.request({
        path: `/space/${spaceId}/photos/meta`,
        method: 'PUT',
        json: { id: 'photos', backend: { id: 'mem-1' } }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.backend, { id: 'mem-1' })

      await alice.was.request({
        path: `/space/${spaceId}/photos/r1`,
        method: 'PUT',
        json: { hello: 'world' }
      })

      // A rename: the body carries no `backend`. Clearing it here would
      // repoint the data plane at the server default and strand `r1`.
      const renamed = await alice.was.request({
        path: `/space/${spaceId}/photos/meta`,
        method: 'PUT',
        json: { id: 'photos', name: 'Renamed' }
      })
      assert.equal(renamed.status, 204)

      const meta = await readMeta(spaceId, 'photos')
      assert.equal(meta.name, 'Renamed')
      assert.deepStrictEqual(meta.backend, { id: 'mem-1' })

      // The Resource is still listed and still readable.
      const listing = await alice.was.request({
        path: `/space/${spaceId}/photos/`,
        method: 'GET'
      })
      assert.deepStrictEqual(
        listing.data.items.map((item: { id: string }) => item.id),
        ['r1']
      )
      const read = await alice.was.request({
        path: `/space/${spaceId}/photos/r1`,
        method: 'GET'
      })
      assert.deepStrictEqual(read.data, { hello: 'world' })
    })

    it('still defaults to the server backend on a create that omits it', async () => {
      const spaceId = await freshSpace()
      const created = await alice.was.request({
        path: `/space/${spaceId}/notes/meta`,
        method: 'PUT',
        json: { id: 'notes' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.backend, { id: 'default' })
    })

    it('still accepts an explicit change of the selection', async () => {
      const spaceId = await freshSpace()
      await alice.was.request({
        path: `/space/${spaceId}/backends`,
        method: 'POST',
        json: {
          id: 'mem-2',
          provider: 'test-provider',
          managedBy: 'external',
          connection: { kind: 'inmem' }
        }
      })
      await alice.was.request({
        path: `/space/${spaceId}/docs/meta`,
        method: 'PUT',
        json: { id: 'docs' }
      })
      const updated = await alice.was.request({
        path: `/space/${spaceId}/docs/meta`,
        method: 'PUT',
        json: { id: 'docs', backend: { id: 'mem-2' } }
      })
      assert.equal(updated.status, 204)
      assert.deepStrictEqual((await readMeta(spaceId, 'docs')).backend, {
        id: 'mem-2'
      })
    })
  })

  describe('an omitted `custom` clears rather than failing the envelope check', () => {
    const descriptor = { scheme: 'edv', version: 1 }

    it('lets an encrypted Collection created without `custom` be updated', async () => {
      const spaceId = await freshSpace()
      const created = await alice.was.request({
        path: `/space/${spaceId}/vault/meta`,
        method: 'PUT',
        json: { id: 'vault', encryption: descriptor }
      })
      assert.equal(created.status, 201)
      assert.equal(created.data.custom, undefined)

      // The same descriptor plus a name, still carrying no `custom`. Judging
      // the absent value as an envelope would refuse this with a 422 and
      // freeze the Collection for good.
      const renamed = await alice.was.request({
        path: `/space/${spaceId}/vault/meta`,
        method: 'PUT',
        json: { id: 'vault', name: 'Vault', encryption: descriptor }
      })
      assert.equal(renamed.status, 204)

      const meta = await readMeta(spaceId, 'vault')
      assert.equal(meta.name, 'Vault')
      assert.deepStrictEqual(meta.encryption, descriptor)
      assert.equal(meta.custom, undefined)
    })

    it('clears a stored envelope when a later update omits it', async () => {
      const spaceId = await freshSpace()
      await alice.was.request({
        path: `/space/${spaceId}/vault/meta`,
        method: 'PUT',
        json: {
          id: 'vault',
          encryption: descriptor,
          // A structurally valid EDV Encrypted Document: a `jwe` envelope
          // with a non-empty `ciphertext` and one key-delivery member.
          custom: {
            jwe: { ciphertext: 'c', iv: 'i', tag: 't', protected: 'p' }
          }
        }
      })
      assert.notEqual((await readMeta(spaceId, 'vault')).custom, undefined)

      const cleared = await alice.was.request({
        path: `/space/${spaceId}/vault/meta`,
        method: 'PUT',
        json: { id: 'vault', encryption: descriptor }
      })
      assert.equal(cleared.status, 204)
      assert.equal((await readMeta(spaceId, 'vault')).custom, undefined)
    })
  })
})
