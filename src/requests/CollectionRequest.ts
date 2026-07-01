/**
 * Request handlers for Collection operations: get/update/delete a Collection,
 * list its items, and add a Resource to it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { v4 as uuidv4 } from 'uuid'

import { buildLinkset } from '../policy.js'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import { resolveResourceInput } from './resourceInput.js'
import { assertValidIds } from '../lib/validateId.js'
import type { CollectionDescription } from '../types.js'
import {
  assertSupportedBackend,
  resolveBackendDescriptor,
  DEFAULT_BACKEND_ID
} from '../lib/backends.js'
import {
  assertSupportedEncryption,
  assertEncryptionTransition,
  assertEncryptedWriteConforms
} from '../lib/encryption.js'
import { resolveBackend } from '../lib/backendRegistry.js'
import {
  collectionPath,
  resourcePath,
  linksetPath,
  backendPath,
  quotaPath,
  queryPath
} from '../lib/paths.js'
import { formatEtag } from '../lib/etag.js'
import {
  CollectionNotFoundError,
  InvalidCollectionError,
  InvalidRequestBodyError,
  StorageError,
  UnsupportedOperationError,
  rethrowOrWrapStorageError
} from '../errors.js'

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
      params: { spaceId, collectionId }
    } = request
    const { serverUrl, storage } = request.server
    const requestName = 'Create Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Verify (capability-only): creating a Resource requires a valid capability
    // invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: collectionPath({
        spaceId,
        collectionId,
        trailingSlash: true
      }),
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

    // zCap checks out, continue
    const resourceId = uuidv4()
    let response: { id: string; 'content-type'?: string; url?: string }
    let written: { version: number }

    // Route resource bytes to the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    const input = await resolveResourceInput(request, dataBackend)
    try {
      written = await dataBackend.writeResource({
        spaceId,
        collectionId,
        resourceId,
        input
      })
      response = {
        id: resourceId,
        'content-type': request.headers['content-type']
      }
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }

    const createdUrl = new URL(
      resourcePath({ spaceId, collectionId, resourceId }),
      serverUrl
    ).toString()
    reply.header('Location', createdUrl)
    // Surface the created Resource's ETag so a client can chain a conditional
    // write (the conditional-writes feature).
    reply.header('etag', formatEtag(written.version))
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
      Body: {
        id?: string
        name?: string
        backend?: unknown
        encryption?: unknown
      }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      body
    } = request
    if (!body) {
      throw new InvalidCollectionError()
    }
    const { storage } = request.server
    const requestName = 'Update Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // The Collection `id` is immutable: when the PUT body carries one, it must
    // match the `{collection_id}` in the URL (spec spells this out for Update
    // Space; applied here for parity). `invalid-request-body` (400).
    if (body.id !== undefined && body.id !== collectionId) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Collection Description "id" (${body.id}) does not match the URL Collection id (${collectionId}).`,
        pointer: '#/id'
      })
    }
    // Validate a supplied backend against the Space's backends-available (bad
    // shape 400, unknown id 409). An absent `backend` resolves to undefined here
    // so an update leaves the existing selection untouched; a create defaults it
    // to the server default below.
    const suppliedBackend =
      body.backend !== undefined
        ? await assertSupportedBackend({
            storage,
            spaceId,
            backend: body.backend,
            requestName
          })
        : undefined
    // Validate the optional encryption marker (shape only); an absent
    // `encryption` validates to `undefined` and leaves the existing marker
    // untouched. The set-once immutability transition is enforced below, after
    // the existing Collection is fetched (so an unauthorized caller cannot probe
    // encryption state).
    const suppliedEncryption = assertSupportedEncryption({
      encryption: body.encryption,
      requestName
    })

    // Verify (capability-only): updating a Collection requires a valid
    // capability invocation; no access-control-policy fallback.
    const { allowedTarget: collectionUrl } = await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: collectionPath({ spaceId, collectionId }),
      requestName
    })

    // zCap checks out, continue
    const existingCollection = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    // The encryption marker is set-once: an update may declare one on a
    // Collection that lacks it, but may not change/clear an existing one
    // (`encryption-immutable` 409). Checked here, after verification.
    if (suppliedEncryption !== undefined) {
      assertEncryptionTransition({
        existing: existingCollection?.encryption,
        incoming: suppliedEncryption
      })
    }
    // `name`, `backend`, and `encryption` are optional. On update, only
    // overwrite each when supplied (otherwise keep the existing value); on
    // create, default `name` to the Collection id and `backend` to the server
    // default (spec).
    const collectionDescription = existingCollection
      ? // Existing: Update only the allowed fields
        {
          ...existingCollection,
          id: collectionId,
          ...(body.name !== undefined && { name: body.name }),
          ...(suppliedBackend !== undefined && { backend: suppliedBackend }),
          ...(suppliedEncryption !== undefined && {
            encryption: suppliedEncryption
          })
        }
      : // New Collection
        {
          id: collectionId,
          type: ['Collection'],
          name: body.name ?? collectionId,
          backend: suppliedBackend ?? { id: DEFAULT_BACKEND_ID },
          ...(suppliedEncryption !== undefined && {
            encryption: suppliedEncryption
          })
        }

    try {
      await storage.writeCollection({
        spaceId,
        collectionId,
        collectionDescription
      })
    } catch (err) {
      request.log.error(err)
      throw new StorageError({ cause: err as Error, requestName })
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
      params: { spaceId, collectionId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // effective access-control policy as a fallback (a public-readable Collection).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: collectionPath({ spaceId, collectionId }),
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

    // Advertise the Collection's self `url` and linkset (policy discovery) on
    // the description; both relative, consistent with the other URL fields the
    // API returns.
    const url = collectionPath({ spaceId, collectionId })
    const linkset = linksetPath({ spaceId, collectionId })

    // Report the selected backend, default-filled for Collections created before
    // the `backend` property existed (spec: an unset backend is `default`).
    const backend = collectionDescription.backend ?? { id: DEFAULT_BACKEND_ID }

    return reply
      .status(200)
      .type('application/json')
      .send(
        JSON.stringify({
          ...collectionDescription,
          type: [...collectionDescription.type].sort(),
          backend,
          url,
          linkset
        } satisfies CollectionDescription)
      )
  }

  /**
   * GET /space/:spaceId/:collectionId/linkset
   * Request handler for the Collection's linkset (RFC9264): advertises the
   * Collection's access-control `policy` and selected `backend` resources for
   * discovery. Readable by whoever may read the Collection (capability or
   * fallback policy).
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async linkset(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Collection Linkset'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): readable by whoever may read the
    // Collection (capability invocation, else the effective policy).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: linksetPath({ spaceId, collectionId }),
      requestName
    })

    const linkset = await buildLinkset({ storage, spaceId, collectionId })
    return reply
      .status(200)
      .type('application/linkset+json')
      .send(JSON.stringify(linkset))
  }

  /**
   * GET /space/:spaceId/:collectionId/backend
   * Request handler for "Collection Backend Selected": returns the detailed
   * backend description object for the Collection's selected backend (resolved
   * from the Collection's stored `{ id }` against the Space's backends-available;
   * default-filled for Collections created before the property existed).
   *
   * Authorization is capability-or-policy, the same as Get Collection: the
   * selected backend is no more sensitive than the Collection description, so a
   * public-readable Collection may also read its backend.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getBackend(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Collection Backend'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): readable by whoever may read the
    // Collection (capability invocation, else the effective policy).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: backendPath({ spaceId, collectionId }),
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

    const backend = await resolveBackendDescriptor({
      storage,
      spaceId,
      collectionDescription
    })
    return reply.status(200).type('application/json').send(backend)
  }

  /**
   * GET /space/:spaceId/:collectionId/quota
   * Request handler for the per-Collection "Quotas" report (spec "Quotas"):
   * the storage report for a single Collection, scoped to its backend (a single
   * backend-usage entry whose `usageBytes` reflects only this Collection). A
   * backend that cannot account per-Collection yields `unsupported-operation`
   * (501); the filesystem backend supports it.
   *
   * Authorization is capability-or-policy, the same as the Space Quota report:
   * a caller not authorized to read it receives a 404 (maximum-privacy
   * invariant), and a public-readable Collection may read its quota.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getQuota(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Collection Quota'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): readable by whoever may read the
    // Collection (capability invocation, else the effective policy).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: quotaPath({ spaceId, collectionId }),
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

    // Report against the Collection's selected (data-plane) backend. A backend
    // that cannot account per-Collection omits `reportCollectionUsage`; the spec
    // sanctions a 501 there.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    if (!dataBackend.reportCollectionUsage) {
      throw new UnsupportedOperationError({ requestName })
    }

    const usage = await dataBackend.reportCollectionUsage({
      spaceId,
      collectionId
    })
    return reply.status(200).type('application/json').send(usage)
  }

  /**
   * POST /space/:spaceId/:collectionId/query
   * The reserved Collection `query` endpoint (spec "Collection-level reserved
   * endpoints"). This server serves a single profile, `changes` -- the
   * replication change feed: the Collection's
   * JSON documents and tombstones changed strictly after `checkpoint`, in change
   * order, capped at `limit`. The query parameters ride the signed JSON POST body
   * (covered by the `Digest`), so no `allowTargetQuery` is needed.
   *
   * A backend that does not serve the change feed (no `changesSince`), or a body
   * naming any profile other than `changes`, yields `unsupported-operation`
   * (501). Authorization is capability-or-policy, the same read semantics as List
   * Collection: an under-authorized caller receives a 404.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async query(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
      Body: {
        profile?: string
        checkpoint?: { id?: unknown; updatedAt?: unknown }
        limit?: unknown
      }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      body
    } = request
    const { storage } = request.server
    const requestName = 'Collection Query'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): readable by whoever may read the
    // Collection (capability invocation, else the effective policy). The signed
    // body is covered by the Digest, so the bare `/query` target authorizes it.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: queryPath({ spaceId, collectionId }),
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

    // Serve the change feed from the Collection's selected (data-plane) backend.
    // This server serves only the `changes` profile; any other (or a backend
    // without the change feed) is an unsupported operation (501).
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    if (body?.profile !== 'changes' || !dataBackend.changesSince) {
      throw new UnsupportedOperationError({ requestName })
    }

    // Parse the optional checkpoint: when present it must carry both string
    // fields (a malformed one is a client error, 400). Absent = start of feed.
    let checkpoint: { id: string; updatedAt: string } | undefined
    if (body.checkpoint !== undefined) {
      const { id, updatedAt } = body.checkpoint
      if (typeof id !== 'string' || typeof updatedAt !== 'string') {
        throw new InvalidRequestBodyError({
          requestName,
          detail: 'checkpoint must have string "id" and "updatedAt" fields.',
          pointer: '#/checkpoint'
        })
      }
      checkpoint = { id, updatedAt }
    }

    // Coerce `limit` (the requested batch size) to a positive integer, else
    // default; the backend clamps an oversized value to its own maximum.
    const DEFAULT_BATCH = 100
    const parsedLimit = Number(body.limit)
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit >= 1
        ? parsedLimit
        : DEFAULT_BATCH

    const result = await dataBackend.changesSince({
      spaceId,
      collectionId,
      ...(checkpoint !== undefined && { checkpoint }),
      limit
    })

    // Project the change feed to the wire shape: a tombstone's `deleted` becomes
    // RxDB's `_deleted`, and the document body stays under `data` (kept out of
    // the user JSON so arbitrary bodies -- not only objects -- round-trip). The
    // user-writable `custom` (the opaque encryption envelope on an encrypted
    // Collection) and its independent `metaVersion` ride along so a metadata-only
    // edit replicates alongside content. The RxDB browser adapter does the final
    // reshape into RxDB documents.
    const documents = result.documents.map(doc => ({
      id: doc.resourceId,
      _deleted: doc.deleted,
      updatedAt: doc.updatedAt,
      version: doc.version,
      ...(doc.metaVersion !== undefined && { metaVersion: doc.metaVersion }),
      ...(doc.data !== undefined && { data: doc.data }),
      ...(doc.custom !== undefined && { custom: doc.custom })
    }))

    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify({ documents, checkpoint: result.checkpoint }))
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
      params: { spaceId, collectionId }
    } = request
    const { storage } = request.server
    const requestName = 'Delete Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Verify (capability-only): deleting a Collection requires a valid
    // capability invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: collectionPath({ spaceId, collectionId }),
      requestName
    })

    try {
      await storage.deleteCollection({ spaceId, collectionId })
    } catch (err) {
      request.log.error(err)
      throw new StorageError({ cause: err as Error, requestName })
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
      Querystring: { limit?: string; cursor?: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      query: { limit, cursor }
    } = request
    const { storage } = request.server
    const requestName = 'List Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // effective access-control policy as a fallback (a public-readable Collection).
    // `allowTargetQuery` lets the signed-request path tolerate the `?limit`/
    // `cursor` pagination query parameters: per the spec they select a page
    // within an already-authorized target and do not change the capability
    // target. Authorization still runs before any cursor validation below, so an
    // under-authorized caller gets the merged 404 -- never an `invalid-cursor`.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: collectionPath({
        spaceId,
        collectionId,
        trailingSlash: true
      }),
      requestName,
      allowTargetQuery: true
    })

    // Fetch collection by id
    const collectionDescription = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    if (!collectionDescription) {
      throw new CollectionNotFoundError({ requestName })
    }

    // Coerce `limit` (a query string) to a positive integer; a non-numeric or
    // `< 1` value is ignored so the backend applies its own default. `cursor` is
    // opaque and passed through verbatim -- the backend validates it and rejects
    // a malformed one with `invalid-cursor` (400).
    // List from the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })
    const parsedLimit = limit !== undefined ? Number(limit) : NaN
    const collectionItems = await dataBackend.listCollectionItems({
      spaceId,
      collectionId,
      ...(Number.isFinite(parsedLimit) && parsedLimit >= 1
        ? { limit: parsedLimit }
        : {}),
      ...(cursor !== undefined && { cursor })
    })

    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify(collectionItems))
  }
}
