/**
 * Request handlers for Resource operations: create-by-id, get, and delete a
 * Resource (JSON object or binary blob).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import { resolveResourceInput } from './resourceInput.js'
import { assertValidIds } from '../lib/validateId.js'
import { resourcePath, metaPath } from '../lib/paths.js'
import { formatEtag, parseWritePreconditions } from '../lib/etag.js'
import {
  CollectionNotFoundError,
  InvalidRequestBodyError,
  ResourceNotFoundError,
  StorageError,
  rethrowOrWrapStorageError
} from '../errors.js'
import type { ResourceMetadataCustom } from '../types.js'

/**
 * Validates and extracts the user-writable `custom` object from an Update
 * Resource Metadata request body. The body MUST be a JSON object; any top-level
 * property other than `custom` is ignored (so a client may GET-modify-PUT the
 * whole Metadata object). A missing `custom` clears all user-writable properties
 * (returns `{}`). Throws `InvalidRequestBodyError` (400) when the body or
 * `custom` shape is wrong.
 * @param body {unknown}   the parsed request body
 * @returns {ResourceMetadataCustom}
 */
function parseCustomMetadata(body: unknown): ResourceMetadataCustom {
  const requestName = 'Update Resource Metadata'
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Request body must be a JSON object.'
    })
  }
  const { custom } = body as Record<string, unknown>
  if (custom === undefined) {
    return {}
  }
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom` property must be a JSON object.',
      pointer: '/custom'
    })
  }
  const { name, tags } = custom as Record<string, unknown>
  if (name !== undefined && typeof name !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom.name` property must be a string.',
      pointer: '/custom/name'
    })
  }
  if (
    tags !== undefined &&
    (typeof tags !== 'object' || tags === null || Array.isArray(tags))
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom.tags` property must be a JSON object.',
      pointer: '/custom/tags'
    })
  }
  // Tag values MUST be strings (spec: values SHOULD be strings; the wire type
  // models them as `Record<string, string>`).
  if (
    tags !== undefined &&
    Object.values(tags as Record<string, unknown>).some(
      value => typeof value !== 'string'
    )
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Every `custom.tags` value must be a string.',
      pointer: '/custom/tags'
    })
  }
  return {
    ...(name !== undefined && { name }),
    ...(tags !== undefined && { tags: tags as Record<string, string> })
  }
}

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
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Put Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Verify (capability-only): creating/updating a Resource requires a valid
    // capability invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: resourcePath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // zCap checks out, continue

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }
    const input = await resolveResourceInput(request)
    // Surface any `If-Match` / `If-None-Match` write precondition to the storage
    // layer, which evaluates it atomically with the write (returning 412
    // `precondition-failed` on a mismatch -- rethrown unchanged below).
    let written: { version: number }
    try {
      written = await storage.writeResource({
        spaceId,
        collectionId,
        resourceId,
        input,
        ...parseWritePreconditions(request.headers)
      })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }
    // Return the new ETag so a client can chain a subsequent conditional write.
    return reply.status(204).header('etag', formatEtag(written.version)).send()
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
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then fall
    // back to the effective access-control policy (e.g. a world-readable
    // Resource). Throws on denial.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: resourcePath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // authorized, continue

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    const contentType = request.headers['content-type']
    let result
    try {
      result = await storage.getResource({
        spaceId,
        collectionId,
        resourceId,
        contentType
      })
    } catch (err) {
      // `getResource` throws ResourceNotFoundError for an absent resource;
      // surface that as a 404. Any other failure is a real storage fault, not a
      // missing resource, so wrap it as a 500 rather than masking it as 404.
      if (err instanceof ResourceNotFoundError) {
        throw err
      }
      throw new StorageError({ cause: err as Error, requestName })
    }

    const getReply = reply.status(200).type(result.storedResourceType)
    // Surface the ETag validator (the conditional-writes feature) when the
    // backend tracks a version for this Resource.
    if (result.version !== undefined) {
      getReply.header('etag', formatEtag(result.version))
    }
    return getReply.send(result.resourceStream)
  }

  /**
   * HEAD /space/:spaceId/:collectionId/:resourceId
   * Request handler for "Head Resource" request: the same authorization as Get
   * Resource but with no response body. Per spec "Content Types and
   * Representations", the response `Content-Type` and `Content-Length`
   * correspond to the `contentType` and `size` of the Resource's Metadata object
   * (the bytes a GET would return). HEAD is a safe method, authorized as a read
   * (capability-or-policy), the same as GET; it reads only the Metadata so it
   * never opens the resource byte stream.
   *
   * Registered explicitly (ahead of the GET route) rather than relying on
   * Fastify's auto-exposed HEAD, which would share the GET handler and stream
   * the whole body -- yielding no `Content-Length` for a streamed representation.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async head(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Head Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Authorize (capability-or-policy): the same read decision as Get Resource,
    // against the same target (a HEAD reveals nothing a GET would not).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: resourcePath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // authorized, continue

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    let metadata
    try {
      metadata = await storage.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId
      })
    } catch (err) {
      throw new StorageError({ cause: err as Error, requestName })
    }
    if (!metadata) {
      throw new ResourceNotFoundError({ requestName })
    }

    // Set the payload headers a GET would send, but send no body. Fastify keeps
    // a manually-set `Content-Length` on a bodyless send (it is not recomputed
    // to 0).
    const headReply = reply
      .status(200)
      .type(metadata.contentType)
      .header('content-length', metadata.size)
    if (metadata.version !== undefined) {
      headReply.header('etag', formatEtag(metadata.version))
    }
    return headReply.send()
  }

  /**
   * GET /space/:spaceId/:collectionId/:resourceId/meta
   * Request handler for "Read Resource Metadata" request. Returns the REQUIRED
   * server-managed fields (`contentType`, `size`), the OPTIONAL `createdAt` /
   * `updatedAt` timestamps, and the user-writable `custom` object (omitted when
   * empty). Authorization is capability-or-policy, the same as Get Resource:
   * metadata reveals nothing beyond what a GET of the resource itself exposes via
   * Content-Type / Content-Length, so a `PublicCanRead` policy also grants
   * metadata reads.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getMeta(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Resource Metadata'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Authorize (capability-or-policy): the capability's `invocationTarget` is
    // the full `/meta` URL (matching the request URL), and the policy level
    // resolves at the resource as for Get Resource.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: metaPath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // authorized, continue

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    let metadata
    try {
      metadata = await storage.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId
      })
    } catch (err) {
      throw new StorageError({ cause: err as Error, requestName })
    }
    if (!metadata) {
      throw new ResourceNotFoundError({ requestName })
    }

    // `version` is the ETag validator, surfaced as the `ETag` header -- not part
    // of the Resource Metadata wire body, so strip it before serializing.
    const { version, ...metadataBody } = metadata
    const metaReply = reply.status(200).type('application/json')
    if (version !== undefined) {
      metaReply.header('etag', formatEtag(version))
    }
    return metaReply.send(JSON.stringify(metadataBody))
  }

  /**
   * PUT /space/:spaceId/:collectionId/:resourceId/meta
   * Request handler for "Update Resource Metadata" request. A full replacement
   * of the Metadata object's user-writable `custom` object (any property omitted
   * is cleared; a body with no `custom` clears them all). Server-managed
   * properties are untouched, and any top-level property other than `custom` in
   * the body is ignored (so a client may GET-modify-PUT the whole object). Does
   * NOT create: a `PUT` to the `/meta` of a nonexistent Resource is a 404.
   * Authorization is capability-only (the `PUT` action), the same as Put
   * Resource. Returns 204.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async putMeta(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
      Body: unknown
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Update Resource Metadata'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Validate the body shape (400) before authorization; body validity does not
    // reveal whether the Resource exists.
    const custom = parseCustomMetadata(request.body)

    // Verify (capability-only): writing metadata requires a valid capability
    // invocation (the `PUT` action); no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: metaPath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // zCap checks out, continue

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    let written
    try {
      written = await storage.writeResourceMetadata({
        spaceId,
        collectionId,
        resourceId,
        custom
      })
    } catch (err) {
      throw new StorageError({ cause: err as Error, requestName })
    }
    // A Metadata object cannot exist apart from its Resource: a PUT to the
    // `/meta` of a nonexistent Resource is a 404 (this operation does not create).
    if (!written) {
      throw new ResourceNotFoundError({ requestName })
    }

    return reply.status(204).send()
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
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Delete Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Verify (capability-only): deleting a Resource requires a valid capability
    // invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: resourcePath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    // zCap checks out, continue. An `If-Match` precondition is evaluated by the
    // storage layer atomically with the removal; a mismatch surfaces as 412
    // `precondition-failed` (rethrown unchanged below).
    const { ifMatch } = parseWritePreconditions(request.headers)
    try {
      await storage.deleteResource({
        spaceId,
        collectionId,
        resourceId,
        ifMatch
      })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }

    return reply.status(204).send()
  }
}
