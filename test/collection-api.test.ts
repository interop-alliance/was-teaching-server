/**
 * Collections API unit tests (Vitest).
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

describe('Collections API', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any
  const PORT = 7767

  beforeAll(async () => {
    ;({ alice } = await zcapClients())
    serverUrl = `http://localhost:${PORT}` // fastify.server.address().port
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })

    // Provision the Space this suite operates on. This suite uses its own
    // temp dataDir, so it must create the Space here rather than relying on
    // filesystem state left behind by other test files.
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}`, serverUrl).toString(),
      method: 'PUT',
      json: {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      }
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

  it('POST /space/:spaceId/ should 404 error on not found space id', async () => {
    const spaceUrl = new URL(
      '/space/space-id-that-does-not-exist/',
      serverUrl
    ).toString()
    let expectedError: any
    try {
      await alice.rootClient.request({
        url: spaceUrl,
        method: 'POST',
        action: 'POST'
      })
    } catch (error) {
      expectedError = error
    }
    assert.equal(expectedError.response.status, 404)
    assert.match(
      expectedError.response.headers.get('content-type'),
      /application\/problem\+json/
    )
  })

  it('[root] create collection via POST', async () => {
    const body = {
      id: 'credentials',
      name: 'Verifiable Credentials'
    }
    const response = await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: body
    })
    assert.equal(response.status, 201)

    const created = response.data
    assert.deepStrictEqual(created, {
      id: 'credentials',
      name: 'Verifiable Credentials',
      type: ['Collection']
    })
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.equal(
      response.headers.get('location'),
      `${serverUrl}/space/${alice.space1.id}/${body.id}`
    )
  })

  it('[root] list collection items via GET :collectionId/', async () => {
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/credentials/`,
        serverUrl
      ).toString(),
      method: 'GET'
    })
    assert.equal(response.status, 200)
    const listResponse = response.data
    assert.equal(listResponse.id, 'credentials')
    assert.equal(listResponse.url, `/space/${alice.space1.id}/credentials`)
    assert.equal(listResponse.name, 'Verifiable Credentials')
    assert.deepStrictEqual(listResponse.type, ['Collection'])
    assert.equal(typeof listResponse.totalItems, 'number')
    assert.ok(Array.isArray(listResponse.items))
    assert.equal(listResponse.totalItems, listResponse.items.length)
  })

  it('[root] get collection description via GET :collectionId', async () => {
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/credentials`,
        serverUrl
      ).toString(),
      method: 'GET',
      action: 'GET'
    })
    assert.equal(response.status, 200)
    assert.deepStrictEqual(response.data, {
      id: 'credentials',
      name: 'Verifiable Credentials',
      type: ['Collection']
    })
  })

  it('[root] create and delete a collection by id', async () => {
    // Create new collection
    const collectionId = 'new-collection'
    const collectionUrl = new URL(
      `/space/${alice.space1.id}/${collectionId}`,
      serverUrl
    ).toString()
    const body = {
      id: collectionId,
      name: 'New Collection'
    }
    await alice.rootClient.request({
      url: collectionUrl,
      method: 'PUT',
      json: body
    })

    // Check it was created
    const existResponse = await alice.rootClient.request({
      url: collectionUrl,
      method: 'GET'
    })
    assert.equal(existResponse.status, 200)

    // Now delete collection
    const deleteResponse = await alice.rootClient.request({
      url: collectionUrl,
      method: 'DELETE'
    })
    assert.equal(deleteResponse.status, 204)

    // Ensure it was deleted
    let checkResponse: any
    try {
      await alice.rootClient.request({
        url: collectionUrl,
        method: 'GET'
      })
    } catch (err: any) {
      checkResponse = err.response
    }
    assert.equal(checkResponse.status, 404)
  })
})
