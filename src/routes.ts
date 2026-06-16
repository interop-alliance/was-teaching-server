/**
 * Route layer: maps URL patterns to *Request handler methods. Each group first
 * installs the `requireAuthHeadersOrPublicRead` then `parseAuthHeaders`
 * onRequest hooks, and redirects slash/no-slash variants to the canonical form.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { SpacesRepositoryRequest } from './requests/SpacesRepositoryRequest.js'
import { SpaceRequest } from './requests/SpaceRequest.js'
import { handleError } from './errors.js'
import { ResourceRequest } from './requests/ResourceRequest.js'
import { CollectionRequest } from './requests/CollectionRequest.js'
import { PolicyRequest } from './requests/PolicyRequest.js'
import {
  parseAuthHeaders,
  requireAuthHeadersOrPublicRead
} from './auth-header-hooks.js'
import { captureRawBody, verifyBodyDigest } from './digest.js'

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
  app.post('/spaces', async (request, reply) => reply.redirect('/spaces/'))
  app.post('/spaces/', SpacesRepositoryRequest.post)

  // List Spaces
  app.get('/spaces', async (request, reply) => reply.redirect('/spaces/'))
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
  app.put('/space/:spaceId/', async (request, reply) =>
    reply.redirect('/space/:spaceId')
  )
  app.put('/space/:spaceId', SpaceRequest.put)

  // Delete Space
  app.delete('/space/:spaceId', SpaceRequest.delete)

  // List Collections for a space
  app.put('/space/:spaceId/collections', async (request, reply) =>
    reply.redirect('/space/:spaceId/collections/')
  )
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

  // Space Quota report (reserved segment; static-beats-parametric routing keeps
  // this ahead of the `:collectionId` parameter). The per-Collection breakdown
  // (spec's `?include=collections`) is always included for now -- see the
  // handler note on the ZCap query-string limitation.
  app.get('/space/:spaceId/quotas', SpaceRequest.quotas)

  // Add Collection to a Space
  app.post('/space/:spaceId', async (request, reply) =>
    reply.redirect('/space/:spaceId/')
  )
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
  app.post('/space/:spaceId/:collectionId', async (request, reply) =>
    reply.redirect('/space/:spaceId/:collectionId/')
  )
  app.post('/space/:spaceId/:collectionId/', CollectionRequest.post)

  // Create a Collection by Id
  app.put(
    '/space/:spaceId/:collectionId/', // no trailing slash allowed
    async (request, reply) => reply.redirect('/space/:spaceId/:collectionId')
  )
  app.put('/space/:spaceId/:collectionId', CollectionRequest.put)

  // Delete Collection by Id
  app.delete(
    '/space/:spaceId/:collectionId/', // no trailing slash allowed
    async (request, reply) => reply.redirect('/space/:spaceId/:collectionId')
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
    async (request, reply) =>
      reply.redirect('/space/:spaceId/:collectionId/:resourceId')
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
