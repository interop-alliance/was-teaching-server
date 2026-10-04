/**
 * Network resolution of a peer server's own `did:webvh`, the one foreign DID
 * this server resolves.
 *
 * A replica pulls a Space from its peer under a capability the Space's
 * controller delegated to the pulling server's DID,
 * `did:webvh:<scid>:<host>:space:server:id`. That DID's history log lives in
 * the pulling server's `server` Space, which is not replicated here, so the
 * serving server fetches it from `https://<host>/space/server/id/did.jsonl`.
 *
 * The fetch is reached only through a peer grant on the verification context
 * (`WebvhResolverContext.peer`). The capability verifier issues one after it
 * has verified the delegation chain whose invoked capability names the DID as
 * its controller, so a request that does not carry such a chain causes no
 * request to any host. What this module adds is the bounds on the fetch
 * itself:
 *
 * - The log is verified like a local log (SCID pinning, hash chain, update-key
 *   signatures), with no witness fetch, and must extend the last head verified
 *   for the DID, so a host cannot serve an older prefix to restore a retired
 *   key.
 * - A verified document is cached per DID for a TTL, then fetched and verified
 *   again, so a key the peer's admin retires stops verifying within one TTL.
 * - A signature naming a key the cached document lacks forces one fetch per DID
 *   per interval. A failed fetch or verification is remembered for a short
 *   time.
 * - A first-contact fetch, of a DID with no verified head here, is counted
 *   against a per-host window and a global limit on concurrent fetches. Past
 *   either it is refused, not queued. A DID this resolver already verified
 *   is refreshed outside the host window, under a concurrency limit of its
 *   own, so DIDs nobody verified cannot crowd out a known peer's refresh.
 *   A known DID's refreshes stay bounded by the TTL and the key-miss
 *   interval.
 * - The default fetcher ({@link fetchPeerLog}) speaks `https` only, on the
 *   default port, follows no redirect, refuses a host that resolves to a
 *   private, loopback or link-local address, and connects only to the addresses
 *   it checked. The body is read as a stream and abandoned at the byte that
 *   crosses the size limit, under one timeout covering the whole fetch.
 *
 * The fetcher is injectable (the `peerLogFetcher` plugin option), since the
 * host bound keeps a real fetch out of the test suite.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import type { FastifyBaseLogger } from 'fastify'
import { LRUCache } from 'lru-cache'
import { Agent, fetch, type Dispatcher, type Response } from 'undici'
import { readLogFromString } from '@interop/did-method-webvh'
import type { DIDDoc, DIDLog } from '@interop/did-method-webvh'

import {
  PEER_WEBVH_CACHE_MAX,
  PEER_WEBVH_CACHE_TTL,
  PEER_WEBVH_FAILURE_TTL,
  PEER_WEBVH_FETCH_TIMEOUT_MS,
  PEER_WEBVH_HOST_FETCH_LIMIT,
  PEER_WEBVH_HOST_FETCH_WINDOW,
  PEER_WEBVH_KEY_MISS_REFETCH_INTERVAL,
  PEER_WEBVH_LOG_MAX_BYTES,
  PEER_WEBVH_MAX_CONCURRENT_FETCHES
} from '../config.default.js'
import { PeerLogFetchError, PeerWebvhResolutionError } from '../errors.js'
import {
  createPinnedLookup,
  isBlockedIp,
  readBodyBounded
} from './outboundAddress.js'
import { parsePeerServerWebvh, WEBVH_LOG_RESOURCE_ID } from './validateDid.js'
import { extendsHead, verifyWebvhLog, type LogHead } from './webvhController.js'

/**
 * Performs the HTTP GET of a peer's history log and resolves its body bytes.
 * It must not resolve more than `maxBytes` bytes, and should stop reading when
 * `signal` aborts. The resolver enforces both again on what it gets back.
 * Injected through the `peerLogFetcher` plugin option; {@link fetchPeerLog} is
 * the default.
 */
export type PeerLogFetcher = (options: {
  url: string
  maxBytes: number
  signal: AbortSignal
}) => Promise<Uint8Array>

/**
 * The URL a peer server publishes its history log at: the `did.jsonl`
 * Resource of the `id` Collection of its `server` Space.
 * @param options {object}
 * @param options.host {string}   the peer's host, as the DID names it
 * @returns {string}
 */
