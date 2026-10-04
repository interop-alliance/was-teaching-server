import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginOptions
} from 'fastify'
import { lookup as dnsLookup } from 'node:dns/promises'
import { fetch, Agent } from 'undici'
import type { Response } from 'undici'
import { LRUCache } from 'lru-cache'
import { LruCache } from '@interop/lru-memoize'

import {
  CORS_PROXY_AGENT_CACHE_MAX,
  CORS_PROXY_AGENT_CACHE_TTL,
  CORS_PROXY_HOST_CHECK_CACHE_MAX,
  CORS_PROXY_HOST_CHECK_CACHE_TTL,
  CORS_PROXY_RESPONSE_CACHE_MAX,
  CORS_PROXY_RESPONSE_CACHE_MAX_BYTES,
  CORS_PROXY_RESPONSE_CACHE_MAX_ENTRY_BYTES,
  CORS_PROXY_RESPONSE_CACHE_MAX_TTL,
  CORS_PROXY_RESPONSE_CACHE_TTL
} from './config.default.js'
import {
  createPinnedLookup,
  isBlockedIp,
  readBodyBounded
} from './lib/outboundAddress.js'

const PROXY_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5

/**
 * Upper bound on the response body the proxy will buffer and relay. Caps memory
 * use per proxied request and refuses to relay an oversized upstream response
 * (enforced both from a declared `content-length` and while streaming).
 */
const PROXY_MAX_RESPONSE_BYTES = 10 * 1024 * 1024

/**
 * Upstream response headers the proxy never copies onto its own reply.
 * `connection`, `keep-alive`, and `transfer-encoding` are hop-by-hop.
 * `content-encoding` and `content-length` describe the bytes on the upstream
 * wire, but undici hands the proxy an already-decoded body (and Fastify sets
 * the length of the buffer it actually sends), so relaying them would make a
 * browser try to decode plaintext. `set-cookie` is scoped to the upstream
 * origin and has no meaning on the proxy's own origin; relaying it would drop
 * one client's upstream cookie into every later client's jar once responses
 * are cached. `date` and `age` describe the moment the upstream answered;
 * Node emits a fresh `Date` for every reply, and a cache hit gets its own
 * `Age` (see {@link CachedResponse}). `link` is dropped because a browser acts
 * on a `Link: rel=preload` header on the proxy's reply, resolving relative
 * URLs against the proxy's own origin, so an upstream could make it fetch
 * arbitrary paths here. The upstream's `access-control-*`
 * headers (matched by prefix in {@link isUnrelayedHeader}) are its own CORS
 * answer for its own origin; the proxy's answer is the one `@fastify/cors`
 * sets on this reply, and relaying the upstream's would overwrite it (an
 * upstream `access-control-allow-origin` naming some other origin would shut
 * the browser out of the very response the proxy exists to open up).
 * `refresh` would navigate a browser that opens the reply directly. The
 * upstream's `content-security-policy`, `content-security-policy-report-only`,
 * `x-content-type-options` and `content-disposition` are its own answers for
 * its own origin; the proxy replaces them with {@link PROXY_REPLY_HEADERS}.
 */
const UNRELAYED_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'set-cookie',
  'link',
  'date',
  'age',
  'refresh',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'content-disposition'
])

/**
 * Headers every proxy reply carries, errors included. The proxy is served on
 * the WAS origin, which may also be a wallet's origin, so an upstream
 * `text/html` body must not run there when a browser opens the proxy URL
 * directly. The sandbox gives such a page an opaque origin, `default-src
 * 'none'` loads nothing, `nosniff` stops a generic type from being sniffed as
 * active content, and `attachment` makes a navigation download the body
 * instead of rendering it. None of them affects a reply read with `fetch()`.
 */
const PROXY_REPLY_HEADERS: [string, string][] = [
  ['content-security-policy', "default-src 'none'; sandbox"],
  ['x-content-type-options', 'nosniff'],
  ['content-disposition', 'attachment']
]

/**
 * Whether an upstream response header is dropped rather than relayed: one of
 * {@link UNRELAYED_HEADERS}, or any `access-control-*` header.
 * @param name {string}   the lower-cased header name
 * @returns {boolean}
 */
function isUnrelayedHeader(name: string): boolean {
  return UNRELAYED_HEADERS.has(name) || name.startsWith('access-control-')
}

