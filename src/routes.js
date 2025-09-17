import { SpacesRepositoryRequest } from './requests/SpacesRepositoryRequest.js'
import { SpaceRequest } from './requests/SpaceRequest.js'
import { SPEC_URL } from '../config.default.js'

export async function initSpaceRoutes (app, options) {
  // All SpacesRepository and Space related routes require auth-related headers
  app.addHook('onRequest', async (request, reply) => {
    const { headers } = request
    if (!(headers['authorization'] && headers['capability-invocation'])) {
      return reply
        .status(401)
        .type('application/problem+json')
        .send({
          type: `${SPEC_URL}#authorization`,
          title: 'Invalid request.',
          errors: [{
            detail: 'Authorization and Capability-Invocation headers are required.',
          }]
        })
    }
  })

  // List Spaces
  app.get('/spaces', async (request, reply) => reply.redirect('/spaces/'))
  // app.get('/spaces/', SpacesRepositoryRequest.get)
  app.get('/spaces/', async (request, reply) => {})

  // Create a Space
  app.post('/spaces', async (request, reply) => reply.redirect('/spaces/'))
  app.post('/spaces/', SpacesRepositoryRequest.post)

  // Get Space info
  app.get('/space/:spaceId', SpaceRequest.get)

  app.put('/space/:spaceId', async (request, reply) => {})
  app.delete('/space/:spaceId', async (request, reply) => {})

  app.get('/space/:spaceId/', async (request, reply) => {})
}
