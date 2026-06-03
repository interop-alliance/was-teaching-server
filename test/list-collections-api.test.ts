/**
 * List Collections API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { zcapClients } from './helpers.js'

describe('List Collections API', () => {
  let fastify: FastifyInstance, serverUrl: string, alice: any
  const PORT = 7777

  beforeAll(async () => {
    ;({ alice } = await zcapClients())
    serverUrl = `http://localhost:${PORT}`
    fastify = createApp({ serverUrl })
    await fastify.listen({ port: PORT })
  })

  afterAll(async () => {
    return fastify.close()
  })

  it('[root] lists collections for a space', async () => {
    const spaceId = `list-collections-space-${crypto.randomUUID()}`
    const collectionId = `list-collections-collection-${crypto.randomUUID()}`
    const resourceId = `list-collections-resource-${crypto.randomUUID()}`

    const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
    const collectionUrl = new URL(
      `/space/${spaceId}/${collectionId}`,
      serverUrl
    ).toString()
    const resourceUrl = new URL(
      `/space/${spaceId}/${collectionId}/${resourceId}`,
      serverUrl
    ).toString()
    const collectionsUrl = new URL(
      `/space/${spaceId}/collections/`,
      serverUrl
    ).toString()

    await alice.rootClient.request({
      url: spaceUrl,
      method: 'PUT',
      json: {
        name: 'List Collections Test Space',
        controller: alice.did
      }
    })

    await alice.rootClient.request({
      url: collectionUrl,
      method: 'PUT',
      json: {
        id: collectionId,
        name: 'List Collections Test Collection'
      }
    })

    await alice.rootClient.request({
      url: resourceUrl,
      method: 'PUT',
      json: {
        id: resourceId,
        name: 'List Collections Test Resource'
      }
    })

    const response = await alice.rootClient.request({
      url: collectionsUrl,
      method: 'GET'
    })

    assert.equal(response.status, 200)
    assert.deepStrictEqual(response.data, {
      url: `/space/${spaceId}/collections/`,
      totalItems: 1,
      items: [
        {
          id: collectionId,
          url: `/space/${spaceId}/${collectionId}`,
          name: 'List Collections Test Collection'
        }
      ]
    })
  })
})
