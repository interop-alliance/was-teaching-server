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
 * behavior. Its `ownsBackend` and `cors` options let such a composition keep
 * the backend lifecycle and the CORS policy to itself. Wrapped with
 * `fastify-plugin`, so the decorations and parsers land on the root instance
 * -- while each route group still creates its own encapsulated context for
 * its hooks.
 */
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import cors, { type FastifyCorsOptions } from '@fastify/cors'
import Multipart from '@fastify/multipart'

import {
  initCollectionRoutes,
  initKmsRoutes,
  initResourceRoutes,
  initSpaceRoutes,
  initSpacesRepositoryRoutes
} from './routes.js'
import { initExchangeRoutes } from './exchanges.js'
import {
  addServiceLinkHook,
  initServiceDescriptionRoutes
} from './serviceDescription.js'
import {
  assertValidServerUrl,
  CORS_PREFLIGHT_MAX_AGE
} from './config.default.js'
import { defaultBackend } from './storage.js'
import { bufferedBodyLimit } from './lib/bodyLimit.js'
import { onboardingTokenAuthorizer } from './provisioning.js'
import {
  createServerSigningKey,
  provisionServerSpace,
  resolveServerDid
} from './lib/serverIdentity.js'
import type {
  StorageBackend,
  BackendProviderRegistry,
  KmsRecordKekRegistry,
  AuthorizeProvisioning,
  IDID
} from './types.js'

