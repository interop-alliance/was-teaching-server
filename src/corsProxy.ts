/**
 * CORS proxy route
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify'

const PROXY_TIMEOUT_MS = 10_000

interface CorsProxyQuery {
  url?: string
}

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