/**
 * A relayed upstream response: the status, the headers the proxy copies to its
 * own reply (see {@link UNRELAYED_HEADERS} for the ones it drops), the
 * buffered body, and the upstream `Cache-Control` and `Age` that decide
 * whether, and for how long, it may be cached. `upstreamAge` is the seconds
 * the response had already spent in caches upstream (0 when not stated), so
 * its freshness lifetime is counted from when the origin produced it rather
 * than restarted here.
 */
interface RelayedResponse {
  status: number
  headers: [string, string][]
  body: Buffer
  cacheControl: string | null
  upstreamAge: number
}

/**
 * A {@link RelayedResponse} in the response cache, with the time it was
 * stored. A hit is replayed with the relayed headers plus an `Age` of the
 * upstream age at storage time plus the seconds since, so a downstream shared
 * cache counts the upstream `max-age` / `s-maxage` down from where this one
 * did instead of restarting it at replay time.
 */
interface CachedResponse {
  response: RelayedResponse
  storedAt: number
}

/**
 * What one upstream fetch amounted to: a relayed response, or the HTTP status
 * and message the proxy refuses the request with.
 */
type ProxyOutcome = RelayedResponse | { status: number; error: string }

/**
 * A cached upstream `Agent` together with the number of proxied fetches
 * currently dispatched through it. `evicted` is set once the cache has dropped
 * the entry; the Agent is destroyed at that moment when idle, and otherwise by
 * the last in-flight fetch to release it (see {@link acquireAgent}), so an
 * eviction or TTL expiry cannot fail a request that is mid-read on the Agent.
 */
interface PinnedAgent {
  agent: Agent
  inFlight: number
  evicted: boolean
}

/**
 * Parses a proxy target string and validates its scheme only (`http`/`https`).
 * Split out of {@link checkProxyTarget} because the response cache needs to
 * compute its lookup key from the client-supplied URL before paying for the
 * DNS check, and a cache hit needs no DNS check at all. The fragment is
 * stripped, since it is never sent upstream, and a URL carrying credentials is
 * refused, since `fetch` cannot send one. The returned URL's `href` is then
 * exactly the fetched identity (origin, path and search).
 * @param target {string}
 * @returns {{url: URL} | {status: number, error: string}}
 */
function parseProxyUrl(
  target: string
): { url: URL } | { status: number; error: string } {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return { status: 400, error: 'Invalid url query parameter' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      status: 400,
      error: 'Only http and https URLs may be proxied.'
    }
  }
  if (parsed.username || parsed.password) {
    return {
      status: 400,
      error: 'URLs with credentials may not be proxied.'
    }
  }
  parsed.hash = ''
  return { url: parsed }
}

/**
 * Validates a single proxy target's host: it must not resolve to a blocked
 * (private / loopback / link-local) address. Runs once for the client-supplied
 * URL and again for every redirect hop, so an allowed public host cannot bounce
 * the proxy to an internal one. Returns the normalized hostname (brackets
 * stripped from an IPv6 literal, lower-cased) that keys every cache and pin
 * map downstream, plus the exact addresses it validated, so the caller can pin
 * the upstream connection to them (closing the DNS-rebinding TOCTOU).
 *
 * A hostname already validated within `hostCheckCache`'s TTL skips the DNS
 * lookup and reuses those addresses; `isBlockedIp` is still re-run on them
 * (cheap, and a defensive backstop) rather than trusting the cache blindly. A
 * failed or blocked lookup is not cached, so a transiently-unreachable or
 * blocked host is re-checked on every request.
 * @param options {object}
 * @param options.url {URL}   an `http`/`https` URL (see {@link parseProxyUrl})
 * @param options.hostCheckCache {LRUCache<string, {address: string, family: number}[]>}
 * @returns {Promise<{hostname: string, addresses: {address: string, family: number}[]} | {status: number, error: string}>}
 *   the normalized hostname plus its validated addresses when allowed, or the
 *   HTTP status + message to reject with.
 */
async function checkProxyTarget({
  url,
  hostCheckCache
}: {
  url: URL
  hostCheckCache: LRUCache<string, { address: string; family: number }[]>
}): Promise<
  | { hostname: string; addresses: { address: string; family: number }[] }
  | { status: number; error: string }
