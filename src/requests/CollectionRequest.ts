/**
 * Request handlers for Collection operations: get/update/delete a Collection,
 * list its items, and add a Resource to it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { v4 as uuidv4 } from 'uuid'

import { handleZcapVerify } from '../zcap.js'
import { getSpaceController } from './SpaceRequest.js'
import {
  CollectionNotFoundError,
  InvalidCollectionError,
  SpaceNotFoundError
} from '../errors.js'
import {
  deleteCollection,
  getCollectionDescription,
  getSpaceDescription,
  listCollectionItems,
  writeCollection,
  writeResource
} from '../storage.js'

export class CollectionRequest {
  /**
   * POST /space/:spaceId/:collectionId/
   * Request handler for "Create Resource" request
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
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      url,
      method,
      headers
    } = request
    const { serverUrl } = request.server
    const requestName = 'Create Resource'

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceController = await getSpaceController({ spaceId, requestName })

    // Fetch collection by id
    const collectionDescription = await getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = new URL(
      `/space/${spaceId}/${collectionId}/`,
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
    // TODO: use a uuid v5 or another hash based id here instead
    const resourceId = uuidv4()
    let response: { id: string; 'content-type'?: string; url?: string }

    try {
      await writeResource({ spaceId, collectionId, resourceId, request })
      response = {
        id: resourceId,
        'content-type': request.headers['content-type']
      }
    } catch (e) {
      throw new Error('Could not create resource: ' + (e as Error).message, {
        cause: e
      })
    }

    const createdUrl = new URL(
      `/space/${spaceId}/${collectionId}/${resourceId}`,
      serverUrl
    ).toString()
    reply.header('Location', createdUrl)
    response.url = createdUrl

    return reply.status(201).send(response)
  }

  /**
   * PUT /space/:spaceId/:collectionId
   * Request handler for "Update (or Create By Id) Collection" request
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
      Params: { spaceId: string; collectionId: string }
      Body: { name: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      url,
      method,
      headers,
      body
    } = request
    if (!body) {
      throw new InvalidCollectionError()
    }
    const { serverUrl } = request.server
    const requestName = 'Update Collection'
    const collectionUrl = new URL(
      `/space/${spaceId}/${collectionId}`,
      serverUrl
    ).toString()

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    await handleZcapVerify({
      url,
      allowedTarget: collectionUrl,
      allowedAction: 'PUT',
      method,
      headers,
      serverUrl,
      spaceController
    })

    // zCap checks out, continue
    const existingCollection = await getCollectionDescription({
      spaceId,
      collectionId
    })
    const collectionDescription = existingCollection
      ? // Existing: Update only the allowed fields
        { ...existingCollection, id: collectionId, name: body.name }
      : // New Collection
        { id: collectionId, type: ['Collection'], name: body.name }

    try {
      await writeCollection({ spaceId, collectionId, collectionDescription })
    } catch (e) {
      request.log.error(e)
      throw new Error('Could not update collection: ' + (e as Error).message, {
        cause: e
      })
    }

    reply.header('Location', collectionUrl)
    return existingCollection
      ? reply.status(204).send() // update
      : reply.status(201).send(collectionDescription) // create
  }

  /**
   * GET /space/:spaceId/:collectionId (no trailing slash): Get Collection details
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      url,
      method,
      headers
    } = request
    const { serverUrl } = request.server
    const requestName = 'Get Collection'

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceController = await getSpaceController({ spaceId, requestName })

    // Perform zCap signature verification (throws appropriate errors)
    const collectionUrl = new URL(
      `/space/${spaceId}/${collectionId}`,
      serverUrl
    ).toString()
    await handleZcapVerify({
      url,
      allowedTarget: collectionUrl,
      allowedAction: 'GET',
      method,
      headers,
      serverUrl,
      spaceController
    })

    // Fetch collection by id
    const collectionDescription = await getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify(collectionDescription))
  }

  /**
   * DELETE /space/:spaceId/:collectionId
   * Request handler for "Delete Collection" request
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
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      url,
      method,
      headers
    } = request
    const { serverUrl } = request.server
    const requestName = 'Delete Collection'
    const collectionUrl = new URL(
      `/space/${spaceId}/${collectionId}`,
      serverUrl
    ).toString()

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    await handleZcapVerify({
      url,
      allowedTarget: collectionUrl,
      allowedAction: 'DELETE',
      method,
      headers,
      serverUrl,
      spaceController
    })

    try {
      await deleteCollection({ spaceId, collectionId })
    } catch (e) {
      request.log.error(e)
      throw new Error('Could not delete collection: ' + (e as Error).message, {
        cause: e
      })
    }

    return reply.status(204).send()
  }

  /**
   * GET /space/:spaceId/:collectionId/ (with trailing slash):
   * List Collection items
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async list(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      url,
      method,
      headers
    } = request
    const { serverUrl } = request.server
    const requestName = 'List Collection'

    const spaceController = await getSpaceController({ spaceId, requestName })

    // Fetch collection by id
    const collectionDescription = await getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = new URL(
      `/space/${spaceId}/${collectionId}/`,
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

    const collectionItems = await listCollectionItems({ spaceId, collectionId })

    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify(collectionItems))
  }
}