export interface FastifyWasOptions {
  /**
   * This server's base URL; used to build and match ZCap invocationTarget URLs
   * (host and port must match exactly). Required: it must be an absolute
   * `http:`/`https:` URL with no userinfo, path, query, or fragment (validated
   * at registration -- sub-path deployment is not supported).
   */
  serverUrl: string
  /**
   * Persistence backend to use; defaults to a filesystem backend rooted at
   * `dataDir` (the project `data/` directory when that is unset). Tests inject
   * their own (e.g. a FileSystemBackend over a temp dir).
   */
  backend?: StorageBackend
  /**
   * Whether the plugin manages the backend's lifecycle. When `true` (the
   * default), it routes the backend's `logger` to `fastify.log`, awaits its
   * `init()` during registration (e.g. Postgres migrations, the filesystem
   * store stamp), and wires its `close()` to Fastify's `onClose`. When
   * `false`, it does none of these, and the composition initializes, logs,
   * and closes the backend itself. `false` requires an injected `backend`,
   * since the composition can only run the lifecycle of a backend it holds a
   * handle to; passing it without one is refused at registration.
   */
  ownsBackend?: boolean
  /**
   * The `@fastify/cors` registration. `false` registers no CORS plugin, so a
   * composition can bring its own. An options object overrides `origin`
   * and/or `methods`. `undefined` keeps the default: `origin: '*'`, the
   * methods the WAS routes serve, the exposed headers browser clients need,
   * and a cached preflight. WAS authorization is signature-based rather than
   * cookie-based, so a wide-open origin is the protocol-appropriate default.
   */
  cors?: false | Pick<FastifyCorsOptions, 'origin' | 'methods'>
  /**
   * Filesystem root the default backend stores under (env `WAS_DATA_DIR`);
   * applied only to the default backend (an injected `backend` carries its
   * own root). `undefined` uses the project `data/` directory.
   */
  dataDir?: string
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
   * The at-rest WebKMS key-record encryption registry (config `KMS_RECORD_KEK` /
   * `KMS_RECORD_KEKS` / `KMS_RECORD_CURRENT_KEK`); `undefined` (or
   * `currentKekId: null`) disables encryption -- key records are written
   * plaintext (the teaching default).
   */
  kmsRecordKek?: KmsRecordKekRegistry
  /**
   * Custom provisioning gate for `POST /spaces/`, Create Space by Id
   * (`PUT /space/:spaceId/meta` on an absent Space), and `POST /kms/keystores`;
   * receives `{ request }` and returns `'verify'` (normal zcap path), `'grant'`
   * (authorized by the callback -- skip zcap verification), or `'deny'` (403).
   * `undefined` means allow (the teaching default). Mutually exclusive with
   * `onboardingToken`.
   */
  authorizeProvisioning?: AuthorizeProvisioning
  /**
   * Shared-secret gate for `POST /spaces/`, Create Space by Id, and
   * `POST /kms/keystores` (config `WAS_ONBOARDING_TOKEN`); when set, those
   * endpoints require an `Authorization: Bearer <token>` header, which then
   * substitutes for zcap verification on that request. `undefined` means
   * disabled (the teaching default); an empty string is refused at
   * registration. Mutually exclusive with `authorizeProvisioning`.
   */
  onboardingToken?: string
  /**
   * Whether the service description's `instance` member carries the server
   * version (config `WAS_DISCLOSE_VERSION`); `createApp()` applies the same
   * switch to `/health` and the welcome page. Defaults to `true`.
   */
  discloseVersion?: boolean
  /**
   * The 32-byte Ed25519 seed the server's export-signing key is derived from
   * (config `WAS_SERVER_KEY_SEED`). The key is advertised on `/service` as
   * `exportSigningKey`. `undefined` means no signing key: exports are
   * unsigned and neither identity member is served.
   */
  serverKeySeed?: Uint8Array
  /**
   * The `did:key` that controls the `server` Space hosting the server's own
   * `did:webvh` history log (config `WAS_ADMIN_DID`). When set, that Space is
   * provisioned at registration if absent, and a stored one must carry this
   * controller. `undefined` means the Space is not provisioned.
   */
  adminDid?: IDID
  /**
   * The store's origin id (env `WAS_ORIGIN_ID`), applied only to the default
   * backend (an injected `backend` carries its own). Used verbatim; `undefined`
   * reads the store's own id, or mints one on first boot.
   */
  originId?: string
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
    ownsBackend = true,
    cors: corsOptions,
    dataDir,
    storageLimitPerSpace,
    maxUploadBytes,
    maxSpacesPerController,
    maxCollectionsPerSpace,
    maxResourcesPerSpace,
    providers,
    enabledBackendProviders,
    kmsRecordKek,
    authorizeProvisioning,
    onboardingToken,
    discloseVersion = true,
    serverKeySeed,
    adminDid,
    originId
  } = options

  // Fail fast on a missing or malformed base URL: without one no ZCap
  // invocationTarget can be built or matched, and one carrying a path, query,
  // or fragment silently breaks every match and Location header (URL-joins
  // drop the base path).
  assertValidServerUrl(serverUrl)

  // An empty token would read as no gate at all, so it is refused rather than
  // silently leaving provisioning open.
  if (onboardingToken !== undefined && onboardingToken.trim() === '') {
    throw new Error('onboardingToken must not be empty.')
  }
  // The two provisioning gates are alternative ways to configure the same seam.
  if (authorizeProvisioning && onboardingToken) {
    throw new Error(
      'authorizeProvisioning and onboardingToken are mutually exclusive.'
    )
  }

  // A composition that runs the backend lifecycle itself needs the backend in
  // hand; over the default one it would skip the store stamp check and the
  // layout migrations `init()` runs, and serve an unchecked data dir.
  if (!ownsBackend && backend === undefined) {
    throw new Error('ownsBackend: false requires an injected backend option.')
  }

  fastify.decorate('serverUrl', serverUrl)
  fastify.decorate('discloseVersion', discloseVersion)
  const storage =
    backend ??
    defaultBackend({
      dataDir,
      capacityBytes: storageLimitPerSpace,
      maxUploadBytes,
      maxSpacesPerController,
      maxCollectionsPerSpace,
      maxResourcesPerSpace,
      originId
    })
  // Route the backend's diagnostics through the Fastify pino logger (the backend
  // defaults to a silent logger until wired here).
  if (ownsBackend) {
    storage.logger = fastify.log
  }
  fastify.decorate('storage', storage)

  // The buffered-body limit, derived from the active backend's per-upload cap
  // and applied as every route's `bodyLimit`. Set per route rather than on the
  // instance so a downstream composition that registers this plugin on its own
  // instance gets the same bound. A route that sets its own `bodyLimit` (the
  // exchanges POST) keeps it.
  const bodyLimit = bufferedBodyLimit(storage.maxUploadBytes)
  fastify.addHook('onRoute', routeOptions => {
    if (routeOptions.bodyLimit === undefined) {
      routeOptions.bodyLimit = bodyLimit
    }
  })

  // Backend lifecycle: run the optional startup hook (e.g. Postgres connect +
  // migrations) during registration, before the server starts listening, and
  // wire the optional shutdown hook (pool drain) to Fastify's close.
  if (ownsBackend) {
    if (storage.init) {
      await storage.init()
    }
    if (storage.close) {
      fastify.addHook('onClose', async () => {
        await storage.close!()
      })
    }
  }
  // Read once so a backend injected without its `init()` fails the boot
  // rather than the first request that needs the id.
  void storage.originId

  // The server's own identity. The `server` Space is provisioned (or checked)
  // once storage is up, and the export-signing key is derived from the seed.
  // Whether the key is listed by a resolvable server DID is read per
  // `/service` request rather than fixed here, since the admin writes that
  // log after boot; the boot-time read below only warns.
  if (adminDid !== undefined) {
    await provisionServerSpace({ storage, adminDid })
  }
  const serverSigningKey =
    serverKeySeed === undefined
      ? undefined
      : await createServerSigningKey({ seed: serverKeySeed })
  fastify.decorate('serverSigningKey', serverSigningKey)
  if (serverSigningKey !== undefined) {
    const did = await resolveServerDid({
      storage,
      serverUrl,
      signingKey: serverSigningKey,
      logger: fastify.log
    })
    if (did === undefined) {
      fastify.log.warn(
        { exportSigningKey: serverSigningKey.exportSigningKey },
        'No server DID lists the export-signing key yet; exports are ' +
          'unsigned until the admin writes the server history log.'
      )
    }
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
  // The provisioning gate for `POST /spaces/`, Create Space by Id, and
  // `POST /kms/keystores`: a custom callback, or the stock onboarding-token
  // check when a token is set, or `undefined` = allow (the teaching default).
  // Read by the `provisioningGate` onRequest hook installed by the route
  // groups carrying those endpoints.
  fastify.decorate(
    'authorizeProvisioning',
    authorizeProvisioning ??
      (onboardingToken ? onboardingTokenAuthorizer(onboardingToken) : undefined)
  )

  // Every response links to the service description (spec "Discovering the
  // Service Description"), so the hook sits on the root instance.
  addServiceLinkHook(fastify)

  // Open CORS by default (`cors: false` leaves it to the composition).
  // `exposedHeaders` is required for browser clients: without it,
  // cross-origin JS cannot read `Location` (space/resource creation), `ETag`
  // (metaVersion concurrency), `Link` (pagination, policy linksets), or
  // `Allow` -- which RFC 9110 makes the whole point of the `405` a `PUT` at a
  // container URL answers, since it names the methods the container does
  // accept. `maxAge` lets browsers cache the preflight answer instead of
  // re-asking before nearly every signed request. No WAS route serves
  // `PATCH`, so it is not offered.
  if (corsOptions !== false) {
    fastify.register(cors, {
      origin: corsOptions?.origin ?? '*',
      methods: corsOptions?.methods ?? [
        'GET',
        'HEAD',
        'POST',
        'PUT',
        'DELETE',
        'OPTIONS'
      ],
      exposedHeaders: ['Location', 'ETag', 'Link', 'Allow'],
      maxAge: CORS_PREFLIGHT_MAX_AGE
    })
  }

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
  // group inherits it; `isJsonContentType()` already treats `+json` as JSON
  // downstream (digest capture, resource-input resolution).
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

  fastify.register(initServiceDescriptionRoutes, { discloseVersion })
  fastify.register(initSpacesRepositoryRoutes)
  fastify.register(initSpaceRoutes)
  fastify.register(initCollectionRoutes)
  fastify.register(initResourceRoutes)
  fastify.register(initKmsRoutes)
  // The ephemeral exchanges facet: unauthenticated by design (no zcap hook
  // chain), so it stays a sibling of the route groups rather than one of them.
  fastify.register(initExchangeRoutes)
}

export const fastifyWas = fp(wasPlugin, {
  fastify: '5.x',
  name: 'fastify-was'
})
