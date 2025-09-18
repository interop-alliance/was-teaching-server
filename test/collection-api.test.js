/**
 * Collections API unit tests
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { createApp } from '../src/server.js'
import { zcapClients } from './helpers.js'

describe('Collections API', () => {
  let fastify, serverUrl, alice, bob
  const PORT = 7767

  before(async () => {
    ({ alice, bob } = await zcapClients())
    serverUrl = `http://localhost:${PORT}` // fastify.server.address().port
    fastify = createApp({ serverUrl })
    await fastify.listen({ port: PORT })
  })
  after(async () => {
    return fastify.close()
  })

  it('POST /space/:spaceId/ should 401 error when no authorization headers', async () => {
    const response = await fetch(new URL('/space/any-space-id/', serverUrl), {
      method: 'POST'
    })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('content-type'), /application\/problem\+json/)
  })

  it('POST /space/:spaceId/ should 404 error on not found space id', async () => {
    const spaceUrl = (new URL('/space/space-id-that-does-not-exist/', serverUrl))
      .toString()
    let expectedError
    try {
      await alice.rootClient.request({
        url: spaceUrl, method: 'POST', action: 'POST'
      })
    } catch (error) {
      expectedError = error
    }
    assert.equal(expectedError.response.status, 404)
    assert.match(expectedError.response.headers.get('content-type'), /application\/problem\+json/)
  })
})
