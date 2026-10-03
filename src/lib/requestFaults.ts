/**
 * Request-level fault injection for tests, reachable only through the
 * `was-teaching-server/testing` entry point. Records every request, and lets a
 * test refuse a chosen request before any handler runs, drop the response of
 * one that was applied, or hold one until the test releases it. An armed fault
 * fires on the first request that matches it, once unless `times` says more.
 *
 * The hooks must be added to the root instance before the protocol plugin is
 * registered. Added later, they run behind each route group's own hooks, and a
 * request those hooks refuse never reaches them.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * One request the server received, in arrival order.
 */
export interface RequestRecord {
  method: string
  /**
   * the request target's path as sent, without its query string
   */
  path: string
  /**
   * the DID of the `Authorization` header's `keyId`, fragment removed. Read
   * off the header before any signature is verified, so it names who the
   * request claims to be signed by. Absent on an unsigned request
   */
  did?: string
  /**
   * the response status, set when the response head is written, after every
   * `onSend` hook. A dropped response carries the status the client never saw
   */
  status?: number
  /**
   * the fault this request took, if any
   */
  fault?: 'refused' | 'dropped' | 'held'
}

/**
 * Selects the request a fault fires on. The object form matches every member
 * it names: `path` against the path without its query string, as an exact
 * string or a pattern. A string is compared with percent-encoding decoded on
 * both sides, and its trailing slash counts, since a container URL and its
 * no-slash form are different requests. An object naming no `method` never
 * matches an `OPTIONS` request, so a browser's CORS preflight does not take a
 * fault meant for the request behind it.
 */
export type RequestMatch =
  | { method?: string; path?: string | RegExp; did?: string }
  | ((record: RequestRecord) => boolean)

type FaultAction =
  | { kind: 'refused'; status: number }
  | { kind: 'dropped' }
  | { kind: 'held'; released: Promise<void> }

type ArmedFault = {
  match: RequestMatch
  remaining: number
  fired: (record: RequestRecord) => void
  disarmed: (err: RequestFaultDisarmedError) => void
} & FaultAction

/**
 * A fault was disarmed before any request took it: `reset()` ran, the server
 * closed, or a hold was released early. Rejects the fault's `fired` / `held`
 * promise, so a test awaiting a request that never came fails here instead of
 * timing out.
 */
export class RequestFaultDisarmedError extends Error {
  constructor() {
    super('The fault was disarmed before a request took it.')
    this.name = 'RequestFaultDisarmedError'
  }
}

/**
 * The fault controls `startTestServer()` returns.
 */
export class RequestFaults {
  /**
   * Every request received so far, in arrival order. `reset()` empties it.
   */
  readonly requests: RequestRecord[] = []
  #armed: ArmedFault[] = []
  #holdReleases = new Set<() => void>()

  /**
   * Adds the recording and fault hooks to a root Fastify instance. Call it
   * before the protocol plugin is registered.
   *
   * @param options {object}
   * @param options.fastify {FastifyInstance}
   */
  constructor({ fastify }: { fastify: FastifyInstance }) {
    fastify.addHook('onRequest', async (request, reply) => {
      const record = recordOf(request)
      this.requests.push(record)
      const fault = this.#take(record)

      // Fastify writes every response head through `writeHead`, a streamed
      // one included, after the last `onSend` hook has run. The status is
      // final there, and whatever the handler wrote is durable.
      const { raw } = reply
      const writeHead = raw.writeHead.bind(raw) as (
        ...head: unknown[]
      ) => typeof raw
      raw.writeHead = ((...head: unknown[]) => {
        record.status = head[0] as number
        if (fault?.kind === 'dropped') {
          // Closing the socket leaves the client with a transport failure.
          request.raw.socket.destroy()
        }
        return writeHead(...head)
      }) as typeof raw.writeHead

      if (!fault) {
        return
      }
      record.fault = fault.kind
      fault.fired(record)
      if (fault.kind === 'refused') {
        // This hook answers ahead of the CORS plugin's own, so the refusal
        // carries the header a cross-origin page needs to read its status.
        if (request.headers.origin !== undefined) {
          reply.header('access-control-allow-origin', '*')
        }
        reply.code(fault.status).type('application/problem+json').send({
          type: 'about:blank',
          title: 'Injected test fault',
          status: fault.status
        })
        return reply
      }
      if (fault.kind === 'held') {
        await fault.released
      }
    })

    // A held request is an active connection, which `close()` waits on.
    fastify.addHook('preClose', async () => {
      this.#disarmAll()
    })
  }

