import { handleZcapVerify } from '../zcap.js'
import { getSpaceController } from './SpaceRequest.js'
import { CollectionNotFoundError } from '../errors.js'
import { v4 as uuidv4 } from 'uuid'
import { getCollectionStorage } from '../storage.js'

export class CollectionRequest {
  /**
   * POST /space/:spaceId/:collectionId/
   * Request handler for "Create Resource" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async post (request, reply) {
    const { params: { spaceId, collectionId }, url, method, headers, body } = request
    const { serverUrl } = this
    const requestName = 'Create Resource'

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceController = await getSpaceController({ spaceId, requestName })

    // Fetch collection by id
    const collectionStorage = getCollectionStorage({ spaceId, collectionId })
    const collectionDescription = await collectionStorage.get('.collection')
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}/`, serverUrl)).toString()
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'POST', method,
      headers, serverUrl, spaceController })

    // zCap checks out, continue
    // TODO: use a uuid v5 or another hash based id here instead
    // TODO: Protect against .collection resource id collision
    const resourceId = body.id || uuidv4()
    const resource = { id: resourceId, ...body }
    await collectionStorage.put(resourceId, resource)

    const createdUrl = (new URL(`/space/${spaceId}/${collectionId}/${resourceId}`, serverUrl)).toString()
    reply.header('Location', createdUrl)
    // TODO probably shouldn't return the full resource, waste of bandwidth
    return reply.status(201).send(resource)
  }

  /**
   * GET /space/:spaceId/:collectionId (no trailing slash): Get Collection details
   */
  static async get (request, reply) {
    const { params: { spaceId, collectionId }, url, method, headers } = request
    const { serverUrl } = this
    const requestName = 'Get Collection'

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceController = await getSpaceController({ spaceId, requestName })

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}`, serverUrl)).toString()
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'GET', method,
      headers, serverUrl, spaceController })

    // Fetch collection by id
    const collectionStorage = getCollectionStorage({ spaceId, collectionId })
    const collectionDescription = await collectionStorage.get('.collection')
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    return reply.status(200).type('application/json')
      .send(JSON.stringify(collectionDescription))
  }

  /**
   * GET /space/:spaceId/:collectionId/ (with trailing slash):
   * List Collection items
   */
  static async list (request, reply) {
    const { params: { spaceId, collectionId }, url, method, headers } = request
    const { serverUrl } = this
    const requestName = 'List Collection'

    const spaceController = await getSpaceController({ spaceId, requestName })

    // Fetch collection by id
    const collectionStorage = getCollectionStorage({ spaceId, collectionId })
    const collectionDescription = await collectionStorage.get('.collection')
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}/`, serverUrl)).toString()
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'GET', method,
      headers, serverUrl, spaceController })

    const collectionItems = await collectionStorage.allDocs()

    return reply.status(200).type('application/json')
      .send(JSON.stringify(collectionItems))
  }
}


