/**
 * Helpers for the HTTP `ETag` strong validator that backs conditional writes
 * (the `conditional-writes` feature) and conditional reads (spec "Caching").
 * A versioned record (a Resource, a chunk, a Resource's `/meta` object, a
 * Collection's governing history log, a Space or Collection Metadata object)
 * carries a `generation` and the write stamp of its last write (see
 * `lib/hlc.ts`). The two are formatted together as one quoted strong
 * validator, `"<generation>.<ms>.<counter>.<originId>"`, with `ms` the epoch
 * millisecond value of the stamp's `updatedAt`. A Space or Collection
 * Metadata object appends a fifth, local segment,
 * `"<generation>.<ms>.<counter>.<originId>.<local>"`: a per-record counter
 * this server advances when the served object changes through a derived
 * member (a backend registration, a governed-log append) without a write, and
 * resets to 0 on the next stamped write. A stamp is minted afresh by every
 * write, so the validator moves with every write. Incoming `If-Match` /
 * `If-None-Match` request headers are normalized into write preconditions,
 * and a read's `If-None-Match` into the set of validators the client already
 * holds; both compare the whole string.
 *
 * The generation is an opaque random marker minted once, at a record's first
 * write, and kept for that record's whole life. A Resource's content record
 * continues through a tombstone and its re-create, so its generation does
 * too; the Resource's `/meta` object is a record of its own, with its own
 * generation, and dies with the tombstone, so a re-create's first metadata
 * write mints a fresh one. A hard delete (a chunk, a Collection, a Space)
 * removes the record, so the next record under the same id mints a fresh
 * generation and its validators can never coincide with the old one's. That
 * is what keeps the validator strong across a delete: a client's cached
 * `ETag` from the previous record matches nothing, so it is never answered
 * 304 with the old body and never passes `If-Match` against the new one.
 */
import { randomBytes } from 'node:crypto'
import { base58 } from '@scure/base'
import type {
  MetadataValidatorParts,
  RecordValidatorParts,
  WriteStamp
} from '../types.js'

/**
 * The parts of a strong `ETag` validator: the record's `generation`, the
 * write stamp of its last write, and, on a Space or Collection Metadata
 * object only, the `local` segment. Storage backends return one from every
 * versioned write.
 */
export interface EtagValidator {
  generation: string
  stamp: WriteStamp
  local?: number
}

/**
 * The stored parts a validator is read from: a record's `generation` beside
 * its stamp members, plus the `local` segment of a container Metadata object.
 * Any part missing means the record has no validator.
 */
export type ValidatorParts = RecordValidatorParts & { local?: number }

/**
 * Mints a new generation marker: eight random bytes, base58-encoded (about
 * eleven alphanumeric characters), so it needs no escaping inside the quoted
 * validator and cannot contain the `.` that separates the segments.
 * @returns {string}
 */
export function newGeneration(): string {
  return base58.encode(randomBytes(8))
}

/**
 * The longest generation `isMintedGeneration` accepts, in characters. A
 * minted one is about eleven; the bound keeps the base58 decode of an
 * archived value cheap.
 */
const MAX_GENERATION_LENGTH = 64

/**
 * Whether a value is a generation this server could have minted: a
 * non-empty base58 string of bounded length. Only such a value can sit
 * inside the quoted `ETag` validator: a `"`, a `.` or a line break would
 * corrupt the header on every later read. An import checks every archived
 * generation with this and mints a fresh one in place of any that fails.
 * @param value {unknown}
 * @returns {boolean}
 */
export function isMintedGeneration(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_GENERATION_LENGTH
  ) {
    return false
  }
  try {
    base58.decode(value)
    return true
  } catch {
    return false
  }
}

/**
 * The generation an import stores an archived record under: the archived
 * one when this server could have minted it (`isMintedGeneration`), else a
 * freshly minted one.
 * @param archived {unknown}   the generation the archive carries, if any
 * @returns {string}
 */
export function importedGeneration(archived: unknown): string {
  return isMintedGeneration(archived) ? archived : newGeneration()
}

/**
 * The generation a write continues under: the record's prior generation when
 * it has one, else a freshly minted one. This is the "mint once, then keep"
 * rule from the file header in code, so every backend write site applies it
 * the same way. A prior of `undefined` (no record) or `null` (an unset
 * database column) mints.
 * @param prior {string | null | undefined}   the stored generation, if any
 * @returns {string}
 */
