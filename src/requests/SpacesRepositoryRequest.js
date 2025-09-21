import { v4 as uuidv4 } from 'uuid'
import { handleZcapVerify } from '../zcap.js'
import { SpaceControllerMismatchError } from '../errors.js'
import { ensureSpaceStorage } from '../storage.js'

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
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'POST', method,
      headers, serverUrl, spaceController: body.controller, requestName: 'Create Space' })

    // zCap checks out, continue
    const spaceStorage = await ensureSpaceStorage({ spaceId })
    await spaceStorage.put('.space', spaceDescription)

    const createdSpaceUrl = (new URL(`/spaces/${spaceId}`, serverUrl)).toString()
    reply.header('Location', createdSpaceUrl)
    return reply.status(201).send(spaceDescription)
  }
}


