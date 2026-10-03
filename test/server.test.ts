/**
 * Server integration tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

import { openTempBackend, startTestServer } from './helpers.js'

// The health report's `version` is the package.json version the server was
// built from (src/config.default.ts reads it at startup); pin the served value
// to it rather than to any string.
const { version: packageVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }

describe('Server', () => {
  let fastify: FastifyInstance, serverUrl: string

  beforeAll(async () => {
    ;({ fastify, serverUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
  })
  afterAll(async () => {
    await fastify.close()
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
    // Under vitest the app runs from src/ (no build stamp), so the served
    // version falls back to exactly the package.json version, and has a
    // semver-shaped `major.minor.patch` core. A built dist/ serves the
    // stamped build version instead.
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