export function resolveGeneration(prior: string | null | undefined): string {
  return prior ?? newGeneration()
}

/**
 * Formats a validator as the quoted strong `ETag`, e.g.
 * `"3mJr7AoUXx2.1767225600000.0.zOrigin"`, with the local segment appended
 * when the validator carries one. The stamp's `updatedAt` is written as its
 * epoch millisecond value. The quotes are part of the on-the-wire value, and
 * `If-Match` comparison is exact-string (strong) comparison.
 * @param validator {EtagValidator}
 * @returns {string}
 */
export function formatEtag({
  generation,
  stamp,
  local
}: EtagValidator): string {
  const segments = [
    generation,
    Date.parse(stamp.updatedAt),
    stamp.updatedAtCounter,
    stamp.originId
  ]
  if (local !== undefined) {
    segments.push(local)
  }
  return `"${segments.join('.')}"`
}

/**
 * The validator of a record whose generation and stamp are both known: the
 * value a backend returns from a write. Only the three stamp members are
 * kept, so a whole stored record may be passed as the `stamp`.
 * @param options {object}
 * @param options.generation {string}
 * @param options.stamp {WriteStamp}
 * @param [options.local] {number}   the local segment, on a container
 *   Metadata object
 * @returns {EtagValidator}
 */
export function stampedValidator({
  generation,
  stamp: { updatedAt, updatedAtCounter, originId },
  local
}: {
  generation: string
  stamp: WriteStamp
  local?: number
}): EtagValidator {
  return {
    generation,
    stamp: { updatedAt, updatedAtCounter, originId },
    ...(local !== undefined && { local })
  }
}

/**
 * The validator of a stored record, or `undefined` when any part is missing
 * (a Resource Metadata object never written has no `/meta` stamp) or its
 * `updatedAt` does not parse as a date.
 * @param parts {ValidatorParts}
 * @returns {EtagValidator | undefined}
 */
export function validatorOf({
  generation,
  updatedAt,
  updatedAtCounter,
  originId,
  local
}: ValidatorParts): EtagValidator | undefined {
  if (
    generation === undefined ||
    updatedAt === undefined ||
    updatedAtCounter === undefined ||
    originId === undefined ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    return undefined
  }
  return stampedValidator({
    generation,
    stamp: { updatedAt, updatedAtCounter, originId },
    local
  })
}

/**
 * The `ETag` of a stored record, or `undefined` when it has no validator.
 * Reads and precondition checks go through this so "no validator" is one
 * value everywhere.
 * @param parts {ValidatorParts}
 * @returns {string | undefined}
 */
export function etagOf(parts: ValidatorParts): string | undefined {
  const validator = validatorOf(parts)
  return validator === undefined ? undefined : formatEtag(validator)
}

/**
 * The validator parts of a stored record, the members a read result carries
 * so the request layer can derive the `ETag`: the `generation` and the stamp
 * members, each left out when the record lacks it.
 * @param record {ValidatorParts | undefined}
 * @returns {RecordValidatorParts}
 */
export function validatorPartsOf(
  record: ValidatorParts | undefined
): RecordValidatorParts {
  return {
    ...(record?.generation !== undefined && { generation: record.generation }),
    ...(record?.updatedAt !== undefined && { updatedAt: record.updatedAt }),
    ...(record?.updatedAtCounter !== undefined && {
      updatedAtCounter: record.updatedAtCounter
    }),
    ...(record?.originId !== undefined && { originId: record.originId })
  }
}

/**
 * The write stamp members of a stored record, each left out when absent.
 * @param record {Partial<WriteStamp> | undefined}
 * @returns {Partial<WriteStamp>}
 */
export function stampOf(
  record: Partial<WriteStamp> | undefined
): Partial<WriteStamp> {
  const { generation: _generation, ...stamp } = validatorPartsOf(record)
  return stamp
}

/**
 * A record without its write stamp members (`updatedAt`, `updatedAtCounter`,
 * `originId`). A Space or Collection Metadata body takes this form in the
 * Postgres `metadata` jsonb, whose stamp lives in its own columns, and an
 * incoming or archived record takes it before the backend's clock stamps it.
 * @param record {T}
 * @returns {Omit<T, keyof WriteStamp>}
 */
