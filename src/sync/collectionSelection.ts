/**
 * Which peer Collections a replica registration pulls. Shared by the pull loop
 * (`sync/replication.ts`), which reads only the selected Collections, and the
 * resolver of a replicated `did:webvh` (`lib/webvhLogLocation.ts`), which
 * reads a history log only from a Collection the loop keeps a copy of. One
 * rule serves both, so the two cannot drift.
 */
import { parseSelfHostedWebvh } from '../lib/validateDid.js'
import { spaceIdOfSpaceUrl } from '../lib/validateId.js'
import type { ReplicaRegistration } from '../types.js'

/**
 * The Collections one registration selects: the listed ones, and always the
 * Collection that holds the history log of the local Space's controller when
 * the peer Space hosts it. `undefined` stands for every Collection, which a
 * registration with no list selects.
 *
 * @param options {object}
 * @param options.record {ReplicaRegistration}   the registration
 * @param [options.localController] {string}   the local Space's controller.
 *   Read only when the registration lists its Collections
 * @returns {Set<string> | undefined}
 */
export function selectedCollectionIds({
  record,
  localController
}: {
  record: Pick<ReplicaRegistration, 'fromSpace' | 'collections'>
  localController?: string
}): Set<string> | undefined {
  if (record.collections === undefined) {
    return undefined
  }
  const wanted = new Set(record.collections.map(({ id }) => id))
  const hosted = parseSelfHostedWebvh(localController, {
    serverUrl: new URL(record.fromSpace).origin
  })
  if (
    hosted !== undefined &&
    hosted.spaceId === spaceIdOfSpaceUrl(record.fromSpace)
  ) {
    wanted.add(hosted.collectionId)
  }
  return wanted
}

/**
 * The selection rule of one registration, as a predicate over Collection ids
 * (see {@link selectedCollectionIds}).
 *
 * @param options {object}
 * @param options.record {ReplicaRegistration}   the registration
 * @param [options.localController] {string}   the local Space's controller.
 *   Read only when the registration lists its Collections
 * @returns {(collectionId: string) => boolean}
 */
export function peerCollectionSelector({
  record,
  localController
}: {
  record: Pick<ReplicaRegistration, 'fromSpace' | 'collections'>
  localController?: string
}): (collectionId: string) => boolean {
  const wanted = selectedCollectionIds({ record, localController })
  if (wanted === undefined) {
    return () => true
  }
  return collectionId => wanted.has(collectionId)
}

/**
 * Whether two selections of one peer Space share a Collection. Each is a
 * result of {@link selectedCollectionIds}. Two that select every Collection
 * overlap, whatever the peer Space holds.
 *
 * @param options {object}
 * @param options.left {Set<string> | undefined}
 * @param options.right {Set<string> | undefined}
 * @returns {boolean}
 */
export function selectionsOverlap({
  left,
  right
}: {
  left: Set<string> | undefined
  right: Set<string> | undefined
}): boolean {
  if (left === undefined) {
    return right === undefined || right.size > 0
  }
  if (right === undefined) {
    return left.size > 0
  }
  return [...left].some(collectionId => right.has(collectionId))
}
