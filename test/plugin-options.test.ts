/**
 * The `fastifyWas` composition options: `ownsBackend` (whether the plugin
 * wires the backend's logger, `init()` and `close()`), `cors` (skip or
 * customize the `@fastify/cors` registration), and a `serverUrl` carrying a
 * trailing slash, which must not double the slash in the URLs the server
 * builds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

/**
 * A FileSystemBackend that counts the lifecycle calls made on it.
 */
class LifecycleSpyBackend extends FileSystemBackend {
  initCalls = 0
  closeCalls = 0

  async init(): Promise<void> {
    this.initCalls += 1
    await super.init()
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

let dataDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'was-plugin-options-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

/**
 * A silent app over its own sub-directory of the suite's data dir, with the
 * options under test layered on.
 *
 * @param name {string}   the sub-directory name
 * @param [options] {object}   further `createApp()` options
 * @returns {FastifyInstance}
 */
function testApp(
  name: string,
  options: Partial<Parameters<typeof createApp>[0]> = {}
): FastifyInstance {
  return createApp({
    serverUrl: 'http://localhost',
    backend: new FileSystemBackend({ dataDir: path.join(dataDir, name) }),
    logger: false,
    ...options
  })
}

describe('ownsBackend option', () => {
  it('manages the backend lifecycle by default', async () => {
    const backend = new LifecycleSpyBackend({
      dataDir: path.join(dataDir, 'owned')
    })
    const app = testApp('owned', { backend })
    await app.ready()
    expect(backend.initCalls).toBe(1)
    expect(backend.logger).toBe(app.log)
    await app.close()
    expect(backend.closeCalls).toBe(1)
  })

  it('ownsBackend: false leaves init, close and the logger to the composition', async () => {
    const backend = new LifecycleSpyBackend({
      dataDir: path.join(dataDir, 'composed')
    })
    // The composition initializes its own backend before registering.
    await backend.init()
    const ownLogger = backend.logger
    const app = testApp('composed', { backend, ownsBackend: false })
    await app.ready()
    expect(backend.initCalls).toBe(1)
    expect(backend.logger).toBe(ownLogger)
    expect(backend.logger).not.toBe(app.log)
    await app.close()
    expect(backend.closeCalls).toBe(0)
  })

  it('ownsBackend: false without a backend is refused at registration', async () => {
    const app = createApp({
      serverUrl: 'http://localhost',
      dataDir: path.join(dataDir, 'unowned-default'),
      ownsBackend: false,
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'ownsBackend: false requires an injected backend option.'
    )
  })
})

describe('cors option', () => {
  /**
   * Sends a CORS preflight for a signed PUT from a browser origin.
   *
   * @param app {FastifyInstance}
   * @returns {Promise<import('light-my-request').Response>}
   */
  async function preflight(app: FastifyInstance) {
    return app.inject({
      method: 'OPTIONS',
      url: '/spaces/',
      headers: {
        origin: 'https://wallet.example',
        'access-control-request-method': 'PUT'
      }
    })
  }

  it('defaults to any origin, without PATCH', async () => {
    const app = testApp('cors1')
    const response = await preflight(app)
    expect(response.headers['access-control-allow-origin']).toBe('*')
    const methods = String(response.headers['access-control-allow-methods'])
    expect(methods).toContain('PUT')
    expect(methods).not.toContain('PATCH')
    await app.close()
  })

  it('cors: false registers no CORS plugin', async () => {
    const app = testApp('cors2', { cors: false })
    const response = await preflight(app)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })

  it('a custom origin replaces the wildcard', async () => {
    const app = testApp('cors3', { cors: { origin: 'https://wallet.example' } })
    const response = await preflight(app)
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://wallet.example'
    )
    // The defaults the option does not override are kept.
    expect(response.headers['access-control-max-age']).toBeDefined()
    await app.close()
  })

  it('a member set to undefined keeps the default', async () => {
    const app = testApp('cors4', {
      cors: { origin: 'https://wallet.example', methods: undefined }
    })
    const response = await preflight(app)
    const methods = String(response.headers['access-control-allow-methods'])
    expect(methods).toContain('PUT')
    expect(methods).not.toContain('PATCH')
    await app.close()
  })
})

describe('serverUrl with a trailing slash', () => {
  let fastify: FastifyInstance, serverUrl: string, alice: any

  beforeAll(async () => {
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir: path.join(dataDir, 'slash') })
    }))
    // The decorated base URL carries the trailing slash the validator admits.
    fastify.serverUrl = `${serverUrl}/`
    ;({ alice } = await zcapClients({ serverUrl }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('builds the governed log URL without a doubled slash', async () => {
    const spaceId = `slash-space-${crypto.randomUUID()}`
    const collectionId = `col-${crypto.randomUUID()}`
    await alice.was.createSpace({
      id: spaceId,
      name: 'Slash Space',
      controller: alice.did
    })
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: collectionId }
    })
    const metaUrl = `${serverUrl}/space/${spaceId}/${collectionId}/meta`
    const genesis = JSON.stringify({
      versionId: '1-hash1',
      versionTime: '2026-10-01T00:00:00Z',
      parameters: { method: 'resource-log:0.1', scid: 'zScid' },
      state: {
        type: 'WasEpochConfiguration',
        scheme: 'edv',
        currentEpoch: 'urn:epoch:1',
        epochs: [
          {
            id: 'urn:epoch:1',
            recipients: [
              {
                header: { kid: 'did:key:zApp1#ka', alg: 'ECDH-ES+A256KW' },
                encrypted_key: 'wrapped'
              }
            ]
          }
        ]
      },
      proof: []
    })
    await alice.was.request({
      url: `${metaUrl}/log`,
      method: 'PUT',
      body: new TextEncoder().encode(genesis + '\n'),
      headers: { 'content-type': 'text/jsonl', 'if-none-match': '*' }
    })

    const described = await alice.was.request({ url: metaUrl, method: 'GET' })
    expect(described.data.encryption.history.resource).toBe(`${metaUrl}/log`)
  })

  it('builds the exchange URL without a doubled slash', async () => {
    const response = await fetch(`${serverUrl}/workflows/ephemeral/exchanges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: { type: 'Test' } })
    })
    expect(response.status).toBe(201)
    const { location } = (await response.json()) as { location: string }
    expect(location).toMatch(
      new RegExp(`^${serverUrl}/workflows/ephemeral/exchanges/[0-9a-f-]+$`)
    )
    expect(response.headers.get('location')).toBe(location)
  })
})
