/**
 * Server integration tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'

describe('Server', () => {
  let fastify: FastifyInstance, serverUrl: string

  beforeAll(async () => {
    fastify = createApp()
    await fastify.listen()
    serverUrl =
      'http://localhost:' + (fastify.server.address() as AddressInfo).port
  })
  afterAll(async () => {
    return fastify.close()
  })

  it('should GET /', async () => {
    const response = await fetch(serverUrl)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /Welcome/)
  })
})
