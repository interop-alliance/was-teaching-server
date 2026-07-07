import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import type { LookupFunction } from 'node:net'
import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { fetch, Agent } from 'undici'

const PROXY_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5

/**
 * Upper bound on the response body the proxy will buffer and relay. Caps memory
 * use per proxied request and refuses to relay an oversized upstream response
 * (enforced both from a declared `content-length` and while streaming).
 */
const PROXY_MAX_RESPONSE_BYTES = 10 * 1024 * 1024

interface CorsProxyQuery {
  url?: string
}

/**
 * True for an IPv4 address in a private, loopback, link-local, or otherwise
 * non-public range -- the SSRF-sensitive destinations the proxy must refuse
 * (RFC 1918 private space, `127.0.0.0/8` loopback, `169.254.0.0/16` link-local
 * -- which covers the `169.254.169.254` cloud-metadata endpoint -- CGNAT, and
 * multicast/reserved). A syntactically invalid address is treated as blocked.
 * @param ip {string}
 * @returns {boolean}
 */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true
  }
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local (incl. cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (RFC 6598)
    (a === 192 && b === 0) || // 192.0.0.0/24 IETF protocol assignments
    a >= 224 // multicast / reserved
  )
}

/**
 * True for an IPv6 address in a loopback, unspecified, unique-local (`fc00::/7`),
 * or link-local (`fe80::/10`) range, or an IPv4-mapped/embedded address whose
 * IPv4 form is blocked. A syntactically invalid address is treated as blocked.
 * @param ip {string}
 * @returns {boolean}
 */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  const mapped = lower.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) {
    return isBlockedIpv4(mapped[1]!)
  }
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fe8') || // fe80::/10 link-local
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('fc') || // fc00::/7 unique-local
    lower.startsWith('fd')
  )
}

/**
 * True for an IP the proxy must not reach. Unparseable input is blocked
 * defensively.
 * @param ip {string}
 * @returns {boolean}
 */
function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) {
    return isBlockedIpv4(ip)
  }
  if (family === 6) {
    return isBlockedIpv6(ip)
  }
  return true
}

/**
 * Parses and validates a single proxy target: `http`/`https` scheme only, and
 * the host must not resolve to a blocked (private / loopback / link-local)
 * address. Runs once for the client-supplied URL and again for every redirect
 * hop, so an allowed public host cannot bounce the proxy to an internal one.
 * Returns the exact addresses it validated so the caller can pin the upstream
 * connection to them (closing the DNS-rebinding TOCTOU).
 * @param target {string}
 * @returns {Promise<{url: URL, addresses: {address: string, family: number}[]} | {status: number, error: string}>}
 *   the parsed URL plus its validated addresses when allowed, or the HTTP
 *   status + message to reject with.
 */
async function checkProxyTarget(target: string): Promise<
  | { url: URL; addresses: { address: string; family: number }[] }
  | { status: number; error: string }
> {
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

  // Resolve the host and refuse private / loopback / link-local destinations
  // (SSRF). `dns.lookup` returns the literal itself for an IP host, so
  // IP-literal targets are covered too.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
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
  return { url: parsed, addresses }
}

/**
 * Builds the undici `connect.lookup` function that pins each upstream socket to
 * the exact addresses `checkProxyTarget` already validated, keyed by hostname.
 * The `fetch` still connects using the original hostname (so TLS certificate
 * validation and SNI keep working) but resolves it only via this map, so a
 * rebinding attacker cannot swap in a fresh, private address between validation
 * and connection. A hostname absent from the map is refused (defense in depth:
 * the agent must never resolve an unpinned host).
 * @param pins {Map<string, {address: string, family: number}[]>} validated
 *   addresses keyed by lower-cased hostname.
 * @returns {LookupFunction} an undici/`net`-compatible lookup callback.
 */
