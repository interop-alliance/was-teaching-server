/**
 * Request handlers for Space operations: get/update/delete a Space, add a
 * Collection to it, list its Collections, and export it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { v4 as uuidv4 } from 'uuid'
import { handleZcapVerify } from '../zcap.js'
import { authorize } from '../authorize.js'
import { buildPolicyLinkset } from '../policy.js'
import { assertValidIds, assertValidId } from '../lib/validateId.js'
import {
  InvalidSpaceIdError,
  InvalidImportError,
  InvalidRequestBodyError,
  SpaceNotFoundError
} from '../errors.js'
import type { IDID, StorageBackend } from '../types.js'

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
    const { serverUrl, storage } = request.server

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName: 'Get Space' })

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await storage.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Get Space' })
    }
    const spaceController = spaceDescription.controller

    // Authorize: capability invocation first, then fall back to policy.
    const allowedTarget = new URL(`/space/${spaceId}`, serverUrl).toString()
    await authorize({
      request,
      allowedTarget,
      spaceId,
      spaceController,
      requestName: 'Get Space'
    })

    // authorized, continue. Advertise the Space's linkset (policy discovery);
    // a relative URL, consistent with the other URL fields the API returns.
    const linkset = `/space/${spaceId}/linkset`
    return reply.status(200).send({ ...spaceDescription, linkset })
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
    const { serverUrl, storage } = request.server
    const requestName = 'Get Space Linkset'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    const spaceController = await getSpaceController({
      storage,
      spaceId,
      requestName
    })

    const allowedTarget = new URL(
      `/space/${spaceId}/linkset`,
      serverUrl
    ).toString()
    await authorize({
      request,
      allowedTarget,
      spaceId,
      spaceController,
      requestName
    })

    const linkset = await buildPolicyLinkset({ storage, spaceId })
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
      Body: { name?: string; controller: IDID }
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

    // The Space Description body must carry a controller DID. The `name`
    // property is optional (see spec: Space Description object).
    if (!body?.controller) {
      throw new InvalidRequestBodyError({
        requestName: 'Update Space',
        detail: 'Space Description body requires a "controller" property.',
        pointer: '#/controller'
      })
    }

    // Check to see if space already exists (if yes, this will be an Update)
    const existingSpaceDescription = await storage.getSpaceDescription({
      spaceId
    })
    const existingController = existingSpaceDescription?.controller

    const [zcapSigningDid] = keyId.split('#')

    request.log.info(
      `Handling PUT request for spaceId: ${spaceId}, zcapSigningDid: ${zcapSigningDid}, existingSpaceDescription: ${existingSpaceDescription ? 'exists' : 'does not exist'}`
    )

    // Important. For exising space objects, make sure the request carries
    // authorization matching the old controller
    const authorizedController = existingController ?? (zcapSigningDid as IDID)

    // Perform zCap signature verification (throws appropriate errors)
    let spaceUrl
    try {
      spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
    } catch (err) {
      request.log.error(
        `Failed to construct spaceUrl for spaceId: ${spaceId}, serverUrl: ${serverUrl}, error: ${(err as Error).message}`
      )
      throw new InvalidSpaceIdError({ requestName: 'Update Space' })
    }

    request.log.info(`spaceUrl: ${spaceUrl}, serverUrl: ${serverUrl}`)
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
      Body: { id?: string; name?: string }
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

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName: 'Create Collection' })
    if (body?.id !== undefined) {
      assertValidId(body.id, {
        kind: 'collection',
        requestName: 'Create Collection'
      })
    }

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await storage.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Create Collection' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = new URL(`/space/${spaceId}/`, serverUrl).toString()
    await handleZcapVerify({
      url,
      allowedTarget,
      allowedAction: 'POST',
      method,
      headers,
      serverUrl,
      spaceController
    })

    // zCap checks out, continue
    // TODO: use a uuid v5 or another hash based id here instead
    // TODO: Protect against .space resource id collision
    const collectionId = body.id || uuidv4()
    // `name` is optional; default it to the Collection id when missing (spec).
    const name = body.name ?? collectionId
    const collectionDescription = {
      id: collectionId,
      type: ['Collection'],
      name
    }

    await storage.writeCollection({
      spaceId,
      collectionId,
      collectionDescription
    })

    const createdUrl = new URL(
      `/space/${spaceId}/${collectionId}`,
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
      params: { spaceId },
      url,
      method,
      headers
    } = request
    const { serverUrl, storage } = request.server

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName: 'Delete Space' })

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await storage.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Delete Space' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = new URL(`/space/${spaceId}`, serverUrl).toString()
    await handleZcapVerify({
      url,
      allowedTarget,
      allowedAction: 'DELETE',
      method,
      headers,
      serverUrl,
      spaceController
    })

    // zCap checks out, continue
    await storage.deleteSpace({ spaceId })

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
      params: { spaceId },
      url,
      method,
      headers
    } = request
    const { serverUrl, storage } = request.server

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName: 'Export Space' })

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await storage.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Export Space' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = new URL(
      `/space/${spaceId}/export`,
      serverUrl
    ).toString()
    await handleZcapVerify({
      url,
      allowedTarget,
      allowedAction: 'POST',
      method,
      headers,
      serverUrl,
      spaceController
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
      params: { spaceId },
      url,
      method,
      headers
    } = request
    const { serverUrl, storage } = request.server

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName: 'Import Space' })

    const spaceDescription = await storage.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Import Space' })
    }
    const spaceController = spaceDescription.controller

    const allowedTarget = new URL(
      `/space/${spaceId}/import`,
      serverUrl
    ).toString()
    await handleZcapVerify({
      url,
      allowedTarget,
      allowedAction: 'POST',
      method,
      headers,
      serverUrl,
      spaceController
    })

    try {
      const summary = await storage.importSpace({
        spaceId,
        tarStream: request.body
      })
      return reply.status(200).send(summary)
    } catch (err) {
      throw new InvalidImportError({ message: (err as Error).message })
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
    const { serverUrl, storage } = request.server

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName: 'List Collections' })

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await storage.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'List Collections' })
    }
    const spaceController = spaceDescription.controller

    // Authorize: capability invocation first, then fall back to space policy.
    const allowedTarget = new URL(
      `/space/${spaceId}/collections/`,
      serverUrl
    ).toString()
    await authorize({
      request,
      allowedTarget,
      spaceId,
      spaceController,
      requestName: 'List Collections'
    })

    const collections = await storage.listCollections({ spaceId })
    return reply.status(200).send({
      url: `/space/${spaceId}/collections/`,
      totalItems: collections.length,
      items: collections
    })
  }
}

/**
 * Load space description object from storage to get space controller.
 * TODO: Cache this
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 *   (`request.server.storage`)
 * @param options.spaceId {string}
 * @param options.requestName {string}
 * @returns {Promise<IDID>} Controller DID for a given space.
 */
export async function getSpaceController({
  storage,
  spaceId,
  requestName
}: {
  storage: StorageBackend
  spaceId: string
  requestName: string
}): Promise<IDID> {
  const spaceDescription = await storage.getSpaceDescription({ spaceId })
  if (!spaceDescription) {
    throw new SpaceNotFoundError({ requestName })
  }
  return spaceDescription.controller
}
