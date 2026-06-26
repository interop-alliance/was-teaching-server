/**
 * Request handlers for Space operations: get/update/delete a Space, add a
 * Collection to it, list its Collections, and export it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { v4 as uuidv4 } from 'uuid'
import { handleZcapVerify, isRootInvocation } from '../zcap.js'
import { buildLinkset } from '../policy.js'
import {
  fetchSpaceAndAuthorize,
  fetchSpaceAndVerify,
  invalidateSpaceDescription
} from './spaceContext.js'
import { assertValidIds, assertValidId } from '../lib/validateId.js'
import { assertValidController } from '../lib/validateDid.js'
import {
  assertSupportedBackend,
  listRegisteredBackends
} from '../lib/backends.js'
import {
  spacePath,
  collectionPath,
  collectionsPath,
  exportPath,
  importPath,
  linksetPath,
  backendsPath,
  quotasPath
} from '../lib/paths.js'
import {
  ProblemError,
  InvalidSpaceIdError,
  InvalidImportError,
  InvalidRequestBodyError,
  IdConflictError,
  SpaceControllerMismatchError
} from '../errors.js'
import type {
  IDID,
  SpaceDescription,
  CollectionsList,
  SpaceQuotaReport
} from '../types.js'

export class SpaceRequest {
  /**
   * GET /space/:spaceId
   * Request handler for "Read Space" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * Example Space Description Object:
   * {
   *   "id": "6b5be748-5f39-4936-a895-409e393c399c",
   *   "type": ["Space"],
   *   "name": "Alice's space",
   *   "controller": "did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW"
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const requestName = 'Get Space'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // Space's access-control policy as a fallback (a public-readable Space).
    const { spaceDescription } = await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: spacePath({ spaceId }),
      requestName
    })

    // authorized, continue. Advertise the Space's self `url` and linkset (policy
    // discovery); both relative, consistent with the other URL fields the API
    // returns. `type` is served lexically sorted (spec SHOULD).
    const url = spacePath({ spaceId })
    const linkset = linksetPath({ spaceId })
    return reply.status(200).send({
      ...spaceDescription,
      type: [...spaceDescription.type].sort(),
      url,
      linkset
    } satisfies SpaceDescription)
  }

  /**
   * GET /space/:spaceId/linkset
   * Request handler for the Space's linkset (RFC9264): advertises the Space's
   * access-control `policy` resource for discovery. Readable by whoever may read
   * the Space (capability or fallback policy).
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async linkset(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Space Linkset'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Authorize (capability-or-policy): readable by whoever may read the Space.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: linksetPath({ spaceId }),
      requestName
    })

    const linkset = await buildLinkset({ storage, spaceId })
    return reply
      .status(200)
      .type('application/linkset+json')
      .send(JSON.stringify(linkset))
  }

  /**
   * PUT /space/:spaceId
   * Request handler for "Update or Create Space by Id" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async put(
    request: FastifyRequest<{
      Params: { spaceId: string }
      Body: { id?: string; name?: string; controller: IDID }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId },
      url,
      method,
      headers,
      body
    } = request
    const { serverUrl, storage } = request.server
    // PUT is a non-safe method, so `requireAuthHeaders` guarantees auth headers
    // were present and `parseAuthHeaders` set `request.zcap` before this handler.
    const { keyId } = request.zcap!

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName: 'Update Space' })

    // The Space `id` is immutable: when the PUT body carries one, it must match
    // the `{space_id}` in the URL (spec: Update Space `invalid-request-body`).
    if (body?.id !== undefined && body.id !== spaceId) {
      throw new InvalidRequestBodyError({
        requestName: 'Update Space',
        detail: `Space Description "id" (${body.id}) does not match the URL Space id (${spaceId}).`,
        pointer: '#/id'
      })
    }

    // The Space Description body must carry a controller DID. The `name`
    // property is optional (see spec: Space Description object).
    if (!body?.controller) {
      throw new InvalidRequestBodyError({
        requestName: 'Update Space',
        detail: 'Space Description body requires a "controller" property.',
        pointer: '#/controller'
      })
    }
    // Reject a malformed / non-`did:key` controller before it is stored.
    assertValidController(body.controller, { requestName: 'Update Space' })

    // Check to see if space already exists (if yes, this will be an Update)
    const existingSpaceDescription = await storage.getSpaceDescription({
      spaceId
    })
    const existingController = existingSpaceDescription?.controller

    const [zcapSigningDid] = keyId.split('#')

    request.log.info(
      `Handling PUT request for spaceId: ${spaceId}, zcapSigningDid: ${zcapSigningDid}, existingSpaceDescription: ${existingSpaceDescription ? 'exists' : 'does not exist'}`
    )

    // Important. For existing Spaces, the request must carry authorization
    // matching the *stored* controller (the body's controller is just the
    // proposed new value). On create there is no stored controller yet, so --
    // as with Create Space via POST -- the invocation must be authorized by
    // the *body's* controller: signed directly by it, or via a delegation
    // chain rooted in it. Verifying a create against the signer instead would
    // let anyone install an unrelated, non-consenting DID as controller.
    const authorizedController = existingController ?? body.controller
    const rootInvocation = isRootInvocation({
      invocation: request.zcap!.invocation
    })
    if (
      !existingSpaceDescription &&
      rootInvocation &&
      zcapSigningDid !== body.controller
    ) {
      throw new SpaceControllerMismatchError({
        zcapSigningDid: zcapSigningDid!,
        controller: body.controller
      })
    }

    // Perform zCap signature verification (throws appropriate errors)
    let spaceUrl
    try {
      spaceUrl = new URL(spacePath({ spaceId }), serverUrl).toString()
    } catch (err) {
      request.log.error(
        `Failed to construct spaceUrl for spaceId: ${spaceId}, serverUrl: ${serverUrl}, error: ${(err as Error).message}`
      )
      throw new InvalidSpaceIdError({ requestName: 'Update Space' })
    }

    request.log.info(`spaceUrl: ${spaceUrl}, serverUrl: ${serverUrl}`)
    try {
      await handleZcapVerify({
        url,
        allowedTarget: spaceUrl,
        allowedAction: 'PUT',
        method,
        headers,
        serverUrl,
        spaceController: authorizedController,
        logger: request.log
      })
    } catch (err) {
      // A delegated *create* that fails to verify is a chain not rooted in
      // the body's controller: spec `controller-mismatch` (400). Updates (and
      // root-form creates, whose signer already matched the controller above)
      // keep their generic verification errors.
      if (!existingSpaceDescription && !rootInvocation) {
        throw new SpaceControllerMismatchError({
          zcapSigningDid: zcapSigningDid!,
          controller: body.controller,
          cause: err as Error
        })
      }
      throw err
    }

    request.log.info('zCap verified')

    // Compose Space Description object body, new or updated. `name` is
    // optional, so only include it when the request supplies one.
    const spaceDescription = existingSpaceDescription
      ? // Existing: Update only the allowed fields
        {
          ...existingSpaceDescription,
          id: spaceId,
          controller: body.controller,
          ...(body.name !== undefined && { name: body.name })
        }
      : // New Space
        {
          id: spaceId,
          type: ['Space'],
          controller: body.controller,
          ...(body.name !== undefined && { name: body.name })
        }

    // zCap checks out, continue
    await storage.writeSpace({ spaceId, spaceDescription })
    // Bust any cached (now-stale) description so the next read sees this write.
    invalidateSpaceDescription({ storage, spaceId })

    reply.header('Location', spaceUrl)
    return existingSpaceDescription
      ? reply.status(204).send() // update
      : reply.status(201).send(spaceDescription) // create
  }

  /**
   * POST /space/:spaceId/
   * Request handler for "Create Collection" request
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
      Params: { spaceId: string }
      Body: { id?: string; name?: string; backend?: unknown }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId },
      body
    } = request
    const { serverUrl, storage } = request.server
    const requestName = 'Create Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })
    if (body?.id !== undefined) {
      assertValidId(body.id, { kind: 'collection', requestName })
    }
    // Validate (and default-fill) the selected backend against the Space's
    // backends-available: a bad shape is 400, an unknown id is 409.
    const backend = await assertSupportedBackend({
      storage,
      spaceId,
      backend: body?.backend,
      requestName
    })

    // Verify (capability-only): creating a Collection requires a valid
    // capability invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: spacePath({ spaceId, trailingSlash: true }),
      requestName
    })

    // zCap checks out, continue
    // POST must not replace an existing Collection: spec `id-conflict` (409);
    // create-or-replace by id is PUT's job. Checked after the capability
    // verification so an unauthorized caller cannot probe Collection ids.
    if (
      body?.id !== undefined &&
      (await storage.getCollectionDescription({
        spaceId,
        collectionId: body.id
      }))
    ) {
      throw new IdConflictError({ kind: 'Collection' })
    }

    // TODO: Protect against .space resource id collision
    const collectionId = body.id || uuidv4()
    // `name` is optional; default it to the Collection id when missing (spec).
    const name = body.name ?? collectionId
    const collectionDescription = {
      id: collectionId,
      type: ['Collection'],
      name,
      backend
    }

    await storage.writeCollection({
      spaceId,
      collectionId,
      collectionDescription
    })

    const createdUrl = new URL(
      collectionPath({ spaceId, collectionId }),
      serverUrl
    ).toString()
    reply.header('Location', createdUrl)
    return reply.status(201).send(collectionDescription)
  }

  /**
   * DELETE /space/:spaceId
   * Request handler for "Delete Space" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async delete(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'Delete Space'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Verify (capability-only): deleting a Space requires a valid capability
    // invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: spacePath({ spaceId }),
      requestName
    })

    // zCap checks out, continue
    await storage.deleteSpace({ spaceId })
    // Bust the cached description so the next read sees the Space as gone (404).
    invalidateSpaceDescription({ storage, spaceId })

    return reply.status(204).send()
  }

  /**
   * POST /space/:spaceId/export
   * Request handler for "Export Space" request
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async export(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'Export Space'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Verify (capability-only): exporting a Space requires a valid capability
    // invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: exportPath({ spaceId }),
      requestName
    })

    // zCap checks out, continue
    const tarFile = await storage.exportSpace({ spaceId })

    return reply.status(200).type('application/x-tar').send(tarFile)
  }

  /**
   * POST /space/:spaceId/import
   * Request handler for "Import Space" request (merge from tarball)
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async import(
    request: FastifyRequest<{ Params: { spaceId: string }; Body: Readable }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'Import Space'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Verify (capability-only): importing into a Space requires a valid
    // capability invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: importPath({ spaceId }),
      requestName
    })

    try {
      const summary = await storage.importSpace({
        spaceId,
        tarStream: request.body
      })
      return reply.status(200).send(summary)
    } catch (err) {
      // Archive-validation failures already surface as typed ProblemErrors
      // (e.g. InvalidImportError from the manifest checks, or an invalid-id
      // error from a malformed archive id) -- let those through unchanged,
      // preserving their status code and message. Anything else is an
      // unexpected failure decoding the upload: wrap it as a generic
      // invalid-import 400, keeping the original as the `cause`.
      if (err instanceof ProblemError) {
        throw err
      }
      throw new InvalidImportError({ cause: err as Error })
    }
  }

  /**
   * GET /space/:spaceId/collections/
   * Request handler for "List Collections" request
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async listCollections(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'List Collections'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // Space's access-control policy as a fallback (a public-readable Space).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: collectionsPath({ spaceId }),
      requestName
    })

    const collections = await storage.listCollections({ spaceId })
    return reply.status(200).send({
      url: collectionsPath({ spaceId }),
      totalItems: collections.length,
      items: collections
    } satisfies CollectionsList)
  }

  /**
   * GET /space/:spaceId/backends
   * Request handler for the "Space Backends Available" request: the list of
   * storage backends registered for the Space. This reference server ships a
   * single server-configured backend (registered as `default`), so the list has
   * one entry, derived from the active backend's own `describe()`.
   *
   * Authorization is capability-or-policy, the same as List Collections: the
   * backends list is no more sensitive than the Space description, so a
   * public-readable Space may also list its backends.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async listBackends(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'List Backends'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // Space's access-control policy as a fallback (a public-readable Space).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: backendsPath({ spaceId }),
      requestName
    })

    return reply
      .status(200)
      .type('application/json')
      .send(await listRegisteredBackends({ storage, spaceId }))
  }

  /**
   * GET /space/:spaceId/quotas
   * Request handler for the "Quotas" request: the Space's storage report,
   * grouped by backend (spec "Quotas"). This reference server ships a single
   * server-configured backend, so the `backends` array has one entry, measured
   * from the active backend's `reportUsage()`.
   *
   * The per-Collection `usageByCollection` breakdown is opt-in via the spec's
   * `?include=collections` query parameter (omitted otherwise, to keep the
   * hot-path payload lean). Reading that query string on a capability-signed
   * request requires `allowTargetQuery` on the authorization call -- the spec's
   * "Quotas" / "Pagination parameters and authorization" rule that a query
   * parameter selecting a representation does not change the target a capability
   * must match (see `verifyZcap`).
   *
   * Authorization is capability-or-policy, the same as List Collections and the
   * backends list: a caller not authorized to read the report receives a 404
   * (the spec's maximum-privacy invariant), and a public-readable Space may read
   * its quota report. Authorization runs before the query is consulted.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async quotas(
    request: FastifyRequest<{
      Params: { spaceId: string }
      Querystring: { include?: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId },
      query: { include }
    } = request
    const { storage } = request.server
    const requestName = 'Get Quotas'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // Space's access-control policy as a fallback (a public-readable Space).
    // `allowTargetQuery` lets the signed-request path tolerate the
    // `?include=collections` query parameter without it changing the capability
    // target.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: quotasPath({ spaceId }),
      requestName,
      allowTargetQuery: true
    })

    // The per-Collection breakdown is opt-in via `?include=collections` (spec
    // "Quotas"); `include` is a comma-separated list of optional sections.
    const includeCollections = (include ?? '')
      .split(',')
      .map(section => section.trim())
      .includes('collections')

    const usage = await storage.reportUsage({ spaceId, includeCollections })

    return reply
      .status(200)
      .type('application/json')
      .send({
        respondedAt: new Date().toISOString(),
        backends: [usage]
      } satisfies SpaceQuotaReport)
  }
}
