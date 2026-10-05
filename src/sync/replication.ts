/**
 * The pull loops of the replication facet: one per stored replica
 * registration. A loop reads its source peer and stores what it reads through
 * the backend's apply path (`StorageBackend.apply*`), which keeps the peer's
 * write stamps. Nothing is pushed, and no request route accepts a stamp.
 *
 * One cycle reads, in order:
 *
 * - The peer Space's Metadata object, for its `name`, and the Space policy.
 *   Both are conditional reads against the `ETag` the last cycle saw.
 * - The peer's Collection listing, tombstones included. The registration's
 *   Collection list selects among them, and the Collection that holds the
 *   controller's history log is always selected. A selected tombstone is
 *   applied.
 * - Each selected Collection's Metadata object, when this server does not
 *   hold that life of the Collection yet, and then its changes feed from the
 *   stored checkpoint. Every change document is applied by kind, and the
 *   checkpoint advances past a document once it is applied or skipped.
 *
 * A refusal from the apply path stalls that Collection alone. The checkpoint
 * holds, the reason is stored with the loop state, and the Collection is
 * retried each cycle while the others go on. A request to the peer that
 * fails ends the cycle. The loop then backs off, doubling its delay up to a
 * limit, and logs one `warn` when the failures begin. Nothing stops a loop
 * but the removal of its registration.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { ISigner } from '@interop/data-integrity-core'

import {
  REPLICATION_BACKOFF_BASE_MS,
  REPLICATION_BACKOFF_MAX_MS,
  REPLICATION_DOCUMENT_MAX_BYTES,
  REPLICATION_FEED_PAGE_SIZE,
  REPLICATION_PULL_INTERVAL_MS
} from '../config.default.js'
import { PeerRequestError, ProblemError } from '../errors.js'
import { DEFAULT_BACKEND_ID } from '../lib/backends.js'
import { bufferedBodyLimit } from '../lib/bodyLimit.js'
import { generationOfEtag } from '../lib/etag.js'
import { invalidateCollectionGovernedDescriptors } from '../lib/governedDescriptorsCache.js'
import { compareStamps, stampOf, withoutStampMembers } from '../lib/hlc.js'
import { isPlainObject } from '../lib/isPlainObject.js'
import {
  collectionLogPath,
  collectionMetaPath,
  collectionPath,
  metaPath,
  policyPath,
  queryPath,
  resourcePath,
  spaceMetaPath
} from '../lib/paths.js'
import {
  invalidateCollectionPolicies,
  invalidatePolicy
} from '../lib/policyCache.js'
import { type ApplyResult, isReceivableStamp } from '../lib/replicaApply.js'
import type { ServerSigningKey } from '../lib/serverIdentity.js'
import { invalidateSpaceMetadata } from '../lib/spaceMetadataCache.js'
import { loadSyncSigner } from '../lib/syncIdentity.js'
import {
  isUrlSafeSegment,
  RESERVED_COLLECTION_IDS,
  RESERVED_RESOURCE_IDS,
  spaceIdOfSpaceUrl
} from '../lib/validateId.js'
import {
  forgetDeletedWebvhLocation,
  invalidateResolvedWebvhDid
} from '../lib/webvhController.js'
import type {
  IDID,
  PolicyDocument,
  ReplicaCollectionState,
  ReplicaLoopState,
  ReplicaStallReason,
  ReplicaStatus,
  ResourceInput,
  ResourceMetaStamp,
  StorageBackend,
  StoredReplica,
  WriteStamp
} from '../types.js'
import { peerCollectionSelector } from './collectionSelection.js'
import { PeerClient } from './peerClient.js'
import type { PeerFetch } from './peerFetch.js'
import { peerUrlOf, storedProjectionOfCollection } from './registration.js'

/**
 * What applying one change did, beside the apply path's own outcomes. Both
 * extra outcomes leave the checkpoint before the document, so the Collection
 * is read again next cycle from there. `retry` means the peer's record moved
 * between the feed page and its read. `pending` means the step stopped the
 * Collection's pull and already recorded why in its loop state.
 */
type ChangeResult = ApplyResult | { outcome: 'retry' } | { outcome: 'pending' }

/**
 * How one Collection's pull ended: `done` when its feed was read to the end,
 * `pending` when it stopped early and is read again next cycle, or
 * `unregistered` when the registration is gone and the loop must stop.
 */
type CollectionOutcome = 'done' | 'pending' | 'unregistered'

/**
 * One loop's in-memory handle.
 */
interface Loop {
  spaceId: string
  replicaId: string
  timer?: NodeJS.Timeout
  // The cycle in flight, if any.
  running?: Promise<void>
  stopped: boolean
}

/**
 * The key of a loop in the manager's map.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.replicaId {string}
 * @returns {string}
 */
function loopKey({
  spaceId,
  replicaId
}: {
  spaceId: string
  replicaId: string
}): string {
  return `${spaceId}/${replicaId}`
}

/**
 * The stamp members of a JSON object a peer served, or `undefined` when it
 * carries no whole, storable stamp.
 * @param value {unknown}
 * @returns {WriteStamp | undefined}
 */
function receivedStampOf(value: unknown): WriteStamp | undefined {
  if (!isPlainObject(value)) {
    return undefined
  }
  const stamp = stampOf(value as Partial<WriteStamp>)
  return isReceivableStamp(stamp) ? stamp : undefined
}

export class ReplicationManager {
  /**
   * The transport to a peer, which a registration's checks read through too.
   */
  readonly peerFetch: PeerFetch
  #storage: StorageBackend
  #getServerUrl: () => string
  #signingKey?: ServerSigningKey
  #logger: FastifyBaseLogger
  #pullIntervalMs: number
  #loops = new Map<string, Loop>()
  #paused = false
  #stopped = false

