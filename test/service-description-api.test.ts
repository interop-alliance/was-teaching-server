/**
 * Service description API tests (Vitest): the unauthenticated `GET /service`
 * document, its caching headers and conditional read, the `Link` header with
 * the `service` relation on every kind of response, the `service` relation in
 * the Space and Collection linksets, and the version-disclosure switch.
 */
import { it, describe, beforeAll, afterAll, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import type { Space } from '@interop/was-client'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { SERVICE_DESCRIPTION_MAX_AGE } from '../src/config.default.js'
import { startTestServer, zcapClients } from './helpers.js'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as {
  name: string
  version: string
  repository: { url: string }
  homepage: string
}

describe('Service description API', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    aliceSpace: Space

  const serviceLink = () => `<${serverUrl}/service>; rel="service"`

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-service-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    aliceSpace = await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space",
      controller: alice.did
    })
    const collection = await aliceSpace.createCollection({
      id: 'private-notes',
      name: 'Private Notes'
    })
    await collection.put('note', { id: 'note', name: 'secret' })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('GET /service', () => {
    it('serves the document without authorization', async () => {
      const response = await fetch(`${serverUrl}/service`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('cache-control')).toBe(
        `public, max-age=${SERVICE_DESCRIPTION_MAX_AGE}`
      )
      expect(response.headers.get('etag')).toMatch(/^"[^"]+"$/)

      expect(await response.json()).toEqual({
        url: `${serverUrl}/service`,
        specs: {
          'https://w3id.org/pws': [
            {
              version: '0.5',
              spaces: `${serverUrl}/spaces/`,
              features: [
                'listing',
                'collection-management',
                'space-management',
                'linksets',
                'policy',
                'metadata',
                'export',
                'backends',
                'query',
                'quotas',
                'changes-query'
              ]
            }
          ],
          'https://w3id.org/pws/authz-profile': [
            {
              version: '0.1',
              url:
                'https://w3c-ccg.github.io/wallet-attached-storage-spec/' +
                'authz-profile/',
              signatureAlgorithms: ['EdDSA'],
              zcapCryptosuites: ['Ed25519Signature2020', 'eddsa-jcs-2022']
            }
          ],
          'https://w3id.org/pws/encrypted-collections': [
            {
              version: '0.1',
              url: 'https://interop-alliance.github.io/encrypted-collections-spec/',
              features: ['blinded-index-query', 'governed-history-logs']
            }
          ]
        },
        instance: {
          name: packageJson.name,
          version: packageJson.version,
          source: packageJson.repository.url,
          homepage: packageJson.homepage
        }
      })
    })

    it('carries the signature members on the profile entry only', async () => {
      const response = await fetch(`${serverUrl}/service`)
      const { specs } = (await response.json()) as {
        specs: Record<string, Record<string, unknown>[]>
      }
      const core = specs['https://w3id.org/pws']![0]!
      const profile = specs['https://w3id.org/pws/authz-profile']![0]!
      expect(profile.signatureAlgorithms).toEqual(['EdDSA'])
      expect(profile.zcapCryptosuites).toEqual([
        'Ed25519Signature2020',
        'eddsa-jcs-2022'
      ])
      expect(core).not.toHaveProperty('signatureAlgorithms')
      expect(core).not.toHaveProperty('zcapCryptosuites')
    })

    it('serves a bodyless HEAD with the same validator', async () => {
      const get = await fetch(`${serverUrl}/service`)
      const head = await fetch(`${serverUrl}/service`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect(head.headers.get('etag')).toBe(get.headers.get('etag'))
      expect(head.headers.get('link')).toBe(serviceLink())
    })

    it('answers 304 to a conditional GET holding the current ETag', async () => {
      const first = await fetch(`${serverUrl}/service`)
      const etag = first.headers.get('etag')!
      const response = await fetch(`${serverUrl}/service`, {
        headers: { 'if-none-match': etag }
      })
      expect(response.status).toBe(304)
      expect(response.headers.get('etag')).toBe(etag)
      expect(response.headers.get('cache-control')).toBe(
        `public, max-age=${SERVICE_DESCRIPTION_MAX_AGE}`
      )
    })
  })

  describe('the service Link header', () => {
    const expectDiscoverable = (response: Response) => {
      expect(response.headers.get('link')).toBe(serviceLink())
      expect(
        response.headers.get('access-control-expose-headers') ?? ''
      ).toMatch(/(^|,\s*)Link(\s*,|$)/)
    }

    it('is on the service description itself', async () => {
      expectDiscoverable(await fetch(`${serverUrl}/service`))
    })

    it('is on an unauthorized HEAD of a private Resource (404)', async () => {
      const response = await fetch(
        `${serverUrl}/space/${alice.space1.id}/private-notes/note`,
        { method: 'HEAD' }
      )
      expect(response.status).toBe(404)
      expectDiscoverable(response)
    })

    it('is on an authorized listing (200)', async () => {
      const response = await alice.was.request({
        path: `/space/${alice.space1.id}/private-notes/`,
        method: 'GET'
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('link')).toBe(serviceLink())
    })

    it('is on a canonicalization redirect (308)', async () => {
      const response = await fetch(`${serverUrl}/spaces`, {
        redirect: 'manual'
      })
      expect(response.status).toBe(308)
      expectDiscoverable(response)
    })

    it('is on an error from the error handler (401)', async () => {
      const response = await fetch(
        `${serverUrl}/space/${alice.space1.id}/private-notes/note`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'anonymous write' })
        }
      )
      expect(response.status).toBe(401)
      expectDiscoverable(response)
    })

    it('is on a 405 at a reserved endpoint', async () => {
      const response = await fetch(
        `${serverUrl}/space/${alice.space1.id}/export`
      )
      expect(response.status).toBe(405)
      expectDiscoverable(response)
    })

    it('is on a 404 for a URL no route matches', async () => {
      const response = await fetch(`${serverUrl}/no-such-route`)
      expect(response.status).toBe(404)
      expectDiscoverable(response)
    })

    it('is on a CORS preflight', async () => {
      const response = await fetch(
        `${serverUrl}/space/${alice.space1.id}/private-notes/note`,
        {
          method: 'OPTIONS',
          headers: {
            origin: 'https://wallet.example',
            'access-control-request-method': 'PUT'
          }
        }
      )
      expect(response.status).toBe(204)
      expect(response.headers.get('link')).toBe(serviceLink())
    })

    it('is on the teaching-server extras (/health)', async () => {
      expectDiscoverable(await fetch(`${serverUrl}/health`))
    })

    it('appends to a Link header a handler already set', async () => {
      const app = createApp({ logger: false, serverUrl: 'https://was.example' })
      app.get('/test-links', async (request, reply) => {
        return reply
          .header(
            'link',
            '<https://was.example/a?cursor=1>; rel="next", ' +
              '<https://was.example/a>; rel="first"'
          )
          .send({})
      })
      const response = await app.inject({ method: 'GET', url: '/test-links' })
      expect(response.headers.link).toBe(
        '<https://was.example/a?cursor=1>; rel="next", ' +
          '<https://was.example/a>; rel="first", ' +
          '<https://was.example/service>; rel="service"'
      )
      await app.close()
    })
  })

  describe('linksets', () => {
    const serviceRelation = () => [
      { href: `${serverUrl}/service`, type: 'application/json' }
    ]

    it('the Space linkset carries the service relation', async () => {
      const response = await alice.was.request({
        path: `/space/${alice.space1.id}/linkset`,
        method: 'GET'
      })
      expect(response.status).toBe(200)
      expect(response.data.linkset[0].service).toEqual(serviceRelation())
    })

    it('the Collection linkset carries the service relation', async () => {
      const response = await alice.was.request({
        path: `/space/${alice.space1.id}/private-notes/linkset`,
        method: 'GET'
      })
      expect(response.status).toBe(200)
      expect(response.data.linkset[0].service).toEqual(serviceRelation())
    })
  })
})

describe('Service description with the version withheld', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-service-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir }),
      discloseVersion: false
    }))
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('omits instance.version and keeps the other members', async () => {
    const response = await fetch(`${serverUrl}/service`)
    const body = (await response.json()) as { instance: object }
    expect(body.instance).toEqual({
      name: packageJson.name,
      source: packageJson.repository.url,
      homepage: packageJson.homepage
    })
  })

  it('omits the version from /health', async () => {
    const response = await fetch(`${serverUrl}/health`)
    expect(await response.json()).toEqual({ status: 'pass' })
  })

  it('omits the version from the welcome page', async () => {
    const response = await fetch(serverUrl)
    const body = await response.text()
    expect(body).toMatch(/Welcome|W\.A\.S\./)
    expect(body).not.toContain(packageJson.version)
  })
})

describe('Service description without a serverUrl', () => {
  let app: FastifyInstance, dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-service-'))
    app = createApp({ backend: new FileSystemBackend({ dataDir }) })
  })
  afterAll(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('serves no document and no service link', async () => {
    const response = await app.inject({ method: 'GET', url: '/service' })
    expect(response.statusCode).toBe(404)
    expect(response.headers.link).toBeUndefined()
  })
})
