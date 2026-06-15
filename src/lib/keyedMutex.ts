/**
 * A keyed in-process mutex that serializes async functions per key, ported from
 * the `@interop/edv-server` storage layer. The conditional-write path uses it to
 * make a Resource's read-check-write atomic: two concurrent writers of the same
 * Resource cannot both observe the same prior version and both succeed.
 *
 * This is a single-instance lock only. It does NOT coordinate writes across
 * multiple server processes or a horizontally-scaled deployment -- that is out
 * of scope for the reference server (see the spec's Conditional Requests note).
 */

/**
 * Serializes async functions per key. `run` chains the given function onto the
 * tail of the key's promise queue, so all functions for the same key execute
 * strictly one at a time, in call order. Distinct keys run concurrently.
 */
export class KeyedMutex {
  private readonly queues = new Map<string, Promise<unknown>>()

  /**
   * Runs `fn` once all previously-queued functions for `key` have settled,
   * resolving (or rejecting) with `fn`'s result. The key's queue entry is
   * cleaned up once it drains so the map does not grow without bound.
   * @param key {string}   the serialization key (e.g. a per-Resource path)
   * @param fn {() => Promise<T>}   the critical section to run under the lock
   * @returns {Promise<T>}
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    // Keep the chain alive even if `fn` rejects, so a failed critical section
    // does not wedge the key's queue; track this swallowed-rejection tail so the
    // queue entry can be reclaimed once it drains (unless a later call replaced
    // it).
    const tail = run.catch(() => {})
    this.queues.set(key, tail)
    try {
      return await run
    } finally {
      if (this.queues.get(key) === tail) {
        this.queues.delete(key)
      }
    }
  }
}
