import { v4 as uuidv4 } from 'uuid'
import { handleZcapVerify } from '../zcap.js'
import { SpaceNotFoundError } from '../errors.js'
import { createCollection, getSpaceDescription } from '../storage.js'

export class SpaceRequest {
  /**
   * GET /space/:spaceId
   * Request handler for "Read Space" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async get (request, reply) {
    const { params: { spaceId }, url, method, headers } = request
    const { serverUrl } = this

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Get Space' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}`, serverUrl)).toString()
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'GET', method,
      headers, serverUrl, spaceController, requestName: 'Get Space' })

    // zCap checks out, continue
    return reply.status(200).send(spaceDescription)
  }

  /**
   * POST /space/:spaceId/
   * Request handler for "Create Collection" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async post (request, reply) {
    const { params: { spaceId }, url, method, headers, body } = request
    const { serverUrl } = this

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Create Collection' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/`, serverUrl)).toString()
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'POST', method,
      headers, serverUrl, spaceController })

    // zCap checks out, continue
    // TODO: use a uuid v5 or another hash based id here instead
    // TODO: Protect against .space resource id collision
    const collectionId = body.id || uuidv4()
    const { name } = body
    const collectionDescription = { id: collectionId, type: ['Collection'], name }

    await createCollection({ spaceId, collectionId, collectionDescription })

    const createdUrl = (new URL(`/space/${spaceId}/${collectionId}`, serverUrl)).toString()
    reply.header('Location', createdUrl)
    return reply.status(201).send(collectionDescription)
  }
}

/**
 * Load space description object from storage to get space controller.
 * TODO: Cache this
 * @param spaceId {string}
 * @param requestName {string}
 *
 * @returns {Promise<string>} Controller DID for a given space.
 */
export async function getSpaceController ({ spaceId, requestName }) {
  const spaceDescription = await getSpaceDescription({ spaceId })
  if (!spaceDescription) {
    throw new SpaceNotFoundError({ requestName })
  }
  return spaceDescription.controller
}