> {
  // Resolve the host and refuse private / loopback / link-local destinations
  // (SSRF). `dns.lookup` returns the literal itself for an IP host, so
  // IP-literal targets are covered too.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  const cachedAddresses = hostCheckCache.get(hostname)
  if (cachedAddresses) {
    if (cachedAddresses.some(({ address }) => isBlockedIp(address))) {
      return { status: 403, error: 'Proxying to this host is not allowed.' }
    }
    return { hostname, addresses: cachedAddresses }
  }

  let addresses: { address: string; family: number }[]
  try {
    addresses = await dnsLookup(hostname, { all: true })
  } catch {
    return { status: 502, error: 'Unable to resolve proxied host.' }
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isBlockedIp(address))
  ) {
    return { status: 403, error: 'Proxying to this host is not allowed.' }
  }
  hostCheckCache.set(hostname, addresses)
  return { hostname, addresses }
}

/**
 * Normalizes a client's `Accept` header for the response-cache key and the
 * upstream request, so variants that mean the same thing share one entry. Each
 * comma-separated member is split at `;`, and each part is trimmed. The media
 * range and each parameter name are lower-cased, since RFC 9110 makes them
 * case-insensitive, and parameter values are kept as sent. Empty members and
 * parts are dropped. Members keep their order and are rejoined with `, `.
 * Returns `undefined` when nothing is left.
 * @param accept {string | string[] | undefined}
 * @returns {string | undefined}
 */
function normalizeAccept(
  accept: string | string[] | undefined
): string | undefined {
  if (typeof accept !== 'string') {
    return undefined
  }
  const members = accept
    .split(',')
    .map(member => {
      const [range = '', ...params] = member
        .split(';')
        .map(part => part.trim())
        .filter(part => part !== '')
      return [range.toLowerCase(), ...params.map(normalizeParameter)].join(';')
    })
    .filter(member => member !== '')
  return members.length > 0 ? members.join(', ') : undefined
}

/**
 * One `name=value` media-type parameter with its name lower-cased and the
 * whitespace around `=` removed. The value is kept as sent.
 * @param parameter {string}
 * @returns {string}
 */
function normalizeParameter(parameter: string): string {
  const separator = parameter.indexOf('=')
  if (separator === -1) {
    return parameter.toLowerCase()
  }
  const name = parameter.slice(0, separator).trim().toLowerCase()
  const value = parameter.slice(separator + 1).trim()
  return `${name}=${value}`
}

/**
 * Adds `Accept` to a reply's `Vary` header, keeping the members an upstream
 * already listed. The response cache is keyed on the normalized `Accept`, so a
 * downstream cache must key on it too. A `Vary: *` is left alone.
 * @param vary {string | undefined}
 * @returns {string}
 */
function varyWithAccept(vary: string | undefined): string {
  const members = (vary ?? '')
    .split(',')
    .map(member => member.trim())
    .filter(member => member !== '')
  if (members.some(member => member === '*' || /^accept$/i.test(member))) {
    return members.join(', ')
  }
  return [...members, 'Accept'].join(', ')
}

/**
 * Destroys an Agent whose cache entry has been dropped and that no proxied
 * fetch is using any longer. Fire-and-forget: nothing awaits an evicted
 * Agent's teardown except the `onClose` hook, which awaits its own snapshot.
 * @param agent {Agent}
 * @returns {void}
 */
function destroyAgent(agent: Agent): void {
  agent.destroy().catch(() => {
    // best-effort teardown of an idle/evicted Agent
  })
}

/**
 * Takes a hold on the cached Agent pinned to exactly these validated addresses
 * for this hostname, building and caching one when none exists. The key is
 * the single host being dialed on this hop (`hostname=addr1,addr2`, addresses
 * sorted), so every request and redirect hop that lands on the same host with
 * the same resolution shares one connection pool, while a re-resolved address
 * set always gets a fresh Agent. Each Agent holds its own single-entry pin map
 * that nothing else references, so it cannot be changed after the fact.
 *
 * The hold is counted before this function returns, with no await in between,
 * so an eviction or TTL expiry from another request cannot slip in ahead of
 * the dispatch. The caller must call the returned `release` once the hop's
 * body has been read or cancelled; it decrements the count exactly once
 * however many times it is called, and destroys the Agent when the cache has
 * already dropped it and this was its last user. Every hold is therefore
 * paired with its own release, and neither a double release nor a negative
 * count is possible.
 * @param options {object}
 * @param options.hostname {string}   normalized, per `checkProxyTarget`
 * @param options.addresses {{address: string, family: number}[]}
 * @param options.agentCache {LRUCache<string, PinnedAgent>}
 * @returns {{agent: Agent, release: () => void}}
 */
