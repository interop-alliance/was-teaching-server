/**
 * Shared handler prelude: fetch a Space (for its controller) and authorize the
 * request against a target. Nearly every handler repeats the same shape -- load
 * the Space Metadata object to get the controller key, build the capability's
 * `invocationTarget` URL, then check authorization -- so it lives here.
 *
 * Two entry points, one per authorization model, so the call site names which it
 * uses (rather than passing a flag):
 *
 * - `fetchSpaceAndAuthorize` -- **capability-or-policy**: capability invocation
 *   first, then the target's effective access-control policy as a fallback. For
 *   read/list endpoints that may be public-readable.
 * - `fetchSpaceAndVerify` -- **capability-only**: capability invocation, no
 *   policy fallback. For write/privileged endpoints and the controller-managed
 *   policy resource.
 */
import type { FastifyRequest } from 'fastify'
import { handleZcapVerify } from '../zcap.js'
import type { ContainerRule } from '../lib/containerRule.js'
import { authorize } from '../authorize.js'
import { spacePath } from '../lib/paths.js'
import { isUrlSafeSegment } from '../lib/validateId.js'
import { getCachedSpaceMetadata } from '../lib/spaceMetadataCache.js'
import { SpaceNotFoundError } from '../errors.js'
import type { StorageBackend, StoredSpaceMetadata } from '../types.js'

/**
 * Fetches a Space Metadata object or throws SpaceNotFoundError (404) when absent.
 * Memoized per storage backend (short TTL) because this is read on every
 * authorized handler; writes invalidate via `invalidateSpaceMetadata`
 * (`lib/spaceMetadataCache.ts`).
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<StoredSpaceMetadata>}
 */
async function getSpaceMetadataOrThrow({
  storage,
  spaceId,
  requestName
}: {
  storage: StorageBackend
  spaceId: string
  requestName: string
}): Promise<StoredSpaceMetadata> {
  const spaceMetadata = await getCachedSpaceMetadata({
    storage,
    spaceId
  })
  if (!spaceMetadata) {
    throw new SpaceNotFoundError({ requestName })
  }
  return spaceMetadata
}

/**
 * Loads a Space Metadata object by its URL param, masking an unknown (or
 * non-URL-safe) id as the 404 `SpaceNotFoundError` -- the WAS
 * existence-masking convention. The verification-free half of
 * `fetchSpaceAndVerify`, for handlers that need the controller before they can
 * build their expected values (the revocation route, whose invocation verifies
 * under the dual-root rule rather than the usual single root). The Space
 * analogue of `fetchKeystore` (keystoreContext.ts).
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 * @param options.spaceId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<StoredSpaceMetadata>}
 */
export async function fetchSpace({
  request,
  spaceId,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  requestName: string
}): Promise<StoredSpaceMetadata> {
  // A non-URL-safe id cannot name a stored Space and must not reach the
  // filesystem layer: same 404 masking.
  if (!isUrlSafeSegment(spaceId)) {
    throw new SpaceNotFoundError({ requestName })
  }
  return await getSpaceMetadataOrThrow({
    storage: request.server.storage,
    spaceId,
    requestName
  })
}

/** The verified context every handler builds before touching storage. */
interface VerifiedSpaceContext {
  /** the fetched Space Metadata object (its controller authorized the request) */
  spaceMetadata: StoredSpaceMetadata
  /** the resolved invocationTarget URL the request was authorized against */
  allowedTarget: string
  /**
   * the Space's own URL, in its canonical trailing-slash (container) form --
   * the root capability target every space-family route also accepts for a
   * delegated chain that attenuates down to the request URL (a Space- or
   * Collection-scoped capability delegated by the controller). A capability
   * on the container covers its `meta` sub-resource, its members, and
   * everything beneath them (spec "Performing Authorized API Calls").
   */
  spaceRootTarget: string
}

/**
 * Loads the Space and builds the capability's invocationTarget URL -- the part
 * shared by both authorization models below. Does not check authorization.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server` for
 *   serverUrl + storage
 * @param options.spaceId {string}
 * @param options.targetPath {string}   the relative path of the capability's
 *   invocationTarget, resolved against serverUrl (e.g. `/space/${spaceId}/`)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @param [options.spaceMetadata] {StoredSpaceMetadata}   an object
 *   the caller already read from storage, so it is not read again here
 * @returns {Promise<VerifiedSpaceContext>}
 */
