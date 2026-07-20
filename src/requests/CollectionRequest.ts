/**
 * Request handlers for Collection operations: get/update/delete a Collection,
 * list its items, and add a Resource to it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import type { ChangeDocument } from '@interop/storage-core'

import { buildLinkset } from '../policy.js'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import { getCollectionOrThrow } from './collectionContext.js'
import { resolveResourceInput } from './resourceInput.js'
import { invokerDid } from '../auth-header-hooks.js'
import { assertValidIds } from '../lib/validateId.js'
import type { CollectionDescription, StorageBackend } from '../types.js'
import { parseBlindedIndexQueryBody } from '../lib/blindedIndex.js'
import {
  assertSupportedIndexes,
  normalizeIndexes,
  parseEqualityQueryBody,
  parseListFilter
} from '../lib/equalityIndex.js'
import {
  assertSupportedBackend,
  resolveBackendDescriptor,
  DEFAULT_BACKEND_ID
} from '../lib/backends.js'
import {
  assertSupportedEncryption,
  assertEncryptionMarkerTransition,
  assertEncryptedWriteConforms
} from '../lib/encryption.js'
import { parseKeyEpochHeader } from '../lib/keyEpoch.js'
import { resolveBackend } from '../lib/backendRegistry.js'
import {
  collectionPath,
  resourcePath,
  linksetPath,
  backendPath,
  quotaPath,
  queryPath
} from '../lib/paths.js'
import { formatEtag, parseWritePreconditions } from '../lib/etag.js'
import {
  InvalidCollectionError,
  InvalidRequestBodyError,
  UnsupportedOperationError,
  UniqueAttributeConflictError,
  rethrowOrWrapStorageError
} from '../errors.js'
import type {
  CollectionIndexDeclaration,
  NormalizedIndexDeclaration
} from '../types.js'

/**
 * The normalized `unique: true` declarations an `indexes` update ADDS -- names
 * that are unique in the incoming declaration but were not unique (declared, or
 * declared without `unique`) in the existing one. These are the claims a
 * declare-time conflict scan must verify against already-stored Resources; an
 * unchanged or removed unique claim needs no scan (it was enforced at write
 * time).
 *
 * @param options {object}
 * @param [options.existing] {Array<string | CollectionIndexDeclaration>}   the
 *   Collection's previously-stored `indexes`
 * @param [options.incoming] {Array<string | CollectionIndexDeclaration>}   the
 *   `indexes` about to be persisted
 * @returns {NormalizedIndexDeclaration[]}
 */
