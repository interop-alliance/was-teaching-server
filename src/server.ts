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
 * @param [options.storageLimitPerSpace] {number}   per-Space storage limit in
 *   bytes (spec "Quotas"); applied only to the default backend (an injected
 *   `backend` carries its own `capacityBytes`). `undefined` means unlimited.
 * @param [options.maxUploadBytes] {number}   per-upload size cap in bytes (spec
 *   "Quotas", `maxUploadBytes`); applied only to the default backend (an
 *   injected `backend` carries its own). `undefined` means no per-upload cap.
 * @returns {import('fastify').FastifyInstance}
 */
export function createApp({
  serverUrl,
  backend,
  storageLimitPerSpace,
  maxUploadBytes
}: {
  serverUrl?: string
  backend?: StorageBackend
  storageLimitPerSpace?: number
  maxUploadBytes?: number
} = {}): FastifyInstance {
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
  const storage =
    backend ??
    defaultBackend({ capacityBytes: storageLimitPerSpace, maxUploadBytes })
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

  // Multipart file uploading. The cap is `files: 2`, not `1`: a write MUST carry
  // exactly one file part, and `resolveResourceInput` enforces that by iterating
  // the parts and rejecting a second one with `invalid-request-body` (400). With
  // a `files: 1` limit busboy would instead silently drop the second part and
  // raise its own `FST_FILES_LIMIT` (413), so the second part must be allowed
  // through to the iterator to be caught and rejected with the correct error.
  //
  // `fileSize` bounds the in-memory buffer of the single permitted part to the
  // backend's per-upload cap (`throwFileSizeLimit` makes `toBuffer()` throw at
  // the boundary, which the request layer maps to `payload-too-large` (413)) --
  // so an oversize multipart upload is rejected before it is fully buffered.
  // Large binaries should use the streaming raw-body path, not multipart.
  fastify.register(Multipart, {
    throwFileSizeLimit: true,
    limits: {
      files: 2,
      ...(storage.maxUploadBytes !== undefined && {
        fileSize: storage.maxUploadBytes
      })
    }
  })

  // Parse `application/<suffix>+json` bodies (e.g. `application/edv+json` for
  // EDV-over-WAS encrypted documents, `application/ld+json`, etc.) as JSON, the
  // same as plain `application/json`. Fastify's built-in JSON parser only
  // matches `application/json` exactly, so structured-suffix JSON media types
  // would otherwise be rejected with a 415. The regex deliberately requires a
  // non-`+` suffix before `+json`, so it never shadows the built-in parser for
  // plain `application/json`. Registered on the root instance so every route
  // group inherits it; `isJson()` already treats `+json` as JSON downstream
  // (digest capture, resource-input resolution).
  fastify.addContentTypeParser(
    /^application\/[^+]+\+json/,
    { parseAs: 'string' },
    fastify.getDefaultJsonParser('error', 'error')
  )

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
