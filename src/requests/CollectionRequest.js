import { v4 as uuidv4 } from 'uuid'

import { handleZcapVerify } from '../zcap.js'
import { getSpaceController } from './SpaceRequest.js'
import { CollectionNotFoundError } from '../errors.js'
import { getCollectionDescription, listCollectionItems, writeResource } from '../storage.js'

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
    const { params: { spaceId, collectionId }, url, method, headers } = request
    const { serverUrl } = this
    const requestName = 'Create Resource'

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceController = await getSpaceController({ spaceId, requestName })

    // Fetch collection by id
    const collectionDescription = await getCollectionDescription({ spaceId, collectionId })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}/`, serverUrl)).toString()
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'POST', method,
      headers, serverUrl, spaceController })

    // zCap checks out, continue
    let resourceId, response

    // TODO: use a uuid v5 or another hash based id here instead
    resourceId = uuidv4()

    try {
      await writeResource({ spaceId, collectionId, resourceId, request })
      response = {
        id: resourceId, 'content-type': request.headers['content-type']
      }
    } catch (e) {
      throw new Error('Could not create resource: ' + e.message, { cause: e })
    }

    const createdUrl = (new URL(`/space/${spaceId}/${collectionId}/${resourceId}`, serverUrl)).toString()
    reply.header('Location', createdUrl)
    response.url = createdUrl

    return reply.status(201).send(response)
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
    const collectionDescription = await getCollectionDescription({ spaceId, collectionId })
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
    const collectionDescription = await getCollectionDescription({ spaceId, collectionId })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}/`, serverUrl)).toString()
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'GET', method,
      headers, serverUrl, spaceController })

    const collectionItems = await listCollectionItems({ spaceId, collectionId })

    return reply.status(200).type('application/json')
      .send(JSON.stringify(collectionItems))
  }
}


