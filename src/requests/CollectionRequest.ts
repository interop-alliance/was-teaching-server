/**
 * Request handlers for Collection operations: read/write the Collection
 * Metadata object (at the reserved `meta` sub-resource), delete a Collection,
 * list its items, add a Resource to it, and serve its query, quota, backend
 * and history-log sub-resources.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import type { ChangeDocument } from '@interop/storage-core'

import { buildLinkset } from '../policy.js'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import {
  fetchCollectionAndBackend,
  getCollectionOrThrow,
  governedEncryptionOf
} from './collectionContext.js'
import { resolveResourceInput } from './resourceInput.js'
import {
  assertCollectionMetadataTransition,
  composeCollectionMetadata,
  parseCollectionMetadataBody
} from './collectionInput.js'
import { invokerDid } from '../auth-header-hooks.js'
import { assertValidIds } from '../lib/validateId.js'
import { readTextBody } from '../lib/requestBody.js'
import {
  LOG_CONTENT_TYPE,
  assertGoverningLogAppend
} from '../lib/governedLog.js'
import type { CollectionMetadata, StorageBackend } from '../types.js'
import { parseBlindedIndexQueryBody } from '../lib/blindedIndex.js'
import {
  declaredIndexesOf,
  parseEqualityQueryBody,
  parseListFilter,
  uniqueIndexesOf
} from '../lib/equalityIndex.js'
import {
  resolveBackendDescriptor,
  DEFAULT_BACKEND_ID
} from '../lib/backends.js'
import { assertEncryptedWriteConforms } from '../lib/encryption.js'
import { parseKeyEpochHeader } from '../lib/keyEpoch.js'
import { parsePageParams } from '../lib/pagination.js'
import { resolveBackend } from '../lib/backendRegistry.js'
import { invalidateResolvedWebvhDid } from '../lib/webvhController.js'
import { invalidateCollectionPolicies } from '../lib/policyCache.js'
import {
  collectionPath,
  resourcePath,
  linksetPath,
  backendPath,
  collectionMetaPath,
  collectionLogPath,
  quotaPath,
  queryPath
} from '../lib/paths.js'
import {
  type EtagValidator,
  metadataEtagOf,
  etagOf,
  formatEtag,
  parseWritePreconditions,
  stripMetadataValidator
} from '../lib/etag.js'
import {
  CollectionNotFoundError,
  EncryptionImmutableError,
  InvalidCollectionError,
  InvalidRequestBodyError,
  UnsupportedOperationError,
  UniqueAttributeConflictError,
  rethrowOrWrapStorageError
} from '../errors.js'
import type { NormalizedIndexDeclaration } from '../types.js'
import { notModifiedReply } from './notModified.js'

/**
 * The normalized `unique: true` declarations a `plaintext.indexes` update ADDS
 * -- names that are unique in the incoming declaration but were not unique
 * (declared, or declared without `unique`) in the existing one. These are the claims a
 * declare-time conflict scan must verify against already-stored Resources; an
 * unchanged or removed unique claim needs no scan (it was enforced at write
 * time).
 *
 * @param options {object}
 * @param [options.existing] {CollectionMetadata}   the Collection's stored
 *   Metadata object
 * @param options.incoming {CollectionMetadata}   the object about to be
 *   persisted
 * @returns {NormalizedIndexDeclaration[]}
 */
