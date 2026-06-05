/**
 * Request handlers for Resource operations: create-by-id, get, and delete a
 * Resource (JSON object or binary blob).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { handleZcapVerify } from '../zcap.js'
import { resolveResourceInput } from './resourceInput.js'
import { assertValidIds } from '../lib/validateId.js'
import {
  CollectionNotFoundError,
  ResourceNotFoundError,
  SpaceNotFoundError,
  StorageError
} from '../errors.js'

export class ResourceRequest {
  /**
   * PUT /space/:spaceId/:collectionId/:resourceId
   * Request handler for "Create (or Update) Resource by Id" request
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
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId },
      url,
      method,
      headers
    } = request
    const { serverUrl, storage } = request.server

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds(
      { spaceId, collectionId, resourceId },
      { requestName: 'Put Resource' }
    )

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await storage.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Put Resource' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = new URL(
      `/space/${spaceId}/${collectionId}/${resourceId}`,
      serverUrl
    ).toString()
    await handleZcapVerify({
      url,
      allowedTarget,
      allowedAction: 'PUT',
      method,
      headers,
      serverUrl,
      spaceController
    })

    // zCap checks out, continue

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName: 'Put Resource' })
    }
    const input = await resolveResourceInput(request)
    try {
      await storage.writeResource({ spaceId, collectionId, resourceId, input })
    } catch (err) {
      throw new StorageError({
        cause: err as Error,
        requestName: 'Put Resource'
      })
    }
    return reply.status(204).send()
  }

  /**
   * GET /space/:spaceId/:collectionId/:resourceId
   * Request handler for "Get Resource" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId },
      url,
      method,
      headers
    } = request
    const { serverUrl, storage } = request.server

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds(
      { spaceId, collectionId, resourceId },
      { requestName: 'Get Resource' }
    )

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await storage.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Get Resource' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = new URL(
      `/space/${spaceId}/${collectionId}/${resourceId}`,
      serverUrl
    ).toString()
    await handleZcapVerify({
      url,
      allowedTarget,
      allowedAction: 'GET',
      method,
      headers,
      serverUrl,
      spaceController
    })

    // zCap checks out, continue

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName: 'Get Resource' })
    }

    const contentType = request.headers['content-type']
    let resourceStream: Readable | undefined
    let storedResourceType: string | undefined
    try {
      const result = await storage.getResource({
        spaceId,
        collectionId,
        resourceId,
        contentType
      })
      resourceStream = result.resourceStream
      storedResourceType = result.storedResourceType
    } catch (err) {
      request.log.error(err)
    }

    if (!resourceStream) {
      throw new ResourceNotFoundError({ requestName: 'Get Resource' })
    }

    return reply.status(200).type(storedResourceType!).send(resourceStream)
  }

  /**
   * DELETE /space/:spaceId/:collectionId/:resourceId
   * Request handler for "Delete Resource" request
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
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId },
      url,
      method,
      headers
    } = request
    const { serverUrl, storage } = request.server

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds(
      { spaceId, collectionId, resourceId },
      { requestName: 'Delete Resource' }
    )

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await storage.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Delete Resource' })
    }
    const spaceController = spaceDescription.controller

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName: 'Delete Resource' })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = new URL(
      `/space/${spaceId}/${collectionId}/${resourceId}`,
      serverUrl
    ).toString()
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
    try {
      await storage.deleteResource({ spaceId, collectionId, resourceId })
    } catch (err) {
      console.log(err)
      throw new StorageError({
        cause: err as Error,
        requestName: 'Delete Resource'
      })
    }

    return reply.status(204).send()
  }
}