function acquireAgent({
  hostname,
  addresses,
  agentCache
}: {
  hostname: string
  addresses: { address: string; family: number }[]
  agentCache: LRUCache<string, PinnedAgent>
}): { agent: Agent; release: () => void } {
  const key = `${hostname}=${addresses
    .map(({ address }) => address)
    .sort()
    .join(',')}`
  let entry = agentCache.get(key)
  if (!entry) {
    entry = {
      agent: new Agent({
        connect: {
          lookup: createPinnedLookup(new Map([[hostname, addresses]]))
        }
      }),
      inFlight: 0,
      evicted: false
    }
    agentCache.set(key, entry)
  }
  const held = entry
  held.inFlight += 1
  let released = false
  return {
    agent: held.agent,
    release: () => {
      if (released) {
        return
      }
      released = true
      held.inFlight -= 1
      if (held.evicted && held.inFlight === 0) {
        destroyAgent(held.agent)
      }
    }
  }
}

/**
 * Best-effort release of an upstream response body the proxy decided not to
 * read (a redirect hop that was followed rather than returned, or an early
 * refusal after the headers arrived). With the Agent long-lived and shared
 * across requests (see {@link acquireAgent}), an abandoned, unconsumed body can
 * leave its socket unfit for reuse; cancelling it lets undici return the
 * connection to the pool instead.
 * @param body {ReadableStream<Uint8Array> | null}
 * @returns {Promise<void>}
 */
async function cancelBody(
  body: ReadableStream<Uint8Array> | null
): Promise<void> {
  if (!body) {
    return
  }
  try {
    await body.cancel()
  } catch {
    // best-effort -- the stream may already be closed or errored
  }
}

/**
 * Refuses a proxied request after the upstream headers arrived, releasing the
 * unread upstream body first.
 * @param options {object}
 * @param options.upstream {Response}
 * @param options.status {number}
 * @param options.error {string}
 * @returns {Promise<ProxyOutcome>}
 */
async function refuseUpstream({
  upstream,
  status,
  error
}: {
  upstream: Response
  status: number
  error: string
}): Promise<ProxyOutcome> {
  await cancelBody(upstream.body)
  return { status, error }
}

/**
 * Parses the cache lifetime, in milliseconds, that a proxied 2xx response
 * should be cached for, from its `Cache-Control` header. Directives are split
 * and matched by name, so `private` inside another directive's value does not
 * count. Returns `undefined` when the response must not be cached at all:
 * `no-store`, `no-cache`, `private`, a non-positive lifetime (RFC 9111 treats
 * `max-age=0` and a negative value as already stale), or a malformed one.
 * Otherwise the lifetime is `s-maxage` when present (this proxy is a shared
 * cache, and RFC 9111 has `s-maxage` override `max-age` for shared caches),
 * else `max-age`, converted to milliseconds and bounded by
 * `CORS_PROXY_RESPONSE_CACHE_MAX_TTL`; when neither is present, returns
 * `CORS_PROXY_RESPONSE_CACHE_TTL`.
 * @param cacheControl {string | null}
 * @returns {number | undefined}
 */
function cacheTtlFromHeader(cacheControl: string | null): number | undefined {
  if (!cacheControl) {
    return CORS_PROXY_RESPONSE_CACHE_TTL
  }
  const directives = new Map<string, string | undefined>()
  for (const part of cacheControl.split(',')) {
    const directive = part.trim().toLowerCase()
    if (!directive) {
      continue
    }
    const separator = directive.indexOf('=')
    if (separator === -1) {
      directives.set(directive, undefined)
    } else {
      directives.set(
        directive.slice(0, separator).trim(),
        directive
          .slice(separator + 1)
          .trim()
          .replace(/^"|"$/g, '')
      )
    }
  }
  if (
    directives.has('no-store') ||
    directives.has('no-cache') ||
    directives.has('private')
  ) {
    return undefined
  }
  const lifetime = directives.get('s-maxage') ?? directives.get('max-age')
  if (lifetime === undefined) {
    return CORS_PROXY_RESPONSE_CACHE_TTL
  }
  const seconds = Number(lifetime)
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return undefined
  }
  return Math.min(seconds * 1000, CORS_PROXY_RESPONSE_CACHE_MAX_TTL)
}

