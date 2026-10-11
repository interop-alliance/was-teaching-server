/**
 * The query envelope shared by the Collection `POST .../query` profiles. The
 * `blinded-index` and `equality` profiles differ only in what an `equals`
 * element's attribute names and values MEAN (opaque blinded strings vs declared
 * plaintext attributes); the envelope around them -- exactly one of
 * `equals` / `has`, the `has` name array, the `count` flag, the opaque `cursor`,
 * and the lenient `limit` coercion -- is identical, so it is validated here once
 * (`lib/blindedIndex.ts` and `lib/equalityIndex.ts` each keep only their
 * profile-specific `equals` element check). The step that shapes a result
 * from the matching candidates (`pageMatches`) and the unique-claim overlap
 * check (`assertNoTermOverlap`) are shared here too.
 *
 * Wording that a client can observe differs per profile ("blinded attribute
 * names" vs "declared attribute names"), so those messages are parameterized
 * rather than unified.
 */
import { encodeCursor } from './cursor.js'
import {
  coerceQueryLimit,
  compareCodeUnits,
  resolvePageSize,
  seekPage
} from './pagination.js'
import { InvalidRequestBodyError } from '../errors.js'

/**
 * Asserts the query body carries exactly one of `equals` / `has` -- supplying
 * neither, or both, is `invalid-request-body` (400). The profiles word this
 * message differently, so the caller supplies it.
 *
 * @param options {object}
 * @param [options.equals] {unknown}   the body's `equals` value
 * @param [options.has] {unknown}   the body's `has` value
 * @param options.detail {string}   the profile's error detail
 * @param [options.requestName] {string}
 * @returns {void}
 */
export function assertExactlyOneOfEqualsOrHas({
  equals,
  has,
  detail,
  requestName
}: {
  equals?: unknown
  has?: unknown
  detail: string
  requestName?: string
}): void {
  if ((equals === undefined) === (has === undefined)) {
    throw new InvalidRequestBodyError({ requestName, detail })
  }
}

/**
 * Asserts `equals` is a non-empty array, returning it for the caller's
 * profile-specific per-element validation.
 *
 * @param options {object}
 * @param options.equals {unknown}   the body's `equals` value
 * @param [options.requestName] {string}
 * @returns {unknown[]}
 */
export function assertEqualsIsNonEmptyArray({
  equals,
  requestName
}: {
  equals: unknown
  requestName?: string
}): unknown[] {
  if (!Array.isArray(equals) || equals.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: '"equals" must be a non-empty array of objects.',
      pointer: '#/equals'
    })
  }
  return equals
}

/**
 * Asserts `has` is a non-empty array of strings, returning it. What those
 * strings NAME differs per profile (blinded attribute names vs declared index
 * names), so the caller supplies the message and applies any further check.
 *
 * @param options {object}
 * @param options.has {unknown}   the body's `has` value
 * @param options.detail {string}   the profile's error detail
 * @param [options.requestName] {string}
 * @returns {string[]}
 */
export function assertHasIsNonEmptyStringArray({
  has,
  detail,
  requestName
}: {
  has: unknown
  detail: string
  requestName?: string
}): string[] {
  if (
    !Array.isArray(has) ||
    has.length === 0 ||
    has.some(name => typeof name !== 'string')
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail,
      pointer: '#/has'
    })
  }
  return has as string[]
}

/**
 * Asserts the optional `count` flag is a boolean when present.
 *
 * @param options {object}
 * @param [options.count] {unknown}   the body's `count` value
 * @param [options.requestName] {string}
 * @returns {void}
 */
function assertCountIsBoolean({
  count,
  requestName
}: {
  count?: unknown
  requestName?: string
}): void {
  if (count !== undefined && typeof count !== 'boolean') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: '"count" must be a boolean.',
      pointer: '#/count'
    })
  }
}

/**
 * Validates the optional opaque `cursor` -- a string when present -- and returns
 * it. Its CONTENT is validated by the backend's cursor decode (`invalid-cursor`
 * 400), not here.
 *
 * @param options {object}
 * @param [options.cursor] {unknown}   the body's `cursor` value
 * @param [options.requestName] {string}
 * @returns {string | undefined}
 */
function parseOptionalCursor({
  cursor,
  requestName
}: {
  cursor?: unknown
  requestName?: string
}): string | undefined {
  if (cursor === undefined) {
    return undefined
  }
  if (typeof cursor !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: '"cursor" must be a string.',
      pointer: '#/cursor'
    })
  }
  return cursor
}

