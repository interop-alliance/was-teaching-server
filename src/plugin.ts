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
import { assertValidServerUrl } from './config.default.js'
import { defaultBackend } from './storage.js'
import { onboardingTokenAuthorizer } from './provisioning.js'
import type {
  StorageBackend,
  BackendProviderRegistry,
  KmsRecordKekRegistry,
  AuthorizeProvisioning
} from './types.js'

export interface FastifyWasOptions {
  /**
   * This server's base URL; used to build and match ZCap invocationTarget URLs
   * (host and port must match exactly). When provided, it must be an absolute
   * `http:`/`https:` URL with no path, query, or fragment (validated at
   * registration -- sub-path deployment is not supported).
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
   * `undefined` means unlimited; `Infinity` (an explicit `unlimited`) is
   * normalized by the backend to the same no-limit behavior.
   */
  storageLimitPerSpace?: number
  /**
   * Per-upload size cap in bytes (spec "Quotas", `maxUploadBytes`); applied
   * only to the default backend (an injected `backend` carries its own).
   * `undefined` applies the backend's default-on cap
   * ({@link DEFAULT_MAX_UPLOAD_BYTES}); `Infinity` (an explicit `unlimited`)
   * disables the cap.
   */
  maxUploadBytes?: number
  /**
   * Max Spaces a single controller may create (spec "Quotas", a default-on
   * count quota); applied only to the default backend (an injected `backend`
   * carries its own). `undefined` applies the backend's default
   * ({@link DEFAULT_MAX_SPACES_PER_CONTROLLER}); `Infinity` (an explicit
   * `unlimited`) disables the cap.
   */
  maxSpacesPerController?: number
  /**
   * Max Collections a single Space may hold (spec "Quotas", a default-on count
   * quota); applied only to the default backend (an injected `backend` carries
   * its own). `undefined` applies the backend's default
   * ({@link DEFAULT_MAX_COLLECTIONS_PER_SPACE}); `Infinity` (an explicit
   * `unlimited`) disables the cap.
   */
  maxCollectionsPerSpace?: number
  /**
   * Max live Resources a single Space may hold across all its Collections (spec
   * "Quotas", a default-on count quota); applied only to the default backend
   * (an injected `backend` carries its own). `undefined` applies the backend's
   * default ({@link DEFAULT_MAX_RESOURCES_PER_SPACE}); `Infinity` (an explicit
   * `unlimited`) disables the cap.
   */
  maxResourcesPerSpace?: number
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
  /**
   * Custom provisioning gate for `POST /spaces/` and `POST /kms/keystores`;
   * receives `{ request }` and returns `'verify'` (normal zcap path), `'grant'`
   * (authorized by the callback -- skip zcap verification), or `'deny'` (403).
   * `undefined` means allow (the teaching default). Mutually exclusive with
   * `onboardingToken`.
   */
  authorizeProvisioning?: AuthorizeProvisioning
  /**
   * Shared-secret gate for `POST /spaces/` and `POST /kms/keystores` (config
   * `WAS_ONBOARDING_TOKEN`); when set, those two endpoints require an
   * `Authorization: Bearer <token>` header, which then substitutes for zcap
   * verification on that request. `undefined` means disabled (the teaching
   * default). Mutually exclusive with `authorizeProvisioning`.
   */
  onboardingToken?: string
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
    maxSpacesPerController,
    maxCollectionsPerSpace,
    maxResourcesPerSpace,
    providers,
    enabledBackendProviders,
    kmsRecordKek,
    authorizeProvisioning,
    onboardingToken
  } = options

  // Fail fast on a malformed base URL: a serverUrl carrying a path, query, or
  // fragment silently breaks every ZCap invocationTarget match and Location
  // header (URL-joins drop the base path), so it is rejected at registration.
  if (serverUrl !== undefined) {
    assertValidServerUrl(serverUrl)
  }

  // The two provisioning gates are alternative ways to configure the same seam.
  if (authorizeProvisioning && onboardingToken) {
    throw new Error(
      'authorizeProvisioning and onboardingToken are mutually exclusive.'
    )
  }

  fastify.decorate('serverUrl', serverUrl as string)
  // Route the backend's diagnostics through the Fastify pino logger (the backend
  // defaults to a silent logger until wired here).
  const storage =
    backend ??
    defaultBackend({
      capacityBytes: storageLimitPerSpace,
      maxUploadBytes,
      maxSpacesPerController,
      maxCollectionsPerSpace,
      maxResourcesPerSpace
    })
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
  // The provisioning gate for `POST /spaces/` and `POST /kms/keystores`: a
  // custom callback, or the stock onboarding-token check when a token is set,
  // or `undefined` = allow (the teaching default). Read by the `provisioningGate`
  // onRequest hook installed by those two route groups.
  fastify.decorate(
    'authorizeProvisioning',
    authorizeProvisioning ??
      (onboardingToken ? onboardingTokenAuthorizer(onboardingToken) : undefined)
  )

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
  // The cap is default-on (the backend applies `DEFAULT_MAX_UPLOAD_BYTES` when
  // none is configured), so `storage.maxUploadBytes` is `undefined` here only
  // when the operator explicitly opted out (`MAX_UPLOAD_BYTES=unlimited`); the
  // conditional spread then leaves multipart uncapped. Large binaries should
  // use the streaming raw-body path, not multipart.
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
