import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent } from 'undici'

import { createApp } from '../src/server.js'
import { createPinnedLookup } from '../src/corsProxy.js'

// The proxy uses undici's `fetch` (so its dispatcher comes from the same undici
// build), so we mock the undici module -- keeping the real `Agent` -- and mock
// DNS so the SSRF guard is deterministic (no real network): by default the
// target host resolves to a public IP (allowed); a test overrides it to a
// private/loopback address to exercise the block.
const { fetchMock, lookupMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  lookupMock: vi.fn()
}))
vi.mock('undici', async importOriginal => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fetchMock
}))
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }))

describe('CORS proxy API', () => {
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })
  afterEach(() => {
    fetchMock.mockReset()
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
    fetchMock.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' }
        })
    )

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
    fetchMock
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
    fetchMock.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://registry.example/loop' }
        })
    )

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
    fetchMock.mockImplementation(async () => {
      return new Response('{"ok":true}', {
        status: 203,
        headers: {
          'cache-control': 'max-age=60',
          'content-type': 'application/json',
          etag: '"abc123"'
        }
      })
    })

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

  it('passes a dispatcher (undici Agent) to fetch', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"ok":true}', { status: 200 })
    )

    const app = createApp()
    await app.inject({
      method: 'GET',
      url:
        '/api/cors?url=' + encodeURIComponent('https://registry.example/thing')
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const options = fetchMock.mock.calls[0]?.[1]
    expect(options?.dispatcher).toBeInstanceOf(Agent)
  })

  it('rejects an upstream response whose content-length exceeds the cap', async () => {
    // A small actual body but a forged, huge content-length header: the proxy
    // must refuse before reading the body.
    fetchMock.mockImplementation(
      async () =>
        new Response('tiny', {
          status: 200,
          headers: { 'content-length': '999999999' }
        })
    )

    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('https://registry.example/big')
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'Proxied response too large.' })
  })

  it('rejects an upstream body that exceeds the cap while streaming', async () => {
    // No content-length, so the cap can only be enforced mid-stream. The stream
    // counts how many chunks were pulled so we can assert it stopped early.
    let chunksPulled = 0
    const chunk = new Uint8Array(4 * 1024 * 1024) // 4 MiB per chunk
    const stream = new ReadableStream({
      pull(controller) {
        chunksPulled++
        controller.enqueue(chunk)
      }
    })
    fetchMock.mockImplementation(
      async () => new Response(stream, { status: 200 })
    )

    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/cors?url=' + encodeURIComponent('https://registry.example/stream')
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'Proxied response too large.' })
    // The stream was cancelled early -- three 4 MiB chunks (12 MiB) are enough
    // to trip the 10 MiB cap, so it never consumed an unbounded number.
    expect(chunksPulled).toBeLessThanOrEqual(4)
  })

  it('returns 502 when the upstream fetch fails', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('network down')
    })

    const app = createApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/cors?url=https%3A%2F%2Fregistry.example%2Fregistry.json'
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'Unable to fetch proxied URL' })
  })
})

describe('createPinnedLookup', () => {
  it('returns the pinned addresses in the options.all array form', () => {
    const pins = new Map([
      [
        'public.example',
        [
          { address: '93.184.216.34', family: 4 },
          { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
        ]
      ]
    ])
    const lookup = createPinnedLookup(pins)

    const callback = vi.fn()
    lookup('public.example', { all: true }, callback)

    expect(callback).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
    ])
  })

  it('returns the first pinned address in the single-address form', () => {
    const pins = new Map([
      ['public.example', [{ address: '93.184.216.34', family: 4 }]]
    ])
    const lookup = createPinnedLookup(pins)

    const callback = vi.fn()
    lookup('public.example', { all: false }, callback)

    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  })

  it('normalizes the hostname to the lower-cased pin key', () => {
    const pins = new Map([
      ['public.example', [{ address: '93.184.216.34', family: 4 }]]
    ])
    const lookup = createPinnedLookup(pins)

    const callback = vi.fn()
    lookup('Public.Example', { all: false }, callback)

    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  })

  it('errors for an unpinned hostname', () => {
    const lookup = createPinnedLookup(new Map())

    const callback = vi.fn()
    lookup('evil.example', { all: false }, callback)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(callback.mock.calls[0]?.[1]).toBeUndefined()
  })
})
