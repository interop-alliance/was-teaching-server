/**
 * App factory: createApp() builds the Fastify instance, registers plugins
 * (cors, static, view, multipart), decorates `serverUrl`, and mounts the four
 * route groups.
 */
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions
} from 'fastify'
import cors from '@fastify/cors'
import fastifyView from '@fastify/view'
import fastifyStatic from '@fastify/static'
// import Accepts from '@fastify/accepts'
import Multipart from '@fastify/multipart'
import handlebars from 'handlebars'
import path from 'node:path'

import {
  initCollectionRoutes,
  initResourceRoutes,
  initSpaceRoutes,
  initSpacesRepositoryRoutes
} from './routes.js'
import { defaultBackend } from './storage.js'
import type { StorageBackend } from './types.js'
import { SPEC_URL, SERVER_VERSION } from './config.default.js'

// TODO: https://github.com/fastify/fastify-helmet
// TODO: https://github.com/fastify/fastify-env

/** The constraint-strategy type Fastify's `routerOptions.constraints` accepts. */
type ContentTypeConstraint = NonNullable<
  NonNullable<FastifyServerOptions['routerOptions']>['constraints']
>[string]

/**
 * Set up a route constraint that will allow custom routing based on
 * incoming content type.
 * Usage:
 * app.post('/my-route', { constraints: { 'content-type': 'application/xml' } }...
 *
 * Shape: a Fastify constraint strategy — `{ name, storage, deriveConstraint }`.
 * `storage()` returns a get/set/del/empty store keyed by the content-type
 * string; `deriveConstraint(req, ctx)` returns the request's `content-type`
 * header value used to select a matching route.
 */
const contentTypeStrategy: ContentTypeConstraint = {
  name: 'content-type',
  storage: function () {
    // Holds find-my-way route handlers keyed by content-type; the handler type
    // lives in the (transitive, non-importable) find-my-way package.
    let contentTypes: Record<string, any> = {}
    return {
      get: contentType => contentTypes[contentType] || null,
      set: (contentType, store) => {
        contentTypes[contentType] = store
      },
      del: contentType => {
        delete contentTypes[contentType]
      },
      empty: () => {
        contentTypes = {}
      }
    }
  },
  // Returns undefined when the header is absent (find-my-way treats that as "no
  // constraint"); the strategy type declares `string`, so cast to satisfy it.
  deriveConstraint: (req, _ctx) => req.headers['content-type'] as string
}

/**
 * Builds the Fastify instance: registers plugins (cors, static, view,
 * multipart), decorates `serverUrl`, and mounts the four route groups.
 * @param options {object}
 * @param [options.serverUrl] {string}   this server's base URL; used to build
 *   and match ZCap invocationTarget URLs (host and port must match exactly)
 * @param [options.backend] {StorageBackend}   persistence backend to use;
 *   defaults to a filesystem backend rooted at the project `data/` directory.
 *   Tests inject their own (e.g. a FileSystemBackend over a temp dir).
 * @returns {import('fastify').FastifyInstance}
 */
export function createApp({
  serverUrl,
  backend
}: { serverUrl?: string; backend?: StorageBackend } = {}): FastifyInstance {
  // By default uses 'pino' logger
  const fastify = Fastify({
    logger: true,
    routerOptions: {
      constraints: {
        'content-type': contentTypeStrategy
      }
    }
  })

  fastify.decorate('serverUrl', serverUrl as string)
  // Route the backend's diagnostics through the Fastify pino logger (the backend
  // defaults to a silent logger until wired here).
  const storage = backend ?? defaultBackend()
  storage.logger = fastify.log
  fastify.decorate('storage', storage)

  // Disable CORS
  fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  })

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

  // Multipart file uploading
  fastify.register(Multipart, {
    limits: {
      files: 1
    }
  })

  // Add a content-type Accepts parser
  // fastify.register(Accepts)

  // Add a human-readable 'Welcome' page
  fastify.get('/', async (request, reply) => {
    return reply.view('home', { title: 'Welcome', SPEC_URL, SERVER_VERSION })
  })

  fastify.register(initSpacesRepositoryRoutes)
  fastify.register(initSpaceRoutes)
  fastify.register(initCollectionRoutes)
  fastify.register(initResourceRoutes)

  return fastify
}
