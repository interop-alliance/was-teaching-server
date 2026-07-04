/**
 * App factory: createApp() builds the Fastify instance, registers plugins
 * (cors, static, view, multipart), decorates `serverUrl`, and mounts the route
 * groups (the four WAS groups plus the WebKMS `/kms` facet).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import fastifyView from '@fastify/view'
import fastifyStatic from '@fastify/static'
import Multipart from '@fastify/multipart'
import handlebars from 'handlebars'
import path from 'node:path'

import {
  initCollectionRoutes,
  initKmsRoutes,
  initResourceRoutes,
  initSpaceRoutes,
  initSpacesRepositoryRoutes
} from './routes.js'
import { initCorsProxyRoutes as initApiCorsProxyRoutes } from './corsProxy.js'
import { defaultBackend } from './storage.js'
import type { StorageBackend, BackendProviderRegistry } from './types.js'
import { SPEC_URL, SERVER_VERSION } from './config.default.js'

// TODO: https://github.com/fastify/fastify-helmet
// TODO: https://github.com/fastify/fastify-env

/**
 * Builds the Fastify instance: registers plugins (cors, static, view,
 * multipart), decorates `serverUrl`, and mounts the route groups (the four
 * WAS groups plus the WebKMS `/kms` facet).
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
 * @param [options.providers] {BackendProviderRegistry}   the provider-adapter
 *   registry the resolver uses to build a Collection's selected external
 *   backend; defaults to an empty map (no external backend is operable).
 * @param [options.enabledBackendProviders] {string[]}   the registration
 *   allowlist of backend `provider` names; `undefined` means permissive.
 * @returns {import('fastify').FastifyInstance}
 */
export function createApp({
  serverUrl,
  backend,
  storageLimitPerSpace,
  maxUploadBytes,
  providers,
  enabledBackendProviders
}: {
  serverUrl?: string
  backend?: StorageBackend
  storageLimitPerSpace?: number
  maxUploadBytes?: number
  providers?: BackendProviderRegistry
  enabledBackendProviders?: string[]
} = {}): FastifyInstance {
  // By default uses 'pino' logger
  const fastify = Fastify({ logger: true })

  fastify.decorate('serverUrl', serverUrl as string)
  // Route the backend's diagnostics through the Fastify pino logger (the backend
  // defaults to a silent logger until wired here).
  const storage =
    backend ??
    defaultBackend({ capacityBytes: storageLimitPerSpace, maxUploadBytes })
  storage.logger = fastify.log
  fastify.decorate('storage', storage)

  // The provider-adapter registry the resolver (lib/backendRegistry.ts) consults
  // to build a Collection's selected external backend. Injected (rather than a
  // module-global mutable registry) so parallel test suites stay isolated -- the
  // same rationale as the injected `storage`. Empty in production this stage.
  fastify.decorate('backendProviders', providers ?? new Map())
  // The optional registration allowlist (config `WAS_ENABLED_BACKENDS`);
  // `undefined` = permissive (any provider may be registered).
  fastify.decorate('enabledBackendProviders', enabledBackendProviders)

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

  // Parse `application/<suffix>+json` bodies (e.g. `application/jose+json` for
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

  // Catch-all parser for arbitrary binary representations. The spec ("Content
  // Types and Representations") lets a Resource be any media type, so a raw
  // (non-multipart) blob PUT/POST -- `application/octet-stream`,
  // `application/jsonl`, images, etc. -- must reach the handler as a byte
  // stream. Fastify only ships parsers for `application/json` and `text/plain`
  // and would otherwise reject every other media type with a 415 before the
  // route runs. This bare pass-through leaves `request.body` as the raw stream,
  // which `resolveResourceInput` normalizes to a `kind: 'binary'` input that the
  // backend streams straight to storage. More specific parsers still win over
  // this fallback: the built-in JSON/text parsers, the `+json` regex above,
  // `@fastify/multipart`'s `multipart/*`, and the `application/x-tar` import
  // parser are all matched ahead of it.
  fastify.addContentTypeParser('*', function (_request, payload, done) {
    done(null, payload)
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
  fastify.register(initSpacesRepositoryRoutes)
  fastify.register(initSpaceRoutes)
  fastify.register(initCollectionRoutes)
  fastify.register(initResourceRoutes)
  fastify.register(initKmsRoutes)

  return fastify
}
