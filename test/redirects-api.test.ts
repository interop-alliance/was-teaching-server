/**
 * Slash/no-slash canonicalization redirects (routes.ts). Regression coverage for
 * the read-reachable (unauthenticated GET) redirects: the handler must emit the
 * concrete request path with the trailing slash toggled -- not the literal route
 * template (`/space/:spaceId`), which a client cannot follow -- and use `308`.
 * (The write-method redirects run the same shared helpers, but sit behind the
 * auth hooks, so they 401 without signed headers.)
 */
import { describe, it, expect } from 'vitest'
import { createApp } from '../src/server.js'

describe('Canonicalization redirects', () => {
  it('adds the trailing slash on GET /spaces (308)', async () => {
    const app = createApp()
    const response = await app.inject({ method: 'GET', url: '/spaces' })

    expect(response.statusCode).toBe(308)
    expect(response.headers.location).toBe('/spaces/')
  })

  it('redirects GET /space/:id/collections to the trailing-slash listing with a concrete id (308)', async () => {
    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url: '/space/abc123/collections'
    })

    expect(response.statusCode).toBe(308)
    // The concrete id, not the `/space/:spaceId/collections/` route template.
    expect(response.headers.location).toBe('/space/abc123/collections/')
  })

  it('preserves the query string across the redirect', async () => {
    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url: '/space/abc123/collections?limit=5&cursor=xyz'
    })

    expect(response.statusCode).toBe(308)
    expect(response.headers.location).toBe(
      '/space/abc123/collections/?limit=5&cursor=xyz'
    )
  })
})
