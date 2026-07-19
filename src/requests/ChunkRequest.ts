/**
 * Request handlers for chunk operations on a chunked Resource (the
 * `chunked-streams` feature): store, fetch, head, delete a single chunk at
 * `/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex`, and list a
 * Resource's chunks at the `chunks/` container. A chunk body is opaque bytes +
 * content-type -- the server stores it exactly like a binary Resource
 * representation and never parses it (any encryption framing is client-side),
 * so the Collection-level encryption conformance check deliberately does NOT
 * apply here: an encrypted stream's chunks are ciphertext fragments, not
 * envelope documents.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import { getCollectionOrThrow } from './collectionContext.js'
import { resolveResourceInput } from './resourceInput.js'
import { resolveBackend } from '../lib/backendRegistry.js'
import { assertValidIds } from '../lib/validateId.js'
import { parseChunkIndexSegment } from '../lib/resourceFileName.js'
import { chunkPath, chunksContainerPath } from '../lib/paths.js'
import { formatEtag, parseWritePreconditions } from '../lib/etag.js'
import {
  InvalidChunkIndexError,
  ResourceNotFoundError,
  rethrowOrWrapStorageError
} from '../errors.js'

/**
 * Parses and validates the `:chunkIndex` path param -- the canonical decimal
 * spelling of an integer in `[0, MAX_CHUNK_INDEX]` (see
 * `parseChunkIndexSegment`) -- throwing `InvalidChunkIndexError` (400)
 * otherwise. Runs before any storage access, like `assertValidIds`.
 * @param raw {string}   the `:chunkIndex` path param
 * @param options {object}
 * @param options.requestName {string}   request name used in the error title
 * @returns {number}
 */
function parseChunkIndex(
  raw: string,
  { requestName }: { requestName: string }
): number {
  const chunkIndex = parseChunkIndexSegment(raw)
  if (chunkIndex === undefined) {
    throw new InvalidChunkIndexError({ requestName })
  }
  return chunkIndex
}

/** The URL params every chunk-member route carries. */
interface ChunkParams {
  spaceId: string
  collectionId: string
  resourceId: string
  chunkIndex: string
}

