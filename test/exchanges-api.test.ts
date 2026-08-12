import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

import { initExchangeRoutes } from '../src/exchanges.js'
import { startTestServer } from './helpers.js'

const EXCHANGES_PATH = '/workflows/ephemeral/exchanges'

/**
 * Creates an exchange over the wire and returns its id plus the URL the server
 * minted for it (asserting the header and the body agree along the way).
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param [options.request] {unknown}   the opaque request payload to store
 * @returns {Promise<{ exchangeId: string, url: string }>}
 */
async function createExchange({
  serverUrl,
  request = { type: 'VerifiablePresentationRequest' }
}: {
  serverUrl: string
  request?: unknown
}): Promise<{ exchangeId: string; url: string }> {
  const response = await fetch(`${serverUrl}${EXCHANGES_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request })
  })
  expect(response.status).toBe(201)
  const location = response.headers.get('location')
  const body = (await response.json()) as { location: string }
  expect(location).toBe(body.location)
  const url = body.location
  return { exchangeId: url.slice(url.lastIndexOf('/') + 1), url }
}

describe('Ephemeral exchanges API', () => {
  let fastify: FastifyInstance
  let serverUrl: string

  beforeAll(async () => {
    ;({ fastify, serverUrl } = await startTestServer())
  })

  afterAll(async () => {
    await fastify.close()
  })

  describe('create', () => {
    it('creates an exchange and returns its URL in the header and body', async () => {
      const { exchangeId, url } = await createExchange({ serverUrl })

      expect(url).toBe(`${serverUrl}${EXCHANGES_PATH}/${exchangeId}`)
      expect(exchangeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      )
    })

    it('refuses a body with no "request" member', async () => {
      const response = await fetch(`${serverUrl}${EXCHANGES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notRequest: true })
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'Missing "request" field'
      })
    })
  })

  describe('begin', () => {
    it('returns the stored request verbatim for an empty-object POST', async () => {
      const stored = { type: 'VerifiablePresentationRequest', challenge: 'abc' }
      const { url } = await createExchange({ serverUrl, request: stored })

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(stored)
    })

    it('treats a POST with no body at all as a begin', async () => {
      const stored = { query: [{ type: 'DIDAuthentication' }] }
      const { url } = await createExchange({ serverUrl, request: stored })

      const response = await fetch(url, { method: 'POST' })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(stored)
    })
  })

  describe('respond and poll', () => {
    it('reports a pending exchange before a response is posted', async () => {
      const { exchangeId, url } = await createExchange({ serverUrl })

      const response = await fetch(url)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        id: exchangeId,
        sequence: 0,
        state: 'pending'
      })
    })

    it('stores and echoes a response, then reports the exchange complete', async () => {
      const { exchangeId, url } = await createExchange({ serverUrl })
      const submitted = {
        type: 'VerifiablePresentation',
        holder: 'did:example:1'
      }

      const posted = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submitted)
      })

      expect(posted.status).toBe(200)
      expect(await posted.json()).toEqual(submitted)

      const polled = await fetch(url)
      expect(polled.status).toBe(200)
      expect(await polled.json()).toEqual({
        id: exchangeId,
        sequence: 1,
        state: 'complete',
        response: submitted
      })
    })

    it('lets the last response write win', async () => {
      const { url } = await createExchange({ serverUrl })

      for (const attempt of [{ attempt: 1 }, { attempt: 2 }]) {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(attempt)
        })
      }

      const polled = (await (await fetch(url)).json()) as {
        response: { attempt: number }
      }
      expect(polled.response).toEqual({ attempt: 2 })
    })
  })

  describe('protocols', () => {
    it('returns the VC API interaction URL', async () => {
      const { url } = await createExchange({ serverUrl })

      const response = await fetch(`${url}/protocols`)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ protocols: { vcapi: url } })
    })

    it('ignores the QR-carried iuv query parameter', async () => {
      const { url } = await createExchange({ serverUrl })

      const response = await fetch(`${url}/protocols?iuv=1`)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ protocols: { vcapi: url } })
    })
  })

  describe('unknown exchanges', () => {
    const unknownUrl = () =>
      `${serverUrl}${EXCHANGES_PATH}/00000000-0000-4000-8000-000000000000`

    it('404s a poll', async () => {
      expect((await fetch(unknownUrl())).status).toBe(404)
    })

    it('404s a begin', async () => {
      const response = await fetch(unknownUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      expect(response.status).toBe(404)
    })

    it('404s a response submission', async () => {
      const response = await fetch(unknownUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'VerifiablePresentation' })
      })
      expect(response.status).toBe(404)
    })

    it('404s a protocols read', async () => {
      expect((await fetch(`${unknownUrl()}/protocols`)).status).toBe(404)
    })
  })

  describe('body limit', () => {
    it('rejects a body larger than 64 KiB', async () => {
      const response = await fetch(`${serverUrl}${EXCHANGES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: { padding: 'x'.repeat(70 * 1024) } })
      })

      expect(response.status).toBe(413)
    })
  })
})

/**
 * Boots a bare Fastify instance carrying only the exchanges facet, so the TTL
 * and the live-exchange cap can be overridden per test through the plugin's
 * registration options (the wired-up server keeps the module defaults).
 *
 * @param options {object}
 * @param [options.exchangeTtlMs] {number}
 * @param [options.maxLiveExchanges] {number}
 * @returns {Promise<FastifyInstance>}
 */
async function exchangesOnlyApp({
  exchangeTtlMs,
  maxLiveExchanges
}: {
  exchangeTtlMs?: number
  maxLiveExchanges?: number
} = {}): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('serverUrl', 'http://localhost:9999')
  app.register(initExchangeRoutes, { exchangeTtlMs, maxLiveExchanges })
  await app.ready()
  return app
}

describe('Ephemeral exchanges lifetime and bounds', () => {
  it('404s every route once an exchange has expired', async () => {
    const app = await exchangesOnlyApp({ exchangeTtlMs: 25 })
    try {
      const created = await app.inject({
        method: 'POST',
        url: EXCHANGES_PATH,
        payload: { request: { hello: 'world' } }
      })
      expect(created.statusCode).toBe(201)
      const { location } = created.json() as { location: string }
      const path = new URL(location).pathname

      // Still live right away.
      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(
        200
      )

      await new Promise(resolve => setTimeout(resolve, 60))

      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(
        404
      )
      expect(
        (await app.inject({ method: 'GET', url: `${path}/protocols` }))
          .statusCode
      ).toBe(404)
      expect(
        (await app.inject({ method: 'POST', url: path, payload: {} }))
          .statusCode
      ).toBe(404)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            payload: { type: 'VerifiablePresentation' }
          })
        ).statusCode
      ).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('refuses creation with 429 once the live-exchange cap is reached', async () => {
    const app = await exchangesOnlyApp({ maxLiveExchanges: 2 })
    try {
      for (let index = 0; index < 2; index++) {
        const created = await app.inject({
          method: 'POST',
          url: EXCHANGES_PATH,
          payload: { request: { index } }
        })
        expect(created.statusCode).toBe(201)
      }

      const refused = await app.inject({
        method: 'POST',
        url: EXCHANGES_PATH,
        payload: { request: { index: 2 } }
      })

      expect(refused.statusCode).toBe(429)
      expect(refused.json()).toEqual({
        error: 'Too many active exchanges; try again later.'
      })
    } finally {
      await app.close()
    }
  })

  it('lets an expired exchange free its slot under the cap', async () => {
    const app = await exchangesOnlyApp({
      exchangeTtlMs: 25,
      maxLiveExchanges: 1
    })
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: EXCHANGES_PATH,
            payload: { request: { first: true } }
          })
        ).statusCode
      ).toBe(201)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: EXCHANGES_PATH,
            payload: { request: { second: true } }
          })
        ).statusCode
      ).toBe(429)

      await new Promise(resolve => setTimeout(resolve, 60))

      expect(
        (
          await app.inject({
            method: 'POST',
            url: EXCHANGES_PATH,
            payload: { request: { third: true } }
          })
        ).statusCode
      ).toBe(201)
    } finally {
      await app.close()
    }
  })
})