export function peerLogUrl({ host }: { host: string }): string {
  return `https://${host}/space/server/id/${WEBVH_LOG_RESOURCE_ID}`
}

/**
 * A verified peer document and the monotonic time its log was fetched.
 */
interface PeerEntry {
  doc: DIDDoc
  fetchedAt: number
}

/**
 * Resolves peer server DIDs over the network, with the cache, rate limits and
 * rollback check described in this module's header. One instance per app,
 * decorated as `fastify.peerWebvh`. Reached only through a peer grant on a
 * verification context.
 */
export class PeerWebvhResolver {
  #fetchLog: PeerLogFetcher
  #logger: FastifyBaseLogger
  #documents = new LRUCache<string, PeerEntry>({ max: PEER_WEBVH_CACHE_MAX })
  /**
   * The head of the last log verified per DID. Kept apart from the documents
   * so it outlives a document's TTL.
   */
  #heads = new LRUCache<string, LogHead>({ max: PEER_WEBVH_CACHE_MAX })
  /**
   * DIDs whose last fetch or verification failed, each with that failure.
   */
  #failures = new LRUCache<string, Error>({
    max: PEER_WEBVH_CACHE_MAX,
    ttl: PEER_WEBVH_FAILURE_TTL
  })
  /**
   * DIDs that had a key-miss fetch within the interval.
   */
  #keyMisses = new LRUCache<string, true>({
    max: PEER_WEBVH_CACHE_MAX,
    ttl: PEER_WEBVH_KEY_MISS_REFETCH_INTERVAL
  })
  /**
   * Monotonic start times of the recent fetches to each host.
   */
  #hostFetches = new LRUCache<string, number[]>({ max: PEER_WEBVH_CACHE_MAX })
  #inFlight = new Map<string, Promise<PeerEntry>>()
  /**
   * The number of fetches running now, for first-contact DIDs and for DIDs
   * with a verified head, counted apart.
   */
  #running = { firstContact: 0, known: 0 }

  /**
   * @param options {object}
   * @param options.fetchLog {PeerLogFetcher}   performs the log's HTTP GET
   * @param options.logger {FastifyBaseLogger}   logs failed fetches
   */
  constructor({
    fetchLog,
    logger
  }: {
    fetchLog: PeerLogFetcher
    logger: FastifyBaseLogger
  }) {
    this.#fetchLog = fetchLog
    this.#logger = logger
  }

  /**
   * Resolves a peer DID to its verified document: from the cache while the
   * entry is within its TTL, otherwise by fetching and verifying the log.
   * @param options {object}
   * @param options.did {string}   a peer server DID
   * @param options.serverUrl {string}   this server's base URL
   * @returns {Promise<DIDDoc>}
   */
  async resolve({
    did,
    serverUrl
  }: {
    did: string
    serverUrl: string
  }): Promise<DIDDoc> {
    const { entry } = await this.#current({ did, serverUrl })
    return entry.doc
  }

  /**
   * Resolves a peer DID for a signature made with `keyId`. When the cached
   * document does not list that key, the log is fetched once more, unless it
   * was just fetched by this call or a key miss already forced a fetch for
   * this DID within the interval.
   * @param options {object}
   * @param options.did {string}   a peer server DID
   * @param options.keyId {string}   the verification method the signature names
   * @param options.serverUrl {string}   this server's base URL
   * @returns {Promise<DIDDoc>}   a verified document listing `keyId`
   */
  async resolveKey({
    did,
    keyId,
    serverUrl
  }: {
    did: string
    keyId: string
    serverUrl: string
  }): Promise<DIDDoc> {
    const { entry, fetched } = await this.#current({ did, serverUrl })
    if (listsMethod({ doc: entry.doc, keyId })) {
      return entry.doc
    }
    if (fetched || this.#keyMisses.has(did)) {
      throw keyNotListed({ did, keyId })
    }
    this.#keyMisses.set(did, true)
    const refreshed = await this.#refresh({ did, serverUrl })
    if (listsMethod({ doc: refreshed.doc, keyId })) {
      return refreshed.doc
    }
    throw keyNotListed({ did, keyId })
  }

  /**
   * The cached entry when it is within its TTL, or a fresh one.
   * @param options {object}
   * @param options.did {string}
   * @param options.serverUrl {string}
   * @returns {Promise<{ entry: PeerEntry, fetched: boolean }>}   `fetched` is
   *   true when this call fetched the log
   */
  async #current({
    did,
    serverUrl
  }: {
    did: string
    serverUrl: string
  }): Promise<{ entry: PeerEntry; fetched: boolean }> {
    const cached = this.#documents.get(did)
    if (
      cached !== undefined &&
      performance.now() - cached.fetchedAt < PEER_WEBVH_CACHE_TTL
    ) {
      return { entry: cached, fetched: false }
    }
    return { entry: await this.#refresh({ did, serverUrl }), fetched: true }
  }

  /**
   * Fetches and verifies the log, sharing one fetch among concurrent callers
   * for the same DID.
   * @param options {object}
   * @param options.did {string}
   * @param options.serverUrl {string}
   * @returns {Promise<PeerEntry>}
   */
  async #refresh({
    did,
    serverUrl
  }: {
    did: string
    serverUrl: string
  }): Promise<PeerEntry> {
    const pending = this.#inFlight.get(did)
    if (pending !== undefined) {
      return await pending
    }
    const work = this.#fetchAndVerify({ did, serverUrl })
    this.#inFlight.set(did, work)
    try {
      return await work
    } finally {
      this.#inFlight.delete(did)
    }
  }

  /**
   * One fetch and verification of a peer log. A failure drops the cached
   * document, so a stale one is never served in place of a failed refresh,
   * and is remembered for {@link PEER_WEBVH_FAILURE_TTL}. A first-contact
   * fetch must fit the host window and the first-contact concurrency limit;
   * a known DID's fetch must fit the known concurrency limit. A refusal by
   * either limit is not remembered.
   * @param options {object}
   * @param options.did {string}
   * @param options.serverUrl {string}
   * @returns {Promise<PeerEntry>}
   */
  async #fetchAndVerify({
    did,
    serverUrl
  }: {
    did: string
    serverUrl: string
  }): Promise<PeerEntry> {
    const parsed = parsePeerServerWebvh(did, { serverUrl })
    if (parsed === undefined) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'it is not a peer server DID on another host.'
      })
    }
    const failure = this.#failures.get(did)
    if (failure !== undefined) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'its last fetch failed, and is not retried yet.',
        cause: failure
      })
    }
    const kind = this.#heads.has(did) ? 'known' : 'firstContact'
    if (this.#running[kind] >= PEER_WEBVH_MAX_CONCURRENT_FETCHES) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'too many peer log fetches are running.'
      })
    }
    if (
      kind === 'firstContact' &&
      !this.#takeHostFetch({ host: parsed.host })
    ) {
      throw new PeerWebvhResolutionError({
        did,
        detail: `too many log fetches to "${parsed.host}" in the window.`
      })
    }
    this.#running[kind]++
    try {
      const log = await this.#fetchLogOf({ did, host: parsed.host })
      if (!extendsHead({ log, head: this.#heads.get(did) })) {
        throw new PeerWebvhResolutionError({
          did,
          detail: 'the log does not extend the last version verified here.'
        })
      }
      const { doc, deactivated } = await verifyWebvhLog({
        did,
        log,
        witnessProofs: []
      })
      if (deactivated) {
        throw new PeerWebvhResolutionError({
          did,
          detail: 'the DID has been deactivated.'
        })
      }
      // The log extends the recorded head, so this only moves it forward.
      this.#heads.set(did, {
        count: log.length,
        versionId: log.at(-1)!.versionId
      })
      const entry = { doc, fetchedAt: performance.now() }
      this.#documents.set(did, entry)
      return entry
    } catch (err) {
      this.#documents.delete(did)
      this.#failures.set(did, err as Error)
      this.#logger.warn({ err, did }, 'Could not resolve a peer server DID.')
      throw err instanceof PeerWebvhResolutionError
        ? err
        : new PeerWebvhResolutionError({
            did,
            detail: 'its history log could not be fetched or verified.',
            cause: err
          })
    } finally {
      this.#running[kind]--
    }
  }

  /**
   * Fetches a peer log under the timeout and size limit, and parses it.
   * @param options {object}
   * @param options.did {string}
   * @param options.host {string}
   * @returns {Promise<DIDLog>}
   */
  async #fetchLogOf({
    did,
    host
  }: {
    did: string
    host: string
  }): Promise<DIDLog> {
    const url = peerLogUrl({ host })
    const signal = AbortSignal.timeout(PEER_WEBVH_FETCH_TIMEOUT_MS)
    const bytes = await withDeadline({
      work: this.#fetchLog({
        url,
        maxBytes: PEER_WEBVH_LOG_MAX_BYTES,
        signal
      }),
      signal,
      url
    })
    if (bytes.byteLength > PEER_WEBVH_LOG_MAX_BYTES) {
      throw new PeerLogFetchError({
        url,
        detail: `the log is larger than ${PEER_WEBVH_LOG_MAX_BYTES} bytes.`
      })
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (err) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'the log is not UTF-8.',
        cause: err
      })
    }
    try {
      return readLogFromString(text)
    } catch (err) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'the log is not valid JSON Lines.',
        cause: err
      })
    }
  }

  /**
   * Counts a first-contact fetch to `host` against the window, or reports
   * that the host is at its limit.
   * @param options {object}
   * @param options.host {string}
   * @returns {boolean}   whether the fetch may start
   */
  #takeHostFetch({ host }: { host: string }): boolean {
    const now = performance.now()
    const recent = (this.#hostFetches.get(host) ?? []).filter(
      startedAt => now - startedAt < PEER_WEBVH_HOST_FETCH_WINDOW
    )
    const allowed = recent.length < PEER_WEBVH_HOST_FETCH_LIMIT
    if (allowed) {
      recent.push(now)
    }
    this.#hostFetches.set(host, recent)
    return allowed
  }
}

