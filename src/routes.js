import { SPEC_URL } from '../config.default.js';
import {CreateSpaceRequest} from './requests/CreateSpaceRequest.js';

export async function initRoutes(app, options) {
  app.get('/', async (request, reply) => {
    return reply.view('home', { title: 'Welcome', SPEC_URL })
  })

  // List Spaces
  app.get('/spaces', async (request, reply) => reply.redirect('/spaces/'))
  app.get('/spaces/', async (request, reply) => {})
  // Create a Space
  app.post('/spaces', async (request, reply) => reply.redirect('/spaces/'))
  app.post('/spaces/', CreateSpaceRequest.post)

  // Get Space info
  app.get('/space/:spaceId', async (request, reply) => {})

  app.put('/space/:spaceId', async (request, reply) => {})
  app.delete('/space/:spaceId', async (request, reply) => {})

  app.get('/space/:spaceId/', async (request, reply) => {})
}
