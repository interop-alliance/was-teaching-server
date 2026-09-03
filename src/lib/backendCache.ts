/**
 * The one shape every per-backend memoization cache in this server takes: a
 * lazily created cache instance scoped to a `StorageBackend` via a WeakMap,
 * plus a prefix-delete helper for caches whose composite string keys encode a
 * containment path.
 *
 * Scoping to the backend instance (rather than a module-global cache) means
 * two backends in one process -- e.g. parallel test suites -- never serve each
 * other's entries, and a cache is discarded with its backend. The Space
 * Description cache, the access-control policy cache, the resolved `did:webvh`
 * document cache, and the per-backend DID resolver all use this factory.
 */
import type { StorageBackend } from '../types.js'

/**
 * Builds a backend-scoped holder for one cache (or any other per-backend
 * object) created by `create`.
 *
 * `for` returns the backend's instance, creating it on first use. `peek`
 * returns it only if it already exists, which is what invalidation paths want:
 * a write against a backend nothing has read through yet has nothing to drop,
 * and must not allocate a cache just to find that out.
 *
 * @param create {() => T}   builds a fresh instance for a backend
 * @returns {{ for: (storage: StorageBackend) => T,
 *   peek: (storage: StorageBackend) => T | undefined }}
 */
export function backendScoped<T extends object>(
  create: () => T
): {
  for: (storage: StorageBackend) => T
  peek: (storage: StorageBackend) => T | undefined
} {
  const instances = new WeakMap<StorageBackend, T>()
  return {
    for(storage) {
      let instance = instances.get(storage)
      if (!instance) {
        instance = create()
        instances.set(storage, instance)
      }
      return instance
    },
    peek(storage) {
      return instances.get(storage)
    }
  }
}

/**
 * Drops every entry whose key starts with `prefix`. Snapshots the key list
 * before deleting so mutating the cache mid-iteration is never a concern.
 * Accepts anything Map-shaped over string keys (`lru-cache`'s `LRUCache`
 * directly, or an `@interop/lru-memoize` `LruCache`'s `.cache`).
 * @param cache {{ keys: () => Iterable<string>, delete: (key: string) => unknown }}
 * @param prefix {string}
 * @returns {void}
 */
export function deleteByPrefix(
  cache: { keys: () => Iterable<string>; delete: (key: string) => unknown },
  prefix: string
): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}
