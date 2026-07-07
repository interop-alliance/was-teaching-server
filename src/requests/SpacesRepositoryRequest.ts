/**
 * Request handler for SpacesRepository operations:
 * - POST /spaces/ (Create Space)
 * - GET /spaces/ (List Spaces).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import { isRootInvocation, verifyZcap } from '../zcap.js'
import { invalidateSpaceDescription } from './spaceContext.js'
import { verifyBodyControllerConsent } from './controllerConsent.js'
import { assertValidId } from '../lib/validateId.js'
import { spacePath, spacesPath } from '../lib/paths.js'
import { assertValidController } from '../lib/validateDid.js'
import {
  SpaceControllerMismatchError,
  InvalidRequestBodyError,
  IdConflictError
} from '../errors.js'
import type { IDID, SpaceSummary, SpaceListing } from '../types.js'

export class SpacesRepositoryRequest {
  /**
   * GET /spaces/
   * Request handler for "List Spaces" (spec "List Spaces Operation"): returns
   * `{ url, totalItems, items }` with only the Spaces the caller is authorized
   * to see. An anonymous or unauthorized request is NOT an error -- it gets the
   * empty-items 200, the spec's explicit exception to 404 masking -- so nothing
   * is revealed about which Spaces exist.
   *
   * Authorization is per Space controller: the root capability for `/spaces/`
   * is synthesized with the candidate Space's controller (see `verifyZcap`), so
   * one verification decides visibility for every Space sharing that
   * controller. A bare-root invocation can only verify where the signer *is*
   * the controller, so those candidates are filtered before any signature
   * work; a delegated invocation reveals the Spaces of whichever controller
   * roots its capability chain.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { url, method, headers } = request
    const { serverUrl, storage } = request.server

    const items: SpaceSummary[] = []
    const listing: SpaceListing = { url: spacesPath(), totalItems: 0, items }

    // No (complete) authorization presented: authorized to see no Spaces,
    // which is the empty 200, not an error.
    if (!request.zcap?.invocation) {
      return reply.send(listing)
    }

    const { keyId, invocation } = request.zcap
    const [zcapSigningDid] = keyId.split('#')
    const rootInvocation = isRootInvocation({ invocation })
    const allowedTarget = new URL(spacesPath(), serverUrl).toString()

    // Visibility is identical across Spaces sharing a controller (the
    // verification depends only on the controller), so verify once per
    // distinct controller. A failed verification just excludes that
    // controller's Spaces -- never an error response.
    const verifiedByController = new Map<IDID, boolean>()
    for (const space of await storage.listSpaces()) {
      const { controller } = space
      if (rootInvocation && controller !== zcapSigningDid) {
        continue // a bare-root invocation cannot verify for another controller
      }
      let authorized = verifiedByController.get(controller)
      if (authorized === undefined) {
        try {
          const result = await verifyZcap({
            url,
            allowedTarget,
            allowedAction: 'GET',
            method,
            headers,
            serverUrl,
            spaceController: controller
          })
          authorized = result.verified === true
        } catch (err) {
          request.log.debug(
            { err },
            'List Spaces: invocation did not verify for a candidate controller'
          )
          authorized = false
        }
        verifiedByController.set(controller, authorized)
      }
      if (authorized) {
        const item: SpaceSummary = {
          id: space.id,
          url: spacePath({ spaceId: space.id })
        }
        if (space.name !== undefined) {
          item.name = space.name
        }
        items.push(item)
      }
    }

    listing.totalItems = items.length
    return reply.send(listing)
  }

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
    const { body } = request
    const { serverUrl, storage } = request.server

    // The Space Description body must carry a controller DID. The `name`
    // property is optional (see spec: Space Description object).
    if (!body?.controller) {
      throw new InvalidRequestBodyError({
        requestName: 'Create Space',
        detail: 'Space Description body requires a "controller" property.',
        pointer: '#/controller'
      })
    }
    // Reject a malformed / non-`did:key` controller before it is stored.
    assertValidController(body.controller, { requestName: 'Create Space' })
    // Reject a path-traversal / non-URL-safe client-supplied space id.
    if (body.id !== undefined) {
      assertValidId(body.id, { kind: 'space', requestName: 'Create Space' })
      // POST must never replace an existing Space: the signature below is
      // verified against the *body's* controller, so without this check any
      // caller could overwrite a Space (controller included) by POSTing its
      // id. Spec: `id-conflict` (409); create-or-replace by id is PUT's job.
      if (await storage.getSpaceDescription({ spaceId: body.id })) {
        throw new IdConflictError({ kind: 'Space' })
      }
    }

    const spaceId = body.id || uuidv4()
    const spaceDescription = { ...body, id: spaceId, type: ['Space'] }

    // The invocation must be *authorized by* the body's controller (spec:
    // Create Space): signed directly by it, or via a delegation chain rooted
    // in it (see `verifyBodyControllerConsent`). Skipped when the provisioning
    // policy already vouched for the request (e.g. a valid onboarding token).
    if (!request.provisioningAuthorized) {
      await verifyBodyControllerConsent({
        request,
        controller: body.controller,
        allowedTarget: new URL(spacesPath(), serverUrl).toString(),
        allowedAction: 'POST',
        MismatchError: SpaceControllerMismatchError,
        requestName: 'Create Space'
      })
    }

    // zCap checks out, continue
    await storage.writeSpace({ spaceId, spaceDescription })
    // Bust any cached (e.g. negatively cached) description for this id so the
    // next read sees the freshly created Space.
    invalidateSpaceDescription({ storage, spaceId })

    const createdSpaceUrl = new URL(
      spacesPath({ spaceId }),
      serverUrl
    ).toString()
    reply.header('Location', createdSpaceUrl)
    return reply.status(201).send(spaceDescription)
  }
}