  /**
   * Tears the first matching request before any handler runs: it is answered
   * with `status` and the store is left untouched.
   *
   * @param options {object}
   * @param options.match {RequestMatch}
   * @param [options.status] {number}   defaults to 503
   * @param [options.times] {number}   how many matching requests to refuse, a
   *   positive integer or `Infinity`; defaults to 1. A client that retries a
   *   failed request needs more
   * @returns {{ fired: Promise<RequestRecord> }}   `fired` resolves when the
   *   fault is first taken, and rejects with `RequestFaultDisarmedError` when
   *   it is disarmed first
   */
  refuse({
    match,
    status = 503,
    times = 1
  }: {
    match: RequestMatch
    status?: number
    times?: number
  }): {
    fired: Promise<RequestRecord>
  } {
    const { fired } = this.#arm({
      match,
      times,
      action: { kind: 'refused', status }
    })
    return { fired }
  }

  /**
   * Tears the first matching request after it is applied: the handler runs to
   * completion and the connection is closed in place of the response, so the
   * client sees a transport failure over a write that landed. Meant for
   * writes. A response the server streams may have nothing to lose.
   *
   * @param options {object}
   * @param options.match {RequestMatch}
   * @param [options.times] {number}   how many matching requests to drop the
   *   response of, a positive integer or `Infinity`; defaults to 1. Each one
   *   is applied, a client's retries included
   * @returns {{ fired: Promise<RequestRecord> }}   `fired` resolves when the
   *   first such request arrives, before its handler runs, and rejects with
   *   `RequestFaultDisarmedError` when the fault is disarmed first
   */
  dropResponse({ match, times = 1 }: { match: RequestMatch; times?: number }): {
    fired: Promise<RequestRecord>
  } {
    const { fired } = this.#arm({ match, times, action: { kind: 'dropped' } })
    return { fired }
  }

  /**
   * Pauses the first matching request before any handler runs, until the test
   * calls `release()`. Closing the server and `reset()` release it too. A
   * `release()` before the request arrives disarms the hold.
   *
   * @param options {object}
   * @param options.match {RequestMatch}
   * @returns {{ held: Promise<RequestRecord>, release: () => void }}   `held`
   *   resolves when the request arrives and is paused, and rejects with
   *   `RequestFaultDisarmedError` when the hold is disarmed first
   */
  hold({ match }: { match: RequestMatch }): {
    held: Promise<RequestRecord>
    release: () => void
  } {
    const released = Promise.withResolvers<void>()
    const { fired, fault } = this.#arm({
      match,
      times: 1,
      action: { kind: 'held', released: released.promise }
    })
    const release = (): void => {
      this.#holdReleases.delete(release)
      this.#disarm(fault)
      released.resolve()
    }
    this.#holdReleases.add(release)
    return { held: fired, release }
  }

  /**
   * Disarms every fault not yet taken, releases every held request, and
   * empties `requests`.
   */
  reset(): void {
    this.#disarmAll()
    this.requests.length = 0
  }

  #arm({
    match,
    times,
    action
  }: {
    match: RequestMatch
    times: number
    action: FaultAction
  }): { fired: Promise<RequestRecord>; fault: ArmedFault } {
    if (times !== Infinity && !(Number.isInteger(times) && times >= 1)) {
      throw new RangeError(
        `"times" must be a positive integer or Infinity, got ${times}.`
      )
    }
    const { promise, resolve, reject } = Promise.withResolvers<RequestRecord>()
    // A test that never awaits the promise must not fail on an unhandled
    // rejection when the fault is disarmed.
    promise.catch(() => {})
    const fault: ArmedFault = {
      ...action,
      match,
      remaining: times,
      fired: resolve,
      disarmed: reject
    }
    this.#armed.push(fault)
    return { fired: promise, fault }
  }

  /**
   * Removes a fault and rejects its promise. A no-op on that promise once the
   * fault has fired.
   */
  #disarm(fault: ArmedFault): void {
    const index = this.#armed.indexOf(fault)
    if (index !== -1) {
      this.#armed.splice(index, 1)
    }
    fault.disarmed(new RequestFaultDisarmedError())
  }

  #disarmAll(): void {
    for (const fault of [...this.#armed]) {
      this.#disarm(fault)
    }
    for (const release of [...this.#holdReleases]) {
      release()
    }
  }

  /**
   * Returns the earliest armed fault the request matches, and disarms it once
   * it has fired its `times`.
   */
  #take(record: RequestRecord): ArmedFault | undefined {
    const fault = this.#armed.find(armed => matches(armed.match, record))
    if (fault && --fault.remaining <= 0) {
      this.#armed.splice(this.#armed.indexOf(fault), 1)
    }
    return fault
  }
}

function recordOf(request: FastifyRequest): RequestRecord {
  const { authorization } = request.headers
  const keyId = authorization?.match(/keyId="([^"]+)"/)?.[1]
  return {
    method: request.method,
    path: request.url.split('?')[0]!,
    ...(keyId && { did: keyId.split('#')[0] })
  }
}

function matches(match: RequestMatch, record: RequestRecord): boolean {
  if (typeof match === 'function') {
    return match(record)
  }
  const { method, path, did } = match
  if (method === undefined) {
    if (record.method === 'OPTIONS') {
      return false
    }
  } else if (method.toUpperCase() !== record.method) {
    return false
  }
  if (did !== undefined && did !== record.did) {
    return false
  }
  if (path === undefined) {
    return true
  }
  if (typeof path === 'string') {
    return decodedPath(path) === decodedPath(record.path)
  }
  // A `g` or `y` pattern carries its position from one `test()` to the next.
  path.lastIndex = 0
  return path.test(record.path)
}

/**
 * Decodes a path's percent-encoding, leaving an encoded reserved character
 * such as `%2F` as it is. A path that does not decode is compared as sent.
 */
function decodedPath(path: string): string {
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}
