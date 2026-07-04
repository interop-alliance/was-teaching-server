import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/server.js'

// Mock DNS resolution so the SSRF guard is deterministic (no real network): by
// default the target host resolves to a public IP (allowed); a test overrides
// it to a private/loopback address to exercise the block.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }))

describe('CORS proxy API', () => {
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    lookupMock.mockReset()
  })

  it('requires a url query parameter', async () => {
    const app = createApp()
    const response = await app.inject({ method: 'GET', url: '/api/cors' })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'Missing url query parameter' })
  })

  it('rejects a non-http(s) scheme', async () => {
    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('file:///etc/passwd')
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: 'Only http and https URLs may be proxied.'
    })
  })

  it('refuses a host that resolves to a private / loopback address (SSRF)', async () => {
    // e.g. the cloud-metadata endpoint, or an internal service.
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/cors?url=' +
        encodeURIComponent(
          'http://169.254.169.254/latest/meta-data/iam/security-credentials/'
        )
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      error: 'Proxying to this host is not allowed.'
    })
    // The upstream fetch is never reached.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a redirect that lands on a private / loopback address (SSRF)', async () => {
    // First lookup (the public start host) is allowed; the redirect target
    // resolves to the cloud-metadata address and must be blocked.
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('https://public.example/start')
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      error: 'Proxying to this host is not allowed.'
    })
    // Only the first (public) hop was fetched.
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('follows an allowed redirect, re-validating each hop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/registry.json' }
        })
      )
      .mockResolvedValueOnce(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/cors?url=' + encodeURIComponent('https://registry.example/start')
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The relative Location is resolved against the previous hop.
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(
      'https://registry.example/registry.json'
    )
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('{"ok":true}')
  })

  it('gives up after too many redirects', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://registry.example/loop' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/cors?url=' + encodeURIComponent('https://registry.example/loop')
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'Too many proxied redirects.' })
    // The initial request plus MAX_REDIRECTS followed hops.
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('fetches the target URL and passes through response details', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _options?: RequestInit) => {
        return new Response('{"ok":true}', {
          status: 203,
          headers: {
            'cache-control': 'max-age=60',
            'content-type': 'application/json',
            etag: '"abc123"'
          }
        })
      }
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/cors?url=' +
        encodeURIComponent(
          'https://registry.example/.well-known/openid-federation'
        ),
      headers: {
        accept: 'application/ld+json, application/json'
      }
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      'https://registry.example/.well-known/openid-federation'
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { accept: 'application/ld+json, application/json' }
    })
    expect(response.statusCode).toBe(203)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['cache-control']).toBe('max-age=60')
    expect(response.headers.etag).toBe('"abc123"')
    expect(response.body).toBe('{"ok":true}')
  })

  it('returns 502 when the upstream fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )

    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/cors?url=https%3A%2F%2Fregistry.example%2Fregistry.json'
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'Unable to fetch proxied URL' })
  })
})
