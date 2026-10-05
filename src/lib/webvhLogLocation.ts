/**
 * Where this server keeps the history log of a `did:webvh` it resolves from
 * storage. Two shapes have one:
 *
 * - A self-hosted DID, `did:webvh:<scid>:<this host>:space:<S>:<C>`, whose log
 *   is `S/C/did.jsonl` here.
 * - A replicated one, `did:webvh:<scid>:<H>:space:<S>:<C>` on a peer host
 *   `H`, whose log this server holds a copy of. It has a location here only
 *   through a replica registration: some local Space `X` registers the peer
 *   Space `https://H/space/S/` as its `fromSpace`, and pulls Collection `C`.
 *   The copy is then `X/C/did.jsonl`, and `X` need not be `S`.
 *
 * The mapping goes through the registration and not through the host alone.
 * A local Space named `S` could belong to anyone on this server, so mapping
 * `H`'s DIDs onto it would let a stranger squat another user's DID by
 * creating that Space id here. A registration passes the checks in
 * `sync/registration.ts`, among them that the peer Space has the local
 * Space's controller, so only the peer Space's controller can make one.
 *
 * When more than one local Space registers the same peer Space and pulls
 * Collection `C`, the DID has no location here and resolves from neither
 * copy. Each copy is a log a local controller can also write directly, and
 * an older copy (a registration whose pull capability stopped verifying, or a
 * log written there by hand) can be a prefix of the current log that still
 * lists a retired key. The resolver's head record refuses such a prefix only
 * once it has verified a longer log, and the record is lost on restart.
 * Picking either copy by a fixed order would let the older one win, so an
 * ambiguous mapping is refused instead.
 *
 * The registrations are read through an index of every stored registration,
 * built from `listAllReplicas()` and cached per storage backend for
 * {@link REPLICA_INDEX_CACHE_TTL}. One index serves every DID, so a request
 * naming an unknown peer DID costs no extra read. Storing or removing a
 * registration drops the index, and so does Delete Space, which removes the
 * Space's registrations with it. The TTL bounds how long another server
 * process sharing the store keeps a stale index, as for the other read caches.
 */
import { REPLICA_INDEX_CACHE_TTL } from '../config.default.js'
import {
  peerCollectionSelector,
  selectedCollectionIds,
  selectionsOverlap
} from '../sync/collectionSelection.js'
import type { ReplicaRegistration, StorageBackend } from '../types.js'
import { backendScoped } from './backendCache.js'
import { getCachedSpaceMetadata } from './spaceMetadataCache.js'
import { parsePeerHostedWebvh, parseSelfHostedWebvh } from './validateDid.js'

/**
 * One stored registration with the local Space that holds it.
 */
interface Candidate {
  spaceId: string
  record: ReplicaRegistration
}

/**
 * The stored registrations by `fromSpace`.
 */
type ReplicaIndex = Map<string, Candidate[]>

/**
 * The controllers of local Spaces, by Space id: each one's stored controller
 * read afresh from storage, past the Space Metadata cache, or the controller
 * a check supposes the Space will have. A check that decides a write reads
 * this way, so a controller another process wrote a moment ago counts. A
 * lookup that passes none reads the cached Space Metadata object instead.
 */
type Controllers = Map<string, string>

/**
 * The cached index per storage backend, with the monotonic time its build
 * started. A build in flight is shared by every lookup that arrives meanwhile.
 */
const replicaIndexes = backendScoped(
  (): { current?: { builtAt: number; index: Promise<ReplicaIndex> } } => ({})
)

/**
 * Drops the cached registration index of a backend. Called after a
 * registration is stored or removed, and after Delete Space.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @returns {void}
 */
export function invalidateReplicaIndex({
  storage
}: {
  storage: StorageBackend
}): void {
  const slot = replicaIndexes.peek(storage)
  if (slot !== undefined) {
    slot.current = undefined
  }
}

/**
 * Builds the index from every stored registration.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @returns {Promise<ReplicaIndex>}
 */
async function buildReplicaIndex({
  storage
}: {
  storage: StorageBackend
}): Promise<ReplicaIndex> {
  const index: ReplicaIndex = new Map()
  for (const { spaceId, record } of await storage.listAllReplicas()) {
    const entries = index.get(record.fromSpace) ?? []
    entries.push({ spaceId, record })
    index.set(record.fromSpace, entries)
  }
  return index
}

/**
 * The cached index, or a fresh one when there is none or it is older than
 * the TTL. A failed build is not kept, so the next lookup builds again.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @returns {Promise<ReplicaIndex>}
 */
