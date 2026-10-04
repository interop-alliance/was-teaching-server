/**
 * Access-control policies as versioned records. A stored policy carries the
 * write stamp of its last write (`updatedAt`, `updatedAtCounter`, `originId`)
 * and a generation, minted at its first write and kept for its life. A read
 * serves the stamp members beside the policy body, and the generation inside
 * the `ETag` only. Delete Policy leaves a tombstone in place of the record:
 * `deleted: true` plus the delete's stamp, with the generation kept and no
 * `type`. A tombstone grants nothing and reads as absent everywhere but
 * `GET .../policy?include=deleted` and the changes feed. A write over it is a
 * create, under a new generation.
 *
 * Both backends build and read the stored record through this module. The
 * filesystem backend stores a policy file as the served body with the
 * generation embedded as the reserved `_generation` member, the convention of
 * the Metadata files. A Collection's own policy and a Resource policy also
 * embed their changes-feed position as the reserved `_feedPosition` member,
 * written last. A Space policy takes no feed position and carries none. The
 * Postgres backend keeps the body in the `policy` jsonb and the stamp,
 * generation, `deleted` mark and feed position in their own columns. An
 * export archive carries a live policy's file without its `_feedPosition`,
 * and no tombstone.
 */
import { isWriteStamp } from '@interop/storage-core'
import type {
  FeedDocument,
  PolicyDocument,
  PolicyTombstone,
  RecordValidatorParts,
  StoredPolicy,
  WriteStamp
} from '../types.js'
import {
  formatEtag,
  type HeldValidators,
  importedGeneration,
  validatorOf
} from './etag.js'
import { stampOf, withoutStampMembers } from './hlc.js'
import { isPlainObject } from './isPlainObject.js'
import { policyPath } from './paths.js'
import { assertPolicyWritePrecondition } from './preconditions.js'
import { InvalidImportError } from '../errors.js'

/**
 * The members a policy write body carries that the server does not store
 * from it: the stamp members, which only the backend's clock sets, `deleted`,
 * which only Delete Policy sets, and `_generation` and `_feedPosition`, the
 * stored layout's reserved members.
 * @param policy {PolicyDocument}   the incoming or archived policy
 * @returns {PolicyDocument}   the body to persist, without a stamp
 */
export function normalizePolicyWrite(policy: PolicyDocument): PolicyDocument {
  const {
    deleted: _deleted,
    _generation: _embeddedGeneration,
    _feedPosition: _embeddedFeedPosition,
    ...body
  } = withoutStampMembers(policy) as PolicyDocument
  return body
}

/**
 * The served body of a live policy: the stored body with this write's stamp
 * members set.
 * @param options {object}
 * @param options.body {PolicyDocument}   the normalized body
 * @param options.stamp {WriteStamp}
 * @returns {PolicyDocument}
 */
export function stampedPolicy({
  body,
  stamp
}: {
  body: PolicyDocument
  stamp: WriteStamp
}): PolicyDocument {
  const { updatedAt, updatedAtCounter, originId } = stamp
  return { ...body, updatedAt, updatedAtCounter, originId }
}

/**
 * The body of a policy tombstone: the `deleted` marker and the delete's write
 * stamp. Nothing of the deleted policy's body is kept.
 * @param stamp {WriteStamp}   the delete's write stamp
 * @returns {PolicyTombstone}
 */
export function policyTombstoneBody(stamp: WriteStamp): PolicyTombstone {
  const { updatedAt, updatedAtCounter, originId } = stamp
  return { deleted: true, updatedAt, updatedAtCounter, originId }
}

/**
 * The serialized policy file of the filesystem backend: the served body (a
 * live policy or a tombstone) with the generation embedded as `_generation`,
 * and the feed position as `_feedPosition` when the policy takes one. The
 * position is written last, so dropping it restores the bytes of a file
 * written without it.
 * @param options {object}
 * @param options.body {PolicyDocument | PolicyTombstone}
 * @param options.generation {string}
 * @param [options.feedPosition] {number}   absent for a Space policy
 * @returns {string}
 */
