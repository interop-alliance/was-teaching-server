/**
 * The memoized access-control policy read shared by `resolveEffectivePolicy`
 * (`policy.ts`), which is on the hot path of every anonymous (policy-fallback)
 * request. One short-TTL cache per storage backend, holding all three policy
 * levels (Space / Collection / Resource) together and keyed by a composite
 * string built from `spaceId` / `collectionId` / `resourceId`; writes
 * invalidate via `invalidatePolicy` (one level) or `invalidateSpacePolicies` /
 * `invalidateCollectionPolicies` (every level under a Space or Collection, for
 * Delete Space / Delete Collection / import) so all consumers always read the
 * same state.
 */
import { LruCache } from '@interop/lru-memoize'
import { POLICY_CACHE_MAX, POLICY_CACHE_TTL } from '../config.default.js'
import type { PolicyDocument, StorageBackend } from '../types.js'
import { backendScoped, deleteByPrefix } from './backendCache.js'

/**
 * One short-TTL memoization cache per storage backend, holding entries for
 * every policy level (see `backendCache.ts` for the scoping rationale).
 */
const policyCaches = backendScoped(
  () =>
    new LruCache({
      max: POLICY_CACHE_MAX,
      ttl: POLICY_CACHE_TTL
    })
)

/**
 * Builds the cache key for one policy level. `spaceId` / `collectionId` /
 * `resourceId` are restricted to the RFC 3986 unreserved charset (see
 * `validateId.ts`), which never contains `/`, so `/` safely separates the
 * three levels and doubles as an unambiguous prefix boundary for the bulk
 * invalidators below.
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @returns {string}
 */
function policyCacheKey({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId?: string
  resourceId?: string
}): string {
  return `${spaceId}/${collectionId ?? ''}/${resourceId ?? ''}`
}

/**
 * Drops the cached policy for one exact level. Call after any write that
 * changes (or removes) it -- PUT/DELETE Policy -- so the next read reflects the
 * new state rather than a stale cached one.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @returns {void}
 */
export function invalidatePolicy({
  storage,
  spaceId,
  collectionId,
  resourceId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId?: string
  resourceId?: string
}): void {
  // Only touch a cache that already exists for this backend.
  policyCaches
    .peek(storage)
    ?.delete(policyCacheKey({ spaceId, collectionId, resourceId }))
}

/**
 * Drops every cached policy under a Space (Space level plus every Collection
 * and Resource level). Call after Delete Space and after an import, either of
 * which can add, replace, or remove a policy at any level.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @returns {void}
 */
export function invalidateSpacePolicies({
  storage,
  spaceId
}: {
  storage: StorageBackend
  spaceId: string
}): void {
  const cache = policyCaches.peek(storage)
  if (cache) {
    deleteByPrefix(cache.cache, `${spaceId}/`)
  }
}

/**
 * Drops every cached policy under a Collection (Collection level plus every
 * Resource level within it). Call after Delete Collection.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {void}
 */
export function invalidateCollectionPolicies({
  storage,
  spaceId,
  collectionId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId: string
}): void {
  const cache = policyCaches.peek(storage)
  if (cache) {
    deleteByPrefix(cache.cache, `${spaceId}/${collectionId}/`)
  }
}

/**
 * Reads an access-control policy through the per-backend memoization cache,
 * returning `undefined` when no policy is set at that level. Used by
 * `resolveEffectivePolicy` for all three levels.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @returns {Promise<PolicyDocument | undefined>}
 */
export async function getCachedPolicy({
  storage,
  spaceId,
  collectionId,
  resourceId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId?: string
  resourceId?: string
}): Promise<PolicyDocument | undefined> {
  return await policyCaches.for(storage).memoize<PolicyDocument | undefined>({
    key: policyCacheKey({ spaceId, collectionId, resourceId }),
    fn: () => storage.getPolicy({ spaceId, collectionId, resourceId })
  })
}
