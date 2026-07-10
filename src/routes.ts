/**
 * Route layer: maps URL patterns to *Request handler methods. Each group first
 * installs the `requireAuthHeadersOrPublicRead` then `parseAuthHeaders`
 * onRequest hooks, and redirects slash/no-slash variants to the canonical form.
 * (The WebKMS `/kms` group is the exception on both counts: it installs the
 * strict `requireAuthHeaders` -- the webkms protocol has no public reads --
 * and no slash redirects, since the protocol's URLs are exact.)
 */
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest
} from 'fastify'
import { SpacesRepositoryRequest } from './requests/SpacesRepositoryRequest.js'
import { SpaceRequest } from './requests/SpaceRequest.js'
import { handleError } from './errors.js'
import { ResourceRequest } from './requests/ResourceRequest.js'
import { CollectionRequest } from './requests/CollectionRequest.js'
import { PolicyRequest } from './requests/PolicyRequest.js'
import { BackendRequest } from './requests/BackendRequest.js'
import { KeystoreRequest } from './requests/KeystoreRequest.js'
import { KeyRequest } from './requests/KeyRequest.js'
import { RevocationRequest } from './requests/RevocationRequest.js'
import {
  parseAuthHeaders,
  requireAuthHeaders,
  requireAuthHeadersOrPublicRead
} from './auth-header-hooks.js'
import { captureRawBody, verifyBodyDigest } from './digest.js'
import { provisioningGate } from './provisioning.js'

/**
 * Toggles the trailing slash on the request's actual path (preserving any query
 * string), returning the canonical target for a slash/no-slash redirect. Built
 * from `request.url` rather than the route template so the `Location` carries
 * the concrete ids (`/space/abc123`), not the literal `/space/:spaceId` -- which
 * a client cannot follow.
 * @param url {string}   the request URL (path plus optional query string)
 * @param addSlash {boolean}   append (true) or strip (false) the trailing slash
 * @returns {string}
 */
function toggleTrailingSlash(url: string, addSlash: boolean): string {
  const queryIndex = url.indexOf('?')
  const pathPart = queryIndex === -1 ? url : url.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : url.slice(queryIndex)
  const canonical = addSlash
    ? pathPart.endsWith('/')
      ? pathPart
      : `${pathPart}/`
    : pathPart.endsWith('/')
      ? pathPart.slice(0, -1)
      : pathPart
  return `${canonical}${query}`
}

/**
 * Redirects to the trailing-slash canonical form of the request URL with a
 * `308` (Permanent Redirect), which -- unlike the default `302` -- requires the
 * client to replay the same method and body, so a redirected POST/PUT is not
 * silently downgraded to GET.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {FastifyReply}
 */
function redirectAddSlash(
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  return reply.redirect(toggleTrailingSlash(request.url, true), 308)
}

/**
 * Redirects to the no-trailing-slash canonical form of the request URL (see
 * {@link redirectAddSlash} for the `308` rationale).
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {FastifyReply}
 */
function redirectStripSlash(
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  return reply.redirect(toggleTrailingSlash(request.url, false), 308)
}

