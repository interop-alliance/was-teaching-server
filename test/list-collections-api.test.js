/**
 * List Collections API unit tests
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { createApp } from '../src/server.js'
import { zcapClients } from './helpers.js'

describe('List Collections API', () => {
  let fastify, serverUrl, alice
  const PORT = 7777

  before(async () => {
    ({ alice } = await zcapClients())
    serverUrl = `http://localhost:${PORT}`
    fastify = createApp({ serverUrl })
    await fastify.listen({ port: PORT })
  })

  after(async () => {
    return fastify.close()
  })

  it('[root] lists collections for a space', async () => {
    const spaceId = `list-collections-space-${crypto.randomUUID()}`
    const collectionId = `list-collections-collection-${crypto.randomUUID()}`
    const resourceId = `list-collections-resource-${crypto.randomUUID()}`

    const spaceUrl = (new URL(`/space/${spaceId}`, serverUrl)).toString()
    const collectionUrl = (new URL(`/space/${spaceId}/${collectionId}`, serverUrl)).toString()
    const resourceUrl = (new URL(`/space/${spaceId}/${collectionId}/${resourceId}`, serverUrl)).toString()
    const collectionsUrl = (new URL(`/space/${spaceId}/collections/`, serverUrl)).toString()

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
          url: `/space/${spaceId}/${collectionId}`
        }
      ]
    })
  })
})