/**
 * Stores a relayed response in the response cache when it qualifies: a 2xx
 * status, a body within `CORS_PROXY_RESPONSE_CACHE_MAX_ENTRY_BYTES`, and a
 * `Cache-Control` that does not refuse caching (see {@link cacheTtlFromHeader}).
 * A response that does not qualify is simply left uncached -- it is relayed
 * to the client either way.
 * @param options {object}
 * @param options.responseCache {LRUCache<string, CachedResponse>}
 * @param options.cacheKey {string}
 * @param options.response {RelayedResponse}
 * @returns {void}
 */
function storeCachedResponse({
  responseCache,
  cacheKey,
  response
}: {
  responseCache: LRUCache<string, CachedResponse>
  cacheKey: string
  response: RelayedResponse
}): void {
  if (response.status < 200 || response.status >= 300) {
    return
  }
  if (response.body.byteLength > CORS_PROXY_RESPONSE_CACHE_MAX_ENTRY_BYTES) {
    return
  }
  const lifetime = cacheTtlFromHeader(response.cacheControl)
  if (lifetime === undefined) {
    return
  }
  // The lifetime counts from when the origin produced the response; what is
  // left of it here is the lifetime less the age it arrived with.
  const ttl = lifetime - response.upstreamAge * 1000
  if (ttl <= 0) {
    return
  }
  responseCache.set(cacheKey, { response, storedAt: Date.now() }, { ttl })
}

/**
 * Fetches a proxy target upstream, following redirects manually and
 * re-validating every hop against the SSRF guard, and buffers the final
 * response (capped at `PROXY_MAX_RESPONSE_BYTES`). Each hop is dispatched
 * through the cached Agent pinned to that hop's validated addresses (see
 * {@link acquireAgent}); the hold on it is released once the hop's body has been
 * read or cancelled. Asks the upstream for an identity encoding, so the
 * declared `content-length` counts the same bytes the proxy will buffer.
 * Never throws: a network failure becomes a 502 outcome.
 * @param options {object}
 * @param options.url {URL}   the client-supplied target, already scheme-checked
 * @param [options.acceptHeader] {string}   the client's normalized `Accept`
 * @param options.hostCheckCache {LRUCache<string, {address: string, family: number}[]>}
 * @param options.agentCache {LRUCache<string, PinnedAgent>}
 * @param options.log {FastifyBaseLogger}
 * @returns {Promise<ProxyOutcome>}
 */
async function fetchProxied({
  url,
  acceptHeader,
  hostCheckCache,
  agentCache,
  log
}: {
  url: URL
  acceptHeader?: string
  hostCheckCache: LRUCache<string, { address: string; family: number }[]>
  agentCache: LRUCache<string, PinnedAgent>
  log: FastifyBaseLogger
}): Promise<ProxyOutcome> {
  const headers: Record<string, string> = { 'accept-encoding': 'identity' }
  if (acceptHeader !== undefined) {
    headers.accept = acceptHeader
  }

  let current = url
  let held: { agent: Agent; release: () => void } | undefined
  try {
    for (let hop = 0; ; hop++) {
      const checked = await checkProxyTarget({ url: current, hostCheckCache })
      if (!('addresses' in checked)) {
        return checked
      }
      held?.release()
      held = acquireAgent({ ...checked, agentCache })

      const upstream = await fetch(current.href, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        dispatcher: held.agent
      })

      const location = upstream.headers.get('location')
      if (upstream.status >= 300 && upstream.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) {
          return await refuseUpstream({
            upstream,
            status: 502,
            error: 'Too many proxied redirects.'
          })
        }
        let next: URL
        try {
          next = new URL(location, current)
        } catch {
          return await refuseUpstream({
            upstream,
            status: 502,
            error: 'Invalid redirect from proxied URL.'
          })
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return await refuseUpstream({
            upstream,
            status: 502,
            error: 'Invalid redirect from proxied URL.'
          })
        }
        await cancelBody(upstream.body)
        current = next
        continue
      }

      // Refuse an upstream that declares a body larger than the cap before
      // reading any of it.
      const declaredLength = Number(upstream.headers.get('content-length'))
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > PROXY_MAX_RESPONSE_BYTES
      ) {
        return await refuseUpstream({
          upstream,
          status: 502,
          error: 'Proxied response too large.'
        })
      }

      // Read incrementally so an undeclared (or lying) oversized body is
      // stopped mid-stream rather than fully buffered. Upstream headers are
      // collected only after the body is fully read, so a mid-stream
      // rejection does not carry the upstream's content-type on the JSON
      // error response.
      const body = await readBodyBounded({
        body: upstream.body,
        maxBytes: PROXY_MAX_RESPONSE_BYTES
      })
      if (body === undefined) {
        return { status: 502, error: 'Proxied response too large.' }
      }
      const relayedHeaders: [string, string][] = []
      upstream.headers.forEach((value, name) => {
        if (!isUnrelayedHeader(name)) {
          relayedHeaders.push([name, value])
        }
      })
      const declaredAge = Number(upstream.headers.get('age'))
      return {
        status: upstream.status,
        headers: relayedHeaders,
        body,
        cacheControl: upstream.headers.get('cache-control'),
        upstreamAge:
          Number.isInteger(declaredAge) && declaredAge > 0 ? declaredAge : 0
      }
    }
  } catch (err) {
    log.warn({ err, target: url.href }, 'CORS proxy fetch failed')
    return { status: 502, error: 'Unable to fetch proxied URL' }
  } finally {
    held?.release()
  }
}

