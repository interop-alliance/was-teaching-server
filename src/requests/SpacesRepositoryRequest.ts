/**
 * Request handler for SpacesRepository operations:
 * - POST /spaces/ (Create Space).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import { handleZcapVerify } from '../zcap.js'
import { invalidateSpaceDescription } from './spaceContext.js'
import { assertValidId } from '../lib/validateId.js'
import {
  SpaceControllerMismatchError,
  InvalidRequestBodyError
} from '../errors.js'
import type { IDID } from '../types.js'

export class SpacesRepositoryRequest {
  /**
   * POST /spaces/
   * Request handler for "Create Space" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async post(
    request: FastifyRequest<{
      Body: { id?: string; name?: string; controller: IDID }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { body, url, method, headers } = request
    const { serverUrl, storage } = request.server
    // POST is a non-safe method, so `requireAuthHeaders` guarantees auth headers
    // were present and `parseAuthHeaders` set `request.zcap` before this handler.
    const { keyId } = request.zcap!

    // The Space Description body must carry a controller DID. The `name`
    // property is optional (see spec: Space Description object).
    if (!body?.controller) {
      throw new InvalidRequestBodyError({
        requestName: 'Create Space',
        detail: 'Space Description body requires a "controller" property.',
        pointer: '#/controller'
      })
    }
    // Reject a path-traversal / non-URL-safe client-supplied space id.
    if (body.id !== undefined) {
      assertValidId(body.id, { kind: 'space', requestName: 'Create Space' })
    }

    // Check to make sure the DID that signed the zcap matches controller
    const [zcapSigningDid] = keyId.split('#')
    if (zcapSigningDid !== body.controller) {
      throw new SpaceControllerMismatchError({
        zcapSigningDid: zcapSigningDid!,
        controller: body.controller
      })
    }

    // TODO: use a uuid v5 or another hash based id here instead
    const spaceId = body.id || uuidv4()
    const spaceDescription = { ...body, id: spaceId, type: ['Space'] }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = new URL(`/spaces/`, serverUrl).toString()
    await handleZcapVerify({
      url,
      allowedTarget,
      allowedAction: 'POST',
      method,
      headers,
      serverUrl,
      spaceController: body.controller,
      requestName: 'Create Space'
    })

    // zCap checks out, continue
    await storage.writeSpace({ spaceId, spaceDescription })
    // Bust any cached (e.g. negatively cached) description for this id so the
    // next read sees the freshly created Space.
    invalidateSpaceDescription({ storage, spaceId })

    const createdSpaceUrl = new URL(`/spaces/${spaceId}`, serverUrl).toString()
    reply.header('Location', createdSpaceUrl)
    return reply.status(201).send(spaceDescription)
  }
}
