import path from 'node:path'
import { FlexDocStore } from 'flex-docstore'
import { handleZcapVerify } from '../routes.js'
import { getSpace } from './SpaceRequest.js'
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
    const spaceDescription = await getSpace({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Create Resource' })
    }
    const spaceController = spaceDescription.controller

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
}

export function getCollectionStorage ({ spaceId, collectionId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)
  return FlexDocStore.using('files', { dir: collectionDir, collection: collectionId, extension: '.json' })
}

export async function resourceStorage ({ spaceId, collectionId }) {

}
