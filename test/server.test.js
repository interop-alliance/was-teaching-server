/**
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { createApp } from '../src/server.js'

describe('API', () => {
  let fastify, serverUrl
  before(async () => {
    fastify = createApp()
    await fastify.listen()
    serverUrl = 'http://localhost:' + fastify.server.address().port
  })
  after(async () => {
    fastify.close()
  })

  it('should GET /', async () => {
    const response = await fetch(serverUrl)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /specification/)
  })

  describe('Spaces API', () => {
    it.only('should create space via POST', async () => {
      const body = {
        "id": "426e7db8-26b5-4fdc-8068-9dcb948fd291",
        "name": "Example space #1",
        "controller": "did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW"
      }

      const response = await fetch(new URL('/spaces/', serverUrl),
        { method: 'POST', headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
      assert.equal(response.status, 201)
      const created = await response.json()
      assert.partialDeepStrictEqual(created, {
        "id": "426e7db8-26b5-4fdc-8068-9dcb948fd291",
        "name": "Example space #1",
        "type": ["Space"],
        "controller": "did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW"
      })
      assert.match(response.headers.get('content-type'), /application\/json/)
      assert.equal(response.headers.get('location'), `/spaces/${body.id}`)
    })
  })
})
