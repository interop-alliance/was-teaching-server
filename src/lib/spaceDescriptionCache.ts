/**
 * The memoized Space Description read shared by the request layer
 * (`requests/spaceContext.ts`) and the verification layer (the annex-chain
 * inspector in `lib/clientAnnexClause.ts`, which runs deep inside capability
 * verification with no request in hand). One short-TTL cache per storage
 * backend, keyed by `spaceId`; writes invalidate via
 * `invalidateSpaceDescription` so both consumers always read the same state.
 */
import { LruCache } from '@interop/lru-memoize'
import {
  SPACE_DESCRIPTION_CACHE_MAX,
  SPACE_DESCRIPTION_CACHE_TTL
} from '../config.default.js'
import type { SpaceDescription, StorageBackend } from '../types.js'
import { backendScoped } from './backendCache.js'

/**
 * One short-TTL memoization cache per storage backend, keyed by `spaceId`
 * (see `backendCache.ts` for the scoping rationale).
 */
const descriptionCaches = backendScoped(
  () =>
    new LruCache({
      max: SPACE_DESCRIPTION_CACHE_MAX,
      ttl: SPACE_DESCRIPTION_CACHE_TTL
    })
)

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
  descriptionCaches.peek(storage)?.delete(spaceId)
}

/**
 * Reads a Space Description through the per-backend memoization cache,
 * returning `undefined` when the Space does not exist. The request layer's
 * throw-on-absent wrapper lives in `requests/spaceContext.ts`.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @returns {Promise<SpaceDescription | undefined>}
 */
export async function getCachedSpaceDescription({
  storage,
  spaceId
}: {
  storage: StorageBackend
  spaceId: string
}): Promise<SpaceDescription | undefined> {
  return await descriptionCaches
    .for(storage)
    .memoize<SpaceDescription | undefined>({
      key: spaceId,
      fn: () => storage.getSpaceDescription({ spaceId })
    })
}
