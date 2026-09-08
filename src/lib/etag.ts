/**
 * Helpers for the HTTP `ETag` strong validator that backs conditional writes
 * (the `conditional-writes` feature) and conditional reads (spec "Caching").
 * A versioned record (a Resource, a chunk, a Collection Description, a
 * metadata object) carries a `generation` and a monotonic `version`; the two
 * are formatted together as one quoted strong validator on the wire. Incoming
 * `If-Match` / `If-None-Match` request headers are normalized into write
 * preconditions, and a read's `If-None-Match` into the set of validators the
 * client already holds.
 *
 * The generation is an opaque random marker minted once, when a record's
 * version counter starts, and kept for that record's whole life. A Resource's
 * content counter continues through a tombstone and its re-create, so its
 * generation does too; the Resource's `/meta` object is a record of its own,
 * with its own generation, and dies with the tombstone (the soft delete drops
 * `custom` and both parts of that validator together), so a re-create's first
 * metadata write mints a fresh one. A hard delete (a chunk, a Collection, a
 * Space) removes the counter with the record, so the next record under the
 * same id mints a fresh generation and its validators can never coincide with
 * the old one's. That is what keeps the validator strong across a delete: a
 * client's cached `ETag` from the previous record matches nothing, so it is
 * never answered 304 with the old body and never passes `If-Match` against
 * the new one.
 */
import { randomBytes } from 'node:crypto'
import { base58 } from '@scure/base'
import type { DescriptionValidatorParts } from '../types.js'

/**
 * The parts of a strong `ETag` validator: the record's `generation` and its
 * monotonic `version` within that generation. Storage backends return one from
 * every versioned write and surface both parts on every versioned read.
 */
export interface EtagValidator {
  generation: string
  version: number
}

/**
 * Mints a new generation marker: eight random bytes, base58-encoded (about
 * eleven alphanumeric characters), so it needs no escaping inside the quoted
 * validator and cannot contain the `.` that separates it from the version.
 * @returns {string}
 */
export function newGeneration(): string {
  return base58.encode(randomBytes(8))
}

/**
 * The generation a write continues under: the record's prior generation when
 * it has one, else a freshly minted one. This is the "mint once, then keep"
 * rule from the file header in code, so every backend write site applies it
 * the same way. A prior of `undefined` (no record, or a legacy record written
 * before generations) or `null` (an unset database column) mints.
 * @param prior {string | null | undefined}   the stored generation, if any
 * @returns {string}
 */
export function resolveGeneration(prior: string | null | undefined): string {
  return prior ?? newGeneration()
}

/**
 * Formats a validator as the quoted strong `ETag` (e.g. generation `3mJr7AoUXx2`
 * at version 3 to `"3mJr7AoUXx2.3"`). The quotes are part of the on-the-wire
 * value, and `If-Match` comparison is exact-string (strong) comparison.
 * @param validator {EtagValidator}
 * @returns {string}
 */
export function formatEtag({ generation, version }: EtagValidator): string {
  return `"${generation}.${version}"`
}

/**
 * The `ETag` of a record that may not have one: `undefined` when either part
 * is missing (a legacy record written before generations, or a metadata object
 * never written, whose `metaVersion` is unset). Reads and precondition checks
 * go through this so "no validator" is one value everywhere.
 * @param options {object}
 * @param [options.generation] {string}
 * @param [options.version] {number}
 * @returns {string | undefined}
 */
export function etagOf({
  generation,
  version
}: {
  generation?: string
  version?: number
}): string | undefined {
  return generation !== undefined && version !== undefined
    ? formatEtag({ generation, version })
    : undefined
}

/**
 * The `ETag` of a stored Space or Collection Description, from its
 * out-of-band validator parts; `undefined` for a legacy record or an absent
 * one (a create's prior state).
 * @param [stored] {DescriptionValidatorParts}
 * @returns {string | undefined}
 */
export function descriptionEtagOf(
  stored?: DescriptionValidatorParts
): string | undefined {
  return etagOf({
    generation: stored?.descriptionGeneration,
    version: stored?.descriptionVersion
  })
}

/**
 * Lifts a description file's on-disk layout (the wire body plus the reserved
 * `_generation` / `_version` members, the filesystem backend's convention and
 * the archive interchange shape) into the stored read shape: the validator
 * re-surfaced out of band as `descriptionGeneration` / `descriptionVersion`,
 * both absent for a legacy record. The inverse of `embedDescriptionValidator`.
 * @param raw {T & { _generation?: string, _version?: number }}
 * @returns {T & DescriptionValidatorParts}
 */
export function storedDescriptionFromFile<T extends object>(
  raw: T & { _generation?: string; _version?: number }
): T & DescriptionValidatorParts {
  const { _generation, _version, ...description } = raw
  return {
    ...(description as T),
    ...(_generation !== undefined && { descriptionGeneration: _generation }),
    ...(_version !== undefined && { descriptionVersion: _version })
  }
}

/**
 * Embeds a description validator into a wire body as the reserved
 * `_generation` / `_version` members, the layout a description file on disk
 * and an archived description share. A missing generation (a legacy record)
 * is left out rather than written as `undefined`, and so is a missing version.
 * @param options {object}
 * @param options.body {T}   the wire body, validator already stripped
 * @param [options.generation] {string}
 * @param [options.version] {number}
 * @returns {T & { _generation?: string, _version?: number }}
 */
export function embedDescriptionValidator<T extends object>({
  body,
  generation,
  version
}: {
  body: T
  generation?: string
  version?: number
}): T & { _generation?: string; _version?: number } {
  return {
    ...body,
    ...(generation !== undefined && { _generation: generation }),
    ...(version !== undefined && { _version: version })
  }
}

/**
 * Drops the out-of-band validator parts from a stored Space or Collection
 * Description read result, leaving the wire body. A handler that composes an
 * update from the stored description spreads this, so the document handed to
 * storage carries no validator of its own.
 * @param stored {T & DescriptionValidatorParts}
 * @returns {T}
 */
export function stripDescriptionValidator<T extends object>(
  stored: T & DescriptionValidatorParts
): T {
  const {
    descriptionGeneration: _generation,
    descriptionVersion: _version,
    ...body
  } = stored
  return body as T
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
 * `W/` prefix is dropped and `W/"g.3"` names the same validator as `"g.3"`. A
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
 * matches a representation with no `ETag` too (a legacy record, or metadata
 * never written); a listed validator can only match a representation that has
 * one.
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
