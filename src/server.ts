/**
 * App factory: createApp() is the community-edition composition. It builds the
 * Fastify instance, registers the `fastifyWas` plugin (the whole WAS protocol
 * surface -- see plugin.ts), and adds the teaching-server extras around it:
 * static assets, the Handlebars-rendered welcome page, the `/health` probe,
 * and the CORS proxy.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyView from '@fastify/view'
import fastifyStatic from '@fastify/static'
import handlebars from 'handlebars'
import path from 'node:path'

import { fastifyWas, type FastifyWasOptions } from './plugin.js'
import { initCorsProxyRoutes as initApiCorsProxyRoutes } from './corsProxy.js'
import { SPEC_URL, SERVER_VERSION } from './config.default.js'

// TODO: https://github.com/fastify/fastify-helmet

/**
 * Builds the Fastify instance: registers the `fastifyWas` protocol plugin
 * (which carries the storage/config decorations and all WAS + WebKMS routes;
 * options are passed through -- see {@link FastifyWasOptions}), then the
 * teaching-server extras (static files, welcome page, health probe, CORS
 * proxy).
 * @param options {FastifyWasOptions}
 * @returns {import('fastify').FastifyInstance}
 */
export function createApp(options: FastifyWasOptions = {}): FastifyInstance {
  // By default uses 'pino' logger
  const fastify = Fastify({ logger: true })

  // The WAS protocol surface (decorations, parsers, WAS + WebKMS route groups)
  fastify.register(fastifyWas, options)

  // Serve static files from the /common folder
  fastify.register(fastifyStatic, {
    root: path.join(import.meta.dirname, '..', 'common'),
    prefix: '/common/'
  })

  // Use Handlebars as the rendering engine
  fastify.register(fastifyView, {
    engine: { handlebars },
    root: path.join(import.meta.dirname, './views'),
    layout: '/templates/main', // ./views/templates/main.hbs
    viewExt: 'hbs'
  })

  // Add a human-readable 'Welcome' page
  fastify.get('/', async (request, reply) => {
    return reply.view('home', { title: 'Welcome', SPEC_URL, SERVER_VERSION })
  })

  // Operational liveness probe (not a WAS protocol feature). Public,
  // unauthenticated, and side-effect-free so load balancers, uptime monitors,
  // and orchestrators can poll it cheaply. Body follows the
  // `application/health+json` shape from the IETF `draft-inadarei-api-health-check`
  // draft; Fastify's implicit HEAD route serves bodyless probes for free.
  fastify.get('/health', async (request, reply) => {
    return reply
      .type('application/health+json')
      .send({ status: 'pass', version: SERVER_VERSION })
  })

  fastify.register(initApiCorsProxyRoutes)

  return fastify
}