async function replicaIndexOf({
  storage
}: {
  storage: StorageBackend
}): Promise<ReplicaIndex> {
  const slot = replicaIndexes.for(storage)
  const now = performance.now()
  let entry = slot.current
  if (entry === undefined || now - entry.builtAt >= REPLICA_INDEX_CACHE_TTL) {
    const fresh = { builtAt: now, index: buildReplicaIndex({ storage }) }
    slot.current = fresh
    fresh.index.catch(() => {
      if (slot.current === fresh) {
        slot.current = undefined
      }
    })
    entry = fresh
  }
  return await entry.index
}

/**
 * The stored controllers of the local Spaces among `candidates`, read afresh
 * from storage. The local controller matters only to a registration that
 * lists its Collections, so the other Spaces are not read. A Space in `known`
 * keeps that controller and is not read either.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.candidates {Candidate[]}
 * @param [options.known] {Controllers}   controllers a check supposes
 * @returns {Promise<Controllers>}
 */
async function storedControllers({
  storage,
  candidates,
  known = new Map()
}: {
  storage: StorageBackend
  candidates: Candidate[]
  known?: Controllers
}): Promise<Controllers> {
  const controllers = new Map(known)
  const unread = new Set(
    candidates
      .filter(
        ({ spaceId, record }) =>
          record.collections !== undefined && !controllers.has(spaceId)
      )
      .map(({ spaceId }) => spaceId)
  )
  await Promise.all(
    [...unread].map(async spaceId => {
      const stored = await storage.getSpaceMetadata({ spaceId })
      if (stored !== undefined) {
        controllers.set(spaceId, stored.controller)
      }
    })
  )
  return controllers
}

/**
 * The local Spaces whose registrations, among `candidates`, pull one
 * Collection of the peer Space the candidates share.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.candidates {Candidate[]}   registrations of one `fromSpace`
 * @param options.collectionId {string}   the peer Collection
 * @param [options.controllers] {Controllers}   the local controllers, read
 *   from the cached Space Metadata objects when absent
 * @returns {Promise<Set<string>>}
 */
async function holdersOf({
  storage,
  candidates,
  collectionId,
  controllers
}: {
  storage: StorageBackend
  candidates: Candidate[]
  collectionId: string
  controllers?: Controllers
}): Promise<Set<string>> {
  const holders = new Set<string>()
  for (const { spaceId, record } of candidates) {
    let localController: string | undefined
    if (record.collections !== undefined) {
      localController =
        controllers === undefined
          ? (await getCachedSpaceMetadata({ storage, spaceId }))?.controller
          : controllers.get(spaceId)
    }
    if (peerCollectionSelector({ record, localController })(collectionId)) {
      holders.add(spaceId)
    }
  }
  return holders
}

/**
 * The location of a self-hosted DID's log, the one the DID names, or
 * `undefined` for any other DID. Synchronous, so the resolver reaches its
 * cache in the same tick for the common case, and an invalidation that lands
 * after the call finds the fetch it starts.
 * @param options {object}
 * @param options.serverUrl {string}   this server's base URL
 * @param options.did {unknown}   the candidate DID
 * @returns {{ spaceId: string, collectionId: string, selfHosted: true } |
 *   undefined}
 */
export function selfHostedLogLocation({
  serverUrl,
  did
}: {
  serverUrl: string
  did: unknown
}): { spaceId: string; collectionId: string; selfHosted: true } | undefined {
  const native = parseSelfHostedWebvh(did, { serverUrl })
  if (native === undefined) {
    return undefined
  }
  return {
    spaceId: native.spaceId,
    collectionId: native.collectionId,
    selfHosted: true
  }
}

/**
 * Locates the stored history log of a `did:webvh`: the local Space and
 * Collection whose `did.jsonl` the resolver reads, or `undefined` when this
 * server stores none for the DID. A self-hosted DID's location is the one it
 * names. A peer-hosted DID's is the local replica of its Space, found through
 * the one registration that pulls its Collection (see this module's header).
 *
 * A storage fault reading the registrations rejects, as a 5xx: it says
 * nothing about whether the DID resolves.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}   this server's base URL
 * @param options.did {unknown}   the candidate DID
 * @returns {Promise<{ spaceId: string, collectionId: string,
 *   selfHosted: boolean } | undefined>}   `selfHosted` is true for a DID on
 *   this server's own host
 */
export async function locateWebvhLog({
  storage,
  serverUrl,
  did
}: {
  storage: StorageBackend
  serverUrl: string
  did: unknown
}): Promise<
  { spaceId: string; collectionId: string; selfHosted: boolean } | undefined
