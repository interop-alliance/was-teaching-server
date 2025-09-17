/**
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { createApp } from '../src/server.js'

describe('Server', () => {
  let fastify, serverUrl

  before(async () => {
    fastify = createApp()
    await fastify.listen()
    serverUrl = 'http://localhost:' + fastify.server.address().port
  })
  after(async () => {
    return fastify.close()
  })

  it('should GET /', async () => {
    const response = await fetch(serverUrl)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /specification/)
  })
})