export function withoutStampMembers<T extends object>(
  record: T
): Omit<T, keyof WriteStamp> {
  const {
    updatedAt: _updatedAt,
    updatedAtCounter: _updatedAtCounter,
    originId: _originId,
    ...rest
  } = record as T & Partial<WriteStamp>
  return rest
}

/**
 * The five-segment `ETag` of a stored Space or Collection Metadata object:
 * its out-of-band generation and local segment beside the stamp members of
 * its body. `undefined` for an absent object (a create's prior state). A
 * record with no local segment stored reads as local 0.
 * @param [stored] {Partial<WriteStamp> & MetadataValidatorParts}
 * @returns {string | undefined}
 */
export function metadataEtagOf(
  stored?: Partial<WriteStamp> & MetadataValidatorParts
): string | undefined {
  if (stored === undefined) {
    return undefined
  }
  return etagOf({
    ...stampOf(stored),
    generation: stored.metaGeneration,
    local: stored.metaLocal ?? 0
  })
}

/**
 * The reserved members a Space or Collection Metadata file embeds beside its
 * wire body: `_generation`, the record's generation, and `_local`, the local
 * validator segment. The stamp members are wire members and are stored bare.
 */
export type EmbeddedMetadataValidator = {
  _generation?: string
  _local?: number
}

/**
 * Lifts a metadata file's on-disk layout (the wire body plus the reserved
 * `_generation` / `_local` members, the filesystem backend's convention; the
 * archive interchange shape carries `_generation` alone) into the stored read
 * shape: the two re-surfaced out of band as `metaGeneration` / `metaLocal`.
 * The inverse of `embedMetadataValidator`.
 * @param raw {T & EmbeddedMetadataValidator}
 * @returns {T & MetadataValidatorParts}
 */
export function storedMetadataFromFile<T extends object>(
  raw: T & EmbeddedMetadataValidator
): T & MetadataValidatorParts {
  const { _generation, _local, ...body } = raw
  return {
    ...(body as T),
    ...(_generation !== undefined && { metaGeneration: _generation }),
    ...(_local !== undefined && { metaLocal: _local })
  }
}

/**
 * Embeds a metadata record's generation and local segment into a wire body as
 * the reserved `_generation` / `_local` members, the layout of a metadata
 * file on disk. A missing part is left out rather than written as
 * `undefined`. An export archive entry passes no `local`, since the local
 * segment is this server's own and never travels.
 * @param options {object}
 * @param options.body {T}   the wire body, stamp members included
 * @param [options.generation] {string}
 * @param [options.local] {number}
 * @returns {T & EmbeddedMetadataValidator}
 */
export function embedMetadataValidator<T extends object>({
  body,
  generation,
  local
}: {
  body: T
  generation?: string
  local?: number
}): T & EmbeddedMetadataValidator {
  return {
    ...body,
    ...(generation !== undefined && { _generation: generation }),
    ...(local !== undefined && { _local: local })
  }
}

/**
 * Drops the out-of-band validator parts from a stored Space or Collection
 * Metadata read result, leaving the wire body (stamp members included). A
 * handler that composes an update from the stored object spreads this, and
 * the backend discards the stamp members it carries.
 * @param stored {T & MetadataValidatorParts}
 * @returns {T}
 */
export function stripMetadataValidator<T extends object>(
  stored: T & MetadataValidatorParts
): T {
  const { metaGeneration: _generation, metaLocal: _local, ...body } = stored
  return body as T
}

/**
 * Removes the local validator segment (`_local`) from a stored metadata
 * file's bytes, for an export archive entry: the segment is this server's
 * own and never travels. Bytes that do not parse as a JSON object, or that
 * carry no such member, are returned unchanged.
 * @param bytes {Buffer}
 * @returns {Buffer}
 */
export function withoutLocalSegment(bytes: Buffer): Buffer {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return bytes
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('_local' in parsed)
  ) {
    return bytes
  }
  const { _local: _dropped, ...rest } = parsed as Record<string, unknown>
  return Buffer.from(JSON.stringify(rest))
}

