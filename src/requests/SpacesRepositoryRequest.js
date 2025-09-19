import { FlexDocStore } from 'flex-docstore'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { v4 as uuidv4 } from 'uuid'
import { handleZcapVerify } from '../routes.js'
import { SpaceControllerMismatchError } from '../errors.js'

export class SpacesRepositoryRequest {
  /**
   * POST /spaces/
   * Request handler for "Create Space" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async post (request, reply) {
    const { body, url, method, headers, zcap: { keyId } } = request
    const { serverUrl } = this

    // Check to make sure the DID that signed the zcap matches controller
    const [ zcapSigningDid ] = keyId.split('#')
    if (zcapSigningDid !== body.controller) {
      throw new SpaceControllerMismatchError({
        zcapSigningDid, controller: body.controller
      })
    }

    // TODO: use a uuid v5 or another hash based id here instead
    const spaceId = body.id || uuidv4()
    const spaceDescription = { id: spaceId, type: ['Space'], ...body }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/spaces/`, serverUrl)).toString()
    const allowedAction = 'POST'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController: body.controller, requestName: 'Create Space',
      specErrorSection: 'create-space-errors', reply })

    // zCap checks out, continue
    const spaceStorage = await ensureSpaceStorage({ spaceId })
    await spaceStorage.put('.space', spaceDescription)

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
