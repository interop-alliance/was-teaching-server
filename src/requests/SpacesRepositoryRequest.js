import { FlexDocStore } from 'flex-docstore'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { v4 as uuidv4 } from 'uuid'
import { SPEC_URL } from '../../config.default.js'

export class SpacesRepositoryRequest {
  static async post (request, reply) {
    const { body, url, method, headers, zcap: { keyId } } = request
    const { serverUrl } = this

    // Check to make sure the DID that signed the zcap matches controller
    const [ zcapSigningDid ] = keyId.split('#')
    if (zcapSigningDid !== body.controller)
      return reply.status(400).type('application/problem+json')
        .send({
          type: `${SPEC_URL}#create-space-errors`,
          title: 'Invalid Create Space request.',
          errors: [{
            detail: 'Authorization capability signing DID' +
              ` ("${zcapSigningDid}") does not match the controller in the body ("${body.controller}").`
          }]
        })

    // TODO: use a uuid v5 or another hash based id here instead
    const spaceId = body.id || uuidv4()
    const spaceDescription = { id: spaceId, type: ['Space'], ...body }

    const storage = await ensureSpaceStorage({ spaceId })
    await storage.put('.space', spaceDescription)

    console.log('CREATED:', spaceDescription)

    const createdSpaceUrl = (new URL(`/spaces/${spaceId}`, serverUrl)).toString()
    reply.header('Location', createdSpaceUrl)
    return reply.status(201).send(spaceDescription)
  }
}

export async function ensureSpaceStorage ({ spaceId }) {
  // Create a directory for the incoming space
  const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')
  const spaceDir = path.join(spacesRepository, spaceId)
  try {
    await mkdir(spaceDir)
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.log(`Space "${spaceId}" already exists, overwriting."`)
    } else {
      throw err // http 500
    }
  }
  return FlexDocStore.using('files', { dir: spaceDir, extension: '.json' })
}
