/**
 * Collections API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { NotFoundError } from '@interop/was-client'
import type { Space } from '@interop/was-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Collections API', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    aliceSpace: Space

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    // Provision the Space this suite operates on. This suite uses its own
    // temp dataDir, so it must create the Space here rather than relying on
    // filesystem state left behind by other test files.
    aliceSpace = await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('POST /space/:spaceId/ should 401 error when no authorization headers', async () => {
    const response = await fetch(new URL('/space/any-space-id/', serverUrl), {
      method: 'POST'
    })
    assert.equal(response.status, 401)
    assert.match(
      response.headers.get('content-type')!,
      /application\/problem\+json/
    )
  })

  it('POST /space/:spaceId/ should fail (NotFoundError) on not found space id', async () => {
    // Adding a collection to a missing space is a write -- WAS does not
    // auto-create parents, so it surfaces as NotFoundError (server 404).
    await assert.rejects(
      alice.was
        .space('space-id-that-does-not-exist')
        .createCollection({ name: 'Test Collection' }),
      (err: unknown) => err instanceof NotFoundError
    )
  })

  it('[root] create collection via POST', async () => {
    const collection = await aliceSpace.createCollection({
      id: 'credentials',
      name: 'Verifiable Credentials'
    })
    assert.equal(collection.id, 'credentials')
    assert.deepStrictEqual(await collection.describe(), {
      id: 'credentials',
      name: 'Verifiable Credentials',
      type: ['Collection'],
      backend: { id: 'default' },
      createdBy: alice.did,
      url: `/space/${alice.space1.id}/credentials`,
      linkset: `/space/${alice.space1.id}/credentials/linkset`
    })
  })

  it('POST with an existing collection id yields id-conflict (409)', async () => {
    const collectionId = crypto.randomUUID()
    await aliceSpace.createCollection({
      id: collectionId,
      name: 'Conflict Test Collection'
    })

    let expectedError: any
    try {
      await alice.was.request({
        url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
        method: 'POST',
        json: { id: collectionId, name: 'Replacement' }
      })
    } catch (error) {
      expectedError = error
    }
    assert.ok(expectedError, 'expected the duplicate-id POST to be rejected')
    assert.equal(expectedError.response.status, 409)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#id-conflict'
    )
    assert.equal(expectedError.data.errors[0].pointer, '#/id')

    // The description is untouched.
    const description = await aliceSpace.collection(collectionId).describe()
    assert.equal(description!.name, 'Conflict Test Collection')
  })

  it('[root] list collection items via GET :collectionId/', async () => {
    const listing = await aliceSpace.collection('credentials').list()
    assert.ok(listing)
    assert.equal(listing.id, 'credentials')
    assert.equal(listing.url, `/space/${alice.space1.id}/credentials`)
    assert.equal(listing.name, 'Verifiable Credentials')
    assert.deepStrictEqual(listing.type, ['Collection'])
    assert.equal(typeof listing.totalItems, 'number')
    assert.ok(Array.isArray(listing.items))
    assert.equal(listing.totalItems, listing.items.length)
  })

  it('[root] get collection description via GET :collectionId', async () => {
    assert.deepStrictEqual(
      await aliceSpace.collection('credentials').describe(),
      {
        id: 'credentials',
        name: 'Verifiable Credentials',
        type: ['Collection'],
        backend: { id: 'default' },
        createdBy: alice.did,
        url: `/space/${alice.space1.id}/credentials`,
        linkset: `/space/${alice.space1.id}/credentials/linkset`
      }
    )
  })

  it('[root] a PUT whose body carries a forged createdBy does not change the stored value', async () => {
    const collectionId = crypto.randomUUID()
    await aliceSpace.createCollection({
      id: collectionId,
      name: 'Forged createdBy Collection'
    })

    await alice.was.request({
      url: new URL(
        `/space/${alice.space1.id}/${collectionId}`,
        serverUrl
      ).toString(),
      method: 'PUT',
      json: { name: 'Renamed', createdBy: 'did:key:zEVIL' }
    })

    const description = await aliceSpace.collection(collectionId).describe()
    assert.equal(description?.createdBy, alice.did)
    assert.equal(description?.name, 'Renamed')
  })

  it('[root] create and delete a collection by id', async () => {
    const collection = aliceSpace.collection('new-collection')

    // Create new collection by id (upsert via configure -> PUT).
    await collection.configure({ name: 'New Collection', force: true })

    // Check it was created
    assert.notEqual(await collection.describe(), null)

    // Now delete collection
    await collection.delete()

    // Ensure it was deleted (reads return null on 404).
    assert.equal(await collection.describe(), null)

    // Delete is idempotent: deleting an already-gone Collection resolves (204),
    // it does not 500 with an underlying ENOENT.
    await collection.delete()
    assert.equal(await collection.describe(), null)
  })

  it('[root] DELETE a never-created collection is idempotent (204, not 500)', async () => {
    const collection = aliceSpace.collection('never-existed-collection')
    await collection.delete()
    assert.equal(await collection.describe(), null)
  })

  it('PUT whose body id does not match the URL collection id yields invalid-request-body (400)', async () => {
    const collectionId = crypto.randomUUID()
    let expectedError: any
    try {
      await alice.was.request({
        url: new URL(
          `/space/${alice.space1.id}/${collectionId}`,
          serverUrl
        ).toString(),
        method: 'PUT',
        json: { id: crypto.randomUUID(), name: 'Mismatch' }
      })
    } catch (error) {
      expectedError = error
    }
    assert.ok(expectedError, 'expected the id-mismatch PUT to be rejected')
    assert.equal(expectedError.response.status, 400)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#invalid-request-body'
    )
    assert.equal(expectedError.data.errors[0].pointer, '#/id')

    // The Collection was not created.
    assert.equal(await aliceSpace.collection(collectionId).describe(), null)
  })

  describe('Collection backend selection', () => {
    it('POST with backend { id: "default" } persists and echoes it', async () => {
      const collectionId = crypto.randomUUID()
      const response = await alice.was.request({
        url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
        method: 'POST',
        json: {
          id: collectionId,
          name: 'Explicit Backend',
          backend: { id: 'default' }
        }
      })
      assert.equal(response.status, 201)
      assert.deepStrictEqual(response.data.backend, { id: 'default' })

      // And it is reflected in the Collection description.
      const description = await aliceSpace.collection(collectionId).describe()
      assert.deepStrictEqual(description!.backend, { id: 'default' })
    })

    it('POST with an unknown backend id yields unsupported-backend (409)', async () => {
      let expectedError: any
      try {
        await alice.was.request({
          url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
          method: 'POST',
          json: {
            id: crypto.randomUUID(),
            name: 'Bad Backend',
            backend: { id: 'no-such-backend' }
          }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(
        expectedError,
        'expected the unknown-backend POST to be rejected'
      )
      assert.equal(expectedError.response.status, 409)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#unsupported-backend'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/backend')
    })

    it('POST with a malformed backend yields invalid-request-body (400)', async () => {
      let expectedError: any
      try {
        await alice.was.request({
          url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
          method: 'POST',
          json: {
            id: crypto.randomUUID(),
            name: 'Malformed Backend',
            backend: 'default'
          }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(
        expectedError,
        'expected the malformed-backend POST to be rejected'
      )
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#invalid-request-body'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/backend')
    })

    it('GET :collectionId/backend returns the full backend descriptor', async () => {
      const response = await alice.was.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/backend`,
          serverUrl
        ).toString(),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, {
        id: 'default',
        name: 'Server Filesystem',
        managedBy: 'server',
        storageMode: ['document', 'blob'],
        persistence: 'durable',
        features: [
          'conditional-writes',
          'changes-query',
          'blinded-index-query',
          'key-epochs',
          'chunked-streams'
        ]
      })
    })

    it('GET :collectionId/backend surfaces the conditional-writes features array', async () => {
      const response = await alice.was.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/backend`,
          serverUrl
        ).toString(),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      // The filesystem backend implements the conditional-writes affordance
      // (ETag / If-Match optimistic concurrency), the `changes-query`
      // replication change feed, the `blinded-index-query` EDV query profile,
      // and the `key-epochs` multi-recipient-encryption affordance; it
      // advertises all four tokens.
      assert.ok(Array.isArray(response.data.features))
      assert.deepStrictEqual(response.data.features, [
        'conditional-writes',
        'changes-query',
        'blinded-index-query',
        'key-epochs',
        'chunked-streams'
      ])
    })

    it('GET :collectionId/backend on a missing collection yields 404', async () => {
      let expectedError: any
      try {
        await alice.was.request({
          url: new URL(
            `/space/${alice.space1.id}/no-such-collection/backend`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected a 404 for the missing collection')
      assert.equal(expectedError.response.status, 404)
    })

    it('PUT create-by-id default-fills the backend', async () => {
      const collection = aliceSpace.collection(crypto.randomUUID())
      await collection.configure({ name: 'PUT Default Backend', force: true })
      const description = await collection.describe()
      assert.deepStrictEqual(description!.backend, { id: 'default' })
    })

    it('Collection linkset advertises the backend and quota relations', async () => {
      const response = await alice.was.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/linkset`,
          serverUrl
        ).toString(),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      const [entry] = response.data.linkset
      assert.deepStrictEqual(entry['https://wallet.storage/spec#backend'], [
        {
          href: `/space/${alice.space1.id}/credentials/backend`,
          type: 'application/json'
        }
      ])
      assert.deepStrictEqual(entry['https://wallet.storage/spec#quota'], [
        {
          href: `/space/${alice.space1.id}/credentials/quota`,
          type: 'application/json'
        }
      ])
    })
  })
})
