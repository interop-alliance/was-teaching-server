/**
 * Spaces Repository and Space API unit tests
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { createApp } from '../src/server.js'
import { client, zcapClients } from './helpers.js'

describe('Spaces', () => {
  let fastify, serverUrl, alice, bob, aliceDelegatedApp
  const PORT = 7766

  before(async () => {
    ({ alice, aliceDelegatedApp, bob } = await zcapClients())
    serverUrl = `http://localhost:${PORT}` // fastify.server.address().port
    fastify = createApp({ serverUrl })
    await fastify.listen({ port: PORT })
  })
  after(async () => {
    return fastify.close()
  })

  describe('Spaces Repository API', () => {
    it.skip('GET /spaces/ should 401 error when no authorization headers', async () => {
      const response = await fetch(new URL('/spaces/', serverUrl))
      assert.equal(response.status, 401)
      assert.match(response.headers.get('content-type'), /application\/problem\+json/)
    })
    it('POST /spaces/ should 401 error when no authorization headers', async () => {
      const response = await fetch(new URL('/spaces/', serverUrl), {
        method: 'POST'
      })
      assert.equal(response.status, 401)
      assert.match(response.headers.get('content-type'), /application\/problem\+json/)
    })
  })

  describe('Space API', () => {
    it('[root] create space via POST', async () => {
      const body = {
        id: alice.space1.id, name: "Alice's Space #1 (Home)", controller: alice.did
      }
      const response = await alice.rootClient.request({
        url: (new URL('/spaces/', serverUrl)).toString(),
        method: 'POST', action: 'POST', json: body
      })
      assert.equal(response.status, 201)

      const created = response.data
      assert.deepStrictEqual(created, {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did
      })
      assert.match(response.headers.get('content-type'), /application\/json/)
      assert.equal(response.headers.get('location'), `${serverUrl}/spaces/${body.id}`)
    })

    it('GET /space/:spaceId should 401 error when no authorization headers', async () => {
      const spaceUrl = (new URL(`/space/${alice.space1.id}`, serverUrl))
        .toString()
      const response = await fetch(spaceUrl, { method: 'GET' })
      assert.equal(response.status, 401)
      assert.match(response.headers.get('content-type'), /application\/problem\+json/)
    })

    it('GET /space/:spaceId should 404 error on not found space id', async () => {
      const spaceUrl = (new URL('/space/space-id-that-does-not-exist', serverUrl))
        .toString()
      let expectedError
      try {
        await alice.rootClient.request({
          url: spaceUrl, method: 'GET', action: 'GET'
        })
      } catch (error) {
        expectedError = error
      }

      assert.equal(expectedError.response.status, 404)
      assert.equal(expectedError.data.title, 'Invalid Get Space request')
      assert.match(expectedError.response.headers.get('content-type'),
        /application\/problem\+json/)
    })

    it('[root] read space via GET with proper authorization', async () => {
      const spaceUrl = (new URL(`/space/${alice.space1.id}`, serverUrl))
        .toString()
      const response = await alice.rootClient.request({
        url: spaceUrl, method: 'GET', action: 'GET'
      })

      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /application\/json/)
      const spaceDescription = response.data
      assert.deepStrictEqual(spaceDescription, {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did
      })
    })

    it('[delegated] authorized app should GET /space/:spaceId', async () => {
      // First, Alice creates the Space
      const body = {
        id: alice.space1.id, name: "Alice's Space #1 (Home)", controller: alice.did
      }
      const response = await alice.rootClient.request({
        url: (new URL('/spaces/', serverUrl)).toString(),
        method: 'POST', action: 'POST', json: body
      })
      assert.equal(response.status, 201)

      // Alice delegates GET access to the space to the app
      const aliceAppClient = client({ signer: aliceDelegatedApp.signer })
      const spaceUrl = (new URL(`/space/${alice.space1.id}`, serverUrl))
        .toString()
      const delegatedSpaceCapability = await alice.rootClient.delegate({
        allowedActions: ['GET'], invocationTarget: spaceUrl,
        controller: aliceDelegatedApp.did
      })

      // console.log('DELEGATED CAP:', delegatedSpaceCapability)

      // Alice's app can now issue a GET request to the space
      const appResponse = await aliceAppClient.request({
        url: spaceUrl, capability: delegatedSpaceCapability,
        method: 'GET', action: 'GET'
      })

      assert.equal(appResponse.status, 200)
      assert.match(appResponse.headers.get('content-type'), /application\/json/)
      assert.deepStrictEqual(appResponse.data, {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did
      })
    })

    it('[root] Bob should not be able to GET Alice space', async () => {
      // First, Alice creates the Space
      const body = {
        id: alice.space1.id, name: "Alice's Space #1 (Home)", controller: alice.did
      }
      const aliceResponse = await alice.rootClient.request({
        url: (new URL('/spaces/', serverUrl)).toString(),
        method: 'POST', action: 'POST', json: body
      })
      assert.equal(aliceResponse.status, 201)

      const spaceUrl = (new URL(`/space/${alice.space1.id}`, serverUrl))
        .toString()

      // Bob tries to access Alice's space with his root signer
      let expectedError
      try {
        await bob.rootClient.request({
          url: spaceUrl, method: 'GET', action: 'GET'
        })
      } catch (error) {
        expectedError = error
      }
      // Bob (intentionally) gets a 404 instead of a 403, to not reveal
      // the space's existence
      assert.equal(expectedError.response.status, 404)
      assert.match(expectedError.response.headers
        .get('content-type'), /application\/problem\+json/)
    })
  })
})