/**
 * Normalizes the `If-Match` / `If-None-Match` request headers into the write
 * preconditions the storage layer evaluates. `If-Match` is passed through as
 * its header value (an array-valued header comma-joined), in any of the RFC
 * 9110 forms `ifMatchCovers` understands: `*`, one quoted validator, or a
 * list. `If-None-Match` is parsed by `parseIfNoneMatch` into the same held
 * set a conditional read uses, so `*` (create-if-absent) and a list of
 * validators both reach the backend. A header that is absent contributes no
 * precondition.
 * @param headers {object}
 * @param [headers.if-match] {string | string[]}
 * @param [headers.if-none-match] {string | string[]}
 * @returns {{ ifMatch?: string, ifNoneMatch?: HeldValidators }}
 */
export function parseWritePreconditions(headers: {
  'if-match'?: string | string[]
  'if-none-match'?: string | string[]
}): { ifMatch?: string; ifNoneMatch?: HeldValidators } {
  const rawIfMatch = headers['if-match']
  const ifMatch = Array.isArray(rawIfMatch) ? rawIfMatch.join(',') : rawIfMatch
  const ifNoneMatch = parseIfNoneMatch(headers['if-none-match'])
  return {
    ...(ifMatch !== undefined && { ifMatch }),
    ...(ifNoneMatch !== undefined && { ifNoneMatch })
  }
}

/**
 * Whether an `If-Match` header value covers a record's current `ETag` (RFC
 * 9110 section 13.1.1): `*` covers any record that has a validator, and a
 * list covers it when one member equals it under strong comparison, so a
 * weak (`W/`-prefixed) member never matches. A record with no `ETag` is
 * covered by nothing, since no client holds a validator for it.
 * @param options {object}
 * @param options.ifMatch {string}   the `If-Match` header value
 * @param [options.currentEtag] {string}   the record's current `ETag`
 * @returns {boolean}
 */
export function ifMatchCovers({
  ifMatch,
  currentEtag
}: {
  ifMatch: string
  currentEtag?: string
}): boolean {
  if (currentEtag === undefined) {
    return false
  }
  if (ifMatch.trim() === '*') {
    return true
  }
  return ifMatch.split(',').some(member => member.trim() === currentEtag)
}

/**
 * The parsed form of a read's `If-None-Match` header (RFC 9110 section
 * 13.1.2): either `*` (any current representation) or the set of quoted strong
 * validators the client holds. The set is what a backend would compare against
 * a stored record's `ETag`, so it is the value to hand down if the
 * not-modified decision ever moves below the request layer.
 */
export type HeldValidators = '*' | Set<string>

/**
 * Parses a read's `If-None-Match` header into the validators the client holds.
 * The comparison RFC 9110 prescribes for `If-None-Match` is the weak one, so a
 * `W/` prefix is dropped and `W/"g.1.0.o"` names the same validator as
 * `"g.1.0.o"`. A
 * member that is not a quoted string is skipped rather than rejected; any
 * quoted string is kept, since only an exact match with an emitted `ETag`
 * counts later. A header that is absent, or carries no quoted validator,
 * yields `undefined` (an unconditional read). An array-valued header is
 * treated as its comma-joined form.
 * @param header {string | string[] | undefined}   the raw `If-None-Match`
 *   request header
 * @returns {HeldValidators | undefined}
 */
export function parseIfNoneMatch(
  header: string | string[] | undefined
): HeldValidators | undefined {
  if (header === undefined) {
    return undefined
  }
  const raw = (Array.isArray(header) ? header.join(',') : header).trim()
  if (raw === '*') {
    return '*'
  }
  const held = new Set<string>()
  for (const member of raw.split(',')) {
    const match = /^\s*(?:W\/)?("[^"]*")\s*$/.exec(member)
    if (match) {
      held.add(match[1]!)
    }
  }
  return held.size > 0 ? held : undefined
}

/**
 * Whether a read is answered 304 Not Modified: the client's held validators
 * (from `parseIfNoneMatch`) cover the representation's current `etag`. RFC
 * 9110 section 13.1.2 makes `*` cover any current representation, so it
 * matches a representation with no `ETag` too (metadata never written); a
 * listed validator can only match a representation that has one.
 * @param options {object}
 * @param [options.held] {HeldValidators}   the parsed `If-None-Match`, if any
 * @param [options.etag] {string}   the representation's current `ETag`
 * @returns {boolean}
 */
export function isNotModified({
  held,
  etag
}: {
  held?: HeldValidators
  etag?: string
}): boolean {
  if (held === undefined) {
    return false
  }
  return held === '*' || (etag !== undefined && held.has(etag))
}
