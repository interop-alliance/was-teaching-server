/**
 * Route layer: maps URL patterns to *Request handler methods. Each group first
 * installs the `requireAuthHeaders` then `parseAuthHeaders` onRequest hooks, and
 * redirects slash/no-slash variants to the canonical form.
 */
import { SpacesRepositoryRequest } from './requests/SpacesRepositoryRequest.js'
import { SpaceRequest } from './requests/SpaceRequest.js'
import { handleError } from './errors.js'
import { ResourceRequest } from './requests/ResourceRequest.js'
import { CollectionRequest } from './requests/CollectionRequest.js'
import { parseAuthHeaders, requireAuthHeaders } from './auth-header-hooks.js'

/**
 * Registers SpacesRepository routes (POST/GET /spaces). Installs the
 * `requireAuthHeaders` then `parseAuthHeaders` onRequest hooks and the
 * `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initSpacesRepositoryRoutes (app, options) {
  app.setErrorHandler(handleError)

  // All SpacesRepository routes require auth-related headers
  // Check headers are present (throw 401 otherwise)
  app.addHook('onRequest', requireAuthHeaders)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)

  // Add a Space to a SpacesRepository (Create Space)
  app.post('/spaces', async (request, reply) => reply.redirect('/spaces/'))
  app.post('/spaces/', SpacesRepositoryRequest.post)

  // List Spaces
  app.get('/spaces', async (request, reply) => reply.redirect('/spaces/'))

  // TODO - Implement the 'List Spaces' request (spec: #list-spaces)
  app.get('/spaces/', async (request, reply) => reply.status(501).send())
}

/**
 * Registers Space routes (get/update/delete a Space, add/list Collections,
 * export/import). Installs the auth hooks and the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initSpaceRoutes (app, options) {
  app.setErrorHandler(handleError)

  // All Space routes require auth-related headers
  // Check headers are present (throw 401 otherwise)
  app.addHook('onRequest', requireAuthHeaders)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)

  // Get Space description object
  app.get('/space/:spaceId', SpaceRequest.get)

  // Update or Create Space by Id (only "no trailing slash" is valid)
  app.put('/space/:spaceId/',
    async (request, reply) => reply.redirect('/space/:spaceId'))
  app.put('/space/:spaceId', SpaceRequest.put)

  // Delete Space
  app.delete('/space/:spaceId', SpaceRequest.delete)

  // List Collections for a space
  app.put('/space/:spaceId/collections',
    async (request, reply) => reply.redirect('/space/:spaceId/collections/'))
  app.get('/space/:spaceId/collections/', SpaceRequest.listCollections)

  // Add Collection to a Space
  app.post('/space/:spaceId',
    async (request, reply) => reply.redirect('/space/:spaceId/'))
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
export async function initCollectionRoutes (app, options) {
  app.setErrorHandler(handleError)

  // All Collection routes require auth-related headers
  // Check headers are present (throw 401 otherwise)
  app.addHook('onRequest', requireAuthHeaders)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)

  // Get Collection description
  app.get('/space/:spaceId/:collectionId', CollectionRequest.get)
  // List Collection items
  app.get('/space/:spaceId/:collectionId/', CollectionRequest.list)

  // Add Resource to a Collection
  app.post('/space/:spaceId/:collectionId',
    async (request, reply) => reply.redirect('/space/:spaceId/:collectionId/'))
  app.post('/space/:spaceId/:collectionId/', CollectionRequest.post)

  // Create a Collection by Id
  app.put('/space/:spaceId/:collectionId/', // no trailing slash allowed
    async (request, reply) => reply.redirect('/space/:spaceId/:collectionId'))
  app.put('/space/:spaceId/:collectionId', CollectionRequest.put)

  // Delete Collection by Id
  app.delete('/space/:spaceId/:collectionId/', // no trailing slash allowed
    async (request, reply) => reply.redirect('/space/:spaceId/:collectionId'))
  app.delete('/space/:spaceId/:collectionId', CollectionRequest.delete)
}

/**
 * Registers Resource routes (create-by-id, get, delete a Resource). Installs the
 * auth hooks and the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initResourceRoutes (app, options) {
  app.setErrorHandler(handleError)

  // All Resource routes require auth-related headers
  // Check headers are present (throw 401 otherwise)
  app.addHook('onRequest', requireAuthHeaders)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)

  // Create a Resource by Id
  app.put('/space/:spaceId/:collectionId/:resourceId/', // no trailing slash allowed
    async (request, reply) => reply.redirect('/space/:spaceId/:collectionId/:resourceId'))
  app.put('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.put)

  // Get Resource
  app.get('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.get)

  // Delete Resource
  app.delete('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.delete)
}
