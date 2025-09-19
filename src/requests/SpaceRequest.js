import path from 'node:path'
import { FlexDocStore } from 'flex-docstore'
import { handleZcapVerify } from '../routes.js'
import { SpaceNotFoundError } from '../errors.js'

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
      throw new SpaceNotFoundError({ requestName: 'Get Space' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}`, serverUrl)).toString()
    const allowedAction = 'GET'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController, requestName: 'Get Space',
      specErrorSection: 'read-space-errors', reply })

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
