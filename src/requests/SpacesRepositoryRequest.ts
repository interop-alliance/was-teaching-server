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
import { invokerDid } from '../auth-header-hooks.js'
import { assertValidId } from '../lib/validateId.js'
import { spacePath, spacesPath } from '../lib/paths.js'
import { encodeCursor, decodeCursor } from '../lib/cursor.js'
import {
  DEFAULT_PAGE_SIZE,
  clampPageSize,
  compareCodeUnits
} from '../lib/pagination.js'
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
   * OPTIONALLY cursor-paginated (spec "Pagination"): pagination happens here in
   * the handler, not the backend, because the page is a page of AUTHORIZED
   * items and the per-controller authorization filtering lives here. Spaces are
   * ordered by `id` ascending (code-unit), a `cursor` resumes strictly after
   * its anchor id, and a `next` link is emitted when one more authorized item
   * exists beyond the page. `totalItems` -- the full authorized count -- is
   * included ONLY on a complete, unpaginated listing (no `cursor` supplied and
   * the scan reached the end without a `next`); otherwise it is omitted, since
   * the spec permits it and computing the true total would mean verifying every
   * candidate controller.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{
      Querystring: Record<string, string | string[] | undefined>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { url, method, headers } = request
    const { serverUrl, storage } = request.server

    const items: SpaceSummary[] = []

    // No (complete) authorization presented: authorized to see no Spaces,
    // which is the empty 200, not an error. This runs BEFORE any cursor
    // validation, so an anonymous caller with a garbage cursor still gets the
    // empty 200 rather than an `invalid-cursor`.
    if (!request.zcap?.invocation) {
      return reply.send({
        url: spacesPath(),
        totalItems: 0,
        items
      } satisfies SpaceListing)
    }

    const { keyId, invocation } = request.zcap
    const [zcapSigningDid] = keyId.split('#')
    const rootInvocation = isRootInvocation({ invocation })
    const allowedTarget = new URL(spacesPath(), serverUrl).toString()

    // `limit` / `cursor` are single-valued pagination params; a repeated value
    // (an array) is ignored and falls back to the default page size.
    const rawLimit = request.query.limit
    const rawCursor = request.query.cursor
    const limit = typeof rawLimit === 'string' ? rawLimit : undefined
    const cursor = typeof rawCursor === 'string' ? rawCursor : undefined

    // Decode the cursor now -- after the anonymous early-return, so an anonymous
    // caller never trips it. The per-space verification below is the
    // authorization; an invalid cursor from an authenticated caller is a 400
    // `invalid-cursor` (the spec's ordering note, as closely as this
    // per-controller-filtered operation allows).
    const after = cursor !== undefined ? decodeCursor(cursor).after : undefined

    // Coerce `limit` to a positive integer, clamped; a non-numeric or `< 1`
    // value falls back to the default page size.
    const parsedLimit = limit !== undefined ? Number(limit) : NaN
    const pageSize =
      Number.isFinite(parsedLimit) && parsedLimit >= 1
        ? clampPageSize(parsedLimit)
        : DEFAULT_PAGE_SIZE

    // Sort by `id` ascending in code-unit order -- the keyset order the cursor
    // seeks within; do not rely on backend ordering.
    const spaces = (await storage.listSpaces()).sort((left, right) =>
      compareCodeUnits(left.id, right.id)
    )

    // Seek to the first space id strictly greater than the cursor's anchor.
    let startIndex = 0
    if (after !== undefined) {
      const found = spaces.findIndex(space => space.id > after)
      startIndex = found === -1 ? spaces.length : found
    }

    // Visibility is identical across Spaces sharing a controller (the
    // verification depends only on the controller), so verify once per distinct
    // controller. A failed verification just excludes that controller's Spaces
    // -- never an error response.
    const verifiedByController = new Map<IDID, boolean>()

    // Fill the page: collect authorized items in id order from the seek point.
    // Once the page is full, keep scanning only until ONE more authorized item
    // is found -- that sets `hasMore` (and thus `next`) -- rather than verifying
    // the whole tail.
    let hasMore = false
    for (let index = startIndex; index < spaces.length; index++) {
      const space = spaces[index]!
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
            spaceController: controller,
            // The `?limit`/`cursor` query selects a page of an already-
            // authorized target; it must still verify against the bare
            // `/spaces/` root capability (see `verifyZcap`).
            allowTargetQuery: true
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
      if (!authorized) {
        continue
      }
      if (items.length === pageSize) {
        // One authorized item beyond a full page: there is a further page, but
        // we stop here without verifying the rest of the tail.
        hasMore = true
        break
      }
      const item: SpaceSummary = {
        id: space.id,
        url: spacePath({ spaceId: space.id })
      }
      if (space.name !== undefined) {
        item.name = space.name
      }
      items.push(item)
    }

    const listing: SpaceListing = { url: spacesPath(), items }
    if (hasMore) {
      const lastId = items[items.length - 1]!.id
      listing.next = `${spacesPath()}?limit=${pageSize}&cursor=${encodeCursor(lastId)}`
    }
    // `totalItems` is the full authorized count only when this response IS the
    // complete authorized set: no cursor was supplied AND the scan reached the
    // end without truncation (no `next`).
    if (cursor === undefined && !hasMore) {
      listing.totalItems = items.length
    }
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

    // zCap checks out, continue. A token-provisioned create carries no
    // invocation, so it records no `createdBy`.
    const createdBy = invokerDid(request)
    await storage.writeSpace({ spaceId, spaceDescription, createdBy })
    // Bust any cached (e.g. negatively cached) description for this id so the
    // next read sees the freshly created Space.
    invalidateSpaceDescription({ storage, spaceId })

    const createdSpaceUrl = new URL(
      spacesPath({ spaceId }),
      serverUrl
    ).toString()
    reply.header('Location', createdSpaceUrl)
    // Echo what was persisted, `createdBy` included, so the create response and
    // a subsequent Get Space agree. An id already in use was rejected as a 409
    // above, so this write created the Space and its creator is this invoker.
    return reply
      .status(201)
      .send({ ...spaceDescription, ...(createdBy && { createdBy }) })
  }
}