async function fetchSpaceContext({
  request,
  spaceId,
  targetPath,
  requestName,
  spaceMetadata
}: {
  request: FastifyRequest
  spaceId: string
  targetPath: string
  requestName: string
  spaceMetadata?: StoredSpaceMetadata
}): Promise<VerifiedSpaceContext> {
  const { serverUrl, storage } = request.server
  spaceMetadata ??= await getSpaceMetadataOrThrow({
    storage,
    spaceId,
    requestName
  })
  const allowedTarget = new URL(targetPath, serverUrl).toString()
  const spaceRootTarget = new URL(
    spacePath({ spaceId, trailingSlash: true }),
    serverUrl
  ).toString()
  return { spaceMetadata, allowedTarget, spaceRootTarget }
}

/**
 * Fetches the Space and AUTHORIZES the request **capability-or-policy**:
 * capability invocation first, then the target's effective access-control policy
 * as a fallback (see authorize.ts). Use for read/list endpoints that may be
 * public-readable. The action checked is the request's HTTP method. Returns the
 * fetched Space Metadata object so callers that also serve it (Read Space)
 * need not fetch it twice.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, and `request.server` for serverUrl + storage
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}   policy-resolution level
 * @param [options.resourceId] {string}   policy-resolution level
 * @param options.targetPath {string}   the relative path of the capability's
 *   invocationTarget, resolved against serverUrl (e.g. `/space/${spaceId}/`)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @param [options.spaceMetadata] {StoredSpaceMetadata}   an object
 *   the caller already read from storage directly (Read Space, which serves it
 *   and decides its 304 on the stored state rather than the per-process
 *   cache), so the prelude does not read it again
 * @returns {Promise<VerifiedSpaceContext>}
 */
export async function fetchSpaceAndAuthorize({
  request,
  spaceId,
  collectionId,
  resourceId,
  targetPath,
  requestName,
  spaceMetadata,
  allowTargetQuery = false
}: {
  request: FastifyRequest
  spaceId: string
  collectionId?: string
  resourceId?: string
  targetPath: string
  requestName: string
  spaceMetadata?: StoredSpaceMetadata
  /**
   * When set, the capability-invocation path tolerates query parameters on
   * the request URL that extend `targetPath` (e.g. List Collection's
   * `?limit`/`cursor`), treating them as a RESTful attenuation of the same
   * target rather than a different one. See `verifyZcap`.
   */
  allowTargetQuery?: boolean
}): Promise<VerifiedSpaceContext> {
  const context = await fetchSpaceContext({
    request,
    spaceId,
    targetPath,
    requestName,
    spaceMetadata
  })
  await authorize({
    request,
    allowedTarget: context.allowedTarget,
    spaceId,
    collectionId,
    resourceId,
    spaceController: context.spaceMetadata.controller,
    requestName,
    allowTargetQuery,
    attenuatedRootTarget: context.spaceRootTarget
  })
  return context
}

/**
 * Fetches the Space and VERIFIES the request **capability-only**: a valid
 * capability invocation is required, with no access-control-policy fallback (see
 * zcap.ts). Use for write/privileged endpoints and the controller-managed policy
 * resource. The action checked is the request's HTTP method. The Space's
 * revocation store is consulted on every delegated chain, so a revoked
 * capability fails here as it does on the `/kms` routes.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, and `request.server` for serverUrl + storage
 * @param options.spaceId {string}
 * @param options.targetPath {string}   the relative path of the capability's
 *   invocationTarget, resolved against serverUrl (e.g. `/space/${spaceId}/`)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @param [options.containerRule] {ContainerRule}   the container rule to
 *   apply, when the operation is an unsafe method at a container URL
 *   (`lib/containerRule.ts`). It is keyed on the Space's canonical
 *   trailing-slash URL, which this prelude already passes as
 *   `attenuatedRootTarget`.
 * @returns {Promise<VerifiedSpaceContext>}
 */
export async function fetchSpaceAndVerify({
  request,
  spaceId,
  targetPath,
  requestName,
  containerRule
}: {
  request: FastifyRequest
  spaceId: string
  targetPath: string
  requestName: string
  containerRule?: ContainerRule
}): Promise<VerifiedSpaceContext> {
  const context = await fetchSpaceContext({
    request,
    spaceId,
    targetPath,
    requestName
  })
  const { url, method, headers } = request
  const { serverUrl, storage } = request.server
  await handleZcapVerify({
    url,
    allowedTarget: context.allowedTarget,
    allowedAction: method,
    method,
    headers,
    serverUrl,
    spaceController: context.spaceMetadata.controller,
    webvh: { storage, serverUrl },
    requestName,
    logger: request.log,
    attenuatedRootTarget: context.spaceRootTarget,
    revocation: { storage, scope: { spaceId } },
    containerRule
  })
  return context
}
