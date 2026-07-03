import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

const PROXY_TIMEOUT_MS = 10_000

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
 * Registers a server-side CORS proxy at `/api/cors`.
 *
 * Example:
 * `/api/cors?url=https%3A%2F%2Fregistry.dcconsortium.org%2F.well-known%2Fopenid-federation`
 *
 * SSRF guard: only `http`/`https` URLs are proxied, and the target host is
 * resolved and rejected when it maps to a private, loopback, or link-local
 * address (e.g. `http://169.254.169.254/...` cloud-metadata, or an internal
 * service). This is an unauthenticated open endpoint; adding a lightweight
 * auth gate (a shared secret header, an allowlist of caller origins, or the
 * server's own capability-invocation check) is a reasonable follow-up.
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

      let parsed: URL
      try {
        parsed = new URL(target)
      } catch {
        return reply.code(400).send({ error: 'Invalid url query parameter' })
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reply
          .code(400)
          .send({ error: 'Only http and https URLs may be proxied.' })
      }

      // Resolve the host and refuse private / loopback / link-local
      // destinations (SSRF). `dns.lookup` returns the literal itself for an IP
      // host, so IP-literal targets are covered too.
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
      let addresses: { address: string }[]
      try {
        addresses = await dnsLookup(hostname, { all: true })
      } catch {
        return reply
          .code(502)
          .send({ error: 'Unable to resolve proxied host.' })
      }
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => isBlockedIp(address))
      ) {
        return reply
          .code(403)
          .send({ error: 'Proxying to this host is not allowed.' })
      }

      const headers: Record<string, string> = {}
      if (typeof request.headers.accept === 'string') {
        headers.accept = request.headers.accept
      }

      try {
        const upstream = await fetch(target, {
          headers,
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS)
        })

        upstream.headers.forEach((value, name) => reply.header(name, value))

        const body = Buffer.from(await upstream.arrayBuffer())
        return reply.code(upstream.status).send(body)
      } catch (error) {
        request.log.warn({ error, target }, 'CORS proxy fetch failed')
        return reply.code(502).send({ error: 'Unable to fetch proxied URL' })
      }
    }
  )
}
