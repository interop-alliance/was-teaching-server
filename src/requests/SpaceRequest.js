import path from 'node:path'
import { FlexDocStore } from 'flex-docstore'

export class SpaceRequest {
  static async get (request, reply) {
    const { params: { spaceId } } = request
    const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')
    const spaceDir = path.join(spacesRepository, spaceId)
    const storage = FlexDocStore.using('files', { dir: spaceDir, extension: '.json' })

    const spaceDescription = await storage.get('.space')

    return reply.status(200).send(spaceDescription)
  }
}
