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

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

describe('Collections API', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    aliceSpace: Space
  const PORT = 7767

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}` // fastify.server.address().port
    ;({ alice } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })

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
    assert.equal(description.name, 'Conflict Test Collection')
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
        linkset: `/space/${alice.space1.id}/credentials/linkset`
      }
    )
  })

  it('[root] create and delete a collection by id', async () => {
    const collection = aliceSpace.collection('new-collection')

    // Create new collection by id (upsert via configure -> PUT).
    await collection.configure({ name: 'New Collection' })

    // Check it was created
    assert.notEqual(await collection.describe(), null)

    // Now delete collection
    await collection.delete()

    // Ensure it was deleted (reads return null on 404).
    assert.equal(await collection.describe(), null)
  })
})