/**
 * Validates and coerces the paging members both profiles' query bodies share:
 * the optional boolean `count`, the lenient `limit` (`coerceQueryLimit`), and
 * the optional opaque `cursor`, whose content the backend's cursor decode
 * validates (`invalid-cursor` 400).
 *
 * @param options {object}
 * @param [options.count] {unknown}   the body's `count` value
 * @param [options.limit] {unknown}   the body's `limit` value
 * @param [options.cursor] {unknown}   the body's `cursor` value
 * @param [options.requestName] {string}
 * @returns {{ count: boolean, limit?: number, cursor?: string }}
 */
export function parseQueryPaging({
  count,
  limit,
  cursor,
  requestName
}: {
  count?: unknown
  limit?: unknown
  cursor?: unknown
  requestName?: string
}): { count: boolean; limit?: number; cursor?: string } {
  assertCountIsBoolean({ count, requestName })

  const resolvedCursor = parseOptionalCursor({ cursor, requestName })

  const resolvedLimit = coerceQueryLimit({ limit })

  return {
    count: count === true,
    ...(resolvedLimit !== undefined && { limit: resolvedLimit }),
    ...(resolvedCursor !== undefined && { cursor: resolvedCursor })
  }
}

/**
 * Shapes a profile's query result from a Collection's candidates: a bare
 * `{count}` of the matches for a count query, else a page of the matches in
 * ascending `resourceId` (code-unit) order with the standard opaque-cursor
 * pagination (`limit` clamped to `[1, MAX_PAGE_SIZE]`, default
 * `DEFAULT_PAGE_SIZE`; `cursor` resumes strictly after its anchor id, so
 * paging stays correct if the anchor was deleted between pages). A malformed
 * `cursor` rejects with `invalid-cursor` (400). The page's `cursor` is present
 * if and only if a further page may follow (`hasMore`).
 *
 * @param options {object}
 * @param options.candidates {Candidate[]}
 * @param options.isMatch {(candidate: Candidate) => boolean}   the profile's
 *   matching rule
 * @param options.project {(candidate: Candidate) => Doc}   a match's document
 *   as the page carries it
 * @param [options.count] {boolean}   return only the match count
 * @param [options.limit] {number}   requested page size
 * @param [options.cursor] {string}   opaque cursor from a prior page
 * @returns {{ count: number } | { documents: Doc[], hasMore: boolean, cursor?: string }}
 */
export function pageMatches<Candidate extends { resourceId: string }, Doc>({
  candidates,
  isMatch,
  project,
  count,
  limit,
  cursor
}: {
  candidates: Candidate[]
  isMatch: (candidate: Candidate) => boolean
  project: (candidate: Candidate) => Doc
  count?: boolean
  limit?: number
  cursor?: string
}):
  { count: number } | { documents: Doc[]; hasMore: boolean; cursor?: string } {
  const matches = candidates
    .filter(isMatch)
    // Ascending `resourceId` in code-unit order -- the SAME ordering the
    // cursor seek (`resourceId > after`) uses, so the keyset is stable.
    .sort((left, right) => compareCodeUnits(left.resourceId, right.resourceId))

  if (count === true) {
    return { count: matches.length }
  }

  const { page, hasMore } = seekPage({
    items: matches,
    cursor,
    pageSize: resolvePageSize(limit),
    keyOf: ({ resourceId }) => resourceId
  })

  return {
    documents: page.map(project),
    hasMore,
    ...(hasMore && {
      cursor: encodeCursor(page[page.length - 1]!.resourceId)
    })
  }
}

/**
 * Enforces a unique-claim invariant on a write: no claim the incoming record
 * makes may be held by any candidate. Claims are compared by string key, so
 * the caller keys each one unambiguously. `candidates` MUST already exclude
 * the record being written, so it never self-conflicts. A record with no
 * claims never throws.
 *
 * @param options {object}
 * @param options.incoming {string[]}   the keys of the incoming record's
 *   claims
 * @param options.candidates {Candidate[]}   the Collection's other live
 *   records
 * @param options.termsOf {(candidate: Candidate) => string[]}   the keys of
 *   the claims a candidate holds
 * @param options.onConflict {() => Error}   the error a conflict throws
 * @returns {void}
 */
export function assertNoTermOverlap<Candidate>({
  incoming,
  candidates,
  termsOf,
  onConflict
}: {
  incoming: string[]
  candidates: Candidate[]
  termsOf: (candidate: Candidate) => string[]
  onConflict: () => Error
}): void {
  if (incoming.length === 0) {
    return
  }
  const claimed = new Set(incoming)
  for (const candidate of candidates) {
    if (termsOf(candidate).some(term => claimed.has(term))) {
      throw onConflict()
    }
  }
}
