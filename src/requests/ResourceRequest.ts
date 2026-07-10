/**
 * Request handlers for Resource operations: create-by-id, get, and delete a
 * Resource (JSON object or binary blob).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import { getCollectionOrThrow } from './collectionContext.js'
import { resolveResourceInput } from './resourceInput.js'
import { invokerDid } from '../auth-header-hooks.js'
import { resolveBackend } from '../lib/backendRegistry.js'
import {
  assertEncryptedWriteConforms,
  assertEncryptedMetaConforms
} from '../lib/encryption.js'
import { assertValidIds } from '../lib/validateId.js'
import { resourcePath, metaPath } from '../lib/paths.js'
import { formatEtag, parseWritePreconditions } from '../lib/etag.js'
import {
  InvalidRequestBodyError,
  ResourceNotFoundError,
  rethrowOrWrapStorageError
} from '../errors.js'
import type { ResourceMetadataCustom } from '../types.js'

/**
 * Validates and extracts the user-writable `custom` object from an Update
 * Resource Metadata request body on a **plaintext** Collection. The body MUST be
 * a JSON object; any top-level property other than `custom` is ignored (so a
 * client may GET-modify-PUT the whole Metadata object). A missing `custom`
 * clears all user-writable properties (returns `{}`). Throws
 * `InvalidRequestBodyError` (400) when the body or `custom` shape is wrong.
 *
 * On an **encrypted** Collection this shape check does not apply -- `custom` is
 * the opaque encryption envelope, validated structurally by
 * {@link assertEncryptedMetaConforms} instead (a `422` on non-conformance).
 * `putMeta` branches on the Collection's `encryption` marker after authorization.
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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // Fail-closed encryption enforcement: if the Collection declares a recognized
    // `encryption` scheme, the content write MUST be a conforming envelope of it
    // (right media type + envelope shape), else `encryption-scheme-mismatch`
    // (422). Runs after auth (above) and the 404, before the body is resolved --
    // so a wrong content type is rejected without consuming the upload, and the
    // 422 is only observable by a caller already authorized to write here.
    assertEncryptedWriteConforms({
      collectionDescription,
      contentType: request.headers['content-type'],
      body: request.body
    })

    // Route resource bytes to the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    const input = await resolveResourceInput(request, dataBackend)
    // Surface any `If-Match` / `If-None-Match` write precondition to the storage
    // layer, which evaluates it atomically with the write (returning 412
    // `precondition-failed` on a mismatch -- rethrown unchanged below).
    let written: { version: number }
    try {
      written = await dataBackend.writeResource({
        spaceId,
        collectionId,
        resourceId,
        input,
        createdBy: invokerDid(request),
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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // Read the bytes from the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    const contentType = request.headers['content-type']
    let result
    try {
      result = await dataBackend.getResource({
        spaceId,
        collectionId,
        resourceId,
        contentType
      })
    } catch (err) {
      // Rethrow a typed ProblemError unchanged -- `getResource`'s
      // ResourceNotFoundError (404) for an absent resource, or a typed fault a
      // data-plane backend raises -- and wrap anything unexpected as a 500.
      rethrowOrWrapStorageError({ err, requestName })
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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // Read Metadata from the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    let metadata
    try {
      metadata = await dataBackend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId
      })
    } catch (err) {
      // Rethrow a typed ProblemError from the data-plane backend unchanged;
      // wrap anything unexpected as a 500.
      rethrowOrWrapStorageError({ err, requestName })
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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // Read Metadata from the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    let metadata
    try {
      metadata = await dataBackend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId
      })
    } catch (err) {
      // Rethrow a typed ProblemError from the data-plane backend unchanged;
      // wrap anything unexpected as a 500.
      rethrowOrWrapStorageError({ err, requestName })
    }
    if (!metadata) {
      throw new ResourceNotFoundError({ requestName })
    }

    // `version` (content) and `metaVersion` (metadata) are out-of-band ETag
    // validators, not part of the Resource Metadata wire body, so strip both
    // before serializing. The `/meta` sub-resource carries its OWN ETag
    // (`metaVersion`, V2) so a metadata-only edit does not disturb the content
    // ETag; it is present only once metadata has been written.
    const { version: _version, metaVersion, ...metadataBody } = metadata
    const metaReply = reply.status(200).type('application/json')
    if (metaVersion !== undefined) {
      metaReply.header('etag', formatEtag(metaVersion))
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

    // Pre-auth body shape (400): the body MUST be a JSON object. The deeper
    // `custom` shape check is deferred until after authorization, where the
    // Collection's `encryption` marker decides whether `custom` is a plaintext
    // `{ name, tags }` (validated by `parseCustomMetadata`) or an opaque envelope
    // (validated structurally by `assertEncryptedMetaConforms`) -- neither is
    // knowable before reading the Collection Description, and gating the check on
    // auth keeps a 422/400 observable only to a caller authorized to write here.
    if (
      typeof request.body !== 'object' ||
      request.body === null ||
      Array.isArray(request.body)
    ) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: 'Request body must be a JSON object.'
      })
    }

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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // Branch on the Collection's encryption marker. On an encrypted Collection
    // the `custom` value MUST be a conforming envelope of the scheme (stored
    // opaquely, `422` on a plaintext/malformed value); on a plaintext Collection
    // it MUST be a well-formed `{ name, tags }` object (`400` otherwise).
    let custom: ResourceMetadataCustom | Record<string, unknown>
    if (collectionDescription.encryption?.scheme !== undefined) {
      const rawCustom = (request.body as Record<string, unknown>).custom
      assertEncryptedMetaConforms({ collectionDescription, custom: rawCustom })
      custom = rawCustom as Record<string, unknown>
    } else {
      custom = parseCustomMetadata(request.body)
    }

    // Write Metadata to the Collection's selected (data-plane) backend. An
    // `If-Match` / `If-None-Match` precondition (the `conditional-writes`
    // feature) is evaluated on the `/meta` `metaVersion` atomically with the
    // write; a mismatch surfaces as 412 `precondition-failed` (rethrown unchanged).
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    let written
    try {
      written = await dataBackend.writeResourceMetadata({
        spaceId,
        collectionId,
        resourceId,
        custom,
        ...parseWritePreconditions(request.headers)
      })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }
    // A Metadata object cannot exist apart from its Resource: a PUT to the
    // `/meta` of a nonexistent Resource is a 404 (this operation does not create).
    if (!written) {
      throw new ResourceNotFoundError({ requestName })
    }

    // Return the new `/meta` ETag (`metaVersion`) so a client can chain a
    // subsequent conditional metadata write.
    return reply
      .status(204)
      .header('etag', formatEtag(written.metaVersion))
      .send()
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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // zCap checks out, continue. An `If-Match` precondition is evaluated by the
    // storage layer atomically with the removal; a mismatch surfaces as 412
    // `precondition-failed` (rethrown unchanged below).
    const { ifMatch } = parseWritePreconditions(request.headers)
    // Delete from the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    try {
      await dataBackend.deleteResource({
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