  /**
   * @param options {object}
   * @param options.storage {StorageBackend}
   * @param options.getServerUrl {() => string}   this server's base URL,
   *   read per cycle since a test boot sets it after `listen()`
   * @param [options.signingKey] {ServerSigningKey}   the server's seed key;
   *   without one every cycle fails for want of a sync signer
   * @param options.peerFetch {PeerFetch}   the transport to a peer
   * @param options.logger {FastifyBaseLogger}
   * @param [options.pullIntervalMs] {number}   the delay between two cycles
   *   that reached the peer; defaults to `REPLICATION_PULL_INTERVAL_MS`
   */
  constructor({
    storage,
    getServerUrl,
    signingKey,
    peerFetch,
    logger,
    pullIntervalMs = REPLICATION_PULL_INTERVAL_MS
  }: {
    storage: StorageBackend
    getServerUrl: () => string
    signingKey: ServerSigningKey | undefined
    peerFetch: PeerFetch
    logger: FastifyBaseLogger
    pullIntervalMs?: number
  }) {
    this.#storage = storage
    this.#getServerUrl = getServerUrl
    this.#signingKey = signingKey
    this.peerFetch = peerFetch
    this.#logger = logger
    this.#pullIntervalMs = pullIntervalMs
  }

  /**
   * Starts one loop per stored registration. Run once the server is ready. A
   * registration stored just before a crash gets its loop here.
   * @returns {Promise<void>}
   */
  async start(): Promise<void> {
    for (const { spaceId, record } of await this.#storage.listAllReplicas()) {
      this.register({ spaceId, replicaId: record.id })
    }
  }