export function policyFile({
  body,
  generation,
  feedPosition
}: {
  body: PolicyDocument | PolicyTombstone
  generation: string
  feedPosition?: number
}): string {
  return JSON.stringify({
    ...body,
    _generation: generation,
    ...(feedPosition !== undefined && { _feedPosition: feedPosition })
  })
}

/**
 * The feed position a stored policy file's parsed contents carry as
 * `_feedPosition`, or `undefined` when it carries no safe integer there.
 * @param raw {unknown}   the parsed policy file
 * @returns {number | undefined}
 */
export function policyFileFeedPosition(raw: unknown): number | undefined {
  if (!isPlainObject(raw)) {
    return undefined
  }
  const { _feedPosition: feedPosition } = raw
  return Number.isSafeInteger(feedPosition)
    ? (feedPosition as number)
    : undefined
}

/**
 * Reads a stored policy file's parsed contents into the stored record: a live
 * policy or a tombstone, beside its validator. The validator is absent when a
 * part of it is missing. `undefined` for a value that is not a JSON object.
 * The server-local `_feedPosition` is left out of the record.
 * @param raw {unknown}   the parsed policy file
 * @returns {StoredPolicy | undefined}
 */
export function storedPolicyFromFile(raw: unknown): StoredPolicy | undefined {
  if (!isPlainObject(raw)) {
    return undefined
  }
  const {
    _generation: generation,
    _feedPosition,
    ...body
  } = raw as Record<string, unknown>
  return storedPolicy({
    generation: typeof generation === 'string' ? generation : undefined,
    stamp: stampOf(body as Partial<WriteStamp>),
    ...(body.deleted !== true && { policy: body as PolicyDocument })
  })
}

/**
 * A stored policy file's bytes as an export archive carries them: the body,
 * stamp members and `_generation`, without the server-local `_feedPosition`.
 * `undefined` for a tombstone, which does not travel. The position is written
 * last, so dropping it restores the bytes a file without it would have. Bytes
 * that do not parse as a JSON object, or that carry no position, are returned
 * unchanged.
 * @param bytes {Buffer}
 * @returns {Buffer | undefined}
 */
export function archivedPolicyFile(bytes: Buffer): Buffer | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return bytes
  }
  if (storedPolicyFromFile(parsed)?.deleted) {
    return undefined
  }
  if (!isPlainObject(parsed) || !('_feedPosition' in parsed)) {
    return bytes
  }
  const { _feedPosition: _dropped, ...archived } = parsed
  return Buffer.from(JSON.stringify(archived))
}

/**
 * Builds the stored record of a policy from its parts: a live policy when
 * `policy` is given, served as stored, else a tombstone holding the `deleted`
 * marker and the stamp.
 * @param options {object}
 * @param [options.generation] {string}
 * @param options.stamp {Partial<WriteStamp>}   the record's stamp members
 * @param [options.policy] {PolicyDocument}   the served body of a live
 *   policy, stamp members included; absent for a tombstone
 * @returns {StoredPolicy}
 */
export function storedPolicy({
  generation,
  stamp,
  policy
}: {
  generation?: string
  stamp: Partial<WriteStamp>
  policy?: PolicyDocument
}): StoredPolicy {
  const validator = validatorOf({ generation, ...stamp })
  if (policy === undefined) {
    return {
      deleted: true,
      tombstone: { deleted: true, ...stamp } as PolicyTombstone,
      ...(validator !== undefined && { validator })
    }
  }
  return {
    deleted: false,
    policy,
    ...(validator !== undefined && { validator })
  }
}

/**
 * One archived policy staged for import: the body to persist, without the
 * archived stamp, and the generation it is stored under.
 */
export interface ImportedPolicy {
  policy: PolicyDocument
  generation: string
}

