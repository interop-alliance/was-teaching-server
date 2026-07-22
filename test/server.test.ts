/**
 * Server integration tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'

// The health report's `version` is the package.json version the server was
// built from (src/config.default.ts reads it at startup); pin the served value
// to it rather than to any string.
const { version: packageVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }

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
    // The served version is exactly the package.json version, and has a
    // semver-shaped `major.minor.patch` core.
    assert.equal(body.version, packageVersion)
    assert.match(body.version, /^\d+\.\d+\.\d+/)
  })

  it('should HEAD /health with an empty body', async () => {
    const response = await fetch(serverUrl + '/health', { method: 'HEAD' })
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.equal(body, '')
  })
})
