import { v4 as uuidv4 } from 'uuid'
import { handleZcapVerify } from '../zcap.js'
import { InvalidSpaceIdError, SpaceNotFoundError } from '../errors.js'
import { writeCollection, deleteSpace, getSpaceDescription, writeSpace }
  from '../storage.js'

export class SpaceRequest {
  /**
   * GET /space/:spaceId
   * Request handler for "Read Space" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * Example Space Description Object:
   * {
   *   "id": "6b5be748-5f39-4936-a895-409e393c399c",
   *   "type": ["Space"],
   *   "name": "Alice's space",
   *   "controller": "did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW"
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
   * PUT /space/:spaceId
   * Request handler for "Update or Create Space by Id" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async put (request, reply) {
    const {
      params: { spaceId }, url, method, headers, body, zcap: { keyId }
    } = request
    const { serverUrl } = this

    // Check to see if space already exists (if yes, this will be an Update)
    const existingSpaceDescription = await getSpaceDescription({ spaceId })
    const existingController = existingSpaceDescription?.controller

    const [ zcapSigningDid ] = keyId.split('#')

    request.log.info(`Handling PUT request for spaceId: ${spaceId}, zcapSigningDid: ${zcapSigningDid}, existingSpaceDescription: ${existingSpaceDescription ? 'exists' : 'does not exist'}`)

    // Important. For exising space objects, make sure the request carries
    // authorization matching the old controller
    const authorizedController = existingController ?? zcapSigningDid

    // Perform zCap signature verification (throws appropriate errors)
    let spaceUrl
    try {
      spaceUrl = (new URL(`/space/${spaceId}`, serverUrl)).toString()
    } catch (e) {
      request.log.error(`Failed to construct spaceUrl for spaceId: ${spaceId}, serverUrl: ${serverUrl}, error: ${e.message}`)
      throw new InvalidSpaceIdError({ requestName: 'Update Space'})
    }

    request.log.info(`spaceUrl: ${spaceUrl}, serverUrl: ${serverUrl}`)
    await handleZcapVerify({ url, allowedTarget: spaceUrl, allowedAction: 'PUT', method,
      headers, serverUrl, spaceController: authorizedController, logger: request.log })

    request.log.info('zCap verified')

    // Compose Space Description object body, new or updated
    const spaceDescription = existingSpaceDescription
      // Existing: Update only the allowed fields
      ? { ...existingSpaceDescription, id: spaceId, name: body.name, controller: body.controller}
      // New Space
      : { id: spaceId, type: ['Space'], name: body.name, controller: body.controller }

    // zCap checks out, continue
    await writeSpace({ spaceId, spaceDescription })

    reply.header('Location', spaceUrl)
    return existingSpaceDescription
      ? reply.status(204).send() // update
      : reply.status(201).send(spaceDescription) // create
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

    await writeCollection({ spaceId, collectionId, collectionDescription })

    const createdUrl = (new URL(`/space/${spaceId}/${collectionId}`, serverUrl)).toString()
    reply.header('Location', createdUrl)
    return reply.status(201).send(collectionDescription)
  }

  /**
   * DELETE /space/:spaceId
   * Request handler for "Delete Space" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async delete (request, reply) {
    const { params: { spaceId }, url, method, headers } = request
    const { serverUrl } = this

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Delete Space' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}`, serverUrl)).toString()
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'DELETE', method,
      headers, serverUrl, spaceController })

    // zCap checks out, continue
    await deleteSpace({ spaceId })

    return reply.status(204).send()
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