/**
 * Whether a document lists `keyId` in its `verificationMethod` array. Which
 * relationship the key is under is checked later, by the invocation proof
 * purpose, against the same document.
 * @param options {object}
 * @param options.doc {DIDDoc}
 * @param options.keyId {string}
 * @returns {boolean}
 */
function listsMethod({ doc, keyId }: { doc: DIDDoc; keyId: string }): boolean {
  return (doc.verificationMethod ?? []).some(method => method.id === keyId)
}

/**
 * The refusal for a signature whose key the resolved document does not list.
 * @param options {object}
 * @param options.did {string}
 * @param options.keyId {string}
 * @returns {PeerWebvhResolutionError}
 */
function keyNotListed({
  did,
  keyId
}: {
  did: string
  keyId: string
}): PeerWebvhResolutionError {
  return new PeerWebvhResolutionError({
    did,
    detail: `the document does not list "${keyId}".`
  })
}

/**
 * Settles with `work`, or rejects when `signal` aborts first. An injected
 * fetcher that ignores the signal is still cut off at the deadline, and its
 * late result is dropped.
 * @param options {object}
 * @param options.work {Promise<T>}
 * @param options.signal {AbortSignal}
 * @param options.url {string}   the fetched URL, for the error
 * @returns {Promise<T>}
 */
