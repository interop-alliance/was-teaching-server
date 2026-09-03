/**
 * CORS preflight caching: the server answers an OPTIONS preflight with an
 * `Access-Control-Max-Age`, so a browser client (whose signed requests carry
 * custom headers and so preflight nearly every call) can cache the answer
 * rather than re-asking every few seconds.
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { CORS_PREFLIGHT_MAX_AGE } from '../src/config.default.js'
import { startTestServer } from './helpers.js'

describe('CORS preflight', () => {
  let fastify: FastifyInstance
  let serverUrl: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-cors-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
  })

  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('answers a preflight with a cacheable Access-Control-Max-Age', async () => {
    const response = await fetch(new URL('/space/some-space', serverUrl), {
      method: 'OPTIONS',
      headers: {
        origin: 'https://wallet.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers':
          'authorization,capability-invocation,digest,content-type'
      }
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-max-age')).toBe(
      String(CORS_PREFLIGHT_MAX_AGE)
    )
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'capability-invocation'
    )
  })
})
