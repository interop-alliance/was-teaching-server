import { FlexDocStore } from 'flex-docstore'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { v4 as uuidv4 } from 'uuid'

export class SpacesRepositoryRequest {
  static async post (request, reply) {
    const { body } = request
    const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')

    // Create a directory for the incoming space
    const spaceId = body.id || uuidv4()
    const spaceDir = path.join(spacesRepository, spaceId)
    try {
      await mkdir(spaceDir)
    } catch (err) {
      if (err.code === 'EEXIST') {
        console.log(`Space "${spaceId}" already exists, overwriting."`)
      } else {
        throw err
      }
    }
    const storage = FlexDocStore.using('files', { dir: spaceDir, extension: '.json' })

    const spaceDescription = {
      id: spaceId,
      type: ['Space'],
      ...body
    }
    await storage.put('.space', spaceDescription)

    console.log('CREATED:', spaceDescription)

    // TODO: Make Location an absolute url
    reply.header('Location', `/spaces/${spaceId}`)
    return reply.status(201).send(spaceDescription)
  }
}
