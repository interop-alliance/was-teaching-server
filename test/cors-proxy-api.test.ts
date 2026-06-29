import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/server.js'

describe('CORS proxy API', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires a url query parameter', async () => {
    const app = createApp()
    const response = await app.inject({ method: 'GET', url: '/api/cors' })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'Missing url query parameter' })
  })

  it('fetches the target URL and passes through response details', async () => {
    const fetchMock = vi.fn(async (_url: URL | RequestInfo, _options?: RequestInit) => {
      return new Response('{"ok":true}', {
        status: 203,
        headers: {
          'cache-control': 'max-age=60',
          'content-type': 'application/json',
          etag: '"abc123"'
        }
      })
    })
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