async function withDeadline<T>({
  work,
  signal,
  url
}: {
  work: Promise<T>
  signal: AbortSignal
  url: string
}): Promise<T> {
  // The late outcome of work cut off by the deadline is not anyone's to see.
  work.catch(() => {})
  let onAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        new PeerLogFetchError({
          url,
          detail: 'the fetch timed out.',
          cause: signal.reason
        })
      )
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Checks a peer log URL before any lookup: `https`, the default port, and no
 * credentials. The resolver builds the URL from a DID whose host already
 * excludes a port, so this restates the bound where the request is made.
 * @param options {object}
 * @param options.url {string}
 * @returns {URL}   the parsed URL
 */
export function checkPeerLogUrl({ url }: { url: string }): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (err) {
    throw new PeerLogFetchError({ url, detail: 'not a URL.', cause: err })
  }
  if (parsed.protocol !== 'https:') {
    throw new PeerLogFetchError({ url, detail: 'only https is fetched.' })
  }
  if (parsed.port !== '') {
    throw new PeerLogFetchError({ url, detail: 'only the default port.' })
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new PeerLogFetchError({ url, detail: 'credentials are refused.' })
  }
  return parsed
}

/**
 * Checks the addresses a peer host resolved to: there must be at least one,
 * and none may be private, loopback, link-local, unique-local, multicast or
 * otherwise non-public (which covers the `169.254.169.254` cloud metadata
 * address). A host with one such address is refused whole.
 * @param options {object}
 * @param options.url {string}   the fetched URL, for the error
 * @param options.addresses {{ address: string, family: number }[]}
 * @returns {void}
 */