/**
 * Registers a server-side CORS proxy at `/api/cors`.
 *
 * Example:
 * `/api/cors?url=https%3A%2F%2Fregistry.dcconsortium.org%2F.well-known%2Fopenid-federation`
 *
 * SSRF guard: only `http`/`https` URLs are proxied, and the target host is
 * resolved and rejected when it maps to a private, loopback, or link-local
 * address (e.g. `http://169.254.169.254/...` cloud-metadata, or an internal
 * service). Redirects are followed manually (up to `MAX_REDIRECTS` hops) and
 * every hop is re-validated the same way, so a public host cannot 3xx the
 * proxy into an internal one. The addresses each hop validated are then pinned
 * for the actual upstream connection (via an undici `Agent` whose
 * `connect.lookup` resolves only from that pin); the Agent comes from a small
 * LRU cache keyed by the hop's hostname plus its validated addresses (see
 * `acquireAgent`) and is reused across requests and hops that land on the same
 * host with the same resolution, so repeated proxying to one host skips a
 * fresh TLS handshake. A re-resolved address set always maps to a new Agent,
 * so the DNS-rebinding guarantee that closes the TOCTOU is unchanged. The
 * relayed response body is capped at `PROXY_MAX_RESPONSE_BYTES`, both from a
 * declared `content-length` and while streaming. Hop-by-hop, encoding, cookie,
 * and timing headers are not relayed (see `UNRELAYED_HEADERS`). Every reply
 * carries `PROXY_REPLY_HEADERS` in place of the upstream's own, so an upstream
 * HTML page cannot run on this origin, and a `Vary` that names `Accept`.
 *
 * Four bounded, in-memory caches back this. A hostname `checkProxyTarget` has
 * already validated is reused for `CORS_PROXY_HOST_CHECK_CACHE_TTL` before a
 * fresh DNS lookup is made (the blocked-address check itself always re-runs
 * on a hit, as a cheap backstop). A 2xx GET response is cached by target URL
 * (fragment stripped) plus the normalized `Accept` header, for a TTL taken from the upstream
 * `Cache-Control` (`s-maxage`, else `max-age`, bounded by
 * `CORS_PROXY_RESPONSE_CACHE_MAX_TTL`) or `CORS_PROXY_RESPONSE_CACHE_TTL` when
 * absent -- a non-2xx response, one whose `Cache-Control` refuses caching
 * (`no-store`, `no-cache`, `private`, a non-positive lifetime), or one whose
 * body exceeds `CORS_PROXY_RESPONSE_CACHE_MAX_ENTRY_BYTES` is relayed but not
 * cached. Concurrent requests for the same uncached key share one upstream
 * fetch through a single-flight memo that empties as each fetch settles. And
 * the pinned Agents themselves, described above, are dropped after
 * `CORS_PROXY_AGENT_CACHE_TTL` without use (the TTL restarts on every use and
 * expiry is timer-driven) or on LRU eviction; an Agent still serving a fetch
 * at that moment is destroyed when that fetch releases it. All four are
 * created fresh per call to this function (not module-global), so two
 * `createApp()` instances in one process -- e.g. parallel test suites -- do
 * not share state, and are cleared on the Fastify instance's `onClose`, which
 * awaits the teardown of every cached Agent.
 *
 * This is an unauthenticated open endpoint; adding a lightweight auth gate (a
 * shared secret header, an allowlist of caller origins, or the server's own
 * capability-invocation check) is a reasonable follow-up.
 *
 * @param app - Fastify instance
 * @param _options - Fastify plugin options
 */
