/**
 * Shared handler prelude: fetch a Space (for its controller) and authorize the
 * request against a target. Nearly every handler repeats the same shape -- load
 * the Space Description to get the controller key, build the capability's
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
import { LruCache } from '@interop/lru-memoize'
import { handleZcapVerify } from '../zcap.js'
import { authorize } from '../authorize.js'
import { spacePath } from '../lib/paths.js'
import { SpaceNotFoundError } from '../errors.js'
import {
  SPACE_DESCRIPTION_CACHE_MAX,
  SPACE_DESCRIPTION_CACHE_TTL
} from '../config.default.js'
import type { IDID, SpaceDescription, StorageBackend } from '../types.js'

/**
 * One short-TTL memoization cache per storage backend, keyed by `spaceId`. The
 * cache is scoped to the backend instance (rather than module-global) via a
 * WeakMap so two backends in one process -- e.g. parallel test suites -- never
 * serve each other's descriptions, and a cache is discarded with its backend.
 */
const descriptionCaches = new WeakMap<StorageBackend, LruCache>()

/**
 * Returns the (lazily created) Space Description cache for a backend.
 * @param storage {StorageBackend}
 * @returns {LruCache}
 */
function descriptionCacheFor(storage: StorageBackend): LruCache {
  let cache = descriptionCaches.get(storage)
  if (!cache) {
    cache = new LruCache({
      max: SPACE_DESCRIPTION_CACHE_MAX,
      ttl: SPACE_DESCRIPTION_CACHE_TTL
    })
    descriptionCaches.set(storage, cache)
  }
  return cache
}

/**
 * Drops the cached Space Description for a Space. Call after any write that
 * changes (or removes) it -- create/update/delete -- so the next read reflects
 * the new state rather than a stale cached one.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @returns {void}
 */
export function invalidateSpaceDescription({
  storage,
  spaceId
}: {
  storage: StorageBackend
  spaceId: string
}): void {
  // Only touch a cache that already exists for this backend.
  descriptionCaches.get(storage)?.delete(spaceId)
}

/**
 * Fetches a Space Description or throws SpaceNotFoundError (404) when absent.
 * Memoized per storage backend (short TTL) because this is read on every
 * authorized handler; writes invalidate via `invalidateSpaceDescription`.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<SpaceDescription>}
 */
async function getSpaceDescriptionOrThrow({
  storage,
  spaceId,
  requestName
}: {
  storage: StorageBackend
  spaceId: string
  requestName: string
}): Promise<SpaceDescription> {
  const spaceDescription = await descriptionCacheFor(storage).memoize<
    SpaceDescription | undefined
  >({
    key: spaceId,
    fn: () => storage.getSpaceDescription({ spaceId })
  })
  if (!spaceDescription) {
    throw new SpaceNotFoundError({ requestName })
  }
  return spaceDescription
}

/** The verified context every handler builds before touching storage. */
export interface VerifiedSpaceContext {
  /** the fetched Space Description (its controller authorized the request) */
  spaceDescription: SpaceDescription
  /** the did:key that controls the Space */
  spaceController: IDID
  /** the resolved invocationTarget URL the request was authorized against */
  allowedTarget: string
  /**
   * the Space's own URL -- the ancestor root target every space-family route
   * also accepts for a delegated chain that attenuates down to the request
   * URL (a Space- or Collection-scoped capability delegated by the controller)
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
 *   invocationTarget, resolved against serverUrl (e.g. `/space/${spaceId}`)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<VerifiedSpaceContext>}
 */
async function fetchSpaceContext({
  request,
  spaceId,
  targetPath,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  targetPath: string
  requestName: string
}): Promise<VerifiedSpaceContext> {
  const { serverUrl, storage } = request.server
  const spaceDescription = await getSpaceDescriptionOrThrow({
    storage,
    spaceId,
    requestName
  })
  const spaceController = spaceDescription.controller
  const allowedTarget = new URL(targetPath, serverUrl).toString()
  const spaceRootTarget = new URL(spacePath({ spaceId }), serverUrl).toString()
  return { spaceDescription, spaceController, allowedTarget, spaceRootTarget }
}

/**
 * Fetches the Space and AUTHORIZES the request **capability-or-policy**:
 * capability invocation first, then the target's effective access-control policy
 * as a fallback (see authorize.ts). Use for read/list endpoints that may be
 * public-readable. The action checked is the request's HTTP method. Returns the
 * fetched Space Description so callers that also serve it (e.g. "Read Space")
 * need not fetch it twice.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, and `request.server` for serverUrl + storage
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}   policy-resolution level
 * @param [options.resourceId] {string}   policy-resolution level
 * @param options.targetPath {string}   the relative path of the capability's
 *   invocationTarget, resolved against serverUrl (e.g. `/space/${spaceId}`)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<VerifiedSpaceContext>}
 */
export async function fetchSpaceAndAuthorize({
  request,
  spaceId,
  collectionId,
  resourceId,
  targetPath,
  requestName,
  allowTargetQuery = false
}: {
  request: FastifyRequest
  spaceId: string
  collectionId?: string
  resourceId?: string
  targetPath: string
  requestName: string
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
    requestName
  })
  await authorize({
    request,
    allowedTarget: context.allowedTarget,
    spaceId,
    collectionId,
    resourceId,
    spaceController: context.spaceController,
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
 * resource. The action checked is the request's HTTP method.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, and `request.server` for serverUrl + storage
 * @param options.spaceId {string}
 * @param options.targetPath {string}   the relative path of the capability's
 *   invocationTarget, resolved against serverUrl (e.g. `/space/${spaceId}`)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<VerifiedSpaceContext>}
 */
export async function fetchSpaceAndVerify({
  request,
  spaceId,
  targetPath,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  targetPath: string
  requestName: string
}): Promise<VerifiedSpaceContext> {
  const context = await fetchSpaceContext({
    request,
    spaceId,
    targetPath,
    requestName
  })
  const { url, method, headers } = request
  const { serverUrl } = request.server
  await handleZcapVerify({
    url,
    allowedTarget: context.allowedTarget,
    allowedAction: method,
    method,
    headers,
    serverUrl,
    spaceController: context.spaceController,
    requestName,
    logger: request.log,
    attenuatedRootTarget: context.spaceRootTarget
  })
  return context
}