export function assertPublicAddresses({
  url,
  addresses
}: {
  url: string
  addresses: { address: string; family: number }[]
}): void {
  if (addresses.length === 0) {
    throw new PeerLogFetchError({ url, detail: 'the host has no address.' })
  }
  const blocked = addresses.find(({ address }) => isBlockedIp(address))
  if (blocked !== undefined) {
    throw new PeerLogFetchError({
      url,
      detail: `the host resolves to a non-public address (${blocked.address}).`
    })
  }
}

/**
 * The default {@link PeerLogFetcher}. Checks the URL, resolves its host and
 * checks every address, then makes the GET through an agent that connects
 * only to those addresses, so a DNS answer that changes after the check is
 * never used. The agent is closed after the one fetch.
 * @param options {object}
 * @param options.url {string}
 * @param options.maxBytes {number}
 * @param options.signal {AbortSignal}
 * @returns {Promise<Uint8Array>}
 */
export async function fetchPeerLog({
  url,
  maxBytes,
  signal
}: {
  url: string
  maxBytes: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  const parsed = checkPeerLogUrl({ url })
  // Brackets off an IPv6 literal, so the lookup and the pin see the address.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  let addresses: { address: string; family: number }[]
  try {
    addresses = await dnsLookup(hostname, { all: true })
  } catch (err) {
    throw new PeerLogFetchError({
      url,
      detail: 'the host does not resolve.',
      cause: err
    })
  }
  assertPublicAddresses({ url, addresses })
  const agent = new Agent({
    connect: { lookup: createPinnedLookup(new Map([[hostname, addresses]])) }
  })
  try {
    return await readBoundedResponse({
      url: parsed.href,
      dispatcher: agent,
      maxBytes,
      signal
    })
  } finally {
    agent.destroy().catch(() => {
      // best-effort teardown of a one-fetch agent
    })
  }
}

/**
 * Makes the GET and reads the body up to `maxBytes`. A redirect is refused
 * rather than followed, as is any status other than 200. A declared
 * `Content-Length` over the limit is refused before the body is read, and an
 * undeclared one is abandoned at the byte that crosses it. Exported for the
 * unit tests, which drive it against a local server through a plain agent.
 * @param options {object}
 * @param options.url {string}
 * @param options.dispatcher {Dispatcher}   the agent to connect through
 * @param options.maxBytes {number}
 * @param options.signal {AbortSignal}   aborts the connection and the read
 * @returns {Promise<Uint8Array>}
 */
export async function readBoundedResponse({
  url,
  dispatcher,
  maxBytes,
  signal
}: {
  url: string
  dispatcher: Dispatcher
  maxBytes: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal,
      dispatcher,
      headers: { accept: 'text/jsonl', 'accept-encoding': 'identity' }
    })
  } catch (err) {
    throw new PeerLogFetchError({
      url,
      detail: 'the request failed.',
      cause: err
    })
  }
  const refuse = async (detail: string) => {
    await response.body?.cancel().catch(() => {})
    return new PeerLogFetchError({ url, detail })
  }
  if (response.status >= 300 && response.status < 400) {
    throw await refuse(`a redirect (${response.status}) is not followed.`)
  }
  if (response.status !== 200) {
    throw await refuse(`the host answered ${response.status}.`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw await refuse(`the log is larger than ${maxBytes} bytes.`)
  }
  let body: Buffer | undefined
  try {
    body = await readBodyBounded({ body: response.body, maxBytes })
  } catch (err) {
    throw new PeerLogFetchError({
      url,
      detail: 'the body could not be read.',
      cause: err
    })
  }
  if (body === undefined) {
    throw new PeerLogFetchError({
      url,
      detail: `the log is larger than ${maxBytes} bytes.`
    })
  }
  return body
}