  /**
   * Starts the loop of a registration, with its first cycle due at once.
   * Does nothing for one that already has a loop.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {void}
   */
  register({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): void {
    const key = loopKey({ spaceId, replicaId })
    if (this.#stopped || this.#loops.has(key)) {
      return
    }
    const loop: Loop = { spaceId, replicaId, stopped: false }
    this.#loops.set(key, loop)
    this.#schedule({ loop, delayMs: 0 })
  }

  /**
   * Stops the loop of a registration that was removed. A cycle in flight
   * ends on its own: the apply path resolves `unregistered` from then on.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {void}
   */
  unregister({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): void {
    const loop = this.#loops.get(loopKey({ spaceId, replicaId }))
    if (loop !== undefined) {
      this.#endLoop(loop)
    }
  }

  /**
   * Stops the loops of every registration on a Space, for Delete Space.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {void}
   */
  unregisterSpace({ spaceId }: { spaceId: string }): void {
    for (const loop of [...this.#loops.values()]) {
      if (loop.spaceId === spaceId) {
        this.#endLoop(loop)
      }
    }
  }

  /**
   * Holds every loop: no scheduled cycle starts until `resume()`. A cycle in
   * flight finishes. `pullNow()` still runs.
   * @returns {void}
   */
  pause(): void {
    this.#paused = true
  }

  /**
   * Lets the scheduled cycles run again, each due at once.
   * @returns {void}
   */
  resume(): void {
    this.#paused = false
    for (const loop of this.#loops.values()) {
      if (loop.running === undefined) {
        this.#schedule({ loop, delayMs: 0 })
      }
    }
  }

  /**
   * Runs one cycle of a registration's loop now and resolves when it ends,
   * after any cycle already in flight. Resolves at once for a registration
   * with no loop.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {Promise<void>}
   */
  async pullNow({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): Promise<void> {
    const loop = this.#loops.get(loopKey({ spaceId, replicaId }))
    if (loop === undefined) {
      return
    }
    await loop.running
    if (!loop.stopped) {
      await this.#runCycle(loop)
    }
  }

  /**
   * Stops every loop and waits for the cycles in flight. Run before the
   * storage backend closes.
   * @returns {Promise<void>}
   */
  async stop(): Promise<void> {
    this.#stopped = true
    const running = [...this.#loops.values()].map(loop => loop.running)
    for (const loop of [...this.#loops.values()]) {
      this.#endLoop(loop)
    }
    await Promise.allSettled(running)
  }

  /**
   * The runtime state of a registration's loop, as its `status` sub-resource
   * serves it, or `undefined` when the registration is not stored.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {Promise<ReplicaStatus | undefined>}
   */
  async status({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): Promise<ReplicaStatus | undefined> {
    if (
      (await this.#storage.getReplica({ spaceId, replicaId })) === undefined
    ) {
      return undefined
    }
    const stored = await this.#storage.getReplicaState({ spaceId, replicaId })
    const collections = Object.entries(stored?.collections ?? {})
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([id, { state, lastAppliedAt, stall }]) => ({
        id,
        state,
        ...(lastAppliedAt !== undefined && { lastAppliedAt }),
        ...(stall !== undefined && { stall })
      }))
    const loop = this.#loops.get(loopKey({ spaceId, replicaId }))
    let state: ReplicaStatus['state'] = 'idle'
    if (loop?.running !== undefined) {
      state = 'pulling'
    } else if ((stored?.failures ?? 0) > 0) {
      state = 'backing-off'
    } else if (collections.some(collection => collection.state === 'stalled')) {
      state = 'stalled'
    }
    return {
      state,
      ...(stored?.lastPullAt !== undefined && {
        lastPullAt: stored.lastPullAt
      }),
      ...(stored?.lastSuccessAt !== undefined && {
        lastSuccessAt: stored.lastSuccessAt
      }),
      ...(stored?.nextPullAt !== undefined && {
        nextPullAt: stored.nextPullAt
      }),
      collections
    }
  }

  /**
   * Removes a loop and cancels its timer.
   * @param loop {Loop}
   * @returns {void}
   */
  #endLoop(loop: Loop): void {
    loop.stopped = true
    clearTimeout(loop.timer)
    this.#loops.delete(loopKey(loop))
  }

  /**
   * Schedules a loop's next cycle.
   * @param options {object}
   * @param options.loop {Loop}
   * @param options.delayMs {number}
   * @returns {void}
   */
  #schedule({ loop, delayMs }: { loop: Loop; delayMs: number }): void {
    clearTimeout(loop.timer)
    if (loop.stopped || this.#stopped) {
      return
    }
    loop.timer = setTimeout(() => {
      if (this.#paused || loop.running !== undefined) {
        return
      }
      void this.#runCycle(loop)
    }, delayMs)
    // A pending pull must not keep the process alive.
    loop.timer.unref()
  }

  /**
   * Runs one cycle, records how it ended in the loop state, and schedules
   * the next one. Never rejects. A cycle that threw outside its pull, on a
   * storage fault reading or writing the loop state, scheduled nothing, so
   * the next one is scheduled here.
   * @param loop {Loop}
   * @returns {Promise<void>}
   */
  async #runCycle(loop: Loop): Promise<void> {
    const run = this.#cycle(loop)
      .catch(err => {
        this.#logger.error(
          { err, spaceId: loop.spaceId, replicaId: loop.replicaId },
          'A replication cycle failed unexpectedly.'
        )
        this.#schedule({ loop, delayMs: REPLICATION_BACKOFF_BASE_MS })
      })
      .finally(() => {
        loop.running = undefined
      })
    loop.running = run
    await run
  }

  /**
   * One cycle: read the peer, apply, persist the state, schedule the next.
   * @param loop {Loop}
   * @returns {Promise<void>}
   */
  async #cycle(loop: Loop): Promise<void> {
    const { spaceId, replicaId } = loop
    const replica = await this.#storage.getReplica({ spaceId, replicaId })
    if (replica === undefined) {
      this.#endLoop(loop)
      return
    }
    const state: ReplicaLoopState = (await this.#storage.getReplicaState({
      spaceId,
      replicaId
    })) ?? { collections: {} }
    state.lastPullAt = new Date().toISOString()

    let registered = true
    let failure: unknown
    try {
      registered = await this.#pull({ spaceId, replica, state })
    } catch (err) {
      failure = err
    }
    if (!registered) {
      this.#endLoop(loop)
      return
    }

    let delayMs = this.#pullIntervalMs
    if (failure === undefined) {
      state.failures = 0
      state.lastSuccessAt = new Date().toISOString()
    } else {
      const failures = (state.failures ?? 0) + 1
      state.failures = failures
      delayMs = Math.min(
        REPLICATION_BACKOFF_BASE_MS * 2 ** (failures - 1),
        REPLICATION_BACKOFF_MAX_MS
      )
      const log = {
        err: failure,
        spaceId,
        replicaId,
        peer: replica.record.fromSpace
      }
      if (failures === 1) {
        this.#logger.warn(
          log,
          'A replication pull failed; the loop is backing off.'
        )
      } else {
        this.#logger.debug(log, 'A replication pull failed again.')
      }
    }
    state.nextPullAt = new Date(Date.now() + delayMs).toISOString()
    const stored = await this.#storage.writeReplicaState({
      spaceId,
      replicaId,
      state
    })
    if (!stored) {
      this.#endLoop(loop)
      return
    }
    this.#schedule({ loop, delayMs })
  }

  /**
   * Reads the peer and applies what it serves. Mutates `state` as it goes
   * and persists it after each Collection whose state changed.
   * @param options {object}
   * @param options.spaceId {string}   the local Space
   * @param options.replica {StoredReplica}
   * @param options.state {ReplicaLoopState}
   * @returns {Promise<boolean>}   `false` when the registration is gone
   * @throws {PeerRequestError}   a request to the peer failed
   */
  async #pull({
    spaceId,
    replica,
    state
  }: {
    spaceId: string
    replica: StoredReplica
    state: ReplicaLoopState
  }): Promise<boolean> {
    const { record } = replica
    const replicaId = record.id
    const serverUrl = this.#getServerUrl()
    const sync = await loadSyncSigner({
      storage: this.#storage,
      serverUrl,
      signingKey: this.#signingKey,
      logger: this.#logger
    })
    if ('refusal' in sync) {
      throw new PeerRequestError({
        url: record.fromSpace,
        detail: `this server has no sync signer. ${sync.reason}`
      })
    }
    const peer = new PeerClient({
      peerFetch: this.peerFetch,
      signer: sync.signer as ISigner,
      capability: record.capability
    })
    const peerSpaceId = spaceIdOfSpaceUrl(record.fromSpace)!
    const peerUrl = (path: string): string =>
      peerUrlOf({ path, fromSpace: record.fromSpace })
    const context = { spaceId, replicaId, peer, peerSpaceId, peerUrl, record }

    if (!(await this.#pullSpaceMetadata({ ...context, state }))) {
      return false
    }
    if (!(await this.#pullSpacePolicy({ ...context, state }))) {
      return false
    }

    const listing = await this.#listPeerCollections(context)
    const selects = await this.#collectionSelector({ spaceId, record })
    for (const { id: collectionId, stamp } of listing.tombstones) {
      // A delete of a Collection this registration does not pull must not
      // remove a local Collection that happens to share its id.
      if (!selects(collectionId)) {
        continue
      }
      const result = await this.#storage.applyCollection({
        spaceId,
        replicaId,
        collectionId,
        collection: { deleted: true, stamp }
      })
      if (result.outcome === 'unregistered') {
        return false
      }
      this.#dropCaches({ kind: 'collection', result, spaceId, collectionId })
      if (result.outcome === 'applied') {
        delete state.collections[collectionId]
      }
    }

    for (const collectionId of listing.live.filter(selects)) {
      const collection: ReplicaCollectionState = state.collections[
        collectionId
      ] ?? { state: 'syncing' }
      state.collections[collectionId] = collection
      const before = JSON.stringify(state)
      const outcome = await this.#pullCollection({
        ...context,
        collectionId,
        collection
      })
      if (outcome === 'unregistered') {
        return false
      }
      if (JSON.stringify(state) === before) {
        continue
      }
      const stored = await this.#storage.writeReplicaState({
        spaceId,
        replicaId,
        state
      })
      if (!stored) {
        return false
      }
    }
    return true
  }

  /**
   * Applies the peer Space's `name`, when its Metadata object changed since
   * the last cycle.
   * @param options {object}   the pull context and the loop state
   * @returns {Promise<boolean>}   `false` when the registration is gone
   */
  async #pullSpaceMetadata({
    spaceId,
    replicaId,
    peer,
    peerSpaceId,
    peerUrl,
    state
  }: PullContext & { state: ReplicaLoopState }): Promise<boolean> {
    const url = peerUrl(spaceMetaPath({ spaceId: peerSpaceId }))
    const served = await peer.readJson({
      url,
      expect: [200, 304],
      ifNoneMatch: state.spaceMetaEtag
    })
    if (served.status === 304) {
      return true
    }
    const stamp = receivedStampOf(served.json)
    if (stamp === undefined) {
      throw new PeerRequestError({
        url,
        detail: 'the Space Metadata object carries no write stamp.'
      })
    }
    const { name } = served.json
    const result = await this.#storage.applySpaceName({
      spaceId,
      replicaId,
      ...(typeof name === 'string' && { name }),
      stamp
    })
    return this.#finishSpaceRecord({
      kind: 'space-name',
      result,
      spaceId,
      state,
      etagMember: 'spaceMetaEtag',
      etag: served.etag
    })
  }

  /**
   * Applies the peer's Space policy, live or a tombstone, when it changed
   * since the last cycle. A Space with no policy record answers 404.
   * @param options {object}   the pull context and the loop state
   * @returns {Promise<boolean>}   `false` when the registration is gone
   */
  async #pullSpacePolicy({
    spaceId,
    replicaId,
    peer,
    peerSpaceId,
    peerUrl,
    state
  }: PullContext & { state: ReplicaLoopState }): Promise<boolean> {
    const url = `${peerUrl(policyPath({ spaceId: peerSpaceId }))}?include=deleted`
    const served = await peer.readJson({
      url,
      expect: [200, 304, 404],
      ifNoneMatch: state.spacePolicyEtag
    })
    if (served.status !== 200) {
      return true
    }
    const result = await this.#applyServedPolicy({
      spaceId,
      replicaId,
      url,
      served
    })
    return this.#finishSpaceRecord({
      kind: 'space-policy',
      result,
      spaceId,
      state,
      etagMember: 'spacePolicyEtag',
      etag: served.etag
    })
  }

  /**
   * The tail both Space-level pulls share: drops the caches an applied record
   * leaves stale, and remembers the `ETag` unless the apply was refused, so a
   * clock-bound refusal is read again next cycle.
   * @param options {object}
   * @param options.kind {'space-name' | 'space-policy'}
   * @param options.result {ApplyResult}
   * @param options.spaceId {string}
   * @param options.state {ReplicaLoopState}
   * @param options.etagMember {'spaceMetaEtag' | 'spacePolicyEtag'}
   * @param options.etag {string | undefined}
   * @returns {boolean}   `false` when the registration is gone
   */
  #finishSpaceRecord({
    kind,
    result,
    spaceId,
    state,
    etagMember,
    etag
  }: {
    kind: 'space-name' | 'space-policy'
    result: ApplyResult
    spaceId: string
    state: ReplicaLoopState
    etagMember: 'spaceMetaEtag' | 'spacePolicyEtag'
    etag: string | undefined
  }): boolean {
    if (result.outcome === 'unregistered') {
      return false
    }
    this.#dropCaches({ kind, result, spaceId })
    if (result.outcome !== 'refused') {
      state[etagMember] = etag
    }
    return true
  }

  /**
   * Applies a policy as a peer's `GET .../policy?include=deleted` served it:
   * the body with its stamp members, under the generation in the `ETag`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.url {string}   the URL read, for an error
   * @param options.served {{ etag?: string, json: Record<string, unknown> }}
   * @returns {Promise<ApplyResult>}
   */
  async #applyServedPolicy({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    url,
    served
  }: {
    spaceId: string
    replicaId: string
    collectionId?: string
    resourceId?: string
    url: string
    served: { etag?: string; json: Record<string, unknown> }
  }): Promise<ApplyResult> {
    const stamp = receivedStampOf(served.json)
    const generation = generationOfEtag(served.etag)
    if (stamp === undefined || generation === undefined) {
      throw new PeerRequestError({
        url,
        detail: 'the policy carries no write stamp or no validator.'
      })
    }
    const deleted = served.json.deleted === true
    return this.#storage.applyPolicy({
      spaceId,
      replicaId,
      ...(collectionId !== undefined && { collectionId }),
      ...(resourceId !== undefined && { resourceId }),
      generation,
      stamp,
      ...(!deleted && {
        policy: withoutStampMembers(served.json) as unknown as PolicyDocument
      })
    })
  }

  /**
   * Reads the peer's whole Collection listing, tombstones included.
   * @param options {object}   the pull context
   * @returns {Promise<{ live: string[], tombstones: { id: string, stamp: WriteStamp }[] }>}
   */
  async #listPeerCollections({ peer, record }: PullContext): Promise<{
    live: string[]
    tombstones: Array<{ id: string; stamp: WriteStamp }>
  }> {
    const live: string[] = []
    const tombstones: Array<{ id: string; stamp: WriteStamp }> = []
    let url: string | undefined = `${record.fromSpace}?include=deleted`
    while (url !== undefined) {
      const page: Awaited<ReturnType<PeerClient['readJson']>> =
        await peer.readJson({ url, expect: [200] })
      const items = Array.isArray(page.json.items) ? page.json.items : []
      for (const item of items) {
        if (
          !isPlainObject(item) ||
          typeof item.id !== 'string' ||
          !isUrlSafeSegment(item.id) ||
          RESERVED_COLLECTION_IDS.has(item.id)
        ) {
          continue
        }
        if (item.deleted !== true) {
          live.push(item.id)
          continue
        }
        const stamp = receivedStampOf(item)
        if (stamp !== undefined) {
          tombstones.push({ id: item.id, stamp })
        }
      }
      const next: unknown = page.json.next
      url = undefined
      if (typeof next === 'string') {
        const followed = new URL(next, record.fromSpace)
        // A listing may not send the loop to another Space or host.
        if (`${followed.origin}${followed.pathname}` !== record.fromSpace) {
          throw new PeerRequestError({
            url: followed.toString(),
            detail: 'the listing\'s "next" leaves the peer Space.'
          })
        }
        url = followed.toString()
      }
    }
    return { live, tombstones }
  }

  /**
   * Which peer Collections this registration pulls, live or tombstoned: the
   * listed ones, or all of them with no list, and always the Collection that
   * holds the history log of the local Space's controller when the peer
   * Space hosts it.
   * @param options {object}
   * @param options.spaceId {string}   the local Space
   * @param options.record {StoredReplica['record']}
   * @returns {Promise<(collectionId: string) => boolean>}
   */
  async #collectionSelector({
    spaceId,
    record
  }: {
    spaceId: string
    record: StoredReplica['record']
  }): Promise<(collectionId: string) => boolean> {
    if (record.collections === undefined) {
      return peerCollectionSelector({ record })
    }
    const local = await this.#storage.getSpaceMetadata({ spaceId })
    return peerCollectionSelector({
      record,
      localController: local?.controller
    })
  }

  /**
   * Pulls one Collection: its Metadata object when this server does not hold
   * that life of it yet, then its changes feed from the stored checkpoint.
   * Mutates `collection`.
   * @param options {object}   the pull context, the Collection id and its
   *   loop state
   * @returns {Promise<CollectionOutcome>}
   */
  async #pullCollection(
    options: PullContext & {
      collectionId: string
      collection: ReplicaCollectionState
    }
  ): Promise<CollectionOutcome> {
    const { spaceId, collectionId, collection, peer, peerSpaceId, peerUrl } =
      options
    const stall = (reason: ReplicaStallReason, detail: string): 'pending' => {
      this.#recordStall({ ...options, reason, detail })
      return 'pending'
    }

    const held = await this.#storage.getCollectionMetadata({
      spaceId,
      collectionId
    })
    if (
      held === undefined ||
      collection.generation === undefined ||
      held.metaGeneration !== collection.generation
    ) {
      const ensured = await this.#pullCollectionMetadata(options)
      if (ensured !== 'done') {
        return ensured
      }
    }

    // A feed page inlines JSON bodies, so a full page can outgrow what the
    // loop buffers. The page size is then halved, down to one document.
    let limit = REPLICATION_FEED_PAGE_SIZE
    for (;;) {
      const params = new URLSearchParams({
        profile: 'changes',
        limit: String(limit)
      })
      if (collection.checkpoint !== undefined) {
        params.set('checkpoint', collection.checkpoint)
      }
      const url = `${peerUrl(
        queryPath({ spaceId: peerSpaceId, collectionId })
      )}?${params.toString()}`
      let page: Awaited<ReturnType<PeerClient['readJson']>>
      try {
        page = await peer.readJson({
          url,
          expect: [200, 400],
          // One document alone may hold a body as large as a JSON upload.
          ...(limit === 1 && {
            maxBytes:
              REPLICATION_DOCUMENT_MAX_BYTES +
              bufferedBodyLimit(this.#storage.maxUploadBytes)
          })
        })
      } catch (err) {
        if (!(err instanceof PeerRequestError) || !err.bodyTooLarge) {
          throw err
        }
        if (limit === 1) {
          return stall(
            'quota-exceeded',
            "The next change document is larger than this server's upload cap."
          )
        }
        limit = Math.ceil(limit / 2)
        continue
      }
      if (page.status === 400) {
        if (collection.checkpoint === undefined) {
          throw new PeerRequestError({
            url,
            detail: 'the peer refused a changes query with no checkpoint.',
            status: 400
          })
        }
        // The peer's feed is in another life: the Collection was deleted and
        // created again. Read its Metadata object and its feed from the start.
        collection.checkpoint = undefined
        collection.generation = undefined
        return 'pending'
      }
      const documents = Array.isArray(page.json.documents)
        ? page.json.documents.filter(isPlainObject)
        : []
      for (const document of documents) {
        let result: ChangeResult
        try {
          result = await this.#applyChange({ ...options, document })
        } catch (err) {
          const refusal = stallOfError(err)
          if (refusal === undefined) {
            throw err
          }
          return stall(refusal.reason, refusal.detail)
        }
        if (result.outcome === 'unregistered') {
          return 'unregistered'
        }
        if (result.outcome === 'refused') {
          return stall(result.reason, result.detail)
        }
        if (result.outcome === 'pending') {
          return 'pending'
        }
        if (result.outcome === 'retry') {
          collection.state = 'syncing'
          delete collection.stall
          return 'pending'
        }
        if (result.outcome === 'applied') {
          collection.lastAppliedAt = new Date().toISOString()
        }
        if (typeof document.checkpoint === 'string') {
          collection.checkpoint = document.checkpoint
        }
        // The Collection moved to another life under this very document.
        if (collection.generation === undefined) {
          return 'pending'
        }
      }
      if (documents.length < limit) {
        collection.state = 'synced'
        delete collection.stall
        return 'done'
      }
    }
  }

  /**
   * Reads the peer's Collection Metadata object and applies it. On `done`
   * this server holds the peer's life of the Collection, and `collection`
   * carries its generation.
   * @param options {object}   the pull context, the Collection id and its
   *   loop state
   * @returns {Promise<CollectionOutcome>}
   */
  async #pullCollectionMetadata(
    options: PullContext & {
      collectionId: string
      collection: ReplicaCollectionState
    }
  ): Promise<CollectionOutcome> {
    const {
      spaceId,
      replicaId,
      collectionId,
      collection,
      peer,
      peerSpaceId,
      peerUrl
    } = options
    const stall = (reason: ReplicaStallReason, detail: string): 'pending' => {
      this.#recordStall({ ...options, reason, detail })
      return 'pending'
    }
    const url = peerUrl(
      collectionMetaPath({ spaceId: peerSpaceId, collectionId })
    )
    const served = await peer.readJson({ url, expect: [200, 404] })
    if (served.status === 404) {
      // Deleted since the listing. Its tombstone arrives next cycle.
      return 'pending'
    }
    const generation = generationOfEtag(served.etag)
    const metadata = storedProjectionOfCollection(served.json)
    if (
      generation === undefined ||
      receivedStampOf(metadata) === undefined ||
      receivedStampOf(metadata.created) === undefined
    ) {
      throw new PeerRequestError({
        url,
        detail:
          'the Collection Metadata object carries no write stamp, no ' +
          'creating stamp, or no validator.'
      })
    }
    const backendId = metadata.backend?.id
    if (backendId !== undefined && backendId !== DEFAULT_BACKEND_ID) {
      return stall(
        'unsupported-backend',
        `The Collection is stored on backend "${backendId}" on the peer. ` +
          'This server replicates into its own default backend only.'
      )
    }

    let result: ApplyResult
    try {
      result = await this.#storage.applyCollection({
        spaceId,
        replicaId,
        collectionId,
        collection: { deleted: false, generation, metadata }
      })
    } catch (err) {
      const refusal = stallOfError(err)
      if (refusal === undefined) {
        throw err
      }
      return stall(refusal.reason, refusal.detail)
    }
    if (result.outcome === 'unregistered') {
      return 'unregistered'
    }
    if (result.outcome === 'refused') {
      return stall(result.reason, result.detail)
    }
    this.#dropCaches({ kind: 'collection', result, spaceId, collectionId })
    if (result.outcome === 'applied') {
      collection.lastAppliedAt = new Date().toISOString()
    }
    const held = await this.#storage.getCollectionMetadata({
      spaceId,
      collectionId
    })
    if (held?.metaGeneration !== generation) {
      // This server holds a tombstone, or a life of the Collection that wins
      // over the peer's. Its members are not pulled into that life.
      collection.state = 'skipped'
      delete collection.stall
      collection.generation = undefined
      collection.checkpoint = undefined
      return 'pending'
    }
    if (collection.generation !== generation) {
      collection.generation = generation
      collection.checkpoint = undefined
    }
    collection.state = 'syncing'
    delete collection.stall
    return 'done'
  }

  /**
   * Applies one change document of a peer's feed, by `kind`. A `kind` this
   * server does not know is skipped.
   * @param options {object}   the pull context, the Collection id and its
   *   loop state, and the change document
   * @returns {Promise<ChangeResult>}
   */
  async #applyChange(
    options: PullContext & {
      collectionId: string
      collection: ReplicaCollectionState
      document: Record<string, unknown>
    }
  ): Promise<ChangeResult> {
    const { document, spaceId, collectionId } = options
    // A Resource change drops its own cache, and a Collection Metadata change
    // drops the Collection's, inside the step: each needs more than the
    // final result to decide.
    if (document.kind === 'resource') {
      return this.#applyResourceChange(options)
    }
    if (document.kind === 'collection-metadata') {
      const outcome = await this.#pullCollectionMetadata(options)
      if (outcome === 'unregistered') {
        return { outcome: 'unregistered' }
      }
      // The read itself recorded a stall or a skip in the loop state.
      return { outcome: outcome === 'done' ? 'skipped' : 'pending' }
    }
    if (document.kind === 'log') {
      const result = await this.#applyLogChange(options)
      this.#dropCaches({ kind: 'log', result, spaceId, collectionId })
      return result
    }
    if (document.kind === 'policy') {
      const result = await this.#applyPolicyChange(options)
      this.#dropCaches({
        kind: 'collection-policy',
        result,
        spaceId,
        collectionId
      })
      return result
    }
    return { outcome: 'skipped' }
  }

  /**
   * Applies a `resource` change document: the content record, then the
   * `/meta` record when the document carries one.
   * @param options {object}   as {@link ReplicationManager.#applyChange}
   * @returns {Promise<ChangeResult>}
   */
  async #applyResourceChange({
    spaceId,
    replicaId,
    collectionId,
    peer,
    peerSpaceId,
    peerUrl,
    document
  }: PullContext & {
    collectionId: string
    document: Record<string, unknown>
  }): Promise<ChangeResult> {
    const resourceId = document.id
    const stamp = receivedStampOf(document)
    const { generation, contentType } = document
    if (
      typeof resourceId !== 'string' ||
      !isUrlSafeSegment(resourceId) ||
      RESERVED_RESOURCE_IDS.has(resourceId) ||
      stamp === undefined ||
      typeof generation !== 'string' ||
      typeof contentType !== 'string'
    ) {
      // Not a record this server could store or address.
      return { outcome: 'skipped' }
    }
    const members = {
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      generation,
      stamp,
      ...(typeof document.createdBy === 'string' && {
        createdBy: document.createdBy as IDID
      }),
      ...(typeof document.writerId === 'string' && {
        writerId: document.writerId
      })
    }

    if (document.deleted === true) {
      const result = await this.#storage.applyResource({
        ...members,
        resource: { deleted: true, contentType }
      })
      this.#dropCaches({
        kind: 'resource',
        result,
        spaceId,
        collectionId,
        resourceId
      })
      return result
    }

    const peerResource = { spaceId: peerSpaceId, collectionId, resourceId }
    // The members the content write set come from `/meta`, a second read.
    const meta = await peer.readJson({
      url: peerUrl(metaPath(peerResource)),
      expect: [200, 404]
    })
    const metaStamp = receivedStampOf(meta.json)
    if (
      meta.status === 404 ||
      metaStamp === undefined ||
      compareStamps(metaStamp, stamp) !== 0
    ) {
      // Written again since the feed page was read.
      return { outcome: 'retry' }
    }
    const createdAt = meta.json.createdAt
    const epoch = document.epoch

    const acquired = await this.#acquireResourceInput({
      peer,
      peerUrl,
      peerResource,
      document,
      contentType
    })
    if (acquired === undefined) {
      return { outcome: 'retry' }
    }
    const { input, release } = acquired
    let result: ApplyResult
    try {
      result = await this.#storage.applyResource({
        ...members,
        ...(typeof createdAt === 'string' && { createdAt }),
        resource: {
          deleted: false,
          input,
          ...(typeof epoch === 'string' && { epoch })
        }
      })
    } finally {
      if (input.kind === 'binary') {
        input.stream.destroy()
      }
      release()
    }
    this.#dropCaches({
      kind: 'resource',
      result,
      spaceId,
      collectionId,
      resourceId
    })
    if (result.outcome === 'unregistered' || result.outcome === 'refused') {
      return result
    }
    return this.#applyResourceMeta({
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      document,
      contentResult: result
    })
  }

  /**
   * Gets the content of a Resource change document: the inline JSON body, or
   * the peer's byte stream.
   * @param options {object}
   * @param options.peer {PeerClient}
   * @param options.peerUrl {(path: string) => string}
   * @param options.peerResource {{ spaceId: string, collectionId: string, resourceId: string }}
   * @param options.document {Record<string, unknown>}
   * @param options.contentType {string}
   * @returns {Promise<{ input: ResourceInput, release: () => void } | undefined>}
   *   `undefined` when the peer's record moved since the feed page, so the
   *   change is retried
   */
  async #acquireResourceInput({
    peer,
    peerUrl,
    peerResource,
    document,
    contentType
  }: {
    peer: PeerClient
    peerUrl: (path: string) => string
    peerResource: { spaceId: string; collectionId: string; resourceId: string }
    document: Record<string, unknown>
    contentType: string
  }): Promise<{ input: ResourceInput; release: () => void } | undefined> {
    if ('data' in document) {
      return {
        input: { kind: 'json', contentType, data: document.data },
        release: () => {}
      }
    }
    const content = await peer.readStream({
      url: peerUrl(resourcePath(peerResource))
    })
    if (content.etag !== document.etag) {
      content.stream.destroy()
      content.release()
      return undefined
    }
    return {
      input: {
        kind: 'binary',
        contentType,
        stream: content.stream,
        ...(content.declaredBytes !== undefined && {
          declaredBytes: content.declaredBytes
        })
      },
      release: content.release
    }
  }

  /**
   * Applies the `/meta` record a Resource change document carries, after its
   * content was applied or skipped.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.document {Record<string, unknown>}
   * @param options.contentResult {ApplyResult}   the content apply's result,
   *   which stands when there is no meta record or its apply was skipped
   * @returns {Promise<ApplyResult>}
   */
  async #applyResourceMeta({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    document,
    contentResult
  }: {
    spaceId: string
    replicaId: string
    collectionId: string
    resourceId: string
    document: Record<string, unknown>
    contentResult: ApplyResult
  }): Promise<ApplyResult> {
    const metaRecord = document.meta
    if (
      !isPlainObject(metaRecord) ||
      receivedStampOf(metaRecord) === undefined ||
      typeof metaRecord.generation !== 'string'
    ) {
      return contentResult
    }
    const metaResult = await this.#storage.applyResourceMetadata({
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      meta: metaRecord as unknown as ResourceMetaStamp,
      ...(isPlainObject(document.custom) && { custom: document.custom })
    })
    return metaResult.outcome === 'skipped' ? contentResult : metaResult
  }

  /**
   * Applies a `log` change document: the Collection's governing history log.
   * @param options {object}   as {@link ReplicationManager.#applyChange}
   * @returns {Promise<ChangeResult>}
   */
  async #applyLogChange({
    spaceId,
    replicaId,
    collectionId,
    peer,
    peerSpaceId,
    peerUrl,
    document
  }: PullContext & {
    collectionId: string
    document: Record<string, unknown>
  }): Promise<ChangeResult> {
    const stamp = receivedStampOf(document)
    const { generation } = document
    if (stamp === undefined || typeof generation !== 'string') {
      return { outcome: 'skipped' }
    }
    const served = await peer.read({
      url: peerUrl(collectionLogPath({ spaceId: peerSpaceId, collectionId })),
      expect: [200, 404]
    })
    if (served.status === 404 || served.etag !== document.etag) {
      return { outcome: 'retry' }
    }
    return this.#storage.applyCollectionLog({
      spaceId,
      replicaId,
      collectionId,
      body: served.body.toString('utf8'),
      generation,
      stamp
    })
  }

  /**
   * Applies a `policy` change document: the Collection's own policy or a
   * Resource's, live or a tombstone. Its `id` is the policy's URL on the
   * peer, which names the level.
   * @param options {object}   as {@link ReplicationManager.#applyChange}
   * @returns {Promise<ChangeResult>}
   */
  async #applyPolicyChange({
    spaceId,
    replicaId,
    collectionId,
    peer,
    peerSpaceId,
    peerUrl,
    document
  }: PullContext & {
    collectionId: string
    document: Record<string, unknown>
  }): Promise<ChangeResult> {
    const collectionUrl = peerUrl(
      collectionPath({
        spaceId: peerSpaceId,
        collectionId,
        trailingSlash: true
      })
    )
    const { id } = document
    if (typeof id !== 'string' || !id.startsWith(collectionUrl)) {
      return { outcome: 'skipped' }
    }
    // `policy` for the Collection's own, `<resourceId>/policy` for a
    // Resource's.
    const segments = id.slice(collectionUrl.length).split('/')
    const resourceId = segments.length === 2 ? segments[0] : undefined
    if (
      segments[segments.length - 1] !== 'policy' ||
      segments.length > 2 ||
      (resourceId !== undefined && !isUrlSafeSegment(resourceId))
    ) {
      return { outcome: 'skipped' }
    }
    const url = `${peerUrl(
      policyPath({ spaceId: peerSpaceId, collectionId, resourceId })
    )}?include=deleted`
    const served = await peer.readJson({ url, expect: [200, 404] })
    if (served.status === 404 || served.etag !== document.etag) {
      return { outcome: 'retry' }
    }
    return this.#applyServedPolicy({
      spaceId,
      replicaId,
      collectionId,
      ...(resourceId !== undefined && { resourceId }),
      url,
      served
    })
  }

  /**
   * Records a stall on a Collection's loop state, keeping the time of a
   * stall that already stood for the same reason. A clock-bound stall is
   * logged at `warn` when it begins, naming the peer.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param options.collectionId {string}
   * @param options.collection {ReplicaCollectionState}
   * @param options.record {StoredReplica['record']}
   * @param options.reason {ReplicaStallReason}
   * @param options.detail {string}
   * @returns {void}
   */
  #recordStall({
    spaceId,
    replicaId,
    collectionId,
    collection,
    record,
    reason,
    detail
  }: {
    spaceId: string
    replicaId: string
    collectionId: string
    collection: ReplicaCollectionState
    record: StoredReplica['record']
    reason: ReplicaStallReason
    detail: string
  }): void {
    const standing =
      collection.state === 'stalled' && collection.stall?.reason === reason
    if (!standing) {
      this.#logger.warn(
        { spaceId, replicaId, collectionId, peer: record.fromSpace, reason },
        `The pull of a Collection stalled: ${detail}`
      )
    }
    collection.state = 'stalled'
    collection.stall = {
      reason,
      since: standing ? collection.stall!.since : new Date().toISOString(),
      detail
    }
  }

  /**
   * The one place that lists which request-layer caches an applied record
   * leaves stale. Drops them only when the apply path reported `applied`.
   * @param options {object}
   * @param options.kind {string}   the kind of record applied
   * @param options.result {{ outcome: string }}   what the apply did
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {void}
   */
  #dropCaches({
    kind,
    result,
    spaceId,
    collectionId,
    resourceId
  }: {
    kind:
      | 'space-name'
      | 'space-policy'
      | 'collection'
      | 'collection-policy'
      | 'log'
      | 'resource'
    result: { outcome: string }
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): void {
    if (result.outcome !== 'applied') {
      return
    }
    const storage = this.#storage
    if (kind === 'space-name') {
      invalidateSpaceMetadata({ storage, spaceId })
    } else if (kind === 'space-policy') {
      invalidatePolicy({ storage, spaceId })
    } else if (kind === 'collection') {
      forgetDeletedWebvhLocation({
        storage,
        spaceId,
        collectionId: collectionId!
      })
      invalidateCollectionPolicies({
        storage,
        spaceId,
        collectionId: collectionId!
      })
      invalidateCollectionGovernedDescriptors({
        storage,
        spaceId,
        collectionId: collectionId!
      })
    } else if (kind === 'collection-policy') {
      invalidateCollectionPolicies({
        storage,
        spaceId,
        collectionId: collectionId!
      })
    } else if (kind === 'log') {
      invalidateCollectionGovernedDescriptors({
        storage,
        spaceId,
        collectionId: collectionId!
      })
    } else {
      invalidateResolvedWebvhDid({
        storage,
        spaceId,
        collectionId: collectionId!,
        resourceId: resourceId!
      })
    }
  }
}

/**
 * What every step of a pull is handed: the local Space and registration, the
 * peer client, and the peer Space's id and URL builder.
 */
interface PullContext {
  spaceId: string
  replicaId: string
  peer: PeerClient
  peerSpaceId: string
  peerUrl: (path: string) => string
  record: StoredReplica['record']
}

/**
 * The stall an error thrown by the apply path stands for, or `undefined` for
 * an error that is not a refusal of the write: a quota or the upload cap
 * (`quota-exceeded`), or a Space or Collection that is gone
 * (`container-refused`).
 * @param err {unknown}
 * @returns {{ reason: ReplicaStallReason, detail: string } | undefined}
 */
function stallOfError(
  err: unknown
): { reason: ReplicaStallReason; detail: string } | undefined {
  if (!(err instanceof ProblemError)) {
    return undefined
  }
  if (err.statusCode === 507 || err.statusCode === 413) {
    return { reason: 'quota-exceeded', detail: err.message }
  }
  if (err.statusCode === 404) {
    return { reason: 'container-refused', detail: err.message }
  }
  return undefined
}
