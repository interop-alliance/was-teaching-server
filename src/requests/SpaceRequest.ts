/**
 * Request handlers for Space operations: read/write the Space Metadata object
 * (at the reserved `meta` sub-resource), delete the Space, add a Collection to
 * it, list its Collections, and export/import it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { v4 as uuidv4 } from 'uuid'
import { handleZcapVerify } from '../zcap.js'
import { SPACE_METADATA_WRITE_ATTEMPTS } from '../config.default.js'
import { buildLinkset } from '../policy.js'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import { invalidateSpaceMetadata } from '../lib/spaceMetadataCache.js'
import { invalidateSpacePolicies } from '../lib/policyCache.js'
import {
  assertBodyController,
  verifyBodyControllerConsent
} from './controllerConsent.js'
import { invokerDid } from '../auth-header-hooks.js'
import { consultProvisioningPolicy } from '../provisioning.js'
import { assertValidIds, assertValidId } from '../lib/validateId.js'
import {
  composeCollectionMetadata,
  parseCollectionMetadataBody
} from './collectionInput.js'
import {
  assertValidController,
  assertValidSpaceController,
  isSelfHostedWebvhController
} from '../lib/validateDid.js'
import {
  forgetDeletedWebvhLocation,
  invalidateResolvedWebvhDid,
  resolveWebvhController
} from '../lib/webvhController.js'
import {
  assertValidSpaceType,
  defaultSpaceType,
  spaceTypeChangeProblem
} from '../lib/spaceType.js'
import { listRegisteredBackends } from '../lib/backends.js'
import { projectSpaceMetadata } from '../lib/spaceProjection.js'
import { buildServiceDescription } from '../serviceDescription.js'
import {
  metadataEtagOf,
  formatEtag,
  parseWritePreconditions,
  stripMetadataValidator
} from '../lib/etag.js'
import { notModifiedReply } from './notModified.js'
import {
  spacePath,
  spaceMetaPath,
  collectionPath,
  exportPath,
  importPath,
  linksetPath,
  backendsPath,
  quotasPath
} from '../lib/paths.js'
import { parsePageParams } from '../lib/pagination.js'
import {
  ProblemError,
  InvalidImportError,
  InvalidRequestBodyError,
  IdConflictError,
  PreconditionFailedError,
  SpaceControllerMismatchError,
  UnresolvableControllerError,
  SpaceNotFoundError,
  ServiceUnavailableError,
  StaleSpaceMetadataError
} from '../errors.js'
import type { EtagValidator, HeldValidators } from '../lib/etag.js'
import type {
  IDID,
  CollectionsList,
  SpaceMetadata,
  SpaceQuotaReport,
  StoredSpaceMetadata
} from '../types.js'

/**
 * The Update Space request (`PUT /space/:spaceId/meta`), shared by its handler
 * and the authorize-and-write step it may run twice.
 */
type PutSpaceMetaRequest = FastifyRequest<{
  Params: { spaceId: string }
  Body: { id?: string; name?: string; type?: unknown; controller: IDID }
}>

