import path from 'node:path'
import { FlexDocStore } from 'flex-docstore'
import { handleZcapVerify } from '../routes.js'
import { getSpace } from './SpaceRequest.js'
import { CollectionNotFoundError, SpaceNotFoundError } from '../errors.js'

export class ResourceRequest {
  /**
   * GET /space/:spaceId/:collectionId/:resourceId
   * Request handler for "Get Resource" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async get (request, reply) {
    const { params: { spaceId, collectionId, resourceId },
      url, method, headers, body } = request
    const { serverUrl } = this

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpace({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Get Resource' })
    }
    const spaceController = spaceDescription.controller

    // Fetch collection by id
    const collectionStorage = getCollectionStorage({ spaceId, collectionId })
    const collectionDescription = await collectionStorage.get('.collection')

    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName: 'Get Resource' })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}/${resourceId}`,
      serverUrl)).toString()
    const allowedAction = 'GET'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController })

    // zCap checks out, continue
    const resource = await collectionStorage.get(resourceId)

    if (!resource) {
      throw new ResourceNotFoundError({ requestName: 'Get Resource' })
    }

    return reply.status(200).send(resource)
  }
}

export function getCollectionStorage ({ spaceId, collectionId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)
  return FlexDocStore.using('files', { dir: collectionDir, collection: collectionId, extension: '.json' })
}

export async function resourceStorage ({ spaceId, collectionId }) {

}
