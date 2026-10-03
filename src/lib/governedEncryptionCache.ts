/**
 * The memoized derivation of a log-governed Collection's `encryption`
 * member (the `governed-history-logs` feature), shared by every handler that
 * reads a Collection Metadata object through `getCollectionOrThrow` and by
 * Update Collection's checks. Deriving the member means parsing the whole
 * history log, which is append-only and grows without bound, so the result
 * is memoized per storage backend. An entry is keyed by the Collection and
 * by the log's own validator (its generation and write stamp): a log write
 * leaves the stored validator behind, so the next derivation is a miss on a
 * new key rather than a stale hit, and the recheck a Metadata write runs
 * under the backend's lock sees whatever head the lock-time log carries. No
 * write therefore needs to invalidate the cache for correctness. Delete
 * Collection, Delete Space, and Import Space still drop a Collection's
 * entries, so a removed or replaced log leaves none behind.
 */
import type { CollectionEncryption } from '@interop/storage-core'
import { LruCache } from '@interop/lru-memoize'
import {
  GOVERNED_ENCRYPTION_CACHE_MAX,
  GOVERNED_ENCRYPTION_CACHE_TTL
} from '../config.default.js'
import type { CollectionLogResult, StorageBackend } from '../types.js'
import { backendScoped, deleteByPrefix } from './backendCache.js'
import { formatEtag } from './etag.js'
import { deriveGovernedEncryption } from './governedLog.js'
import { collectionLogPath } from './paths.js'

/**
 * One memoization cache per storage backend, keyed by Collection and log
 * validator (see `backendCache.ts` for the scoping rationale).
 */
const encryptionCaches = backendScoped(
  () =>
    new LruCache({
      max: GOVERNED_ENCRYPTION_CACHE_MAX,
      ttl: GOVERNED_ENCRYPTION_CACHE_TTL
    })
)

/**
 * The key prefix every entry under one Space shares. `spaceId` and
 * `collectionId` are restricted to the RFC 3986 unreserved charset (see
 * `validateId.ts`), which never contains `/`, so `/` separates the parts and
 * doubles as the prefix boundary for the bulk invalidators below.
 * @param spaceId {string}
 * @returns {string}
 */
function spaceKeyPrefix(spaceId: string): string {
  return `${spaceId}/`
}

/**
 * The key prefix every entry of one Collection shares.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
function collectionKeyPrefix({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${spaceKeyPrefix(spaceId)}${collectionId}/`
}

/**
 * Drops every derived descriptor cached for a Collection. Call after Delete
 * Collection, since the log goes with it.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {void}
 */
export function invalidateCollectionGovernedEncryption({
  storage,
  spaceId,
  collectionId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId: string
}): void {
  // Only touch a cache that already exists for this backend.
  const cache = encryptionCaches.peek(storage)
  if (cache) {
    deleteByPrefix(cache.cache, collectionKeyPrefix({ spaceId, collectionId }))
  }
}

/**
 * Drops every derived descriptor cached under a Space. Call after Delete
 * Space and after an import, either of which can remove or install the log
 * of any Collection in the Space.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @returns {void}
 */
export function invalidateSpaceGovernedEncryption({
  storage,
  spaceId
}: {
  storage: StorageBackend
  spaceId: string
}): void {
  const cache = encryptionCaches.peek(storage)
  if (cache) {
    deleteByPrefix(cache.cache, spaceKeyPrefix(spaceId))
  }
}

/**
 * The `encryption` descriptor a stored history log derives, read through the
 * per-backend memoization cache: the log head's `state` with
 * `history: { method, resource }` stamped on. `undefined` for no log (an
 * ungoverned Collection). The caller has already read the log (the body and
 * its validator); only the parse is saved here. A stored log the parser
 * rejects is a server-side fault (`StorageError`, 500), and a rejected
 * derivation is not retained.
 * @param options {object}
 * @param options.storage {StorageBackend}   the backend the log was read from
 * @param options.serverUrl {string}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.log] {CollectionLogResult}   the stored log, as read, if any
 * @returns {Promise<CollectionEncryption | undefined>}
 */
export async function getCachedGovernedEncryption({
  storage,
  serverUrl,
  spaceId,
  collectionId,
  log
}: {
  storage: StorageBackend
  serverUrl: string
  spaceId: string
  collectionId: string
  log?: CollectionLogResult
}): Promise<CollectionEncryption | undefined> {
  if (!log) {
    return undefined
  }
  return await encryptionCaches.for(storage).memoize<CollectionEncryption>({
    key:
      collectionKeyPrefix({ spaceId, collectionId }) +
      formatEtag(log.validator),
    fn: async () =>
      deriveGovernedEncryption({
        body: log.body,
        logUrl: new URL(
          collectionLogPath({ spaceId, collectionId }),
          serverUrl
        ).toString()
      })
  })
}
