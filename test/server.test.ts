/**
 * Server integration tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'

describe('Server', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({ backend: new FileSystemBackend({ dataDir }) })
    await fastify.listen()
    serverUrl =
      'http://localhost:' + (fastify.server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('should GET /', async () => {
    const response = await fetch(serverUrl)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /Welcome/)
  })

  it('should GET /health without authentication', async () => {
    const response = await fetch(serverUrl + '/health')
    const body = (await response.json()) as { status: string; version: string }

    assert.equal(response.status, 200)
    assert.match(
      response.headers.get('content-type') ?? '',
      /^application\/health\+json/
    )
    assert.equal(body.status, 'pass')
    assert.equal(typeof body.version, 'string')
  })

  it('should HEAD /health with an empty body', async () => {
    const response = await fetch(serverUrl + '/health', { method: 'HEAD' })
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.equal(body, '')
  })
})
