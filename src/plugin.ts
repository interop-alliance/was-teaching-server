/**
 * The WAS protocol surface as a registerable Fastify plugin (`fastifyWas`):
 * the storage/config decorations, CORS, multipart and content-type parsers,
 * and the route groups (the four WAS groups plus the WebKMS `/kms` facet) --
 * everything from routes.ts down, including the auth/digest hook chains and
 * the error handler those groups install.
 *
 * The community `createApp()` (server.ts) registers this plugin with defaults;
 * a hardened downstream composition registers the same plugin (with its own
 * backend and policy plugins around it) and inherits the identical wire
 * behavior. Wrapped with `fastify-plugin`, so the decorations and parsers land
 * on the root instance -- while each route group still creates its own
 * encapsulated context for its hooks.
 */
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import Multipart from '@fastify/multipart'

import {
  initCollectionRoutes,
  initKmsRoutes,
  initResourceRoutes,
  initSpaceRoutes,
  initSpacesRepositoryRoutes
} from './routes.js'
import { defaultBackend } from './storage.js'
import type {
  StorageBackend,
  BackendProviderRegistry,
  KmsRecordKekRegistry
} from './types.js'

export interface FastifyWasOptions {
  /**
   * This server's base URL; used to build and match ZCap invocationTarget URLs
   * (host and port must match exactly).
   */
  serverUrl?: string
  /**
   * Persistence backend to use; defaults to a filesystem backend rooted at the
   * project `data/` directory. Tests inject their own (e.g. a
   * FileSystemBackend over a temp dir).
   */
  backend?: StorageBackend
  /**
   * Per-Space storage limit in bytes (spec "Quotas"); applied only to the
   * default backend (an injected `backend` carries its own `capacityBytes`).
   * `undefined` means unlimited.
   */
  storageLimitPerSpace?: number
  /**
   * Per-upload size cap in bytes (spec "Quotas", `maxUploadBytes`); applied
   * only to the default backend (an injected `backend` carries its own).
   * `undefined` means no per-upload cap.
   */
  maxUploadBytes?: number
  /**
   * The provider-adapter registry the resolver uses to build a Collection's
   * selected external backend; defaults to an empty map (no external backend
   * is operable).
   */
  providers?: BackendProviderRegistry
  /**
   * The registration allowlist of backend `provider` names; `undefined` means
   * permissive.
   */
  enabledBackendProviders?: string[]
  /**
   * The at-rest WebKMS key-record encryption registry (config `KMS_RECORD_KEK`);
   * `undefined` (or `currentKekId: null`) disables encryption -- key records are
   * written plaintext (the teaching default).
   */
  kmsRecordKek?: KmsRecordKekRegistry
}

/**
 * Decorates the instance with the WAS storage/config surface, registers the
 * protocol-level plugins and content-type parsers, and mounts the route groups.
 * @param fastify {import('fastify').FastifyInstance}
 * @param options {FastifyWasOptions}
 * @returns {Promise<void>}
 */
async function wasPlugin(
  fastify: FastifyInstance,
  options: FastifyWasOptions
): Promise<void> {
  const {
    serverUrl,
    backend,
    storageLimitPerSpace,
    maxUploadBytes,
    providers,
    enabledBackendProviders,
    kmsRecordKek
  } = options

  fastify.decorate('serverUrl', serverUrl as string)
  // Route the backend's diagnostics through the Fastify pino logger (the backend
  // defaults to a silent logger until wired here).
  const storage =
    backend ??
    defaultBackend({ capacityBytes: storageLimitPerSpace, maxUploadBytes })
  storage.logger = fastify.log
  fastify.decorate('storage', storage)

  // Backend lifecycle: run the optional startup hook (e.g. Postgres connect +
  // migrations) during registration, before the server starts listening, and
  // wire the optional shutdown hook (pool drain) to Fastify's close.
  if (storage.init) {
    await storage.init()
  }
  if (storage.close) {
    fastify.addHook('onClose', async () => {
      await storage.close!()
    })
  }

  // The provider-adapter registry the resolver (lib/backendRegistry.ts) consults
  // to build a Collection's selected external backend. Injected (rather than a
  // module-global mutable registry) so parallel test suites stay isolated -- the
  // same rationale as the injected `storage`. Empty in production this stage.
  fastify.decorate('backendProviders', providers ?? new Map())
  // The optional registration allowlist (config `WAS_ENABLED_BACKENDS`);
  // `undefined` = permissive (any provider may be registered).
  fastify.decorate('enabledBackendProviders', enabledBackendProviders)
  // The at-rest key-record encryption registry (config `KMS_RECORD_KEK`);
  // `undefined` = disabled (records written plaintext). Read at the KMS
  // orchestration seam (KeyRequest), never inside a backend.
  fastify.decorate('kmsRecordKek', kmsRecordKek)

  // Disable CORS
  fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
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

  fastify.register(initSpacesRepositoryRoutes)
  fastify.register(initSpaceRoutes)
  fastify.register(initCollectionRoutes)
  fastify.register(initResourceRoutes)
  fastify.register(initKmsRoutes)
}

export const fastifyWas = fp(wasPlugin, {
  fastify: '5.x',
  name: 'fastify-was'
})
