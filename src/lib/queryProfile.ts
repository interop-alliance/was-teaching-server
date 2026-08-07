/**
 * The query envelope shared by the Collection `POST .../query` profiles. The
 * `blinded-index` and `equality` profiles differ only in what an `equals`
 * element's attribute names and values MEAN (opaque blinded strings vs declared
 * plaintext attributes); the envelope around them -- exactly one of
 * `equals` / `has`, the `has` name array, the `count` flag, the opaque `cursor`,
 * and the lenient `limit` coercion -- is identical, so it is validated here once
 * (`lib/blindedIndex.ts` and `lib/equalityIndex.ts` each keep only their
 * profile-specific `equals` element check).
 *
 * Wording that a client can observe differs per profile ("blinded attribute
 * names" vs "declared attribute names"), so those messages are parameterized
 * rather than unified.
 */
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
export function assertCountIsBoolean({
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
export function parseOptionalCursor({
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
 * Lenient `limit` coercion, the same rule as the `changes` profile: a
 * non-numeric or `< 1` value resolves to `undefined` so the backend applies its
 * own default, and an oversized one is left for the backend to clamp.
 *
 * @param options {object}
 * @param [options.limit] {unknown}   the body's `limit` value
 * @returns {number | undefined}
 */
export function coerceQueryLimit({
  limit
}: {
  limit?: unknown
}): number | undefined {
  const parsedLimit = Number(limit)
  return Number.isFinite(parsedLimit) && parsedLimit >= 1
    ? parsedLimit
    : undefined
}