export async function initCorsProxyRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  // ttlResolution: 0 disables lru-cache's default ~1ms debounce of its
  // internal clock reads. These caches see nowhere near enough traffic for
  // that debounce to matter, and skipping it keeps every TTL exact.
  const responseCache = new LRUCache<string, CachedResponse>({
    max: CORS_PROXY_RESPONSE_CACHE_MAX,
    maxSize: CORS_PROXY_RESPONSE_CACHE_MAX_BYTES,
    sizeCalculation: entry => entry.response.body.byteLength || 1,
    ttlResolution: 0
  })
  const inFlightFetches = new LruCache({
    max: CORS_PROXY_RESPONSE_CACHE_MAX,
    disposeOnSettle: true
  })
  const hostCheckCache = new LRUCache<
    string,
    { address: string; family: number }[]
  >({
    max: CORS_PROXY_HOST_CHECK_CACHE_MAX,
    ttl: CORS_PROXY_HOST_CHECK_CACHE_TTL,
    ttlResolution: 0
  })
  const agentCache = new LRUCache<string, PinnedAgent>({
    max: CORS_PROXY_AGENT_CACHE_MAX,
    ttl: CORS_PROXY_AGENT_CACHE_TTL,
    ttlResolution: 0,
    updateAgeOnGet: true,
    ttlAutopurge: true,
    dispose: entry => {
      entry.evicted = true
      if (entry.inFlight === 0) {
        destroyAgent(entry.agent)
      }
    }
  })

  app.addHook('onClose', async () => {
    // Snapshot first: clear() runs `dispose`, which tears down only the idle
    // Agents. The server is going away, so every Agent is destroyed here,
    // in-flight or not, and the hook waits for that to finish.
    const entries = [...agentCache.values()]
    agentCache.clear()
    hostCheckCache.clear()
    responseCache.clear()
    await Promise.allSettled(entries.map(entry => entry.agent.destroy()))
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of PROXY_REPLY_HEADERS) {
      reply.header(name, value)
    }
    const vary = reply.getHeader('vary')
    reply.header(
      'vary',
      varyWithAccept(Array.isArray(vary) ? vary.join(', ') : vary?.toString())
    )
    return payload
  })

  app.get<{ Querystring: { url?: string } }>(
    '/api/cors',
    async (request, reply) => {
      const target = request.query.url

      if (!target) {
        return reply.code(400).send({ error: 'Missing url query parameter' })
      }

      const parsedTarget = parseProxyUrl(target)
      if (!('url' in parsedTarget)) {
        return reply
          .code(parsedTarget.status)
          .send({ error: parsedTarget.error })
      }
      const { url } = parsedTarget

      const acceptHeader = normalizeAccept(request.headers.accept)
      const cacheKey = `${url.href}\n${acceptHeader ?? ''}`

      const hit = responseCache.get(cacheKey)
      const outcome =
        hit?.response ??
        (await inFlightFetches.memoize<ProxyOutcome>({
          key: cacheKey,
          fn: async () => {
            const fetched = await fetchProxied({
              url,
              acceptHeader,
              hostCheckCache,
              agentCache,
              log: request.log
            })
            if ('body' in fetched) {
              storeCachedResponse({
                responseCache,
                cacheKey,
                response: fetched
              })
            }
            return fetched
          }
        }))

      if ('error' in outcome) {
        return reply.code(outcome.status).send({ error: outcome.error })
      }
      for (const [name, value] of outcome.headers) {
        reply.header(name, value)
      }
      if (hit) {
        const residentSeconds = Math.floor((Date.now() - hit.storedAt) / 1000)
        reply.header('age', String(outcome.upstreamAge + residentSeconds))
      }
      return reply.code(outcome.status).send(outcome.body)
    }
  )
}
