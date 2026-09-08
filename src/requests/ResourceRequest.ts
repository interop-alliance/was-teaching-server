/**
 * Request handlers for Resource operations: create-by-id, get, and delete a
 * Resource (JSON object or binary blob).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import {
  fetchCollectionAndBackend,
  getCollectionOrThrow,
  getResourceMetadataOrThrow
} from './collectionContext.js'
import { resolveResourceInput } from './resourceInput.js'
import { invokerDid } from '../auth-header-hooks.js'
import { resolveBackend } from '../lib/backendRegistry.js'
import { assertEncryptedWriteConforms } from '../lib/encryption.js'
import { assertValidIds } from '../lib/validateId.js'
import { resolveMetadataCustom } from '../lib/customMetadata.js'
import { assertJsonObjectBody } from '../lib/requestBody.js'
import { declaredIndexesOf, uniqueIndexesOf } from '../lib/equalityIndex.js'
import { resourcePath, metaPath } from '../lib/paths.js'
import {
  type EtagValidator,
  etagOf,
  formatEtag,
  parseWritePreconditions
} from '../lib/etag.js'
import { parseKeyEpochHeader, parseMetaEpoch } from '../lib/keyEpoch.js'
import { invalidateResolvedWebvhDid } from '../lib/webvhController.js'
import { ResourceNotFoundError, rethrowOrWrapStorageError } from '../errors.js'
import { notModifiedBeforeStream, notModifiedReply } from './notModified.js'

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
      request,
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
    // A content write into an encrypted Collection MAY declare the key epoch it
    // encrypted under via the `Key-Epoch` header (the `key-epochs` feature);
    // the server stores it opaquely and clears it when absent (the new
    // ciphertext's epoch is unknown -- a stale stamp is worse than none).
    // Advisory, non-signature-covered metadata.
    const { epoch } = parseKeyEpochHeader({
      headers: request.headers,
      requestName
    })
    // Any `unique: true` index entries the Collection declares ride along, so
    // the backend enforces the uniqueness claim atomically with the write (409).
    const uniqueIndexes = uniqueIndexesOf({
      indexes: declaredIndexesOf({ collectionDescription })
    })
    // Surface any `If-Match` / `If-None-Match` write precondition to the storage
    // layer, which evaluates it atomically with the write (returning 412
    // `precondition-failed` on a mismatch -- rethrown unchanged below).
    let written: EtagValidator
    try {
      written = await dataBackend.writeResource({
        spaceId,
        collectionId,
        resourceId,
        input,
        createdBy: invokerDid(request),
        epoch,
        ...(uniqueIndexes.length > 0 && { uniqueIndexes }),
        ...parseWritePreconditions(request.headers)
      })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }
    // A write of `did.jsonl` into ANY Collection may replace the history log a
    // self-hosted did:webvh controller resolves from, so any document cached
    // from the previous log is stale as of this write.
    invalidateResolvedWebvhDid({ storage, spaceId, collectionId, resourceId })
    // Return the new ETag so a client can chain a subsequent conditional write.
    return reply.status(204).header('etag', formatEtag(written)).send()
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

    // Fetch collection by id, and read the bytes from the Collection's selected
    // (data-plane) backend.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // A conditional read (spec "Caching") consults the Metadata first and
    // answers 304 without opening the byte stream.
    const notModified = await notModifiedBeforeStream({
      request,
      reply,
      readMetadata: () =>
        getResourceMetadataOrThrow({
          dataBackend,
          spaceId,
          collectionId,
          resourceId,
          requestName
        })
    })
    if (notModified) {
      return notModified
    }

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
    // backend tracks one for this Resource.
    const resultEtag = etagOf(result)
    if (resultEtag !== undefined) {
      getReply.header('etag', resultEtag)
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

    // Fetch collection by id, and read Metadata from the Collection's selected
    // (data-plane) backend.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })
    const metadata = await getResourceMetadataOrThrow({
      dataBackend,
      spaceId,
      collectionId,
      resourceId,
      requestName
    })

    // A conditional read (spec "Caching"): the same 304 a GET would answer.
    const contentEtag = etagOf(metadata)
    const notModified = notModifiedReply({ request, reply, etag: contentEtag })
    if (notModified) {
      return notModified
    }

    // Set the payload headers a GET would send, but send no body. Fastify keeps
    // a manually-set `Content-Length` on a bodyless send (it is not recomputed
    // to 0).
    const headReply = reply
      .status(200)
      .type(metadata.contentType)
      .header('content-length', metadata.size)
    if (contentEtag !== undefined) {
      headReply.header('etag', contentEtag)
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

    // Fetch collection by id, and read Metadata from the Collection's selected
    // (data-plane) backend.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })
    const metadata = await getResourceMetadataOrThrow({
      dataBackend,
      spaceId,
      collectionId,
      resourceId,
      requestName
    })

    // `generation` with `version` (content) and `metaGeneration` with
    // `metaVersion` (metadata) are out-of-band ETag validators, not part of
    // the Resource Metadata wire body, so strip all four before serializing.
    // The `/meta` sub-resource carries its OWN ETag (V2) so a metadata-only
    // edit does not disturb the content ETag, and its own generation so the
    // validator dies with the metadata object on a soft delete; it is present
    // only once metadata has been written.
    const {
      generation: _generation,
      version: _version,
      metaGeneration,
      metaVersion,
      ...metadataBody
    } = metadata
    const metaEtag = etagOf({
      generation: metaGeneration,
      version: metaVersion
    })

    // A conditional read (spec "Caching") against the `/meta` ETag.
    const notModified = notModifiedReply({ request, reply, etag: metaEtag })
    if (notModified) {
      return notModified
    }

    const metaReply = reply.status(200).type('application/json')
    if (metaEtag !== undefined) {
      metaReply.header('etag', metaEtag)
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
    const requestName = 'Update Resource Metadata'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Pre-auth body shape (400): the body MUST be a JSON object. The deeper
    // `custom` shape check is deferred until after authorization, where the
    // Collection's `encryption` descriptor decides whether `custom` is a plaintext
    // `{ name, tags }` or an opaque envelope (see `resolveMetadataCustom`) --
    // neither is knowable before reading the Collection Description, and gating
    // the check on auth keeps a 422/400 observable only to a caller authorized to
    // write here.
    const body = assertJsonObjectBody({
      body: request.body,
      requestName,
      detail: 'Request body must be a JSON object.'
    })

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
      request,
      spaceId,
      collectionId,
      requestName
    })

    // Branch on the Collection's encryption descriptor. On an encrypted Collection
    // the `custom` value MUST be a conforming envelope of the scheme (stored
    // opaquely, `422` on a plaintext/malformed value); on a plaintext Collection
    // it MUST be a well-formed `{ name, tags }` object (`400` otherwise).
    const custom = resolveMetadataCustom({
      collectionDescription,
      body,
      requestName
    })

    // The key-epoch stamp (the `key-epochs` feature) MAY also be declared here
    // as a top-level `epoch` member (a sibling of `custom`). Unlike `custom`
    // (full-replace), an omitted `epoch` PRESERVES the stored value -- it
    // describes the content write, not the metadata write. A present value must
    // be a non-empty string (400).
    const { epoch } = parseMetaEpoch({ body, requestName })

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
    // Any `unique: true` index entries the Collection declares ride along, so
    // the backend enforces the uniqueness claim for custom-sourced attributes
    // atomically with this metadata write (409).
    const uniqueIndexes = uniqueIndexesOf({
      indexes: declaredIndexesOf({ collectionDescription })
    })
    let written
    try {
      written = await dataBackend.writeResourceMetadata({
        spaceId,
        collectionId,
        resourceId,
        custom,
        epoch,
        ...(uniqueIndexes.length > 0 && { uniqueIndexes }),
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

    // Return the new `/meta` ETag so a client can chain a subsequent
    // conditional metadata write.
    return reply.status(204).header('etag', formatEtag(written)).send()
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

    // Fetch collection by id, and delete from the Collection's selected
    // (data-plane) backend.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // zCap checks out, continue. An `If-Match` precondition is evaluated by the
    // storage layer atomically with the removal; a mismatch surfaces as 412
    // `precondition-failed` (rethrown unchanged below).
    const { ifMatch } = parseWritePreconditions(request.headers)
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
    // Removing a `did.jsonl` history log, from ANY Collection, makes a
    // self-hosted did:webvh controller unresolvable; drop any document still
    // cached from it.
    invalidateResolvedWebvhDid({ storage, spaceId, collectionId, resourceId })

    return reply.status(204).send()
  }
}