> {
  const native = selfHostedLogLocation({ serverUrl, did })
  if (native !== undefined) {
    return native
  }
  const hosted = parsePeerHostedWebvh(did, { serverUrl })
  if (hosted === undefined) {
    return undefined
  }
  const candidates =
    (await replicaIndexOf({ storage })).get(hosted.fromSpace) ?? []
  const holders = await holdersOf({
    storage,
    candidates,
    collectionId: hosted.collectionId
  })
  if (holders.size !== 1) {
    return undefined
  }
  const [spaceId] = [...holders] as [string]
  return { spaceId, collectionId: hosted.collectionId, selfHosted: false }
}
/**
 * The local Space, other than `spaceId`, that already holds a registration
 * of the same peer Space pulling a Collection `record` would pull too, or
 * `undefined` when there is none. Storing `record` beside such a
 * registration would leave every `did:webvh` hosted in a shared Collection
 * with two locations, and so with none (see this module's header). Reads the
 * stored registrations and the other Spaces' controllers afresh, past the
 * caches.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.spaceId {string}   the local Space `record` is for
 * @param options.record {ReplicaRegistration}   the proposed registration
 * @param options.localController {string}   that Space's controller
 * @returns {Promise<string | undefined>}
 */
export async function replicaMappingConflict({
  storage,
  spaceId,
  record,
  localController
}: {
  storage: StorageBackend
  spaceId: string
  record: ReplicaRegistration
  localController: string
}): Promise<string | undefined> {
  const others = (
    (await buildReplicaIndex({ storage })).get(record.fromSpace) ?? []
  ).filter(other => other.spaceId !== spaceId)
  const controllers = await storedControllers({ storage, candidates: others })
  const proposed = selectedCollectionIds({ record, localController })
  for (const other of others) {
    const held = selectedCollectionIds({
      record: other.record,
      localController: controllers.get(other.spaceId)
    })
    if (selectionsOverlap({ left: proposed, right: held })) {
      return other.spaceId
    }
  }
  return undefined
}

/**
 * The outcome of a controller change or a registration removal that would
 * break a mapping: a `did:webvh` hosted in Collection `collectionId` of the
 * peer Space `fromSpace` would gain a second local copy, the one Space
 * `holder` already keeps, or the local Space `spaceId`'s controller `did`
 * would be left with no copy.
 */
export type MappingConflict =
  | {
      kind: 'second-holder'
      fromSpace: string
      collectionId: string
      holder: string
    }
  | { kind: 'unmapped'; did: string; spaceId: string }

/**
 * The registrations of one peer Space with the local controllers they are
 * read under: as stored, or as a change would leave them.
 */
interface Mapping {
  candidates: Candidate[]
  controllers: Controllers
}

/**
 * The first local Space whose controller, a `did:webvh` hosted in the peer
 * Space `fromSpace`, has one log location under the `before` mapping and
 * none, or two, under the `after` one. `undefined` when there is none. A
 * controller two local Spaces map before the change has no location to lose,
 * so a change that ends such an ambiguity is not reported. A Space's
 * controller is the one `after` supposes, else its stored one.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}   this server's base URL
 * @param options.fromSpace {string}   the peer Space whose mapping changes
 * @param options.before {Mapping}   its registrations now
 * @param options.after {Mapping}   its registrations after the change
 * @returns {Promise<{ did: string, spaceId: string } | undefined>}   the DID
 *   with the local Space it controls
 */
async function controllerUnmappedBy({
  storage,
  serverUrl,
  fromSpace,
  before,
  after
}: {
  storage: StorageBackend
  serverUrl: string
  fromSpace: string
  before: Mapping
  after: Mapping
}): Promise<{ did: string; spaceId: string } | undefined> {
  for (const space of await storage.listSpaces()) {
    const did = after.controllers.get(space.id) ?? space.controller
    const hosted = parsePeerHostedWebvh(did, { serverUrl })
    if (hosted === undefined || hosted.fromSpace !== fromSpace) {
      continue
    }
    const { collectionId } = hosted
    const held = await holdersOf({ storage, ...before, collectionId })
    if (held.size !== 1) {
      continue
    }
    const left = await holdersOf({ storage, ...after, collectionId })
    if (left.size !== 1) {
      return { did, spaceId: space.id }
    }
  }
  return undefined
}

