/**
 * Per-Collection backend resolver (spec "Backends"; stage 3 of the BYOS plan).
 * Maps a Collection's selected `backend.id` to the live `StorageBackend` that
 * serves its **data plane** (resource bytes, metadata, listings, change feed),
 * while the server `default` backend (`request.server.storage`) keeps the
 * **control plane** (Space/Collection descriptions, policies, the backend
 * registry records). For the `default` backend the two planes are the same
 * instance, so behavior is byte-for-byte unchanged.
 *
 * `resolveBackend` short-circuits to the default backend for the common
 * `default`/absent selection (one branch, no extra I/O). For a Collection that
 * selects a registered `external` backend it loads the (secret-bearing) backend
 * record from the control plane and builds -- memoized -- the provider adapter
 * from the injected `backendProviders` registry; with no factory for the record's
 * `provider` it fails closed with `unsupported-backend` (409). Memoization
 * mirrors spaceContext.ts: one `LruCache` per registry (a `WeakMap`), so adapter
 * instances are reused across requests and a registry's adapters are GC'd with
 * it.
 */
import type { FastifyRequest } from 'fastify'
import { LruCache } from '@interop/lru-memoize'
import { DEFAULT_BACKEND_ID } from './backends.js'
import { UnsupportedBackendError } from '../errors.js'
import { RESOLVED_BACKEND_CACHE_MAX } from '../config.default.js'
import type {
  BackendProviderRegistry,
  CollectionDescription,
  StorageBackend
} from '../types.js'

/**
 * One adapter cache per provider registry, keyed by `${spaceId}/${backendId}`.
 * Scoped to the registry instance via a `WeakMap` (rather than module-global) so
 * parallel test suites never share adapters, and a cache is discarded with its
 * registry. `memoize` evicts a rejected promise automatically, so a failed
 * resolution (missing record / no factory) is retried on the next request rather
 * than cached.
 */
const adapterCaches = new WeakMap<BackendProviderRegistry, LruCache>()

/**
 * Returns the (lazily created) adapter cache for a provider registry.
 * @param providers {BackendProviderRegistry}
 * @returns {LruCache}
 */
function adapterCacheFor(providers: BackendProviderRegistry): LruCache {
  let cache = adapterCaches.get(providers)
  if (!cache) {
    cache = new LruCache({ max: RESOLVED_BACKEND_CACHE_MAX })
    adapterCaches.set(providers, cache)
  }
  return cache
}

/**
 * Resolves the data-plane `StorageBackend` for a Collection. Returns the server
 * default backend when the Collection selects `default` (or selects nothing);
 * otherwise builds (memoized) the provider adapter for its registered backend.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server` (the
 *   control-plane `storage`, the `backendProviders` registry, and the
 *   non-request instance `log` passed to the memoized adapter factory)
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.collectionDescription] {CollectionDescription}   the
 *   already-fetched description (most handlers fetch it for auth); read from the
 *   control plane when omitted
 * @returns {Promise<StorageBackend>}
 */
export async function resolveBackend({
  request,
  spaceId,
  collectionId,
  collectionDescription
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  collectionDescription?: CollectionDescription
}): Promise<StorageBackend> {
  const { storage, backendProviders } = request.server
  const description =
    collectionDescription ??
    (await storage.getCollectionDescription({ spaceId, collectionId }))
  const backendId = description?.backend?.id
  // Fast path: the default backend is both control and data plane (unchanged).
  if (backendId === undefined || backendId === DEFAULT_BACKEND_ID) {
    return storage
  }
  return adapterCacheFor(backendProviders).memoize<StorageBackend>({
    key: `${spaceId}/${backendId}`,
    fn: async () => {
      // Control-plane read: the secret-bearing record lives on the default backend.
      const record = await storage.getBackend({ spaceId, backendId })
      if (!record) {
        throw new UnsupportedBackendError({ backendId })
      }
      // Status gating is deferred (stage 4): the resolver keys on whether a
      // provider factory is registered, not on `connection.status` (which only
      // becomes `connected` once the OAuth exchange exists).
      const factory = backendProviders.get(record.provider)
      if (!factory) {
        throw new UnsupportedBackendError({
          backendId,
          detail: `Backend '${backendId}' is registered but not connected/operable yet.`
        })
      }
      // Wire the non-request instance logger (as `createApp` does for the
      // primary backend), NOT `request.log`: the adapter is memoized and reused
      // across requests, so capturing the first request's per-request child
      // logger would mis-tag every later log line with that first request's id.
      return factory(record, { logger: request.server.log })
    }
  })
}

/**
 * Drops the memoized adapter for a backend record. Call after a record changes
 * (register-replace / deregister) so the next resolve rebuilds the adapter from
 * the new connection material.
 * @param options {object}
 * @param options.providers {BackendProviderRegistry}
 * @param options.spaceId {string}
 * @param options.backendId {string}
 * @returns {void}
 */
export function invalidateResolvedBackend({
  providers,
  spaceId,
  backendId
}: {
  providers: BackendProviderRegistry
  spaceId: string
  backendId: string
}): void {
  // Only touch a cache that already exists for this registry.
  adapterCaches.get(providers)?.delete(`${spaceId}/${backendId}`)
}
