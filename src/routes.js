import { SpacesRepositoryRequest } from './requests/SpacesRepositoryRequest.js'
import { SpaceRequest } from './requests/SpaceRequest.js'
import { handleError } from './errors.js'
import { ResourceRequest } from './requests/ResourceRequest.js'
import { CollectionRequest } from './requests/CollectionRequest.js'
import { parseAuthHeaders, requireAuthHeaders } from './auth-header-hooks.js'

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
  // TODO
  app.get('/spaces/', async (request, reply) => {})
}

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
  // TODO
  app.get('/space/:spaceId/', async (request, reply) => {})

  // Add Collection to a Space
  app.post('/space/:spaceId',
    async (request, reply) => reply.redirect('/space/:spaceId/'))
  app.post('/space/:spaceId/', SpaceRequest.post)
}

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