function newlyUniqueDeclarations({
  existing,
  incoming
}: {
  existing?: Array<string | CollectionIndexDeclaration>
  incoming?: Array<string | CollectionIndexDeclaration>
}): NormalizedIndexDeclaration[] {
  const existingUnique = new Set(
    normalizeIndexes({ indexes: existing })
      .filter(declaration => declaration.unique)
      .map(declaration => declaration.name)
  )
  return normalizeIndexes({ indexes: incoming }).filter(
    declaration => declaration.unique && !existingUnique.has(declaration.name)
  )
}

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
    // A content write into an encrypted Collection MAY declare the key epoch it
    // encrypted under via the `WAS-Key-Epoch` header (the `key-epochs` feature);
    // the server stores it opaquely and clears it when absent (the new
    // ciphertext's epoch is unknown). Advisory, non-signature-covered metadata.
    const { epoch } = parseKeyEpochHeader({
      headers: request.headers,
      requestName
    })
    // When the Collection declares any `unique: true` index entries (the
    // `equality-query` feature), pass the normalized unique entries so the
    // backend enforces the plaintext uniqueness claim atomically with the write
    // (409). Write authorization has already run, so the existence-revealing 409
    // is observable only to a caller authorized to write here.
    const uniqueIndexes = normalizeIndexes({
      indexes: collectionDescription.indexes
    }).filter(declaration => declaration.unique)
    try {
      written = await dataBackend.writeResource({
        spaceId,
        collectionId,
        resourceId,
        input,
        createdBy: invokerDid(request),
        epoch,
        ...(uniqueIndexes.length > 0 && { uniqueIndexes })
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
        indexes?: unknown
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
    // Validate the optional encryption marker (shape only); an absent
    // `encryption` validates to `undefined` and leaves the existing marker
    // untouched. The set-once immutability transition is enforced below, after
    // the existing Collection is fetched (so an unauthorized caller cannot probe
    // encryption state).
    const suppliedEncryption = assertSupportedEncryption({
      encryption: body.encryption,
      requestName
    })
    // Validate the optional `indexes` declaration (shape only); an absent
    // `indexes` validates to `undefined` and leaves the stored declaration
    // untouched, while a supplied array (an empty one clears it) replaces it --
    // `indexes` is updatable, unlike the set-once `encryption` marker. The
    // mutual-exclusion-with-encryption rail and the unique-add conflict scan are
    // enforced below, against the description about to be persisted.
    const suppliedIndexes = assertSupportedIndexes({
      indexes: body.indexes,
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

    // zCap checks out, continue.
    // Validate a supplied backend against the Space's backends-available (bad
    // shape 400, unknown id 409). Checked AFTER verification (it reads the
    // Space's registered backend ids) so an unauthorized caller cannot probe
    // which ids are registered by distinguishing a 409 from the masked 404 --
    // like the `id-conflict` / `encryption-immutable` conflict checks. An absent
    // `backend` resolves to undefined so an update leaves the existing selection
    // untouched; a create defaults it to the server default below.
    const suppliedBackend =
      body.backend !== undefined
        ? await assertSupportedBackend({
            storage,
            spaceId,
            backend: body.backend,
            requestName
          })
        : undefined

    const existingCollection = await storage.getCollectionDescription({
      spaceId,
      collectionId
    })
    // The encryption marker is set-once (an update may declare one on a
    // Collection that lacks it, but may not change/clear an existing one --
    // `encryption-immutable` 409), and the key-epoch safety rails (the
    // `key-epochs` feature) make epochs append-only with a `currentEpoch` that
    // never moves backwards; recipient churn within an epoch stays free.
    // Checked here, after verification, for a clean early rejection --
    // re-evaluated atomically with the write via `assertTransition` below.
    if (suppliedEncryption !== undefined) {
      assertEncryptionMarkerTransition({
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
          }),
          ...(suppliedIndexes !== undefined && { indexes: suppliedIndexes })
        }
      : // New Collection
        {
          id: collectionId,
          type: ['Collection'],
          name: body.name ?? collectionId,
          backend: suppliedBackend ?? { id: DEFAULT_BACKEND_ID },
          ...(suppliedEncryption !== undefined && {
            encryption: suppliedEncryption
          }),
          ...(suppliedIndexes !== undefined && { indexes: suppliedIndexes })
        }

    // Mutual exclusion (spec "Collection Data Model"): the description about to
    // be persisted MUST NOT carry both a non-empty `indexes` and an `encryption`
    // marker -- the server cannot extract plaintext attributes from an opaque
    // envelope. Enforced in BOTH directions (adding `indexes` to an encrypted
    // Collection, or `encryption` to an indexed one) against the merged
    // description, so a pre-existing value on the other field is caught too.
    if (
      Array.isArray(collectionDescription.indexes) &&
      collectionDescription.indexes.length > 0 &&
      collectionDescription.encryption !== undefined
    ) {
      throw new InvalidRequestBodyError({
        requestName,
        detail:
          'Collection "indexes" must not be combined with an "encryption" marker.',
        pointer: '#/indexes'
      })
    }

    // Adding a `unique: true` claim for a name that was not unique before MUST
    // be rejected if the Collection's already-stored Resources already violate
    // it (spec "Collection Data Model"). Scan for a pre-existing conflict before
    // acknowledging the update, when the data-plane backend supports the scan.
    // Best-effort under concurrency (like the count-quota checks): a Resource
    // write racing this update could still slip a conflicting value in, which
    // the write-time uniqueness check then rejects.
    const newlyUnique = newlyUniqueDeclarations({
      existing: existingCollection?.indexes,
      incoming: collectionDescription.indexes
    })
    if (newlyUnique.length > 0) {
      const dataBackend = await resolveBackend({
        request,
        spaceId,
        collectionId,
        collectionDescription
      })
      if (dataBackend.findEqualityUniqueViolation) {
        const violation = await dataBackend.findEqualityUniqueViolation({
          spaceId,
          collectionId,
          indexes: newlyUnique
        })
        if (violation) {
          throw new UniqueAttributeConflictError({ variant: 'equality' })
        }
      }
    }

    // `If-Match` (the `key-epochs` / conditional-Collection-write feature) makes
    // a Collection Description update a compare-and-swap on its monotonic
    // description version, so two clients concurrently editing the marker (e.g.
    // both adding a recipient) cannot silently clobber one another. Opt-in: an
    // unconditional PUT still upserts as before. Evaluated atomically with the
    // write inside the backend; a stale validator surfaces as 412
    // `precondition-failed` (rethrown unchanged).
    const { ifMatch } = parseWritePreconditions(request.headers)
    let written: { version: number }
    try {
      written = await storage.writeCollection({
        spaceId,
        collectionId,
        collectionDescription,
        createdBy: invokerDid(request),
        ...(ifMatch !== undefined && { ifMatch }),
        // Re-evaluate the encryption-marker rails atomically with the write,
        // against the prior the backend re-reads under its lock: the early
        // check above ran against a pre-lock read, so without this a
        // concurrent marker write in between could be silently clobbered (an
        // appended epoch dropped by this full replacement) even though both
        // writers passed the rails -- the append-only guarantee must hold
        // unconditionally, not just under `If-Match`.
        assertTransition: prior =>
          assertEncryptionMarkerTransition({
            existing: prior?.encryption,
            incoming: collectionDescription.encryption
          })
      })
    } catch (err) {
      // Rethrow a typed ProblemError from the data-plane backend unchanged
      // (e.g. a 507 quota / 412 precondition) rather than flattening it to a
      // 500; wrap anything genuinely unexpected. `handleError` logs the 5xx once.
      rethrowOrWrapStorageError({ err, requestName })
    }

    reply.header('Location', collectionUrl)
    // Surface the new description ETag so a client can chain a conditional
    // update (read-modify-CAS on the marker).
    reply.header('etag', formatEtag(written.version))
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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // Advertise the Collection's self `url` and linkset (policy discovery) on
    // the description; both relative, consistent with the other URL fields the
    // API returns.
    const url = collectionPath({ spaceId, collectionId })
    const linkset = linksetPath({ spaceId, collectionId })

    // Report the selected backend, default-filled for Collections created before
    // the `backend` property existed (spec: an unset backend is `default`).
    const backend = collectionDescription.backend ?? { id: DEFAULT_BACKEND_ID }

    // The description `version` is the out-of-band ETag validator, not part of
    // the Collection Description wire body, so strip it before serializing and
    // surface it as the `ETag` header (so a client can read-modify-CAS the
    // marker). Present only once the Collection has been written under
    // versioning; a legacy Collection reports none.
    const { descriptionVersion, ...descriptionBody } = collectionDescription
    const getReply = reply.status(200).type('application/json')
    if (descriptionVersion !== undefined) {
      getReply.header('etag', formatEtag(descriptionVersion))
    }
    return getReply.send(
      JSON.stringify({
        ...descriptionBody,
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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

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
   * endpoints"). This server serves two profiles, selected by the body's
   * `profile`:
   *
   * - `changes` -- the replication change feed: the Collection's JSON
   *   documents and tombstones changed strictly after `checkpoint`, in change
   *   order, capped at `limit`.
   * - `blinded-index` -- the EDV blinded-attribute query (the
   *   `blinded-index-query` backend feature): `{index, equals | has, count,
   *   limit, cursor}` evaluated against the HMAC-blinded `indexed` entries of
   *   the Collection's stored documents, answering `{documents, hasMore,
   *   cursor?}` (matching documents verbatim, opaque-cursor paginated) or
   *   `{count}`.
   * - `equality` -- the plaintext equality query (the `equality-query` backend
   *   feature): `{equals | has, count, limit, cursor}` evaluated against the
   *   attributes the server extracts from the Collection's Resources per its
   *   declared `indexes`, answering `{documents, hasMore, cursor?}` (each
   *   document `{id, data?, custom?}`) or `{count}`. Only plaintext Collections
   *   serve it; an encrypted Collection answers `unsupported-operation` (501).
   *
   * The query parameters ride the signed JSON POST body (covered by the
   * `Digest`), so no `allowTargetQuery` is needed. A body naming any other
   * profile, or a backend without the profile's method, yields
   * `unsupported-operation` (501). Authorization is capability-or-policy, the
   * same read semantics as List Collection: an under-authorized caller
   * receives a 404.
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
        index?: unknown
        equals?: unknown
        has?: unknown
        count?: unknown
        cursor?: unknown
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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // Serve the query from the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })

    if (body?.profile === 'changes' && dataBackend.changesSince) {
      return CollectionRequest._queryChanges({
        reply,
        dataBackend,
        spaceId,
        collectionId,
        body,
        requestName
      })
    }
    if (body?.profile === 'blinded-index' && dataBackend.queryByBlindedIndex) {
      // Validate/normalize the EDV query body fields (400 on a malformed
      // query), then let the backend evaluate and paginate.
      const parsed = parseBlindedIndexQueryBody({ body, requestName })
      const result = await dataBackend.queryByBlindedIndex({
        spaceId,
        collectionId,
        ...parsed
      })
      return reply
        .status(200)
        .type('application/json')
        .send(JSON.stringify(result))
    }
    if (body?.profile === 'equality' && dataBackend.queryByEquality) {
      // The `equality` profile applies only to plaintext Collections: an
      // encrypted Collection's documents are opaque envelopes the server cannot
      // extract attributes from, so it answers `unsupported-operation` (501).
      if (collectionDescription.encryption !== undefined) {
        throw new UnsupportedOperationError({ requestName })
      }
      // Resolve the declared indexes off the control-plane description: an
      // undeclared/empty declaration means every named attribute fails the
      // fail-closed declared-names check (400). Parse/validate the query body
      // against it, then let the backend extract, match, and paginate.
      const indexes = normalizeIndexes({
        indexes: collectionDescription.indexes
      })
      const parsed = parseEqualityQueryBody({ body, indexes, requestName })
      const result = await dataBackend.queryByEquality({
        spaceId,
        collectionId,
        indexes,
        ...parsed
      })
      return reply
        .status(200)
        .type('application/json')
        .send(JSON.stringify(result))
    }

    // Any other profile, or a backend without the profile's method.
    throw new UnsupportedOperationError({ requestName })
  }

  /**
   * The `changes` profile of the Collection `query` endpoint (see `query`
   * above): parses the checkpoint/limit, pulls the page from the backend's
   * change feed, and projects it to the wire shape.
   *
   * @param options {object}
   * @param options.reply {import('fastify').FastifyReply}
   * @param options.dataBackend {StorageBackend}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.body {object}   the query POST body
   * @param options.requestName {string}
   * @returns {Promise<FastifyReply>}
   */
  static async _queryChanges({
    reply,
    dataBackend,
    spaceId,
    collectionId,
    body,
    requestName
  }: {
    reply: FastifyReply
    dataBackend: StorageBackend
    spaceId: string
    collectionId: string
    body: {
      checkpoint?: { id?: unknown; updatedAt?: unknown }
      limit?: unknown
    }
    requestName: string
  }): Promise<FastifyReply> {
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

    const result = await dataBackend.changesSince!({
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
    // edit replicates alongside content, as does the server-managed `createdBy`
    // so a replica learns each Resource's creator without a `/meta` fetch per
    // Resource. The RxDB browser adapter does the final reshape into RxDB
    // documents.
    const documents: ChangeDocument[] = result.documents.map(doc => ({
      id: doc.resourceId,
      _deleted: doc.deleted,
      updatedAt: doc.updatedAt,
      version: doc.version,
      ...(doc.metaVersion !== undefined && { metaVersion: doc.metaVersion }),
      ...(doc.createdBy !== undefined && { createdBy: doc.createdBy }),
      ...(doc.data !== undefined && { data: doc.data }),
      ...(doc.custom !== undefined && { custom: doc.custom }),
      // The client-declared key epoch (the `key-epochs` feature) rides the feed
      // so a replicating reader picks the right epoch key without a `/meta` fetch.
      ...(doc.epoch !== undefined && { epoch: doc.epoch })
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
      // Rethrow a typed ProblemError from the data-plane backend unchanged
      // (e.g. a 507 quota / 412 precondition) rather than flattening it to a
      // 500; wrap anything genuinely unexpected. `handleError` logs the 5xx once.
      rethrowOrWrapStorageError({ err, requestName })
    }

    return reply.status(204).send()
  }

  /**
   * GET /space/:spaceId/:collectionId/ (with trailing slash):
   * List Collection items.
   *
   * With one or more `filter[<attr>]=<value>` query parameters this becomes the
   * anonymous-cacheable entry point over the same equality machinery as the
   * POST `equality` query profile: the filters map to a single-element `equals`
   * conjunction (string-valued equality only) and the handler answers the same
   * `{documents, hasMore, cursor?}` page. Authorization is the ordinary
   * capability-or-policy GET path (a `PublicCanRead` Collection answers a filter
   * query anonymously, so an HTTP cache can serve it); `allowTargetQuery`
   * already tolerates the query string. Every filter attribute MUST be declared
   * in the Collection's `indexes` (fail-closed 400, which also covers encrypted
   * Collections -- they can never declare `indexes`); the data-plane backend
   * MUST serve `queryByEquality` (else 501). With no `filter[...]` parameter the
   * existing listing behavior is unchanged.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async list(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
      Querystring: Record<string, string | string[] | undefined>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    // `limit` / `cursor` are single-valued pagination params; a repeated value
    // (an array) is ignored here and falls back to the backend default.
    const rawLimit = request.query.limit
    const rawCursor = request.query.cursor
    const limit = typeof rawLimit === 'string' ? rawLimit : undefined
    const cursor = typeof rawCursor === 'string' ? rawCursor : undefined
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
    const collectionDescription = await getCollectionOrThrow({
      storage,
      spaceId,
      collectionId,
      requestName
    })

    // List (or filter-query) from the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionDescription
    })

    // GET equality filter: `filter[<attr>]=<value>` maps to the equality profile
    // over the same machinery. Present filters take this cacheable path; their
    // absence leaves the ordinary listing below untouched.
    const filters = parseListFilter({ query: request.query, requestName })
    if (filters !== undefined) {
      // Fail-closed declared-names check, the same rule as the POST profile:
      // every filter attribute MUST be declared in the Collection's `indexes`
      // (an encrypted Collection has none, so a filter there is always a 400).
      const indexes = normalizeIndexes({
        indexes: collectionDescription.indexes
      })
      const declared = new Set(indexes.map(declaration => declaration.name))
      for (const name of Object.keys(filters)) {
        if (!declared.has(name)) {
          throw new InvalidRequestBodyError({
            requestName,
            detail: `Filter attribute "${name}" is not declared in the Collection's indexes.`,
            pointer: `#/filter/${name}`
          })
        }
      }
      if (!dataBackend.queryByEquality) {
        throw new UnsupportedOperationError({ requestName })
      }
      // The canonical GET semantics: a single-element `equals` conjunction over
      // string values. Reuse the already-parsed `limit` / `cursor` params and
      // answer the same page shape as the POST profile.
      const parsedFilterLimit = limit !== undefined ? Number(limit) : NaN
      const result = await dataBackend.queryByEquality({
        spaceId,
        collectionId,
        indexes,
        query: { equals: [{ ...filters }] },
        ...(Number.isFinite(parsedFilterLimit) && parsedFilterLimit >= 1
          ? { limit: parsedFilterLimit }
          : {}),
        ...(cursor !== undefined && { cursor })
      })
      return reply
        .status(200)
        .type('application/json')
        .send(JSON.stringify(result))
    }

    // Coerce `limit` (a query string) to a positive integer; a non-numeric or
    // `< 1` value is ignored so the backend applies its own default. `cursor` is
    // opaque and passed through verbatim -- the backend validates it and rejects
    // a malformed one with `invalid-cursor` (400).
    const parsedLimit = limit !== undefined ? Number(limit) : NaN
    const collectionItems = await dataBackend.listCollectionItems({
      spaceId,
      collectionId,
      // Pass the control-plane description: a data-plane (external) backend does
      // not hold it, and the listing's `name`/`type`/encryption flag come from it.
      collectionDescription,
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
