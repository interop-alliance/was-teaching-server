/**
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { createApp } from '../src/server.js'
import { zcapClient } from './helpers.js'

describe('Spaces', () => {
  let fastify, serverUrl, rootZcapClient
  const PORT = 7766

  before(async () => {
    ({ rootZcapClient } = await zcapClient())
    serverUrl = `http://localhost:${PORT}` // fastify.server.address().port

    console.log('TEST SERVER URL:', serverUrl)

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

    it('should create space via POST', async () => {
      const body = {
        "id": "426e7db8-26b5-4fdc-8068-9dcb948fd291",
        "name": "Example space #1",
        "controller": "did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD"
      }

      const response = await rootZcapClient.request({
        url: (new URL('/spaces/', serverUrl)).toString(),
        method: 'POST', action: 'POST', json: body
      })
      assert.equal(response.status, 201)

      const created = response.data
      assert.deepStrictEqual(created, {
        "id": "426e7db8-26b5-4fdc-8068-9dcb948fd291",
        "name": "Example space #1",
        "type": ["Space"],
        "controller": "did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD"
      })
      assert.match(response.headers.get('content-type'), /application\/json/)
      assert.equal(response.headers.get('location'), `/spaces/${body.id}`)
    })

    it('Get /space/:spaceId should 401 error when no authorization headers', async () => {
      const spaceUrl = (new URL('/space/426e7db8-26b5-4fdc-8068-9dcb948fd291', serverUrl))
        .toString()
      const response = await fetch(spaceUrl, { method: 'GET' })
      assert.equal(response.status, 401)
      assert.match(response.headers.get('content-type'), /application\/problem\+json/)
    })

    it('should read space via GET with proper authorization', async () => {
      const spaceUrl = (new URL('/space/426e7db8-26b5-4fdc-8068-9dcb948fd291', serverUrl))
        .toString()
      const response = await rootZcapClient.request({
        url: spaceUrl, method: 'GET', action: 'GET'
      })

      console.log(response.data)

      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /application\/json/)
      const spaceDescription = response.data
      assert.deepStrictEqual(spaceDescription, {
        id: '426e7db8-26b5-4fdc-8068-9dcb948fd291',
        type: [ 'Space' ],
        name: 'Example space #1',
        controller: 'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD'
      })
    })
  })
})
