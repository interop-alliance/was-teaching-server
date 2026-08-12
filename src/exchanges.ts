/**
 * The ephemeral exchanges facet: a transient, unauthenticated rendezvous the
 * server offers for cross-device flows (a desktop page mints an exchange, a
 * phone scans its QR and posts the answer back). It is a capability-URL
 * surface -- possession of the unguessable exchange URL is the only access
 * control there is, so the URL must be treated as the secret it is. The server
 * never inspects what it relays: the `request` a creator stores and the
 * `response` a responder posts are opaque JSON to it (in practice a
 * presentation request and a presentation). Every exchange is in-memory only,
 * bounded in count, and expires roughly ten minutes after creation -- nothing
 * is persisted, and a server restart drops all live exchanges. This facet is
 * deliberately outside the WAS zcap authorization model; it holds no wallet
 * data and grants no access to any Space.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { LruCache } from '@interop/lru-memoize'

/**
 * How long an exchange stays live, measured from creation. It must comfortably
 * exceed the wall-clock a consumer's ceremony takes end to end -- a ~5 minute
 * invite countdown plus a ~2 minute poll window -- so a person scanning a QR
 * late still lands on a live exchange rather than a 404.
 */
const EXCHANGE_TTL_MS = 10 * 60 * 1000

/**
 * Upper bound on live (non-expired) exchanges. Creation is refused with 429
 * once the bound is reached, so an unauthenticated endpoint cannot be used to
 * grow the server's memory without limit. It is also passed to the underlying
 * LRU as `max`, as a backstop.
 */
const MAX_LIVE_EXCHANGES = 1000

/**
 * Prefix for the cache key an exchange id maps to, so the store's key space
 * stays self-describing if it ever holds anything else.
 */
const KEY_PREFIX = 'exchange:'

/**
 * One live exchange: the opaque `request` its creator stored, plus the opaque
 * `response` a responder later posted (absent until then). Both halves share
 * one cache entry, so they share one lifetime and expiry is a single event.
 */
interface ExchangeRecord {
  request: unknown
  response?: unknown
}

/**
 * True when a POST to an exchange is the "begin" call (fetch the stored
 * request) rather than a response submission: no body at all, an explicit
 * `null`, or an empty JSON object.
 * @param body {unknown}   the parsed request body
 * @returns {boolean}
 */
function isBeginBody(body: unknown): boolean {
  if (body === undefined || body === null) {
    return true
  }
  return (
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as object).length === 0
  )
}

/**
 * Registers the ephemeral exchange routes under
 * `/workflows/ephemeral/exchanges`. Deliberately unauthenticated: these routes
 * install none of the WAS auth/digest hook chains, exactly like the CORS proxy
 * facet, and their only access control is the unguessable exchange URL.
 *
 * Each registration owns its own store (rather than a module-global one), so
 * parallel test servers stay isolated.
 *
 * @param app {import('fastify').FastifyInstance}   Fastify instance
 * @param options {import('fastify').FastifyPluginOptions}   Fastify plugin
 *   options
 * @param [options.exchangeTtlMs] {number}   override the exchange lifetime in
 *   ms; defaults to {@link EXCHANGE_TTL_MS} (tests inject a short one)
 * @param [options.maxLiveExchanges] {number}   override the live-exchange cap;
 *   defaults to {@link MAX_LIVE_EXCHANGES}
 * @returns {Promise<void>}
 */
export async function initExchangeRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions
): Promise<void> {
  const ttl: number = options.exchangeTtlMs ?? EXCHANGE_TTL_MS
  const max: number = options.maxLiveExchanges ?? MAX_LIVE_EXCHANGES
  const store = new LruCache({ max, ttl })

  // These routes speak JSON only. The root instance installs a catch-all
  // parser that hands the raw stream through as `request.body` for arbitrary
  // Resource representations; that makes no sense here, so this encapsulated
  // context drops it and any other media type is refused with 415.
  app.removeContentTypeParser('*')

  /**
   * Reads the live record behind an exchange id, or `undefined` when the id is
   * unknown or its entry has expired (the LRU prunes on access).
   * @param exchangeId {string}
   * @returns {Promise<ExchangeRecord | undefined>}
   */
  async function readExchange(
    exchangeId: string
  ): Promise<ExchangeRecord | undefined> {
    const entry = store.cache.get(KEY_PREFIX + exchangeId) as
      Promise<ExchangeRecord> | undefined
    return entry ? await entry : undefined
  }

  /**
   * The canonical URL of an exchange on this server. Read from the per-request
   * instance, so a server whose `serverUrl` is corrected after `listen()`
   * (the test helper) still mints correct URLs.
   * @param options {object}
   * @param options.serverUrl {string}
   * @param options.exchangeId {string}
   * @returns {string}
   */
  function exchangeUrl({
    serverUrl,
    exchangeId
  }: {
    serverUrl: string
    exchangeId: string
  }): string {
    return `${serverUrl}/workflows/ephemeral/exchanges/${exchangeId}`
  }

  app.post<{ Body: { request?: unknown } | null }>(
    '/workflows/ephemeral/exchanges',
    { bodyLimit: 65536 },
    async (request, reply) => {
      const requestData = request.body?.request
      if (requestData === undefined || requestData === null) {
        return reply.code(400).send({ error: 'Missing "request" field' })
      }

      // Drop expired entries before counting, so long-dead exchanges never
      // consume the cap.
      store.cache.purgeStale()
      if (store.cache.size >= max) {
        return reply
          .code(429)
          .send({ error: 'Too many active exchanges; try again later.' })
      }

      const exchangeId = randomUUID()
      const record: ExchangeRecord = { request: requestData }
      await store.memoize({
        key: KEY_PREFIX + exchangeId,
        fn: async () => record
      })

      const url = exchangeUrl({
        serverUrl: request.server.serverUrl,
        exchangeId
      })
      return reply.code(201).header('Location', url).send({ location: url })
    }
  )

  app.get<{ Params: { exchangeId: string } }>(
    '/workflows/ephemeral/exchanges/:exchangeId',
    async (request, reply) => {
      const { exchangeId } = request.params
      const record = await readExchange(exchangeId)
      if (!record) {
        return reply.code(404).send()
      }
      if (record.response === undefined) {
        return reply.send({ id: exchangeId, sequence: 0, state: 'pending' })
      }
      return reply.send({
        id: exchangeId,
        sequence: 1,
        state: 'complete',
        response: record.response
      })
    }
  )

  app.post<{ Params: { exchangeId: string }; Body: unknown }>(
    '/workflows/ephemeral/exchanges/:exchangeId',
    { bodyLimit: 65536 },
    async (request, reply) => {
      const { exchangeId } = request.params
      const record = await readExchange(exchangeId)
      if (!record) {
        return reply.code(404).send()
      }

      // "Begin": hand back the stored request verbatim.
      if (isBeginBody(request.body)) {
        return reply.send(record.request)
      }

      // Otherwise this is the response half of the exchange. Last write wins.
      record.response = request.body
      return reply.send(request.body)
    }
  )

  app.get<{ Params: { exchangeId: string } }>(
    '/workflows/ephemeral/exchanges/:exchangeId/protocols',
    async (request, reply) => {
      const { exchangeId } = request.params
      const record = await readExchange(exchangeId)
      if (!record) {
        return reply.code(404).send()
      }
      return reply.send({
        protocols: {
          vcapi: exchangeUrl({
            serverUrl: request.server.serverUrl,
            exchangeId
          })
        }
      })
    }
  )
}
