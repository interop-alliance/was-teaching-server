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

  // TODO: make sure all iterations return ResourceNotFound error
  it('GET /space/:spaceId/:collectionId/:resourceId should 404 error on not found space id', async () => {
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
    assert.match(expectedError.response.headers.get('content-type'),
      /application\/problem\+json/)
  })

  it('[root] POST and GET Resource with proper authorization', async () => {
    // First, create the Resource
    const body = {
      id: 'sample-resource', name: 'Sample Verifiable Credential'
    }
    const response = await alice.rootClient.request({
      url: (new URL(`/space/${alice.space1.id}/credentials/`, serverUrl)).toString(),
      method: 'POST', action: 'POST', json: body
    })
    assert.equal(response.status, 201)

    assert.equal(response.data['content-type'], 'application/json')

    assert.match(response.headers.get('content-type'), /application\/json/)
    const resourceUrl = response.headers.get('location')
    assert.ok(resourceUrl.startsWith(`${serverUrl}/space/${alice.space1.id}/credentials/`))

    // Next, GET the created resource
    const fetchResourceResponse = await alice.rootClient.request({
      url: resourceUrl, method: 'GET'
    })
    assert.equal(fetchResourceResponse.status, 200)
    assert.match(fetchResourceResponse.headers.get('content-type'),
      /application\/json/)
    assert.equal(fetchResourceResponse.data.name, 'Sample Verifiable Credential')
  })

  it('[root] POST and GET a non-JSON resource', async () => {
    const body = new Blob(['line 1\nline2\n'], {type: 'text/plain'})
    let response
    try {
      response = await alice.rootClient.request({
        url: (new URL(`/space/${alice.space1.id}/credentials/`, serverUrl)).toString(),
        method: 'POST', body
      })
    } catch (e) {
      console.log(e.data)
    }

    assert.equal(response.status, 201)
    const createdUrl = response.headers.get('location')

    // Next, GET the created resource
    let fetchResourceResponse
    try {
      fetchResourceResponse = await alice.rootClient.request({
        url: createdUrl, method: 'GET'
      })
    } catch (e) {
      console.log(e.data)
    }
    assert.equal(fetchResourceResponse.status, 200)
    const responseBody = await fetchResourceResponse.text()
    assert.equal(responseBody, 'line 1\nline2\n')
  })
})
