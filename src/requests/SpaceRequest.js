import path from 'node:path'
import { FlexDocStore } from 'flex-docstore'
import { SPEC_URL } from '../../config.default.js'
import { handleZcapVerify } from '../routes.js'

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
    const spaceDescription = await getSpace({ spaceId })
    if (!spaceDescription) {
      return reply.status(404).type('application/problem+json')
        .send({
          type: `${SPEC_URL}#read-space-errors`,
          title: 'Invalid Get Space request.',
          errors: [{
            detail: 'Space not found or invalid authorization.',
          }]
        })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}`, serverUrl)).toString()
    const allowedAction = 'GET'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController, requestName: 'Get Space',
      specErrorSection: 'read-space-errors' })

    // zCap checks out, continue
    return reply.status(200).send(spaceDescription)
  }
}

export async function getSpace ({ spaceId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')
  const spaceDir = path.join(spacesRepository, spaceId)
  const storage = FlexDocStore.using('files', { dir: spaceDir, extension: '.json' })

  return storage.get('.space')
}