export function createPinnedLookup(
  pins: Map<string, { address: string; family: number }[]>
): LookupFunction {
  return function pinnedLookup(
    hostname: string,
    options: { all?: boolean },
    callback: (
      err: NodeJS.ErrnoException | null,
      addressOrAddresses?: string | { address: string; family: number }[],
      family?: number
    ) => void
  ): void {
    const entries = pins.get(hostname.toLowerCase())
    if (!entries || entries.length === 0) {
      callback(new Error(`Refusing to resolve unpinned host: ${hostname}`))
      return
    }
    if (options.all) {
      callback(null, entries)
      return
    }
    const first = entries[0]!
    callback(null, first.address, first.family)
  } as unknown as LookupFunction
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
 * for the actual upstream connection (via a per-request undici `Agent` whose
 * `connect.lookup` resolves only from that pin map), so a DNS-rebinding
 * attacker cannot pass validation with a public IP and have the subsequent
 * `fetch` re-resolve to a private one (closing the TOCTOU). The relayed
 * response body is capped at `PROXY_MAX_RESPONSE_BYTES`, both from a declared
 * `content-length` and while streaming. This is an unauthenticated open
 * endpoint; adding a lightweight auth gate (a shared secret header, an
 * allowlist of caller origins, or the server's own capability-invocation
 * check) is a reasonable follow-up.
 *
 * @param app - Fastify instance
 * @param _options - Fastify plugin options
 */
export async function initCorsProxyRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  app.get<{ Querystring: CorsProxyQuery }>(
    '/api/cors',
    async (request, reply) => {
      const target = request.query.url

      if (!target) {
        return reply.code(400).send({ error: 'Missing url query parameter' })
      }

      const checked = await checkProxyTarget(target)
      if (!('url' in checked)) {
        return reply.code(checked.status).send({ error: checked.error })
      }
      let current = checked.url

      const headers: Record<string, string> = {}
      if (typeof request.headers.accept === 'string') {
        headers.accept = request.headers.accept
      }

      // One undici Agent per proxied request, resolving each hop only via the
      // addresses that hop already validated. The Agent must stay alive until
      // the body is fully read, so it is torn down once in the finally below.
      const pins = new Map<string, { address: string; family: number }[]>()
      const pinKey = (url: URL) =>
        url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      pins.set(pinKey(current), checked.addresses)
      const agent = new Agent({ connect: { lookup: createPinnedLookup(pins) } })

      try {
        for (let hop = 0; ; hop++) {
          const upstream = await fetch(current.href, {
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
            dispatcher: agent
          })

          const location = upstream.headers.get('location')
          if (upstream.status >= 300 && upstream.status < 400 && location) {
            if (hop >= MAX_REDIRECTS) {
              return reply
                .code(502)
                .send({ error: 'Too many proxied redirects.' })
            }
            let next: URL
            try {
              next = new URL(location, current)
            } catch {
              return reply
                .code(502)
                .send({ error: 'Invalid redirect from proxied URL.' })
            }
            const nextChecked = await checkProxyTarget(next.toString())
            if (!('url' in nextChecked)) {
              return reply
                .code(nextChecked.status)
                .send({ error: nextChecked.error })
            }
            current = nextChecked.url
            pins.set(pinKey(current), nextChecked.addresses)
            continue
          }

          // Refuse an upstream that declares a body larger than the cap before
          // reading any of it.
          const declaredLength = Number(upstream.headers.get('content-length'))
          if (
            Number.isFinite(declaredLength) &&
            declaredLength > PROXY_MAX_RESPONSE_BYTES
          ) {
            return reply
              .code(502)
              .send({ error: 'Proxied response too large.' })
          }

          // Read incrementally so an undeclared (or lying) oversized body is
          // stopped mid-stream rather than fully buffered. Upstream headers
          // are copied only after the body is fully read, so a mid-stream
          // rejection does not carry the upstream's content-type /
          // content-length on the JSON error response.
          const chunks: Buffer[] = []
          if (upstream.body) {
            const reader = upstream.body.getReader()
            let total = 0
            for (;;) {
              const { done, value } = await reader.read()
              if (done) {
                break
              }
              total += value.byteLength
              if (total > PROXY_MAX_RESPONSE_BYTES) {
                await reader.cancel()
                return reply
                  .code(502)
                  .send({ error: 'Proxied response too large.' })
              }
              chunks.push(Buffer.from(value))
            }
          }
          upstream.headers.forEach((value, name) => reply.header(name, value))
          return reply.code(upstream.status).send(Buffer.concat(chunks))
        }
      } catch (error) {
        request.log.warn({ error, target }, 'CORS proxy fetch failed')
        return reply.code(502).send({ error: 'Unable to fetch proxied URL' })
      } finally {
        // destroy(), not close(): early-exit paths (blocked redirect, too
        // many redirects, oversized content-length) leave upstream bodies
        // unconsumed, and close() would wait on them. Everything the reply
        // sends is already buffered, so tearing down the sockets is safe.
        await agent.destroy()
      }
    }
  )
}
