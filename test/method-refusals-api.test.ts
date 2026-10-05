/**
 * Method refusals and slash redirects answer ahead of the auth hooks
 * (routes.ts, `config.noAuth`). A 405 at a reserved endpoint or a container
 * URL, and a 308 between the slash forms of a URL, answer the same whoever
 * asks, so an anonymous request gets them rather than a 401. A real route
 * still demands the auth headers. The refusals cover every reserved sub-path a
 * group anchors, so a method there is not answered by the parametric route one
 * level up.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { createApp } from '../src/server.js'
import { HOSTED_PAGE_SANDBOX_CSP } from '../src/lib/hostedPageSandbox.js'
import { openTempBackend } from './helpers.js'

describe('Method refusals and redirects ahead of the auth hooks', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await createApp({
      serverUrl: 'http://localhost',
      backend: await openTempBackend({ prefix: 'was-method-refusals-' })
    })
  })
  afterAll(async () => {
    await app.close()
  })

  /**
   * Asserts an anonymous-request 405: the `Allow` header, the `about:blank`
   * problem document, and the hosted-page sandbox policy.
   */
  function expectRefusal(
    response: LightMyRequestResponse,
    allow: string
  ): void {
    expect(response.statusCode).toBe(405)
    expect(response.headers.allow).toBe(allow)
    expect(response.headers['content-type']).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toMatchObject({
      type: 'about:blank',
      title: 'Method Not Allowed'
    })
    expect(response.headers['content-security-policy']).toBe(
      HOSTED_PAGE_SANDBOX_CSP
    )
  }

  describe('anonymous 405s', () => {
    it('PUT at a Space container URL is 405, not 401', async () => {
      const response = await app.inject({ method: 'PUT', url: '/space/S/' })
      expectRefusal(response, 'GET, HEAD, POST, DELETE')
    })

    it('PUT at a Collection container URL is 405, not 401', async () => {
      const response = await app.inject({ method: 'PUT', url: '/space/S/C/' })
      expectRefusal(response, 'GET, HEAD, POST, DELETE')
    })

    it('DELETE at the Space Metadata URL is 405, not 401', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/space/S/meta'
      })
      expectRefusal(response, 'GET, HEAD, PUT')
    })

    it('a refusal answers before the body is parsed', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/space/S/',
        headers: { 'content-type': 'application/json' },
        payload: '{not json'
      })
      expectRefusal(response, 'GET, HEAD, POST, DELETE')
    })

    it('a POST refusal is still marked no-store', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/space/S/meta'
      })
      expectRefusal(response, 'GET, HEAD, PUT')
      expect(response.headers['cache-control']).toBe('no-store')
    })
  })

  describe('a real route still demands the auth headers', () => {
    it('anonymous POST at a Space container URL is 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/space/S/',
        headers: { 'content-type': 'application/json' },
        payload: '{}'
      })
      expect(response.statusCode).toBe(401)
    })

    it('anonymous PUT of the Space Metadata object is 401', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/space/S/meta',
        headers: { 'content-type': 'application/json' },
        payload: '{}'
      })
      expect(response.statusCode).toBe(401)
    })

    it('anonymous PUT of a Resource is 401', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/space/S/C/R',
        headers: { 'content-type': 'application/json' },
        payload: '{}'
      })
      expect(response.statusCode).toBe(401)
    })
  })

  describe('anonymous bare-form container redirects', () => {
    for (const method of ['PUT', 'DELETE', 'POST'] as const) {
      it(`${method} /space/S is 308 to the container URL`, async () => {
        const response = await app.inject({ method, url: '/space/S' })
        expect(response.statusCode).toBe(308)
        expect(response.headers.location).toBe('/space/S/')
      })
    }

    it('PUT /space/S/C is 308 to the container URL', async () => {
      const response = await app.inject({ method: 'PUT', url: '/space/S/C' })
      expect(response.statusCode).toBe(308)
      expect(response.headers.location).toBe('/space/S/C/')
    })

    it('POST of the retired collections endpoint is 308', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/space/S/collections'
      })
      expect(response.statusCode).toBe(308)
      expect(response.headers.location).toBe('/space/S/')
    })
  })

  describe('reserved sub-paths the parametric routes used to answer', () => {
    it('GET /space/S/backends/x is 405, not a reserved-id 409', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/space/S/backends/x'
      })
      expectRefusal(response, 'PUT, DELETE')
    })

    it('GET /space/S/meta/log is 405 with an empty Allow', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/space/S/meta/log'
      })
      expectRefusal(response, '')
    })

    it('HEAD /space/S/meta/log is 405 too', async () => {
      const response = await app.inject({
        method: 'HEAD',
        url: '/space/S/meta/log'
      })
      expect(response.statusCode).toBe(405)
      expect(response.headers.allow).toBe('')
    })

    it('POST of a chunk URL is 405', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/space/S/C/R/chunks/0'
      })
      expectRefusal(response, 'GET, HEAD, PUT, DELETE')
    })
  })

  describe('the Spaces repository', () => {
    for (const method of ['DELETE', 'PUT'] as const) {
      it(`${method} /spaces/ is 405`, async () => {
        const response = await app.inject({ method, url: '/spaces/' })
        expectRefusal(response, 'GET, HEAD, POST')
      })

      it(`${method} /spaces is 308 to /spaces/`, async () => {
        const response = await app.inject({ method, url: '/spaces' })
        expect(response.statusCode).toBe(308)
        expect(response.headers.location).toBe('/spaces/')
      })
    }

    it('PATCH /spaces is 405', async () => {
      const response = await app.inject({ method: 'PATCH', url: '/spaces' })
      expectRefusal(response, 'GET, HEAD, POST, PUT, DELETE')
    })
  })

  describe('strip-slash redirects on Resource and chunk URLs', () => {
    const cases = [
      { url: '/space/S/C/R/', target: '/space/S/C/R' },
      { url: '/space/S/C/R/chunks/0/', target: '/space/S/C/R/chunks/0' }
    ]
    for (const { url, target } of cases) {
      for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'POST'] as const) {
        it(`${method} ${url} is 308 to the no-slash form`, async () => {
          const response = await app.inject({ method, url: `${url}?a=1&b=2` })
          expect(response.statusCode).toBe(308)
          expect(response.headers.location).toBe(`${target}?a=1&b=2`)
        })
      }
    }

    it('GET of the chunk listing is not redirected', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/space/S/C/R/chunks/'
      })
      // An unknown Space: the handler's masked 404, not a redirect.
      expect(response.statusCode).toBe(404)
    })
  })
})