export class ChunkRequest {
  /**
   * PUT /space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex
   * Request handler for "Put Chunk": stores chunk `chunkIndex` of the Resource
   * (raw bytes body, upsert). The parent Resource MUST already exist (404
   * otherwise -- chunks cannot be orphaned). Authorization is capability-only
   * against the chunk's own full URL, the same exact-match zcap target rule as
   * every other route. Supports `If-Match` / `If-None-Match` on the chunk's
   * own ETag, and the backend's `maxUploadBytes` cap (413). Returns 204 with
   * the chunk's new ETag.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async put(
    request: FastifyRequest<{ Params: ChunkParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Put Chunk'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })
    const chunkIndex = parseChunkIndex(request.params.chunkIndex, {
      requestName
    })

    // Verify (capability-only): writing a chunk requires a valid capability
    // invocation against the chunk's own URL; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: chunkPath({ spaceId, collectionId, resourceId, chunkIndex }),
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

    // Route chunk bytes to the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    const input = await resolveResourceInput(request, dataBackend)
    // Surface any `If-Match` / `If-None-Match` write precondition to the
    // storage layer, which evaluates it against the chunk's own version
    // atomically with the write (412 `precondition-failed` on a mismatch).
    let written: { version: number }
    try {
      written = await dataBackend.writeChunk({
        spaceId,
        collectionId,
        resourceId,
        chunkIndex,
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
   * GET /space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex
   * Request handler for "Get Chunk": streams the chunk's stored bytes.
   * Authorization is capability-or-policy (the same read decision as Get
   * Resource, resolved at the Resource's policy level -- a chunk reveals a
   * fragment of the same content).
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{ Params: ChunkParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Chunk'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })
    const chunkIndex = parseChunkIndex(request.params.chunkIndex, {
      requestName
    })

    // Authorize (capability-or-policy) against the chunk's own URL; the policy
    // level resolves at the parent Resource, as for Get Resource.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: chunkPath({ spaceId, collectionId, resourceId, chunkIndex }),
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
    let result
    try {
      // The parent Resource must exist (and not be a tombstone) for any of
      // its chunks to be readable: an orphan chunk left behind by
      // out-of-band state 404s here exactly like the Resource route and the
      // chunk listing do -- checked via its metadata, never its byte stream.
      const parent = await dataBackend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId
      })
      if (!parent) {
        throw new ResourceNotFoundError({ requestName })
      }
      result = await dataBackend.getChunk({
        spaceId,
        collectionId,
        resourceId,
        chunkIndex
      })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }

    const getReply = reply.status(200).type(result.storedResourceType)
    if (result.version !== undefined) {
      getReply.header('etag', formatEtag(result.version))
    }
    return getReply.send(result.resourceStream)
  }

  /**
   * HEAD /space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex
   * Request handler for "Head Chunk": the same authorization as Get Chunk with
   * no response body; `Content-Type` / `Content-Length` come from the chunk's
   * stored metadata, so the byte stream is never opened (mirrors Head
   * Resource). Registered explicitly ahead of the GET route for the same
   * reason Head Resource is.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async head(
    request: FastifyRequest<{ Params: ChunkParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Head Chunk'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })
    const chunkIndex = parseChunkIndex(request.params.chunkIndex, {
      requestName
    })

    // Authorize (capability-or-policy): the same read decision as Get Chunk,
    // against the same target (a HEAD reveals nothing a GET would not).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: chunkPath({ spaceId, collectionId, resourceId, chunkIndex }),
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

    // Read chunk metadata from the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    let metadata
    try {
      // The same parent-Resource existence gate as Get Chunk: an orphan
      // chunk's headers reveal what a GET would.
      const parent = await dataBackend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId
      })
      if (!parent) {
        throw new ResourceNotFoundError({ requestName })
      }
      metadata = await dataBackend.getChunkMetadata({
        spaceId,
        collectionId,
        resourceId,
        chunkIndex
      })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }
    if (!metadata) {
      throw new ResourceNotFoundError({ requestName })
    }

    // Set the payload headers a GET would send, but send no body.
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
   * DELETE /space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex
   * Request handler for "Delete Chunk": removes one stored chunk. Unlike
   * Delete Resource, deleting an absent chunk is a 404 (mirroring the EDV
   * chunk contract -- a reassembling reader must be able to distinguish "gone"
   * from "never written"). Authorization is capability-only against the
   * chunk's own URL. Supports `If-Match` (412 on mismatch). Returns 204.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async delete(
    request: FastifyRequest<{ Params: ChunkParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Delete Chunk'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })
    const chunkIndex = parseChunkIndex(request.params.chunkIndex, {
      requestName
    })

    // Verify (capability-only): deleting a chunk requires a valid capability
    // invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: chunkPath({ spaceId, collectionId, resourceId, chunkIndex }),
      requestName
    })

    // Fetch collection by id
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // zCap checks out, continue. An `If-Match` precondition is evaluated by
    // the storage layer atomically with the removal (412 on mismatch).
    const { ifMatch } = parseWritePreconditions(request.headers)
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    let removed: boolean
    try {
      // The same parent-Resource existence gate as the read handlers: a
      // chunk of an absent (or tombstoned) parent is a 404, not a deletable
      // orphan.
      const parent = await dataBackend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId
      })
      if (!parent) {
        throw new ResourceNotFoundError({ requestName })
      }
      removed = await dataBackend.deleteChunk({
        spaceId,
        collectionId,
        resourceId,
        chunkIndex,
        ifMatch
      })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }
    if (!removed) {
      throw new ResourceNotFoundError({ requestName })
    }

    return reply.status(204).send()
  }

  /**
   * GET /space/:spaceId/:collectionId/:resourceId/chunks/
   * Request handler for "List Chunks": the discovery/reassembly listing. The
   * server never reassembles a chunked Resource -- a reader learns the chunk
   * set here (count + per-chunk index/size/contentType/version) and fetches
   * `0..count-1` itself. Requires the parent Resource to exist (404
   * otherwise). Authorization is capability-or-policy against the `chunks/`
   * container path, resolved at the Resource's policy level.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async list(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'List Chunks'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Authorize (capability-or-policy) against the `chunks/` container path;
    // the policy level resolves at the parent Resource.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: chunksContainerPath({ spaceId, collectionId, resourceId }),
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

    // List from the Collection's selected (data-plane) backend. The parent
    // Resource must exist for its chunk listing to (an absent Resource has no
    // `chunks/` container) -- checked via its metadata, never its byte stream.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    let listing
    try {
      const parent = await dataBackend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId
      })
      if (!parent) {
        throw new ResourceNotFoundError({ requestName })
      }
      listing = await dataBackend.listChunks({
        spaceId,
        collectionId,
        resourceId
      })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }

    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify({ resourceId, ...listing }))
  }
}
