import path from 'node:path'
import { FlexDocStore } from 'flex-docstore'
import { handleZcapVerify } from '../routes.js'
import { getSpaceController } from './SpaceRequest.js'
import { CollectionNotFoundError, SpaceNotFoundError } from '../errors.js'
import { v4 as uuidv4 } from 'uuid'

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

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceController = await getSpaceController({ spaceId, requestName: 'Create Resource' })

    // Fetch collection by id
    const collectionStorage = getCollectionStorage({ spaceId, collectionId })
    const collectionDescription = await collectionStorage.get('.collection')
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName: 'Create Resource' })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}/`, serverUrl)).toString()
    const allowedAction = 'POST'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController })

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

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceController = await getSpaceController({ spaceId, requestName: 'Get Collection' })

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}`, serverUrl)).toString()
    const allowedAction = 'GET'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController })

    // Fetch collection by id
    const collectionStorage = getCollectionStorage({ spaceId, collectionId })
    const collectionDescription = await collectionStorage.get('.collection')
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName: 'Get Collection' })
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

    const spaceController = await getSpaceController({ spaceId, requestName: 'List Collection' })

    // Fetch collection by id
    const collectionStorage = getCollectionStorage({ spaceId, collectionId })
    const collectionDescription = await collectionStorage.get('.collection')
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName: 'Create Resource' })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}/`, serverUrl)).toString()
    const allowedAction = 'GET'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController })

    const collectionItems = await collectionStorage.allDocs()

    return reply.status(200).type('application/json')
      .send(JSON.stringify(collectionItems))
  }
}

export function getCollectionStorage ({ spaceId, collectionId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)
  return FlexDocStore.using('files', { dir: collectionDir, collection: collectionId, extension: '.json' })
}