/**
 * The conflict changing a local Space's controller would make, or
 * `undefined` when there is none. A registration that lists its Collections
 * also selects the Collection that holds the local controller's history log,
 * when its peer Space hosts it (`sync/collectionSelection.ts`). So a change
 * of controller changes the selections of the Space's own registrations, and
 * a controller change touches at most two peer Collections: the one hosting
 * the new controller's log, which the change may add to a selection, and the
 * one hosting the current controller's log, which it may remove.
 *
 * An added Collection another local Space's registration already selects is
 * a `second-holder` conflict: every `did:webvh` hosted there, the new
 * controller included, would have two locations, and so none (see this
 * module's header). A removed Collection this Space was the one holder of,
 * while some local Space's controller is hosted there, is an `unmapped`
 * conflict: that controller would be left with no location. A Collection a
 * registration lists is held whatever the controller, so listing the one
 * hosting the current controller's log lets the Space change controller
 * freely. Reads the stored registrations and the other Spaces' controllers
 * afresh, past the caches.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}   this server's base URL
 * @param options.spaceId {string}   the local Space whose controller changes
 * @param options.controller {string}   the proposed controller
 * @param options.currentController {string}   the stored controller
 * @returns {Promise<MappingConflict | undefined>}
 */
export async function controllerChangeConflict({
  storage,
  serverUrl,
  spaceId,
  controller,
  currentController
}: {
  storage: StorageBackend
  serverUrl: string
  spaceId: string
  controller: string
  currentController: string
}): Promise<MappingConflict | undefined> {
  const gained = parsePeerHostedWebvh(controller, { serverUrl })
  const lost = parsePeerHostedWebvh(currentController, { serverUrl })
  if (gained === undefined && lost === undefined) {
    return undefined
  }
  const index = await buildReplicaIndex({ storage })
  // The peer Space's mappings before and after the change: the stored
  // controllers, with this Space's supposed each way.
  const mappingsOf = async (
    fromSpace: string
  ): Promise<{ before: Mapping; after: Mapping }> => {
    const candidates = index.get(fromSpace) ?? []
    const controllers = await storedControllers({
      storage,
      candidates,
      known: new Map([[spaceId, currentController]])
    })
    return {
      before: { candidates, controllers },
      after: {
        candidates,
        controllers: new Map(controllers).set(spaceId, controller)
      }
    }
  }
  if (gained !== undefined) {
    const { before, after } = await mappingsOf(gained.fromSpace)
    const { collectionId } = gained
    const held = await holdersOf({ storage, ...before, collectionId })
    const left = await holdersOf({ storage, ...after, collectionId })
    const holder = [...left].find(other => other !== spaceId)
    if (!held.has(spaceId) && left.has(spaceId) && holder !== undefined) {
      return {
        kind: 'second-holder',
        fromSpace: gained.fromSpace,
        collectionId,
        holder
      }
    }
  }
  if (lost === undefined) {
    return undefined
  }
  const unmapped = await controllerUnmappedBy({
    storage,
    serverUrl,
    fromSpace: lost.fromSpace,
    ...(await mappingsOf(lost.fromSpace))
  })
  return unmapped === undefined ? undefined : { kind: 'unmapped', ...unmapped }
}

/**
 * The first Space controller that removing one registration would leave with
 * no log location: a `did:webvh` that is a local Space's stored controller,
 * maps to a local copy through this registration now, and would map to none
 * without it. `undefined` when there is none, or when the registration is not
 * stored. Reads the stored registrations and the Spaces' controllers afresh,
 * past the caches.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}   this server's base URL
 * @param options.spaceId {string}   the local Space holding the registration
 * @param options.replicaId {string}   the registration
 * @returns {Promise<{ did: string, spaceId: string } | undefined>}   the DID
 *   with the local Space it controls
 */
export async function controllerUnmappedByRemoval({
  storage,
  serverUrl,
  spaceId,
  replicaId
}: {
  storage: StorageBackend
  serverUrl: string
  spaceId: string
  replicaId: string
}): Promise<{ did: string; spaceId: string } | undefined> {
  const index = await buildReplicaIndex({ storage })
  const removed = [...index.values()]
    .flat()
    .find(entry => entry.spaceId === spaceId && entry.record.id === replicaId)
  if (removed === undefined) {
    return undefined
  }
  const { fromSpace } = removed.record
  const candidates = index.get(fromSpace) ?? []
  const controllers = await storedControllers({ storage, candidates })
  return await controllerUnmappedBy({
    storage,
    serverUrl,
    fromSpace,
    before: { candidates, controllers },
    after: {
      candidates: candidates.filter(entry => entry !== removed),
      controllers
    }
  })
}
