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

/**
 * A keyed readers-writer lock, the container counterpart of {@link KeyedMutex}:
 * many holders may run under `read` for a key at once, while `write` runs alone
 * once the readers in flight have drained. The filesystem backend uses it to
 * make a container removal (a Collection or Space delete, which is a `write`)
 * mutually exclusive with the writes that create paths inside that container
 * (each a `read`), so a delete cannot land between a write's `mkdir` and its
 * file write and leave the directory recreated behind the delete.
 *
 * Readers take priority: a reader arriving while another reader holds the key
 * is admitted immediately rather than queueing behind a waiting writer. That is
 * deliberate -- a write path may acquire the shared side more than once (an
 * import writes Resources through the same guarded helpers), and with writer
 * priority such a nested acquisition would wait on a writer that is itself
 * waiting for the outer acquisition to drain. The cost is that a removal is
 * delayed while writes to its Space keep overlapping; each shared section is a
 * single file write, so the queue drains in practice.
 *
 * Single-instance only, like `KeyedMutex`: it does not coordinate across
 * processes.
 */
export class KeyedReadWriteLock {
  readonly #states = new Map<
    string,
    {
      readers: number
      writerActive: boolean
      waitingReaders: Array<() => void>
      waitingWriters: Array<() => void>
    }
  >()

  /**
   * Runs `fn` under the key's shared side, concurrently with other `read`
   * holders but never while a `write` holds the key.
   * @param key {string}   the container key (e.g. a Space id)
   * @param fn {() => Promise<T>}   the critical section
   * @returns {Promise<T>}
   */
  async read<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const state = this.#stateFor(key)
    if (state.writerActive) {
      // `#drain` counts an admitted waiter in before resuming it, so no writer
      // can slip in between the resume and this function body resuming.
      await new Promise<void>(resolve => state.waitingReaders.push(resolve))
    } else {
      state.readers++
    }
    try {
      return await fn()
    } finally {
      state.readers--
      this.#drain(key)
    }
  }

  /**
   * Runs `fn` under the key's exclusive side, once every `read` holder in
   * flight has finished and with no other holder admitted meanwhile.
   * @param key {string}   the container key (e.g. a Space id)
   * @param fn {() => Promise<T>}   the critical section
   * @returns {Promise<T>}
   */
  async write<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const state = this.#stateFor(key)
    if (state.writerActive || state.readers > 0) {
      // As in `read`: `#drain` marks the key held before resuming this waiter.
      await new Promise<void>(resolve => state.waitingWriters.push(resolve))
    } else {
      state.writerActive = true
    }
    try {
      return await fn()
    } finally {
      state.writerActive = false
      this.#drain(key)
    }
  }

  /**
   * The key's lock state, created on first use.
   * @param key {string}
   * @returns {object}
   */
  #stateFor(key: string) {
    let state = this.#states.get(key)
    if (!state) {
      state = {
        readers: 0,
        writerActive: false,
        waitingReaders: [],
        waitingWriters: []
      }
      this.#states.set(key, state)
    }
    return state
  }

  /**
   * Admits whoever can run now that a holder has released: every waiting reader
   * once no writer holds the key, otherwise a single waiting writer once the
   * readers have drained. Reclaims the key's entry when nothing is left holding
   * or waiting, so the map does not grow without bound.
   * @param key {string}
   * @returns {void}
   */
  #drain(key: string): void {
    const state = this.#states.get(key)
    if (!state || state.writerActive) {
      return
    }
    if (state.waitingReaders.length > 0) {
      const readers = state.waitingReaders.splice(0)
      state.readers += readers.length
      for (const resume of readers) {
        resume()
      }
      return
    }
    if (state.readers === 0 && state.waitingWriters.length > 0) {
      state.writerActive = true
      state.waitingWriters.shift()!()
      return
    }
    if (
      state.readers === 0 &&
      state.waitingReaders.length === 0 &&
      state.waitingWriters.length === 0
    ) {
      this.#states.delete(key)
    }
  }
}
