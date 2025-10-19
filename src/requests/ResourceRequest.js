import { handleZcapVerify } from '../zcap.js'
import { getCollectionDescription, getResource, getSpaceDescription } from '../storage.js'
import { CollectionNotFoundError, ResourceNotFoundError, SpaceNotFoundError } from '../errors.js'

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
      url, method, headers } = request
    const { serverUrl } = this

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Get Resource' })
    }
    const spaceController = spaceDescription.controller

    // Fetch collection by id
    const collectionDescription = await getCollectionDescription({ spaceId, collectionId })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName: 'Get Resource' })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/${collectionId}/${resourceId}`,
      serverUrl)).toString()
    await handleZcapVerify({ url, allowedTarget, allowedAction: 'GET', method,
      headers, serverUrl, spaceController })

    // zCap checks out, continue
    const contentType = request.headers['content-type']
    const { resourceStream, storedResourceType } =
      await getResource({ spaceId, collectionId, resourceId, contentType })

    if (!resourceStream) {
      throw new ResourceNotFoundError({ requestName: 'Get Resource' })
    }

    return reply.status(200).type(storedResourceType).send(resourceStream)
  }
}