function newlyUniqueDeclarations({
  existing,
  incoming
}: {
  existing?: CollectionMetadata
  incoming: CollectionMetadata
}): NormalizedIndexDeclaration[] {
  const existingUnique = new Set(
    uniqueIndexesOf({
      indexes: declaredIndexesOf({ collectionMetadata: existing })
    }).map(declaration => declaration.name)
  )
  return uniqueIndexesOf({
    indexes: declaredIndexesOf({ collectionMetadata: incoming })
  }).filter(declaration => !existingUnique.has(declaration.name))
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
    const { serverUrl } = request.server
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
    const collectionMetadata = await getCollectionOrThrow({
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
      collectionMetadata,
      contentType: request.headers['content-type'],
      body: request.body
    })

    // zCap checks out, continue
    const resourceId = uuidv4()
    let response: { id: string; 'content-type'?: string; url?: string }
    let written: EtagValidator

    // Route resource bytes to the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionMetadata
    })
    const input = await resolveResourceInput(request, dataBackend)
    // A content write into an encrypted Collection MAY declare the key epoch it
    // encrypted under via the `Key-Epoch` header (the `key-epochs` feature);
    // the server stores it opaquely and clears it when absent (the new
    // ciphertext's epoch is unknown). Advisory, non-signature-covered metadata.
    const { epoch } = parseKeyEpochHeader({
      headers: request.headers,
      requestName
    })
    // Any `unique: true` index entries the Collection declares ride along, so
    // the backend enforces the uniqueness claim atomically with the write (409).
    const uniqueIndexes = uniqueIndexesOf({
      indexes: declaredIndexesOf({ collectionMetadata })
    })
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
    reply.header('etag', formatEtag(written))
    response.url = createdUrl

    return reply.status(201).send(response)
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
    const { serverUrl, storage } = request.server
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

    const linkset = await buildLinkset({
      storage,
      serverUrl,
      spaceId,
      collectionId
    })
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
   * Authorization is capability-or-policy, the same as Read Collection
   * Metadata: the selected backend is no more sensitive than the Metadata
   * object, so a public-readable Collection may also read its backend.
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
    const collectionMetadata = await getCollectionOrThrow({
      request,
      spaceId,
      collectionId,
      requestName
    })

    const backend = await resolveBackendDescriptor({
      storage,
      spaceId,
      collectionMetadata
    })
    return reply.status(200).type('application/json').send(backend)
  }

  /**
   * GET /space/:spaceId/:collectionId/meta
   * Request handler for "Read Collection Metadata": the Collection Metadata
   * object, the "about it" document of the Collection container (spec
   * "Collection Metadata Data Model") -- its configuration members (`name`,
   * `backend`, `encryption` / `plaintext`, `generator`, `generatorOrigin`)
   * beside the server-managed `createdBy`, `createdAt` and `updatedAt`, the
   * opaque `epoch` stamp and the user-writable `custom` object (omitted when
   * empty). There is no `contentType` / `size`: a Collection is a container,
   * with no stored representation to describe. One `ETag` covers the whole
   * object. On a log-governed Collection the `encryption` member is derived
   * from the log head (`getCollectionOrThrow`).
   *
   * Authorization is capability-or-policy against the `meta` URL; a capability
   * on the Collection container covers it too, and the policy level resolves
   * at the Collection, so a public-readable Collection may read its Metadata.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getMeta(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const requestName = 'Read Collection Metadata'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): the capability's `invocationTarget` is
    // the full `/meta` URL (matching the request URL), and the policy level
    // resolves at the Collection.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: collectionMetaPath({ spaceId, collectionId }),
      requestName
    })

    // authorized, continue. Metadata cannot exist apart from its Collection:
    // an absent Collection is a 404, conflated with an unauthorized read.
    const collectionMetadata = await getCollectionOrThrow({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // `metaGeneration` / `metaVersion` are the out-of-band `ETag` validator,
    // not part of the wire body: strip them and emit the `ETag` header. A
    // legacy Collection written before versioning reports none.
    const metadataBody = stripMetadataValidator(collectionMetadata)
    const metaEtag = metadataEtagOf(collectionMetadata)

    // A conditional read (spec "Caching") against the object's `ETag`.
    const notModified = notModifiedReply({ request, reply, etag: metaEtag })
    if (notModified) {
      return notModified
    }

    // Advertise the Collection's self `url` (the canonical trailing-slash
    // container form) and linkset (policy discovery); both relative,
    // consistent with the other URL fields the API returns. Report the
    // selected backend, default-filled for a Collection stored without one
    // (spec: an unset backend is `default`). `type` is served lexically sorted
    // (spec SHOULD).
    const metaReply = reply.status(200).type('application/json')
    if (metaEtag !== undefined) {
      metaReply.header('etag', metaEtag)
    }
    return metaReply.send(
      JSON.stringify({
        ...metadataBody,
        type: [...collectionMetadata.type].sort(),
        backend: collectionMetadata.backend ?? { id: DEFAULT_BACKEND_ID },
        url: collectionPath({ spaceId, collectionId, trailingSlash: true }),
        linkset: linksetPath({ spaceId, collectionId })
      } satisfies CollectionMetadata)
    )
  }

  /**
   * PUT /space/:spaceId/:collectionId/meta
   * Request handler for "Update (or Create by Id) Collection": a full
   * replacement of the Collection Metadata object that creates the Collection
   * when none exists under the id (201, `Location` naming the Collection
   * container) and reconfigures it otherwise (204). A writable member the
   * body omits is cleared, with the spec's exceptions (`plaintext` is kept,
   * the set-once `encryption` may not be dropped, the read-only members are
   * ignored); the composition rules live in `composeCollectionMetadata`. One
   * `ETag` covers the object, so `If-None-Match: *` is the guarded create and
   * `If-Match` the compare-and-swap on it. Authorization is capability-only
   * (the `PUT` action) against the `meta` URL; a capability on the Collection
   * container covers it too.
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async putMeta(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
      Body: unknown
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
    const { serverUrl, storage } = request.server
    const requestName = 'Update Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Pre-auth body shape (400). The deeper `custom` check is deferred until
    // after authorization, where the encryption descriptor in effect decides
    // whether `custom` is a plaintext `{ name, tags }` or an opaque envelope;
    // gating it on auth keeps a 422/400 observable only to a caller
    // authorized to write here.
    const parsed = parseCollectionMetadataBody({ body, requestName })
    // The Collection `id` is immutable: when the body carries one, it must
    // match the `{collection_id}` in the URL (spec spells this out for Update
    // Space; applied here for parity). `invalid-request-body` (400).
    if (parsed.body.id !== undefined && parsed.body.id !== collectionId) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Collection Metadata "id" (${String(parsed.body.id)}) does not match the URL Collection id (${collectionId}).`,
        pointer: '#/id'
      })
    }

    // Verify (capability-only): writing the object requires a valid
    // capability invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: collectionMetaPath({ spaceId, collectionId }),
      requestName
    })

    // zCap checks out, continue. The stored object is read directly (not
    // through `getCollectionOrThrow`), since the derived `encryption` of a
    // log-governed Collection must not be re-persisted; the governed
    // descriptor is resolved separately for the checks that need it.
    const [existingCollection, logEncryption] = await Promise.all([
      storage.getCollectionMetadata({ spaceId, collectionId }),
      governedEncryptionOf({ storage, serverUrl, spaceId, collectionId })
    ])
    const governedEncryption = existingCollection ? logEncryption : undefined
    const collectionMetadata = await composeCollectionMetadata({
      request,
      spaceId,
      collectionId,
      parsed,
      ...(existingCollection && {
        existing: stripMetadataValidator(existingCollection)
      }),
      governedEncryption,
      requestName
    })

    // Adding a `unique: true` claim for a name that was not unique before MUST
    // be rejected if the Collection's already-stored Resources already violate
    // it (spec "Collection Metadata Data Model"). Scan for a pre-existing
    // conflict before acknowledging the update, when the data-plane backend
    // supports the scan. Best-effort under concurrency (like the count-quota
    // checks): a Resource write racing this update could still slip a
    // conflicting value in, which the write-time uniqueness check then rejects.
    const newlyUnique = newlyUniqueDeclarations({
      existing: existingCollection,
      incoming: collectionMetadata
    })
    if (newlyUnique.length > 0) {
      const dataBackend = await resolveBackend({
        request,
        spaceId,
        collectionId,
        collectionMetadata
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

    // `If-Match` (the `conditional-writes` feature) makes the write a
    // compare-and-swap on the object's monotonic version, so two clients
    // concurrently editing it (e.g. both adding a recipient) cannot silently
    // clobber one another, and `If-None-Match: *` makes the PUT a guarded
    // create (two clients racing to provision the same Collection cannot both
    // succeed, so the loser cannot overwrite the winner's `backend`). Both
    // opt-in: an unconditional PUT still upserts. Evaluated atomically with
    // the write inside the backend; a stale validator or a present object
    // surfaces as 412 `precondition-failed` (rethrown unchanged).
    const { ifMatch, ifNoneMatch } = parseWritePreconditions(request.headers)
    const createdBy = invokerDid(request)
    let written: EtagValidator
    try {
      written = await storage.writeCollection({
        spaceId,
        collectionId,
        collectionMetadata,
        createdBy,
        ...(ifMatch !== undefined && { ifMatch }),
        ...(ifNoneMatch !== undefined && { ifNoneMatch }),
        // Re-evaluate the encryption-descriptor rails and the `plaintext` /
        // `encryption` exclusion atomically with the write, against the prior
        // the backend re-reads under its lock: the early checks ran against a
        // pre-lock read, so without this a concurrent descriptor write in
        // between could be silently clobbered (an appended epoch, or a
        // just-added `plaintext`, dropped by this full replacement) even
        // though both writers passed the checks -- the guarantees must hold
        // unconditionally, not just under `If-Match`.
        assertTransition: async prior => {
          assertCollectionMetadataTransition({
            parsed,
            existing: prior,
            governedEncryption: prior
              ? await governedEncryptionOf({
                  storage,
                  serverUrl,
                  spaceId,
                  collectionId
                })
              : undefined,
            requestName
          })
        }
      })
    } catch (err) {
      // Rethrow a typed ProblemError from the data-plane backend unchanged
      // (e.g. a 507 quota / 412 precondition) rather than flattening it to a
      // 500; wrap anything genuinely unexpected. `handleError` logs the 5xx once.
      rethrowOrWrapStorageError({ err, requestName })
    }

    // Surface the new `ETag` so a client can chain a conditional update
    // (read-modify-CAS on the object).
    reply.header('etag', formatEtag(written))
    if (existingCollection) {
      return reply.status(204).send()
    }
    // Created: `Location` names the Collection (its canonical container URL),
    // not the Metadata object that was written (spec "Update Collection").
    const collectionUrl = collectionPath({
      spaceId,
      collectionId,
      trailingSlash: true
    })
    reply.header('Location', new URL(collectionUrl, serverUrl).toString())
    // Echo what was persisted, `createdBy` and the container `url` included, so
    // the create response and a subsequent Read Collection Metadata agree.
    return reply.status(201).send({
      ...collectionMetadata,
      ...(createdBy && { createdBy }),
      url: collectionUrl
    })
  }

  /**
   * GET /space/:spaceId/:collectionId/meta/log
   * Request handler for "Get Collection History Log" (the
   * `governed-history-logs` feature): the governing log's JSON Lines body,
   * verbatim, served as `text/jsonl` with its own `ETag`. Authorization is
   * capability-or-policy at the Collection level, like `/meta`: any
   * capability whose target covers the Collection URL reads it, so a share
   * grantee or an app reads the log with the zcap it already holds. A
   * Collection with no log is a 404, conflated with an unauthorized read.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getLog(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Collection History Log'

    assertValidIds({ spaceId, collectionId }, { requestName })

    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: collectionLogPath({ spaceId, collectionId }),
      requestName
    })

    // authorized, continue

    let log
    try {
      log = await storage.getCollectionLog({ spaceId, collectionId })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }
    if (!log) {
      throw new CollectionNotFoundError({ requestName })
    }

    const etag = formatEtag(log)
    const notModified = notModifiedReply({ request, reply, etag })
    if (notModified) {
      return notModified
    }
    return reply
      .status(200)
      .type(LOG_CONTENT_TYPE)
      .header('etag', etag)
      .send(log.body)
  }

  /**
   * PUT /space/:spaceId/:collectionId/meta/log
   * Request handler for "Write Collection History Log" (the
   * `governed-history-logs` feature): the `/log` transport's guarded create
   * (`If-None-Match: *`) and compare-and-swap append (`If-Match`, the prior
   * bytes carried verbatim plus the new line), `412` on a lost race. The
   * guarded create is the declaration that makes the Collection log-governed;
   * it is refused with `encryption-immutable` (409) on a Collection whose
   * Metadata object already holds a client-written `encryption` member. Each
   * write checks the line contract (`invalid-request-body`, 400) and, against
   * the prior head, the encryption descriptor's transition checks, atomically
   * with the write. Authorization is capability-only (the `PUT` action), as
   * for `/meta`. Does NOT create a Collection. Returns 204 with the log's new
   * `ETag`.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async putLog(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
      Body: unknown
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { storage } = request.server
    const requestName = 'Write Collection History Log'

    assertValidIds({ spaceId, collectionId }, { requestName })

    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: collectionLogPath({ spaceId, collectionId }),
      requestName
    })

    // zCap checks out, continue

    // Buffered in memory, so bounded: the backend's per-upload cap when it has
    // one, else Fastify's `bodyLimit` (what a buffering parser would apply).
    const body = await readTextBody({
      request,
      maxBytes:
        storage.maxUploadBytes ?? request.server.initialConfig.bodyLimit!,
      backendId: storage.describe().id
    })

    let written
    try {
      written = await storage.writeCollectionLog({
        spaceId,
        collectionId,
        body,
        ...parseWritePreconditions(request.headers),
        assertTransition: ({ prior, collectionMetadata }) => {
          // The declaration: a log may only govern a Collection whose stored
          // Metadata object holds no client-written descriptor. Pre-release
          // there is no conversion, only re-provisioning.
          if (prior === undefined && collectionMetadata.encryption) {
            throw new EncryptionImmutableError({
              detail:
                "A history log cannot govern a Collection whose 'encryption' " +
                'descriptor was written on its Metadata object.'
            })
          }
          assertGoverningLogAppend({ body, prior: prior?.body, requestName })
        }
      })
    } catch (err) {
      rethrowOrWrapStorageError({ err, requestName })
    }
    if (!written) {
      throw new CollectionNotFoundError({ requestName })
    }

    return reply.status(204).header('etag', formatEtag(written)).send()
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

    // Fetch collection by id, and report against the Collection's selected
    // (data-plane) backend. A backend that cannot account per-Collection omits
    // `reportCollectionUsage`; the spec sanctions a 501 there.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
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
   *   declared `plaintext.indexes`, answering `{documents, hasMore, cursor?}` (each
   *   document `{id, data?, custom?}`) or `{count}`. Only plaintext Collections
   *   serve it; an encrypted Collection answers `unsupported-operation` (501).
   *
   * The query parameters ride the signed JSON POST body (covered by the
   * `Digest`), so no `allowTargetQuery` is needed. A body with no `profile`
   * member is malformed (the registry marks `profile` REQUIRED) and yields
   * `invalid-request-body` (400); a body naming any other profile, or a
   * backend without the profile's method, yields `unsupported-operation`
   * (501). Authorization is capability-or-policy, the
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

    // Fetch collection by id, and serve the query from the Collection's
    // selected (data-plane) backend.
    const { collectionMetadata, dataBackend } = await fetchCollectionAndBackend(
      {
        request,
        spaceId,
        collectionId,
        requestName
      }
    )

    // "You did not say which profile" is a malformed request (the Query
    // Profile Registry marks `profile` REQUIRED), not an unsupported feature:
    // 400, distinct from the 501 an unrecognized profile gets below.
    if (body?.profile === undefined) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: "The query body is missing the required 'profile' member.",
        pointer: '#/profile'
      })
    }

    if (body.profile === 'changes' && dataBackend.changesSince) {
      return CollectionRequest.#queryChanges({
        reply,
        dataBackend,
        spaceId,
        collectionId,
        body,
        requestName
      })
    }
    if (body.profile === 'blinded-index' && dataBackend.queryByBlindedIndex) {
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
    if (body.profile === 'equality' && dataBackend.queryByEquality) {
      // The `equality` profile applies only to plaintext Collections: an
      // encrypted Collection's documents are opaque envelopes the server cannot
      // extract attributes from, so it answers `unsupported-operation` (501).
      if (collectionMetadata.encryption !== undefined) {
        throw new UnsupportedOperationError({ requestName })
      }
      // Resolve the declared indexes off the control-plane description: an
      // undeclared/empty declaration means every named attribute fails the
      // fail-closed declared-names check (400). Parse/validate the query body
      // against it, then let the backend extract, match, and paginate.
      const indexes = declaredIndexesOf({ collectionMetadata })
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
  static async #queryChanges({
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
    // Resource. The content `etag` and `/meta` `metaEtag` -- the quoted strong
    // validators exactly as the server emits them in the `ETag` header -- ride
    // the feed too, so a replica can send `If-Match` from feed state alone
    // without a GET per Resource. The RxDB browser adapter does the final
    // reshape into RxDB documents.
    const documents: ChangeDocument[] = result.documents.map(doc => {
      const etag = etagOf({ generation: doc.generation, version: doc.version })
      const metaEtag = etagOf({
        generation: doc.metaGeneration,
        version: doc.metaVersion
      })
      return {
        id: doc.resourceId,
        _deleted: doc.deleted,
        updatedAt: doc.updatedAt,
        version: doc.version,
        ...(doc.metaVersion !== undefined && { metaVersion: doc.metaVersion }),
        ...(etag !== undefined && { etag }),
        ...(metaEtag !== undefined && { metaEtag }),
        ...(doc.createdBy !== undefined && { createdBy: doc.createdBy }),
        ...(doc.data !== undefined && { data: doc.data }),
        ...(doc.custom !== undefined && { custom: doc.custom }),
        // The client-declared key epoch (the `key-epochs` feature) rides the
        // feed so a replicating reader picks the right epoch key without a
        // `/meta` fetch.
        ...(doc.epoch !== undefined && { epoch: doc.epoch })
      }
    })

    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify({ documents, checkpoint: result.checkpoint }))
  }

  /**
   * DELETE /space/:spaceId/:collectionId/
   * Request handler for "Delete Collection" request (the Collection container
   * URL, in its canonical trailing-slash form)
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
      targetPath: collectionPath({
        spaceId,
        collectionId,
        trailingSlash: true
      }),
      requestName
    })

    try {
      await storage.deleteCollection({ spaceId, collectionId })
    } catch (err) {
      // Rethrow a typed ProblemError from the data-plane backend unchanged
      // (e.g. a 507 quota / 412 precondition) rather than flattening it to a
      // 500; wrap anything genuinely unexpected. `handleError` logs the 5xx once.
      rethrowOrWrapStorageError({ err, requestName })
    } finally {
      // Deleting a Collection drops any history log a self-hosted did:webvh
      // controller resolves from it; bust every document cached from that
      // Collection. Done in `finally` because a recursive delete is not
      // atomic: a failure partway through has already removed some entries.
      invalidateResolvedWebvhDid({ storage, spaceId, collectionId })
      // ...and every policy cached at the Collection level or under any of
      // its Resources.
      invalidateCollectionPolicies({ storage, spaceId, collectionId })
    }

    return reply.status(204).send()
  }

  /**
   * GET /space/:spaceId/:collectionId/
   * List Collection items: a `GET` of the Collection container lists its
   * members (spec "Reading This Document").
   *
   * With one or more `filter[<attr>]=<value>` query parameters this becomes the
   * anonymous-cacheable entry point over the same equality machinery as the
   * POST `equality` query profile: the filters map to a single-element `equals`
   * conjunction (string-valued equality only) and the handler answers the same
   * `{documents, hasMore, cursor?}` page. Authorization is the ordinary
   * capability-or-policy GET path (a `PublicCanRead` Collection answers a filter
   * query anonymously, so an HTTP cache can serve it); `allowTargetQuery`
   * already tolerates the query string. Every filter attribute MUST be declared
   * in the Collection's `plaintext.indexes` (fail-closed 400, which also covers
   * encrypted Collections -- they can never carry `plaintext`); the data-plane backend
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
    const { limit, cursor } = parsePageParams({ query: request.query })
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

    // Fetch collection by id, and list (or filter-query) from the Collection's
    // selected (data-plane) backend.
    const { collectionMetadata, dataBackend } = await fetchCollectionAndBackend(
      {
        request,
        spaceId,
        collectionId,
        requestName
      }
    )

    // GET equality filter: `filter[<attr>]=<value>` maps to the equality profile
    // over the same machinery. Present filters take this cacheable path; their
    // absence leaves the ordinary listing below untouched.
    const filters = parseListFilter({ query: request.query, requestName })
    if (filters !== undefined) {
      // Fail-closed declared-names check, the same rule as the POST profile:
      // every filter attribute MUST be declared in the Collection's
      // `plaintext.indexes` (an encrypted Collection has none, so a filter
      // there is always a 400).
      const indexes = declaredIndexesOf({ collectionMetadata })
      const declared = new Set(indexes.map(declaration => declaration.name))
      for (const name of Object.keys(filters)) {
        if (!declared.has(name)) {
          throw new InvalidRequestBodyError({
            requestName,
            detail: `Filter attribute "${name}" is not declared in the Collection's "plaintext.indexes".`,
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
      const result = await dataBackend.queryByEquality({
        spaceId,
        collectionId,
        indexes,
        query: { equals: [{ ...filters }] },
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor })
      })
      return reply
        .status(200)
        .type('application/json')
        .send(JSON.stringify(result))
    }

    const collectionItems = await dataBackend.listCollectionItems({
      spaceId,
      collectionId,
      // Pass the control-plane Metadata object: a data-plane (external)
      // backend does not hold it, and the listing's `name`/`type`/encryption
      // flag come from it.
      collectionMetadata,
      ...(limit !== undefined && { limit }),
      ...(cursor !== undefined && { cursor })
    })

    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify(collectionItems))
  }
}