/**
 * Reads an archived policy file for import. The body loses its archived
 * stamp, which the importing backend replaces with its own, and keeps the
 * archived generation when this server could have minted it
 * (`importedGeneration`). An archive carries live policies only, so a
 * tombstone (`deleted: true`) refuses the import, as does a file that is not
 * a JSON object.
 * @param options {object}
 * @param options.bytes {Buffer}   the archived file's bytes
 * @param options.fileName {string}   the archive entry, for the error message
 * @returns {ImportedPolicy}
 */
export function importedPolicy({
  bytes,
  fileName
}: {
  bytes: Buffer
  fileName: string
}): ImportedPolicy {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    parsed = undefined
  }
  if (!isPlainObject(parsed) || parsed.deleted === true) {
    throw new InvalidImportError({
      message:
        `The archive's policy file "${fileName}" is not a live policy ` +
        'object.'
    })
  }
  return {
    policy: normalizePolicyWrite(parsed as PolicyDocument),
    generation: importedGeneration(parsed._generation)
  }
}

/**
 * The held record a policy write mints its validator against
 * (`mintValidator`'s `prior`). A live policy hands over its generation and
 * stamp, so the write keeps the generation. A tombstone hands over its stamp
 * alone, so a write over it mints a new generation with a stamp above the
 * tombstone's. `undefined` when no record is stored.
 * @param record {StoredPolicy | undefined}
 * @returns {RecordValidatorParts | undefined}
 */
export function priorPolicyParts(
  record: StoredPolicy | undefined
): RecordValidatorParts | undefined {
  if (record === undefined) {
    return undefined
  }
  if (record.deleted) {
    return stampOf(record.tombstone)
  }
  return {
    ...(record.validator !== undefined && {
      generation: record.validator.generation
    }),
    ...stampOf(record.policy as Partial<WriteStamp>)
  }
}

/**
 * Evaluates a policy write's or delete's preconditions against the record
 * its backend read under the write's lock, and returns the live policy the
 * write lands over. A tombstone counts as absent, so the result is
 * `undefined` for one, as for no record.
 * @param options {object}
 * @param options.prior {StoredPolicy | undefined}   the stored record
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @param [options.ifMatch] {string}
 * @param [options.ifNoneMatch] {HeldValidators}
 * @returns {StoredPolicy | undefined}   the live policy, when one is stored
 */
export function livePolicyUnderPrecondition({
  prior,
  spaceId,
  collectionId,
  resourceId,
  ifMatch,
  ifNoneMatch
}: {
  prior: StoredPolicy | undefined
  spaceId: string
  collectionId?: string
  resourceId?: string
  ifMatch?: string
  ifNoneMatch?: HeldValidators
}): StoredPolicy | undefined {
  const live = prior?.deleted === false ? prior : undefined
  assertPolicyWritePrecondition({
    policyPath: policyPath({ spaceId, collectionId, resourceId }),
    exists: live !== undefined,
    currentEtag: live?.validator && formatEtag(live.validator),
    ifMatch,
    ifNoneMatch
  })
  return live
}

/**
 * The changes-feed document of a stored policy record, live or a tombstone:
 * its stamp, and the validator its own GET serves. `undefined` when the
 * record's stamp is incomplete.
 * @param options {object}
 * @param options.record {StoredPolicy}
 * @param [options.resourceId] {string}   absent for the Collection's own
 *   policy
 * @param options.feedPosition {number}
 * @returns {FeedDocument | undefined}
 */
export function policyFeedDocument({
  record,
  resourceId,
  feedPosition
}: {
  record: StoredPolicy
  resourceId?: string
  feedPosition: number
}): FeedDocument | undefined {
  const stamp = stampOf(record.deleted ? record.tombstone : record.policy)
  if (!isWriteStamp(stamp)) {
    return undefined
  }
  return {
    kind: 'policy',
    ...(resourceId !== undefined && { resourceId }),
    feedPosition,
    ...stamp,
    deleted: record.deleted,
    ...(record.validator !== undefined && { validator: record.validator })
  }
}