export class SpaceRequest {
  /**
   * GET /space/:spaceId/meta
   * Request handler for "Read Space" request: the Space Metadata object, the
   * "about it" document of the Space container (spec "Space Metadata Data
   * Model"). Authorization is capability-or-policy against the `meta` URL; a
   * capability on the Space container covers it too.
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * Example Space Metadata object:
   * {
   *   "id": "6b5be748-5f39-4936-a895-409e393c399c",
   *   "type": ["Space"],
   *   "name": "Alice's space",
   *   "controller": "did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJNdVW",
   *   "url": "/space/6b5be748-5f39-4936-a895-409e393c399c/",
   *   "linkset": "/space/6b5be748-5f39-4936-a895-409e393c399c/linkset"
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getMeta(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const requestName = 'Read Space'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // The object served (and the validator the 304 decision below is
    // made on) is read from storage directly, not from the short-TTL
    // per-process cache the authorization prelude would use: with several
    // server instances over one backend, another instance's write invalidates
    // only its own cache, and a 304 affirms that the client's copy is
    // current, so it must be decided on the stored state. The same read
    // supplies the prelude its controller, so the Space is read once.
    const spaceMetadata = await request.server.storage.getSpaceMetadata({
      spaceId
    })
    if (!spaceMetadata) {
      throw new SpaceNotFoundError({ requestName })
    }
    // Authorize (capability-or-policy): capability invocation first, then the
    // Space's access-control policy as a fallback (a public-readable Space).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: spaceMetaPath({ spaceId }),
      requestName,
      spaceMetadata
    })

    // `metaGeneration` / `metaVersion` are the out-of-band `ETag` validator,
    // not part of the wire body: strip them and emit the `ETag` header
    // instead. A legacy Space written before versioning reports none.
    const storedMetadata = stripMetadataValidator(spaceMetadata)
    const metaEtag = metadataEtagOf(spaceMetadata)
    // A conditional read (`If-None-Match` covering the current validator) is
    // answered 304 with no body, after authorization so an under-authorized
    // read still got the 404 mask above.
    const notModified = notModifiedReply({ request, reply, etag: metaEtag })
    if (notModified) {
      return notModified
    }

    // authorized, continue. The served object is the shared projection: the
    // Space's self `url` (the canonical trailing-slash container form), its
    // linkset (policy discovery) and its backends-available listing, stamped
    // by `projectSpaceMetadata` so every path that materializes the object
    // agrees.
    const getReply = reply.status(200)
    if (metaEtag !== undefined) {
      getReply.header('etag', metaEtag)
    }
    return getReply.send(
      await projectSpaceMetadata({
        storage: request.server.storage,
        spaceId,
        spaceMetadata: storedMetadata
      })
    )
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

    // Authorize (capability-or-policy): readable by whoever may read the Space.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: linksetPath({ spaceId }),
      requestName
    })

    const linkset = await buildLinkset({ storage, serverUrl, spaceId })
    return reply
      .status(200)
      .type('application/linkset+json')
      .send(JSON.stringify(linkset))
  }

  /**
   * PUT /space/:spaceId/meta
   * Request handler for "Update (or Create by Id) Space" request: a full
   * replacement of the Space Metadata object that creates the Space when none
   * exists under the id (201, `Location` naming the Space container) and
   * updates it otherwise (204). The read-only `url`, `linkset` and `createdBy`
   * are ignored in the body. Authorization is capability-only against the
   * `meta` URL; a capability on the Space container covers it too.
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
    request: PutSpaceMetaRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId },
      body
    } = request
    const { serverUrl, storage } = request.server

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName: 'Update Space' })

    // The Space `id` is immutable: when the PUT body carries one, it must match
    // the `{space_id}` in the URL (spec: Update Space `invalid-request-body`).
    if (body?.id !== undefined && body.id !== spaceId) {
      throw new InvalidRequestBodyError({
        requestName: 'Update Space',
        detail: `Space Metadata "id" (${body.id}) does not match the URL Space id (${spaceId}).`,
        pointer: '#/id'
      })
    }

    // The Space Metadata body must carry a controller DID.
    assertBodyController({ body, requestName: 'Update Space' })
    // Reject a controller shape this server cannot authorize against before it
    // is stored. Update Space is the one call site that also accepts a
    // self-hosted `did:webvh` (the "promotion by ordering" flow), and only on
    // its update branch; its create branch, Create Space, and the keystore
    // routes stay `did:key`-only.
    assertValidSpaceController(body.controller, {
      serverUrl,
      requestName: 'Update Space'
    })
    // The OPTIONAL `type` array subtypes `Space`. Shape-checked here; whether
    // it may be applied is decided after authorization (it is immutable once
    // the Space exists).
    const requestedType = assertValidSpaceType(body.type, {
      requestName: 'Update Space'
    })

    const metaUrl = new URL(spaceMetaPath({ spaceId }), serverUrl).toString()
    const spaceUrl = new URL(
      spacePath({ spaceId, trailingSlash: true }),
      serverUrl
    ).toString()
    const { ifMatch, ifNoneMatch } = parseWritePreconditions(request.headers)

    // Check to see if space already exists (if yes, this will be an Update).
    // A Space that changes before the write is re-read and re-authorized.
    let outcome: {
      written: EtagValidator
      spaceMetadata: SpaceMetadata
      created: boolean
    }
    for (let attempt = 1; ; attempt++) {
      const existingSpaceMetadata = await storage.getSpaceMetadata({ spaceId })
      try {
        outcome = await authorizeAndWriteSpaceMetadata({
          request,
          existingSpaceMetadata,
          requestedType,
          metaUrl,
          spaceUrl,
          ifMatch,
          ifNoneMatch
        })
        break
      } catch (err) {
        if (!(err instanceof StaleSpaceMetadataError)) {
          throw err
        }
        if (attempt >= SPACE_METADATA_WRITE_ATTEMPTS) {
          throw new ServiceUnavailableError({
            detail:
              'The Space Metadata object kept changing under concurrent writes; retry the request.',
            retryAfter: 1
          })
        }
      }
    }
    const { written, spaceMetadata, created } = outcome
    // Bust any cached (now-stale) object so the next read sees this write.
    invalidateSpaceMetadata({ storage, spaceId })

    // Surface the new `ETag` so a client can chain a conditional update
    // (read-modify-CAS on the Space Metadata object).
    reply.header('etag', formatEtag(written))
    if (!created) {
      return reply.status(204).send()
    }
    // Created: `Location` names the Space (its canonical container URL), not
    // the Metadata object that was written (spec "Update Space"). A Space
    // that did not exist before this write has no registered backends, so
    // the echo stamps the server's own descriptor without a read.
    reply.header('Location', spaceUrl)
    return reply.status(201).send(
      await projectSpaceMetadata({
        storage,
        spaceId,
        spaceMetadata,
        backends: [storage.describe()]
      })
    )
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
      Body: { id?: unknown }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId },
      body
    } = request
    const { serverUrl, storage } = request.server
    const requestName = 'Create Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access. The
    // body is the Collection Metadata object (spec "Create Collection"); its
    // shape is checked before authorization, on the same terms as the PUT.
    assertValidIds({ spaceId }, { requestName })
    const parsed = parseCollectionMetadataBody({ body, requestName })
    if (body.id !== undefined) {
      if (typeof body.id !== 'string') {
        throw new InvalidRequestBodyError({
          requestName,
          detail: 'The Collection Metadata "id" must be a string.',
          pointer: '#/id'
        })
      }
      assertValidId(body.id, { kind: 'collection', requestName })
    }

    // Verify (capability-only): creating a Collection requires a valid
    // capability invocation; no access-control-policy fallback. The container
    // rule does not apply here: Collection creation stays exact-target
    // delegable.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: spacePath({ spaceId, trailingSlash: true }),
      requestName
    })

    // zCap checks out, continue.
    // POST must not replace an existing Collection: spec `id-conflict` (409);
    // create-or-replace by id is PUT's job. Checked after the capability
    // verification so an unauthorized caller cannot probe Collection ids --
    // like the backend allowlist check inside `composeCollectionMetadata`.
    const collectionId = body.id !== undefined ? body.id : uuidv4()
    if (
      body.id !== undefined &&
      (await storage.getCollectionMetadata({ spaceId, collectionId }))
    ) {
      throw new IdConflictError({ kind: 'Collection' })
    }

    const collectionMetadata = await composeCollectionMetadata({
      request,
      spaceId,
      collectionId,
      parsed,
      requestName
    })

    const createdBy = invokerDid(request)
    let written
    try {
      written = await storage.writeCollection({
        spaceId,
        collectionId,
        collectionMetadata,
        createdBy,
        // Two creates racing on one client-supplied id both pass the check
        // above; the guarded write lets exactly one through, and the loser's
        // 412 is served as the spec's `id-conflict`, as for Create Space.
        ifNoneMatch: '*'
      })
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        throw new IdConflictError({ kind: 'Collection' })
      }
      throw err
    }

    // `Location` names the Collection in its canonical trailing-slash
    // (container) form.
    const createdUrl = new URL(
      collectionPath({ spaceId, collectionId, trailingSlash: true }),
      serverUrl
    ).toString()
    reply.header('Location', createdUrl)
    // Surface the new Collection Metadata `ETag` so a client can chain a
    // conditional update (the `key-epochs` conditional-Collection-write feature).
    reply.header('etag', formatEtag(written))
    // Echo what was persisted, `createdBy` and the container `url` included, so
    // the create response and a subsequent Read Collection Metadata agree. An
    // id already in use was rejected as a 409 above, so this write created the
    // Collection.
    return reply.status(201).send({
      ...collectionMetadata,
      ...(createdBy && { createdBy }),
      url: collectionPath({ spaceId, collectionId, trailingSlash: true })
    })
  }

  /**
   * DELETE /space/:spaceId/
   * Request handler for "Delete Space" request (the Space container URL, in
   * its canonical trailing-slash form)
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
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'Delete Space'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Verify (capability-only): deleting a Space requires a valid capability
    // invocation; no access-control-policy fallback.
    // The container rule: Delete Space takes a direct root invocation, or a
    // delegated capability whose invoked grant targets exactly this Space's
    // canonical URL with `allowedAction` exactly `['DELETE']`. A single-verb
    // DELETE grant is not a data grant, which is why the exception is keyed on
    // the exact action set.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: spacePath({ spaceId, trailingSlash: true }),
      requestName,
      containerRule: 'exact-delete'
    })

    // zCap checks out, continue
    try {
      await storage.deleteSpace({ spaceId })
    } finally {
      // Invalidate in `finally` because a recursive delete is not atomic: a
      // failure partway through has already removed some of what the caches
      // describe.
      // Bust the cached Metadata object so the next read sees the Space as
      // gone (404).
      invalidateSpaceMetadata({ storage, spaceId })
      // Every Collection in the Space went with it, so any controller document
      // resolved out of a history log there is stale too.
      // A log re-created in the Space afterwards starts a history of its own,
      // so its recorded heads go too.
      forgetDeletedWebvhLocation({ storage, spaceId })
      // ...and so is every policy cached at the Space level or under any of
      // its Collections/Resources.
      invalidateSpacePolicies({ storage, spaceId })
    }

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
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'Export Space'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Verify (capability-only): exporting a Space requires a valid capability
    // invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: exportPath({ spaceId }),
      requestName
    })

    // zCap checks out, continue
    // The archive carries this server's Service Description verbatim, so an
    // importer can read which specification versions and feature set the
    // contents were written under. An app composed without a `serverUrl` has
    // no absolute URL to build one from, and exports without it.
    const { serverUrl, discloseVersion } = request.server
    const service =
      serverUrl === undefined
        ? undefined
        : buildServiceDescription({ serverUrl, discloseVersion })
    const tarFile = await storage.exportSpace({ spaceId, service })

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
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'Import Space'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Verify (capability-only): importing into a Space requires a valid
    // capability invocation; no access-control-policy fallback. Whether the
    // verified invocation was of the Space's root capability (which only the
    // Space's controller can sign) rather than a delegated chain decides one
    // thing: whether the archived Space Metadata object's user-writable
    // members are restored or skipped. It is read off the verification result
    // itself, not off the header's serialization.
    const { rootInvocation } = await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: importPath({ spaceId }),
      requestName
    })

    try {
      const summary = await storage.importSpace({
        spaceId,
        tarStream: request.body,
        // A delegated chain reaches the import route by attenuation, and
        // rewriting the Space's own description is the controller's.
        restoreSpaceMetadata: rootInvocation
      })
      return reply.status(200).send(summary)
    } catch (err) {
      // Archive-validation failures already surface as typed ProblemErrors
      // (e.g. InvalidImportError from the manifest checks, or an invalid-id
      // error from a malformed archive id) -- let those through unchanged,
      // preserving their status code and message. Anything else is an
      // unexpected failure decoding the upload: wrap it as a generic
      // invalid-import 400, keeping the original as the `cause`.
      if (err instanceof ProblemError) {
        throw err
      }
      throw new InvalidImportError({ cause: err as Error })
    } finally {
      // An import may add or replace the contents of any Collection in the
      // Space, so drop any controller document resolved from a history log
      // there. Done in `finally` because an import is not atomic: a failure
      // partway through has already written earlier entries.
      invalidateResolvedWebvhDid({ storage, spaceId })
      // An import can also add, replace, or fill in a policy at any level
      // (Space, Collection, or Resource); drop every policy cached under this
      // Space rather than tracking which levels it touched.
      invalidateSpacePolicies({ storage, spaceId })
      // A root-invoked import restores the Space Metadata object's `type` and
      // `name`, so the cached object is stale too.
      invalidateSpaceMetadata({ storage, spaceId })
    }
  }

  /**
   * GET /space/:spaceId/
   * Request handler for "List Collections" request -- a `GET` of the Space
   * container lists its members (spec "Reading This Document"). OPTIONALLY
   * cursor-paginated
   * (spec "Pagination"): `?limit`/`cursor` select a page of the Space's
   * Collections, and the response carries a `next` continuation link when a
   * further page may follow. Each listed Collection carries a `public` flag
   * (true iff a `PublicCanRead` policy is attached), so a client need not
   * probe each Collection's policy resource separately.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async listCollections(
    request: FastifyRequest<{
      Params: { spaceId: string }
      Querystring: Record<string, string | string[] | undefined>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { limit, cursor } = parsePageParams({ query: request.query })
    const { storage } = request.server
    const requestName = 'List Collections'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // Space's access-control policy as a fallback (a public-readable Space).
    // `allowTargetQuery` lets the signed-request path tolerate the `?limit`/
    // `cursor` pagination query parameters: per the spec they select a page
    // within an already-authorized target and do not change the capability
    // target. Authorization still runs before any cursor validation in the
    // backend, so an under-authorized caller gets the merged 404 -- never an
    // `invalid-cursor`.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: spacePath({ spaceId, trailingSlash: true }),
      requestName,
      allowTargetQuery: true
    })

    const collections = await storage.listCollections({
      spaceId,
      ...(limit !== undefined && { limit }),
      ...(cursor !== undefined && { cursor })
    })
    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify(collections satisfies CollectionsList))
  }

  /**
   * GET /space/:spaceId/backends
   * Request handler for the "Space Backends Available" request: the list of
   * storage backends registered for the Space. This reference server ships a
   * single server-configured backend (registered as `default`), so the list has
   * one entry, derived from the active backend's own `describe()`.
   *
   * Authorization is capability-or-policy, the same as List Collections: the
   * backends list is no more sensitive than the Space Metadata object, so a
   * public-readable Space may also list its backends.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async listBackends(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'List Backends'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // Space's access-control policy as a fallback (a public-readable Space).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: backendsPath({ spaceId }),
      requestName
    })

    return reply
      .status(200)
      .type('application/json')
      .send(await listRegisteredBackends({ storage, spaceId }))
  }

  /**
   * GET /space/:spaceId/quotas
   * Request handler for the "Quotas" request: the Space's storage report,
   * grouped by backend (spec "Quotas"). This reference server ships a single
   * server-configured backend, so the `backends` array has one entry, measured
   * from the active backend's `reportUsage()`.
   *
   * The per-Collection `usageByCollection` breakdown is opt-in via the spec's
   * `?include=collections` query parameter (omitted otherwise, to keep the
   * hot-path payload lean). Reading that query string on a capability-signed
   * request requires `allowTargetQuery` on the authorization call -- the spec's
   * "Quotas" / "Pagination parameters and authorization" rule that a query
   * parameter selecting a representation does not change the target a capability
   * must match (see `verifyZcap`).
   *
   * Authorization is capability-or-policy, the same as List Collections and the
   * backends list: a caller not authorized to read the report receives a 404
   * (the spec's maximum-privacy invariant), and a public-readable Space may read
   * its quota report. Authorization runs before the query is consulted.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async quotas(
    request: FastifyRequest<{
      Params: { spaceId: string }
      Querystring: { include?: string | string[] }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId },
      query: { include }
    } = request
    const { storage } = request.server
    const requestName = 'Get Quotas'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // Space's access-control policy as a fallback (a public-readable Space).
    // `allowTargetQuery` lets the signed-request path tolerate the
    // `?include=collections` query parameter without it changing the capability
    // target.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      targetPath: quotasPath({ spaceId }),
      requestName,
      allowTargetQuery: true
    })

    // The per-Collection breakdown is opt-in via `?include=collections` (spec
    // "Quotas"); `include` is a comma-separated list of optional sections. A
    // repeated `?include=` makes Fastify's default parser yield a string array,
    // so normalize to an array first -- calling `.split` on the array would 500
    // (unauthenticated-reachable on a public-readable Space).
    const includeValues = Array.isArray(include)
      ? include
      : include !== undefined
        ? [include]
        : []
    const includeCollections = includeValues
      .flatMap(value => value.split(','))
      .map(section => section.trim())
      .includes('collections')

    const usage = await storage.reportUsage({ spaceId, includeCollections })

    return reply
      .status(200)
      .type('application/json')
      .send({
        respondedAt: new Date().toISOString(),
        backends: [usage]
      } satisfies SpaceQuotaReport)
  }
}

/**
 * One attempt at Update Space's authorize-and-write, on the branch the
 * pre-read `existingSpaceMetadata` selects. An existing Space is authorized
 * against its stored controller; an absent one against the body's own
 * controller (`verifyBodyControllerConsent`). The write is pinned to the
 * pre-read: if the object re-read under the backend's lock is not the one
 * authorized against, it throws `StaleSpaceMetadataError` and writes nothing,
 * so a concurrent writer's Space is never replaced under an authorization
 * checked against another.
 * @param options {object}
 * @param options.request {PutSpaceMetaRequest}
 * @param [options.existingSpaceMetadata] {StoredSpaceMetadata}   the Space as
 *   read before authorization, `undefined` when absent
 * @param [options.requestedType] {string[]}   the body's shape-checked `type`
 * @param options.metaUrl {string}   the Space Metadata URL, the capability target
 * @param options.spaceUrl {string}   the Space's canonical container URL
 * @param [options.ifMatch] {string}   the client's `If-Match`
 * @param [options.ifNoneMatch] {HeldValidators}   the client's `If-None-Match`
 * @returns {Promise<{ written: EtagValidator, spaceMetadata: SpaceMetadata, created: boolean }>}
 *   the new validator, the object handed to storage, and whether the write
 *   created the Space
 */
async function authorizeAndWriteSpaceMetadata({
  request,
  existingSpaceMetadata,
  requestedType,
  metaUrl,
  spaceUrl,
  ifMatch,
  ifNoneMatch
}: {
  request: PutSpaceMetaRequest
  existingSpaceMetadata?: StoredSpaceMetadata
  requestedType?: string[]
  metaUrl: string
  spaceUrl: string
  ifMatch?: string
  ifNoneMatch?: HeldValidators
}): Promise<{
  written: EtagValidator
  spaceMetadata: SpaceMetadata
  created: boolean
}> {
  const {
    params: { spaceId },
    url,
    method,
    headers,
    body
  } = request
  const { serverUrl, storage } = request.server

  // Perform zCap signature verification (throws appropriate errors). The
  // capability target is the `meta` URL; the Space's root capability (its
  // canonical container URL) is accepted as the root of a delegated chain
  // attenuating down to it, as on every space-family route.
  //
  // Important. For existing Spaces, the request must carry authorization
  // matching the *stored* controller (the body's controller is just the
  // proposed new value). On create there is no stored controller yet, so --
  // as with Create Space via POST -- the invocation must be authorized by
  // the *body's* controller: signed directly by it, or via a delegation
  // chain rooted in it (see `verifyBodyControllerConsent`).
  if (existingSpaceMetadata) {
    if (request.provisioningAuthorized) {
      // The provisioning gate saw no Space and vouched for a create, but one
      // appeared before this read. The request carries no capability
      // invocation to authorize an update with, so it is refused like any
      // other unauthorized write to an existing Space.
      throw new SpaceNotFoundError({ requestName: 'Update Space' })
    }
    await handleZcapVerify({
      url,
      allowedTarget: metaUrl,
      allowedAction: 'PUT',
      method,
      headers,
      serverUrl,
      spaceController: existingSpaceMetadata.controller,
      webvh: { storage, serverUrl },
      logger: request.log,
      attenuatedRootTarget: spaceUrl,
      revocation: { storage, scope: { spaceId } },
      // The container rule: Update Space Metadata on an existing Space is
      // controller-only. A delegated capability is refused whatever its
      // `allowedAction`, because a Space-subtree data grant would otherwise
      // reach the controller rewrite by ordinary attenuation.
      containerRule: 'controller-only'
    })
  } else {
    // Creation stays `did:key`-only, as on Create Space: the `did:webvh`
    // shape the pre-check above admits is a controller a Space may be
    // updated to, not one it may be created with.
    assertValidController(body.controller, { requestName: 'Update Space' })
    // The gate decided from its own earlier read of the Space. If it saw one
    // that has since been deleted, it let this request through as an update
    // without consulting the provisioning policy, so consult it now (a no-op
    // when the gate already did).
    await consultProvisioningPolicy(request)
    // Skipped when the provisioning policy already vouched for the create
    // (e.g. a valid onboarding token), as on Create Space via POST.
    if (!request.provisioningAuthorized) {
      await verifyBodyControllerConsent({
        request,
        controller: body.controller,
        allowedTarget: metaUrl,
        allowedAction: 'PUT',
        // The Space container URL's root capability is accepted as the base
        // of a delegated chain here too, as on the update branch above: a
        // delegated-provisioning grant is minted on the container, and
        // without this it could update an existing Space's Metadata object
        // but not create one by `PUT`.
        attenuatedRootTarget: spaceUrl,
        MismatchError: SpaceControllerMismatchError
      })
    }
  }

  // A proposed `did:webvh` controller must resolve -- and fully verify --
  // against its history log in this server's storage BEFORE it is stored.
  // After the promotion, both this request and writes to the Collection
  // holding that log are authorized by the very controller being named, so
  // storing an unresolvable DID (a typo, a not-yet-published log) would
  // deadlock the Space with no break-glass.
  if (isSelfHostedWebvhController(body.controller, { serverUrl })) {
    try {
      await resolveWebvhController({
        storage,
        serverUrl,
        did: body.controller
      })
    } catch (err) {
      throw new UnresolvableControllerError({
        did: body.controller,
        requestName: 'Update Space',
        cause: err as Error
      })
    }
  }

  // Compose the Space Metadata object, new or updated. `name` is optional,
  // so only include it when the request supplies one.
  const spaceMetadata = existingSpaceMetadata
    ? // Existing: update only the allowed fields. The stored object's
      // out-of-band validator is not part of the body handed to storage.
      {
        ...stripMetadataValidator(existingSpaceMetadata),
        id: spaceId,
        controller: body.controller,
        ...(body.name !== undefined && { name: body.name })
      }
    : // New Space
      {
        id: spaceId,
        type: requestedType ?? defaultSpaceType(),
        controller: body.controller,
        ...(body.name !== undefined && { name: body.name })
      }

  // A Space Metadata object's `type` is set at creation and immutable after
  // it, so a Space cannot change role under a consumer that already
  // classified it. An absent (or set-equal) `type` preserves the stored
  // value.
  const typeProblem =
    existingSpaceMetadata && requestedType
      ? spaceTypeChangeProblem({
          requested: requestedType,
          stored: existingSpaceMetadata.type
        })
      : undefined
  if (typeProblem !== undefined) {
    throw new InvalidRequestBodyError({
      requestName: 'Update Space',
      detail: typeProblem,
      pointer: '#/type'
    })
  }

  // zCap checks out, continue. The client's own preconditions are evaluated
  // as sent, atomically with the write.
  const written = await storage.writeSpace({
    spaceId,
    spaceMetadata,
    createdBy: invokerDid(request),
    ...(ifMatch !== undefined && { ifMatch }),
    ...(ifNoneMatch !== undefined && { ifNoneMatch }),
    // The authorization above holds only for the Space the pre-read saw:
    // absent on a create, or this exact validator on an update.
    assertTransition: prior => {
      if (
        (prior === undefined) !== (existingSpaceMetadata === undefined) ||
        metadataEtagOf(prior) !== metadataEtagOf(existingSpaceMetadata)
      ) {
        throw new StaleSpaceMetadataError()
      }
    }
  })
  return {
    written,
    spaceMetadata,
    created: existingSpaceMetadata === undefined
  }
}
