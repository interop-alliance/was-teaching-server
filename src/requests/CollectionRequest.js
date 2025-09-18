import path from 'node:path'
import { FlexDocStore } from 'flex-docstore'
import { SPEC_URL } from '../../config.default.js'
import { handleZcapVerify } from '../routes.js'
import { getSpace } from './SpaceRequest.js'

export class CollectionRequest {
  /**
   * POST /space/:spaceId/
   * Request handler for "Create Collection" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async post (request, reply) {
    const { params: { spaceId }, url, method, headers } = request
    const { serverUrl } = this

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpace({ spaceId })
    if (!spaceDescription) {
      return reply.status(404).type('application/problem+json')
        .send({
          type: `${SPEC_URL}#create-collection-errors`,
          title: 'Invalid Create Collection request.',
          errors: [{
            detail: 'Space not found or invalid authorization.',
          }]
        })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/`, serverUrl)).toString()
    const allowedAction = 'POST'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController, requestName: 'Create Collection',
      specErrorSection: 'create-collection-errors' })
  }
}
