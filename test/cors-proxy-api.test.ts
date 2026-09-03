import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent } from 'undici'

import { createApp } from '../src/server.js'
import { createPinnedLookup } from '../src/corsProxy.js'
import {
  CORS_PROXY_AGENT_CACHE_TTL,
  CORS_PROXY_HOST_CHECK_CACHE_TTL,
  CORS_PROXY_RESPONSE_CACHE_MAX_ENTRY_BYTES,
  CORS_PROXY_RESPONSE_CACHE_TTL
} from '../src/config.default.js'

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

describe('CORS proxy response cache', () => {
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })
  afterEach(() => {
    fetchMock.mockReset()
    lookupMock.mockReset()
  })

  it('serves a repeat GET for the same URL from the cache', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"abc"' }
        })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' + encodeURIComponent('https://registry.example/cached')

    const first = await app.inject({ method: 'GET', url })
    const second = await app.inject({ method: 'GET', url })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(second.statusCode).toBe(first.statusCode)
    expect(second.body).toBe(first.body)
    expect(second.headers['content-type']).toBe(first.headers['content-type'])
    expect(second.headers.etag).toBe(first.headers.etag)
  })

  it('caches for the TTL from Cache-Control max-age, and refetches once it elapses', async () => {
    // lru-cache reads elapsed time from `performance.now()`, captured as a
    // module-level reference at import time -- `vi.useFakeTimers()` swaps out
    // the global `performance` object wholesale, which that reference never
    // sees. Spying on `performance.now` in place patches the very object
    // lru-cache already holds, so a controlled clock actually reaches it.
    let mockNow = 1_000 // nonzero: lru-cache treats a start timestamp of exactly 0 as unset
    const nowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => mockNow)
    try {
      fetchMock.mockImplementation(
        async () =>
          new Response('{"a":1}', {
            status: 200,
            headers: { 'cache-control': 'max-age=5' }
          })
      )

      const app = createApp()
      const url =
        '/api/cors?url=' + encodeURIComponent('https://registry.example/ttl')

      await app.inject({ method: 'GET', url })
      await app.inject({ method: 'GET', url })
      expect(fetchMock).toHaveBeenCalledOnce()

      mockNow += 5_001

      await app.inject({ method: 'GET', url })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('caches for the default TTL when Cache-Control has no usable max-age', async () => {
    let mockNow = 1_000 // nonzero: lru-cache treats a start timestamp of exactly 0 as unset
    const nowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => mockNow)
    try {
      fetchMock.mockImplementation(
        async () => new Response('{"a":1}', { status: 200 })
      )

      const app = createApp()
      const url =
        '/api/cors?url=' +
        encodeURIComponent('https://registry.example/default-ttl')

      await app.inject({ method: 'GET', url })

      mockNow += CORS_PROXY_RESPONSE_CACHE_TTL - 1_000
      await app.inject({ method: 'GET', url })
      expect(fetchMock).toHaveBeenCalledOnce()

      mockNow += 2_000
      await app.inject({ method: 'GET', url })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('never caches a non-2xx response', async () => {
    fetchMock.mockImplementation(
      async () => new Response('not found', { status: 404 })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' + encodeURIComponent('https://registry.example/missing')

    await app.inject({ method: 'GET', url })
    await app.inject({ method: 'GET', url })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never caches a response whose Cache-Control is no-store', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('{"a":1}', {
          status: 200,
          headers: { 'cache-control': 'no-store' }
        })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' + encodeURIComponent('https://registry.example/no-store')

    await app.inject({ method: 'GET', url })
    await app.inject({ method: 'GET', url })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never caches a response with Cache-Control max-age=0', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('{"a":1}', {
          status: 200,
          headers: { 'cache-control': 'max-age=0' }
        })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' +
      encodeURIComponent('https://registry.example/max-age-0')

    await app.inject({ method: 'GET', url })
    await app.inject({ method: 'GET', url })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('relays but does not cache a body larger than the per-entry cap', async () => {
    const bigBody = 'x'.repeat(CORS_PROXY_RESPONSE_CACHE_MAX_ENTRY_BYTES + 1024)
    fetchMock.mockImplementation(
      async () => new Response(bigBody, { status: 200 })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' +
      encodeURIComponent('https://registry.example/large-body')

    const first = await app.inject({ method: 'GET', url })
    const second = await app.inject({ method: 'GET', url })

    expect(first.body).toBe(bigBody)
    expect(second.body).toBe(bigBody)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caches distinct Accept headers separately for the same URL', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"ok":true}', { status: 200 })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' +
      encodeURIComponent('https://registry.example/accept-varies')

    await app.inject({
      method: 'GET',
      url,
      headers: { accept: 'application/json' }
    })
    await app.inject({
      method: 'GET',
      url,
      headers: { accept: 'application/ld+json' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // A repeat of the first Accept value is a cache hit.
    await app.inject({
      method: 'GET',
      url,
      headers: { accept: 'application/json' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('CORS proxy upstream connection reuse', () => {
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })
  afterEach(() => {
    fetchMock.mockReset()
    lookupMock.mockReset()
  })

  it('reuses the same Agent dispatcher across requests to the same pinned host', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"ok":true}', { status: 200 })
    )

    const app = createApp()
    await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('https://registry.example/one')
    })
    await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('https://registry.example/two')
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const dispatcherA = fetchMock.mock.calls[0]?.[1]?.dispatcher
    const dispatcherB = fetchMock.mock.calls[1]?.[1]?.dispatcher
    expect(dispatcherA).toBeInstanceOf(Agent)
    expect(dispatcherA).toBe(dispatcherB)
  })

  it('uses a different Agent dispatcher for a different pinned address set', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"ok":true}', { status: 200 })
    )
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '203.0.113.7', family: 4 }])

    const app = createApp()
    await app.inject({
      method: 'GET',
      url:
        '/api/cors?url=' + encodeURIComponent('https://registry-a.example/one')
    })
    await app.inject({
      method: 'GET',
      url:
        '/api/cors?url=' + encodeURIComponent('https://registry-b.example/two')
    })

    const dispatcherA = fetchMock.mock.calls[0]?.[1]?.dispatcher
    const dispatcherB = fetchMock.mock.calls[1]?.[1]?.dispatcher
    expect(dispatcherA).not.toBe(dispatcherB)
  })

  it('skips the DNS lookup for a repeat request to the same host within the window', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"ok":true}', { status: 200 })
    )

    const app = createApp()
    await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('https://registry.example/one')
    })
    await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('https://registry.example/two')
    })

    expect(lookupMock).toHaveBeenCalledOnce()
  })

  it('re-runs the DNS lookup once the host-check window elapses', async () => {
    let mockNow = 1_000 // nonzero: lru-cache treats a start timestamp of exactly 0 as unset
    const nowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => mockNow)
    try {
      fetchMock.mockImplementation(
        async () => new Response('{"ok":true}', { status: 200 })
      )

      const app = createApp()
      await app.inject({
        method: 'GET',
        url:
          '/api/cors?url=' + encodeURIComponent('https://registry.example/one')
      })

      mockNow += CORS_PROXY_HOST_CHECK_CACHE_TTL + 1_000

      await app.inject({
        method: 'GET',
        url:
          '/api/cors?url=' + encodeURIComponent('https://registry.example/two')
      })

      expect(lookupMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('CORS proxy relayed headers and cache directives', () => {
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })
  afterEach(() => {
    fetchMock.mockReset()
    lookupMock.mockReset()
  })

  it('asks the upstream for an identity encoding and drops encoding, cookie, and timing headers', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'transfer-encoding': 'chunked',
            connection: 'keep-alive',
            'set-cookie': 'session=abc; Path=/',
            date: 'Mon, 01 Jan 2024 00:00:00 GMT',
            age: '12',
            expires: 'Tue, 02 Jan 2024 00:00:00 GMT',
            'cache-control': 'max-age=600'
          }
        })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' + encodeURIComponent('https://registry.example/headers')
    const first = await app.inject({ method: 'GET', url })
    const second = await app.inject({ method: 'GET', url })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'accept-encoding': 'identity' }
    })
    for (const response of [first, second]) {
      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('{"ok":true}')
      expect(response.headers['content-type']).toContain('application/json')
      expect(response.headers.expires).toBe('Tue, 02 Jan 2024 00:00:00 GMT')
      expect(response.headers['content-encoding']).toBeUndefined()
      expect(response.headers['transfer-encoding']).toBeUndefined()
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(response.headers.date).not.toBe('Mon, 01 Jan 2024 00:00:00 GMT')
      expect(response.headers['content-length']).toBe('11')
    }
    // The upstream's own Age is not relayed on the miss; the hit carries the
    // proxy's Age, which starts from the upstream's (see the Age test below).
    expect(first.headers.age).toBeUndefined()
    expect(second.headers.age).toBe('12')
  })

  it('answers with its own CORS headers, never the upstream ones', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'max-age=600',
            'access-control-allow-origin': 'https://only-upstream.example',
            'access-control-allow-credentials': 'true',
            'access-control-expose-headers': 'X-Upstream-Only'
          }
        })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' + encodeURIComponent('https://registry.example/cors')
    const first = await app.inject({
      method: 'GET',
      url,
      headers: { origin: 'https://wallet.example' }
    })
    // The cached replay must not carry them either: the cache key ignores the
    // requesting origin, so a relayed value would reach every later client.
    const second = await app.inject({
      method: 'GET',
      url,
      headers: { origin: 'https://another-wallet.example' }
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    for (const response of [first, second]) {
      expect(response.statusCode).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBe('*')
      expect(
        response.headers['access-control-allow-credentials']
      ).toBeUndefined()
      expect(response.headers['access-control-expose-headers']).not.toContain(
        'X-Upstream-Only'
      )
    }
  })

  it('replays a cached response with an Age counted from the upstream age', async () => {
    // Freshness (lru-cache) runs on `performance.now()` and Age on
    // `Date.now()`; drive both from one controlled clock.
    let mockNow = 1_000
    const nowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => mockNow)
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow)
    try {
      fetchMock.mockImplementation(
        async () =>
          new Response('{"a":1}', {
            status: 200,
            headers: { 'cache-control': 'max-age=100', age: '30' }
          })
      )

      const app = createApp()
      const url =
        '/api/cors?url=' + encodeURIComponent('https://registry.example/age')

      const miss = await app.inject({ method: 'GET', url })
      expect(miss.headers.age).toBeUndefined()

      mockNow += 10_000
      const hit = await app.inject({ method: 'GET', url })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(hit.headers.age).toBe('40')

      // The entry lives for what was left of the upstream lifetime (100 - 30
      // seconds), not a full max-age restarted at storage time.
      mockNow += 61_000
      await app.inject({ method: 'GET', url })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
      dateSpy.mockRestore()
    }
  })

  it('prefers s-maxage over max-age, as a shared cache', async () => {
    let mockNow = 1_000 // nonzero: lru-cache treats a start timestamp of exactly 0 as unset
    const nowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => mockNow)
    try {
      fetchMock.mockImplementation(
        async () =>
          new Response('{"a":1}', {
            status: 200,
            headers: { 'cache-control': 'max-age=600, s-maxage=5' }
          })
      )

      const app = createApp()
      const url =
        '/api/cors?url=' + encodeURIComponent('https://registry.example/shared')

      await app.inject({ method: 'GET', url })
      await app.inject({ method: 'GET', url })
      expect(fetchMock).toHaveBeenCalledOnce()

      mockNow += 5_001
      await app.inject({ method: 'GET', url })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('never caches a response whose shared-cache lifetime is zero, even with a positive max-age', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('{"a":1}', {
          status: 200,
          headers: { 'cache-control': 'max-age=600, s-maxage=0' }
        })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' + encodeURIComponent('https://registry.example/s0')
    await app.inject({ method: 'GET', url })
    await app.inject({ method: 'GET', url })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never caches a response with a negative max-age', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('{"a":1}', {
          status: 200,
          headers: { 'cache-control': 'max-age=-1' }
        })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' + encodeURIComponent('https://registry.example/neg')
    await app.inject({ method: 'GET', url })
    await app.inject({ method: 'GET', url })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('matches cache directives by name, not substring', async () => {
    // `private` here is the value of an extension directive, not a directive
    // itself, so the response is cacheable.
    fetchMock.mockImplementation(
      async () =>
        new Response('{"a":1}', {
          status: 200,
          headers: { 'cache-control': 'max-age=60, x-scope="private"' }
        })
    )

    const app = createApp()
    const url =
      '/api/cors?url=' + encodeURIComponent('https://registry.example/name')
    await app.inject({ method: 'GET', url })
    await app.inject({ method: 'GET', url })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('shares one upstream fetch between concurrent requests for the same URL', async () => {
    let releaseUpstream: () => void = () => {}
    const upstreamGate = new Promise<void>(resolve => {
      releaseUpstream = resolve
    })
    fetchMock.mockImplementation(async () => {
      await upstreamGate
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })

    const app = createApp()
    const url =
      '/api/cors?url=' + encodeURIComponent('https://registry.example/flight')
    const pending = [
      app.inject({ method: 'GET', url }),
      app.inject({ method: 'GET', url }),
      app.inject({ method: 'GET', url })
    ]
    // Let all three reach the fetch before the upstream answers.
    await new Promise(resolve => setImmediate(resolve))
    releaseUpstream()
    const responses = await Promise.all(pending)

    expect(fetchMock).toHaveBeenCalledOnce()
    for (const response of responses) {
      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('{"ok":true}')
    }
  })
})

describe('CORS proxy Agent lifecycle', () => {
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })
  afterEach(() => {
    fetchMock.mockReset()
    lookupMock.mockReset()
  })

  it('reuses one Agent for a host whether reached directly or via redirect', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === 'https://a.example/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://b.example/final' }
        })
      }
      return new Response('{"ok":true}', { status: 200 })
    })

    const app = createApp()
    await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('https://a.example/start')
    })
    await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('https://b.example/direct')
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const hopA = fetchMock.mock.calls[0]?.[1]?.dispatcher
    const hopB = fetchMock.mock.calls[1]?.[1]?.dispatcher
    const directB = fetchMock.mock.calls[2]?.[1]?.dispatcher
    expect(hopA).not.toBe(hopB)
    expect(hopB).toBe(directB)
  })

  it('does not destroy an Agent that a fetch is still using when its cache entry expires', async () => {
    let mockNow = 1_000 // nonzero: lru-cache treats a start timestamp of exactly 0 as unset
    const nowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => mockNow)
    try {
      let releaseUpstream: () => void = () => {}
      const upstreamGate = new Promise<void>(resolve => {
        releaseUpstream = resolve
      })
      const destroySpy = vi.spyOn(Agent.prototype, 'destroy')
      fetchMock
        .mockImplementationOnce(async () => {
          await upstreamGate
          return new Response('{"slow":true}', { status: 200 })
        })
        .mockImplementation(
          async () => new Response('{"fast":true}', { status: 200 })
        )

      const app = createApp()
      const slow = app.inject({
        method: 'GET',
        url:
          '/api/cors?url=' + encodeURIComponent('https://registry.example/slow')
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(fetchMock).toHaveBeenCalledOnce()

      // The slow fetch's Agent expires while it is still in flight; the next
      // request to the same host evicts the stale entry and builds a new one.
      mockNow += CORS_PROXY_AGENT_CACHE_TTL + 1_000
      const fast = await app.inject({
        method: 'GET',
        url:
          '/api/cors?url=' + encodeURIComponent('https://registry.example/fast')
      })
      expect(fast.statusCode).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const slowAgent = fetchMock.mock.calls[0]?.[1]?.dispatcher
      const fastAgent = fetchMock.mock.calls[1]?.[1]?.dispatcher
      expect(slowAgent).not.toBe(fastAgent)
      // Not destroyed yet: the slow fetch still holds it. (undici's
      // promise-form destroy() re-enters itself with a callback, so the spy
      // is judged by which Agents it ran on, not by call count.)
      expect(destroySpy.mock.contexts).not.toContain(slowAgent)

      releaseUpstream()
      const slowResponse = await slow
      expect(slowResponse.statusCode).toBe(200)
      expect(slowResponse.body).toBe('{"slow":true}')
      // Released by its last user, the evicted Agent is destroyed now, and
      // the live one is untouched.
      expect(destroySpy.mock.contexts).toContain(slowAgent)
      expect(destroySpy.mock.contexts).not.toContain(fastAgent)
      destroySpy.mockRestore()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('destroys every cached Agent on close', async () => {
    const destroySpy = vi.spyOn(Agent.prototype, 'destroy')
    fetchMock.mockImplementation(
      async () => new Response('{"ok":true}', { status: 200 })
    )

    const app = createApp()
    await app.inject({
      method: 'GET',
      url: '/api/cors?url=' + encodeURIComponent('https://registry.example/one')
    })
    await app.close()

    const agent = fetchMock.mock.calls[0]?.[1]?.dispatcher
    expect(agent).toBeInstanceOf(Agent)
    expect(destroySpy.mock.contexts).toContain(agent)
    destroySpy.mockRestore()
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
