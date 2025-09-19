/**
 * Resource API unit tests
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { createApp } from '../src/server.js'
import { zcapClients } from './helpers.js'

describe('Resource API', () => {
  let fastify, serverUrl, alice, bob
  const PORT = 7768

  before(async () => {
    ({ alice, bob } = await zcapClients())
    serverUrl = `http://localhost:${PORT}` // fastify.server.address().port
    fastify = createApp({ serverUrl })
    await fastify.listen({ port: PORT })
  })
  after(async () => {
    return fastify.close()
  })

  it('GET /space/:spaceId/:resourceId should 401 error when no authorization headers', async () => {
    const response = await fetch(new URL('/space/any-space-id/any-collection/any-resource', serverUrl), {
      method: 'GET'
    })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('content-type'), /application\/problem\+json/)
  })

  it.skip('GET /space/:spaceId/:collectionId/:resourceId should 404 error on not found space id', async () => {
    const url = (new URL('/space/space-id-that-does-not-exist/unknown-collection/unknown-resource', serverUrl))
      .toString()
    let expectedError
    try {
      await alice.rootClient.request({
        url, method: 'GET', action: 'GET'
      })
    } catch (error) {
      console.log('ERROR', error)
      expectedError = error
    }
    assert.equal(expectedError.response.status, 404)
    // assert.match(expectedError.response.headers.get('content-type'), /application\/problem\+json/)
  })

  it.skip('[root] create collection via POST', async () => {
    const body = {
      id: 'credentials', name: 'Verifiable Credentials'
    }
    const response = await alice.rootClient.request({
      url: (new URL(`/space/${alice.space1.id}/`, serverUrl)).toString(),
      method: 'POST', action: 'POST', json: body
    })
    assert.equal(response.status, 201)

    const created = response.data
    assert.deepStrictEqual(created, {
      id: 'credentials',
      name: 'Verifiable Credentials',
      type: ['Collection']
    })
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.equal(response.headers.get('location'), `${serverUrl}/space/${alice.space1.id}/${body.id}`)
  })
})
