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

  before(async () => {
    ({ rootZcapClient } = await zcapClient())

    fastify = createApp()
    await fastify.listen()
    serverUrl = 'http://localhost:' + fastify.server.address().port
  })
  after(async () => {
    return fastify.close()
  })

  describe('Spaces Repository API', () => {
    it('GET /spaces/ should 401 error when no authorization headers', async () => {
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
        "controller": "did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW"
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
        "controller": "did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW"
      })
      assert.match(response.headers.get('content-type'), /application\/json/)
      assert.equal(response.headers.get('location'), `/spaces/${body.id}`)
    })

    it.skip('should read space via GET', async () => {
      const response = await fetch(
        new URL('/space/426e7db8-26b5-4fdc-8068-9dcb948fd291', serverUrl)
      )
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /application\/json/)
      const spaceDescription = await response.json()
      assert.deepStrictEqual(spaceDescription, {
        id: '426e7db8-26b5-4fdc-8068-9dcb948fd291',
        type: [ 'Space' ],
        name: 'Example space #1',
        controller: 'did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW'
      })
    })
  })
})
