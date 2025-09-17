import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyView from '@fastify/view'
import fastifyStatic from '@fastify/static'
import handlebars from 'handlebars'
import path from 'node:path'

import { initSpaceRoutes } from './routes.js'
import { SPEC_URL } from '../config.default.js'

// TODO: https://github.com/fastify/fastify-helmet
// TODO: https://github.com/fastify/fastify-env

export function createApp (options) {
  // By default uses 'pino' logger
  const fastify = Fastify({ logger: true })

  // Disable CORS
  fastify.register(cors, { origin: '*' })

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
    return reply.view('home', { title: 'Welcome', SPEC_URL })
  })

  fastify.register(initSpaceRoutes)

  return fastify
}

export async function startServer () {
  try {
    await fastify.listen({ port: 3002 })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

const fastify = createApp()
// startServer(fastify)
