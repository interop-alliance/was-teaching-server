/**
 * Slash/no-slash canonicalization redirects (routes.ts). Regression coverage for
 * the read-reachable (unauthenticated GET) redirects: the handler must emit the
 * concrete request path in canonical form -- not the literal route template
 * (`/space/:spaceId`), which a client cannot follow -- and use `308`. A
 * container (the repository, a Space, a Collection) is canonical WITH the
 * trailing slash, and the retired `collections` endpoint redirects to the Space
 * container. (The write-method redirects run the same shared helpers, but sit
 * behind the auth hooks, so they 401 without signed headers.)
 */
import { afterAll, describe, it, expect } from 'vitest'
import { createApp } from '../src/server.js'
import type { FastifyInstance } from 'fastify'
import { openTempBackend } from './helpers.js'

describe('Canonicalization redirects', () => {
  // Every app the suite creates, closed in afterAll so each app's private temp
  // data dir is removed (the plugin owns its backend).
  const apps: FastifyInstance[] = []
  afterAll(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  /**
   * A fresh app over a private temp data dir.
   */
  async function testApp() {
    const app = await createApp({
      serverUrl: 'http://localhost',
      backend: await openTempBackend({ prefix: 'was-redirects-' })
    })
    apps.push(app)
    return app
  }

  it('adds the trailing slash on GET /spaces (308)', async () => {
    const app = await testApp()
    const response = await app.inject({ method: 'GET', url: '/spaces' })

    expect(response.statusCode).toBe(308)
    expect(response.headers.location).toBe('/spaces/')
  })

  it('redirects GET /space/:id to the Space container with a concrete id (308)', async () => {
    const app = await testApp()
    const response = await app.inject({ method: 'GET', url: '/space/abc123' })

    expect(response.statusCode).toBe(308)
    // The concrete id, not the `/space/:spaceId/` route template.
    expect(response.headers.location).toBe('/space/abc123/')
  })

  it('redirects GET /space/:id/:cid to the Collection container (308)', async () => {
    const app = await testApp()
    const response = await app.inject({
      method: 'GET',
      url: '/space/abc123/credentials'
    })

    expect(response.statusCode).toBe(308)
    expect(response.headers.location).toBe('/space/abc123/credentials/')
  })

  it('preserves the query string across the container redirect', async () => {
    const app = await testApp()
    const response = await app.inject({
      method: 'GET',
      url: '/space/abc123?limit=5&cursor=xyz'
    })

    expect(response.statusCode).toBe(308)
    expect(response.headers.location).toBe('/space/abc123/?limit=5&cursor=xyz')
  })

  for (const url of [
    '/space/abc123/collections',
    '/space/abc123/collections/'
  ]) {
    it(`redirects the retired GET ${url} to the Space container (308)`, async () => {
      const app = await testApp()
      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(308)
      expect(response.headers.location).toBe('/space/abc123/')
    })
  }

  it('round-trips a percent-encoded spaceId through the retired collections redirect', async () => {
    const app = await testApp()
    // The router percent-decodes `request.params.spaceId`, so a `Location`
    // rebuilt from it would name a different resource (`/space/a/b/`, i.e.
    // Collection `b` of Space `a`). The emitted segment must stay byte-
    // identical to what the client sent.
    const response = await app.inject({
      method: 'GET',
      url: '/space/a%2Fb/collections'
    })

    expect(response.statusCode).toBe(308)
    expect(response.headers.location).toBe('/space/a%2Fb/')
  })

  it('does not let an encoded question mark in the spaceId become a query', async () => {
    const app = await testApp()
    const response = await app.inject({
      method: 'GET',
      url: '/space/a%3Fx=1/collections'
    })

    expect(response.statusCode).toBe(308)
    expect(response.headers.location).toBe('/space/a%3Fx=1/')
  })

  it('preserves the query string across the retired collections redirect', async () => {
    const app = await testApp()
    const response = await app.inject({
      method: 'GET',
      url: '/space/abc123/collections?limit=5&cursor=xyz'
    })

    expect(response.statusCode).toBe(308)
    expect(response.headers.location).toBe('/space/abc123/?limit=5&cursor=xyz')
  })

  it('leaves a sub-resource path alone (GET .../meta is not redirected)', async () => {
    const app = await testApp()
    const response = await app.inject({
      method: 'GET',
      url: '/space/abc123/meta'
    })

    // An unknown Space: the handler's masked 404, not a redirect.
    expect(response.statusCode).toBe(404)
  })
})