/**
 * Registers SpacesRepository routes (POST/GET /spaces). Installs the
 * `requireAuthHeadersOrPublicRead` then `parseAuthHeaders` onRequest hooks and
 * the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initSpacesRepositoryRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  app.setErrorHandler(handleError)

  // Gate provisioning (Create Space): the configured policy may grant/deny, or
  // (the default) allow -- in which case the normal zcap path below runs.
  app.addHook('onRequest', provisioningGate)
  // Create Space (POST) requires auth-related headers (401 otherwise); a List
  // Spaces read may proceed unauthenticated -- an anonymous list is the spec's
  // empty-items 200, never an error (the exception to 404 masking).
  app.addHook('onRequest', requireAuthHeadersOrPublicRead)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)
  // Capture raw body bytes (JSON/text) so the digest can be recomputed against
  // exactly what the client signed (spec "Request Body Integrity").
  app.addHook('preParsing', captureRawBody)
  // Enforce the Digest header binding: require it covered by the signature and,
  // when the raw body is available, recompute and compare it.
  app.addHook('preValidation', verifyBodyDigest)

  // Add a Space to a SpacesRepository (Create Space)
  app.post('/spaces', redirectAddSlash)
  app.post('/spaces/', SpacesRepositoryRequest.post)

  // List Spaces
  app.get('/spaces', redirectAddSlash)
  app.get('/spaces/', SpacesRepositoryRequest.get)
}

/**
 * Registers Space routes (get/update/delete a Space, add/list Collections,
 * export/import). Installs the auth hooks and the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initSpaceRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  app.setErrorHandler(handleError)

  // Writes require auth; reads (GET/HEAD) may proceed unauthenticated so the
  // handler can fall back to an access-control policy (e.g. a public Space).
  app.addHook('onRequest', requireAuthHeadersOrPublicRead)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)
  // Capture raw body bytes (JSON/text) so the digest can be recomputed against
  // exactly what the client signed (spec "Request Body Integrity").
  app.addHook('preParsing', captureRawBody)
  // Enforce the Digest header binding: require it covered by the signature and,
  // when the raw body is available, recompute and compare it.
  app.addHook('preValidation', verifyBodyDigest)

  // Get Space description object
  app.get('/space/:spaceId', SpaceRequest.get)

  // Update or Create Space by Id (only "no trailing slash" is valid)
  app.put('/space/:spaceId/', redirectStripSlash)
  app.put('/space/:spaceId', SpaceRequest.put)

  // Delete Space
  app.delete('/space/:spaceId', SpaceRequest.delete)

  // List Collections for a space (the canonical form has a trailing slash;
  // registered as GET so `GET /space/:spaceId/collections` redirects there
  // rather than falling through to the Collection GET route).
  app.get('/space/:spaceId/collections', redirectAddSlash)
  app.get('/space/:spaceId/collections/', SpaceRequest.listCollections)

  // Space access-control policy (reserved segment; Fastify routes static
  // segments ahead of the `:collectionId` parameter, so this never collides).
  app.get('/space/:spaceId/policy', PolicyRequest.get)
  app.put('/space/:spaceId/policy', PolicyRequest.put)
  app.delete('/space/:spaceId/policy', PolicyRequest.delete)

  // Space linkset (RFC9264 policy discovery)
  app.get('/space/:spaceId/linkset', SpaceRequest.linkset)

  // Space Backends Available (reserved segment; static-beats-parametric routing
  // keeps this ahead of the `:collectionId` parameter in the Collection routes).
  app.get('/space/:spaceId/backends', SpaceRequest.listBackends)

  // Register / replace / deregister an `external` backend record. Static
  // `backends` beats the parametric `:collectionId` / `:resourceId` of the
  // Collection/Resource route groups, so these resolve correctly (the same
  // mechanism that keeps the GET above and the singular `/backend` working).
  app.post('/space/:spaceId/backends', BackendRequest.post)
  app.put('/space/:spaceId/backends/:backendId', BackendRequest.put)
  app.delete('/space/:spaceId/backends/:backendId', BackendRequest.delete)

  // Space Quota report (reserved segment; static-beats-parametric routing keeps
  // this ahead of the `:collectionId` parameter). The per-Collection breakdown
  // (spec's `?include=collections`) is opt-in via that query string -- see the
  // handler note on the ZCap query-string limitation.
  app.get('/space/:spaceId/quotas', SpaceRequest.quotas)

  // Revoke a zcap delegated from this Space (`:revocationId` = the URL-encoded
  // id of the capability being revoked, which is also the request body). Four
  // segments deep, so it shadows no Collection or Resource route.
  app.post(
    '/space/:spaceId/zcaps/revocations/:revocationId',
    RevocationRequest.postSpace
  )

  // Add Collection to a Space
  app.post('/space/:spaceId', redirectAddSlash)
  app.post('/space/:spaceId/', SpaceRequest.post)

  // POST /space/12345/export
  app.post('/space/:spaceId/export', SpaceRequest.export)

  // POST /space/12345/import
  app.addContentTypeParser('application/x-tar', (_req, body, done) => {
    done(null, body)
  })
  app.post('/space/:spaceId/import', SpaceRequest.import)
}

/**
 * Registers Collection routes (get/update/delete a Collection, list its items,
 * add a Resource). Installs the auth hooks and the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initCollectionRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  app.setErrorHandler(handleError)

  // Writes require auth; reads (GET/HEAD) may proceed unauthenticated so the
  // handler can fall back to an access-control policy (e.g. a public Collection).
  app.addHook('onRequest', requireAuthHeadersOrPublicRead)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)
  // Capture raw body bytes (JSON/text) so the digest can be recomputed against
  // exactly what the client signed (spec "Request Body Integrity").
  app.addHook('preParsing', captureRawBody)
  // Enforce the Digest header binding: require it covered by the signature and,
  // when the raw body is available, recompute and compare it.
  app.addHook('preValidation', verifyBodyDigest)

  // Get Collection description
  app.get('/space/:spaceId/:collectionId', CollectionRequest.get)
  // List Collection items
  app.get('/space/:spaceId/:collectionId/', CollectionRequest.list)

  // Collection access-control policy (reserved segment; static-beats-parametric
  // routing keeps this ahead of the `:resourceId` parameter).
  app.get('/space/:spaceId/:collectionId/policy', PolicyRequest.get)
  app.put('/space/:spaceId/:collectionId/policy', PolicyRequest.put)
  app.delete('/space/:spaceId/:collectionId/policy', PolicyRequest.delete)

  // Collection linkset (RFC9264 policy discovery)
  app.get('/space/:spaceId/:collectionId/linkset', CollectionRequest.linkset)

  // Collection Backend Selected (reserved segment; static-beats-parametric
  // routing keeps this ahead of the `:resourceId` parameter in Resource routes).
  app.get('/space/:spaceId/:collectionId/backend', CollectionRequest.getBackend)

  // Per-Collection Quota report (reserved segment; static-beats-parametric
  // routing keeps this ahead of the `:resourceId` parameter in Resource routes).
  app.get('/space/:spaceId/:collectionId/quota', CollectionRequest.getQuota)

  // Collection query (reserved segment; spec "Collection-level reserved
  // endpoints"). The WAS server serves the replication change feed as the
  // `changes` profile; params ride the signed
  // POST body. Static-beats-parametric routing keeps this ahead of the
  // `:resourceId` parameter in Resource routes.
  app.post('/space/:spaceId/:collectionId/query', CollectionRequest.query)

  // Add Resource to a Collection
  app.post('/space/:spaceId/:collectionId', redirectAddSlash)
  app.post('/space/:spaceId/:collectionId/', CollectionRequest.post)

  // Create a Collection by Id
  app.put(
    '/space/:spaceId/:collectionId/', // no trailing slash allowed
    redirectStripSlash
  )
  app.put('/space/:spaceId/:collectionId', CollectionRequest.put)

  // Delete Collection by Id
  app.delete(
    '/space/:spaceId/:collectionId/', // no trailing slash allowed
    redirectStripSlash
  )
  app.delete('/space/:spaceId/:collectionId', CollectionRequest.delete)
}

/**
 * Registers Resource routes (create-by-id, get, delete a Resource). Installs the
 * auth hooks and the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initResourceRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  app.setErrorHandler(handleError)

  // Writes require auth; reads (GET/HEAD) may proceed unauthenticated so the
  // handler can fall back to an access-control policy (e.g. a public Resource).
  app.addHook('onRequest', requireAuthHeadersOrPublicRead)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)
  // Capture raw body bytes (JSON/text) so the digest can be recomputed against
  // exactly what the client signed (spec "Request Body Integrity").
  app.addHook('preParsing', captureRawBody)
  // Enforce the Digest header binding: require it covered by the signature and,
  // when the raw body is available, recompute and compare it.
  app.addHook('preValidation', verifyBodyDigest)

  // Create a Resource by Id
  app.put(
    '/space/:spaceId/:collectionId/:resourceId/', // no trailing slash allowed
    redirectStripSlash
  )
  app.put('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.put)

  // Head Resource. Declared before the GET route so it overrides Fastify's
  // auto-exposed HEAD (which would share the GET handler and stream the body
  // without a Content-Length); this handler reads only the Metadata and sets
  // Content-Type/Content-Length from it (spec "Content Types and Representations").
  app.head('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.head)

  // Get Resource
  app.get('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.get)

  // Delete Resource
  app.delete(
    '/space/:spaceId/:collectionId/:resourceId',
    ResourceRequest.delete
  )

  // Resource access-control policy (reserved segment)
  app.get('/space/:spaceId/:collectionId/:resourceId/policy', PolicyRequest.get)
  app.put('/space/:spaceId/:collectionId/:resourceId/policy', PolicyRequest.put)
  app.delete(
    '/space/:spaceId/:collectionId/:resourceId/policy',
    PolicyRequest.delete
  )

  // Resource metadata (reserved segment; spec "Resource Metadata Data Model")
  app.get(
    '/space/:spaceId/:collectionId/:resourceId/meta',
    ResourceRequest.getMeta
  )
  // Update Resource Metadata (full replacement of the user-writable `custom`).
  app.put(
    '/space/:spaceId/:collectionId/:resourceId/meta',
    ResourceRequest.putMeta
  )
}

/**
 * Registers the WebKMS keystore and key routes (the `/kms` facet).
 * Installs the same hook chain as the WAS groups
 * except that the auth requirement is the strict `requireAuthHeaders`: every
 * webkms route, GETs included, is zcap-invoked -- the protocol has no public
 * reads. No slash-redirect variants either; the protocol's URLs are exact --
 * only these shapes are registered.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initKmsRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  app.setErrorHandler(handleError)

  // Gate provisioning (Create Keystore): the configured policy may grant/deny,
  // or (the default) allow -- in which case the normal zcap path below runs.
  app.addHook('onRequest', provisioningGate)
  // Every operation is privileged: 401 when auth headers are absent.
  app.addHook('onRequest', requireAuthHeaders)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)
  // Capture raw body bytes (JSON/text) so the digest can be recomputed against
  // exactly what the client signed (spec "Request Body Integrity").
  app.addHook('preParsing', captureRawBody)
  // Enforce the Digest header binding: require it covered by the signature and,
  // when the raw body is available, recompute and compare it.
  app.addHook('preValidation', verifyBodyDigest)

  // Create Keystore
  app.post('/kms/keystores', KeystoreRequest.post)

  // List Keystores by controller (`?controller=<did>`)
  app.get('/kms/keystores', KeystoreRequest.list)

  // Get Keystore config
  app.get('/kms/keystores/:keystoreId', KeystoreRequest.get)

  // Update Keystore config
  app.post('/kms/keystores/:keystoreId', KeystoreRequest.update)

  // Generate Key (GenerateKeyOperation)
  app.post('/kms/keystores/:keystoreId/keys', KeyRequest.generate)

  // List Keys (fork extension: enumerate the keystore's public key
  // descriptions). Static `/keys` beats the parametric `/keys/:keyId` below,
  // so this never collides with the key-description GET.
  app.get('/kms/keystores/:keystoreId/keys', KeyRequest.list)

  // Key operation dispatch by envelope type (Sign / Verify / DeriveSecret /
  // WrapKey / UnwrapKey)
  app.post('/kms/keystores/:keystoreId/keys/:keyId', KeyRequest.operation)

  // Public key description
  app.get('/kms/keystores/:keystoreId/keys/:keyId', KeyRequest.get)

  // Revoke a delegated zcap (`:revocationId` = the URL-encoded id of the
  // capability being revoked, which is also the request body)
  app.post(
    '/kms/keystores/:keystoreId/zcaps/revocations/:revocationId',
    RevocationRequest.post
  )
}
