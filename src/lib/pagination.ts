/**
 * Shared cursor-pagination shaping for the List Collection operation and the
 * change feed (spec "Pagination"): page sizing, the keyset seek that turns an
 * ordered array plus a cursor into one page, the `next` continuation-link
 * template, and the query-parameter coercion the listing handlers apply. Every
 * paginated site goes through these, so an oversized `limit`, a repeated
 * parameter, a page boundary, and a `next` URL all behave identically
 * everywhere.
 */
import { decodeCursor, encodeCursor } from './cursor.js'

/**
 * Page sizing: `DEFAULT_PAGE_SIZE` applies when a request omits `limit`;
 * `MAX_PAGE_SIZE` is the server maximum an oversized `limit` is clamped down to
 * (rather than rejected).
 */
export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 1000

/**
 * Clamps a requested `limit` to `[1, MAX_PAGE_SIZE]`.
 * @param limit {number}
 * @returns {number}
 */
export function clampPageSize(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE)
}

/**
 * Compares two strings in code-unit order (the order the `<` / `>` operators
 * use), returning -1 / 0 / 1. Keyset pagination sorts and seeks with the same
 * operator, so the comparator must agree with `>` -- `localeCompare` can not.
 * One shared definition for both backends' keyset sorts and the List Spaces
 * handler's in-memory ordering.
 * @param left {string}
 * @param right {string}
 * @returns {number}
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Resolves a requested `limit` to the page size actually used: clamped to
 * `[1, MAX_PAGE_SIZE]`, defaulting to `DEFAULT_PAGE_SIZE` when absent.
 * @param [limit] {number}   requested page size
 * @returns {number}
 */
export function resolvePageSize(limit?: number): number {
  return limit === undefined ? DEFAULT_PAGE_SIZE : clampPageSize(limit)
}

/**
 * Cuts one page out of an array already sorted in ascending keyset order
 * (code-unit, matching the `>` seek below), resuming strictly after a cursor's
 * anchor key. Keyset stability: a missing anchor (deleted between pages) does
 * not break the scan, since we resume at the first key greater than it. A
 * malformed cursor rejects with `invalid-cursor` (400), via `decodeCursor`.
 *
 * Takes `pageSize + 1` items from the seek point to detect a further page
 * without a second pass; the page is the first `pageSize`, and `hasMore` is
 * whether the extra one arrived (so a page that exactly fills the list has no
 * spurious empty trailing page).
 *
 * @param options {object}
 * @param options.items {Item[]}   the full list, in keyset order
 * @param [options.cursor] {string}   opaque cursor from a prior page
 * @param options.pageSize {number}   resolved page size
 * @param options.keyOf {Function}   reads an item's keyset key
 * @returns {{ page: Item[], hasMore: boolean }}
 */
export function seekPage<Item>({
  items,
  cursor,
  pageSize,
  keyOf
}: {
  items: Item[]
  cursor?: string
  pageSize: number
  keyOf: (item: Item) => string
}): { page: Item[]; hasMore: boolean } {
  let startIndex = 0
  if (cursor !== undefined) {
    const { after } = decodeCursor(cursor)
    const found = items.findIndex(item => keyOf(item) > after)
    startIndex = found === -1 ? items.length : found
  }

  const window = items.slice(startIndex, startIndex + pageSize + 1)
  const hasMore = window.length > pageSize
  const page = hasMore ? window.slice(0, pageSize) : window
  return { page, hasMore }
}

/**
 * Builds a page's `next` continuation URL. The cursor (the last key on the
 * page) and, where the listing echoes it, the page size are baked into the URL
 * so the client follows it verbatim without constructing query parameters.
 * `limit` is omitted for listings whose page size is not client-selectable.
 * @param options {object}
 * @param options.path {string}   the listing's own URL, without a query
 * @param [options.limit] {number}   page size to echo back
 * @param options.after {string}   keyset key of the last item on this page
 * @returns {string}
 */
export function nextPageUrl({
  path,
  limit,
  after
}: {
  path: string
  limit?: number
  after: string
}): string {
  const params = [
    ...(limit !== undefined ? [`limit=${limit}`] : []),
    `cursor=${encodeCursor(after)}`
  ]
  return `${path}?${params.join('&')}`
}

/**
 * Reads the `limit` / `cursor` pagination parameters off a listing request's
 * query string. Both are single-valued; a repeated value (an array) is ignored
 * and falls back to the default page size. `limit` is coerced to a positive
 * integer -- a non-numeric or `< 1` value resolves to `undefined`, so the
 * backend applies its own default. `cursor` is opaque and passed through
 * verbatim -- the backend validates it and rejects a malformed one with
 * `invalid-cursor` (400).
 * @param options {object}
 * @param options.query {Record<string, string | string[] | undefined>}
 * @returns {{ limit?: number, cursor?: string }}
 */
export function parsePageParams({
  query
}: {
  query: Record<string, string | string[] | undefined>
}): { limit?: number; cursor?: string } {
  const rawLimit = query.limit
  const rawCursor = query.cursor
  const parsedLimit = typeof rawLimit === 'string' ? Number(rawLimit) : NaN
  return {
    ...(Number.isFinite(parsedLimit) && parsedLimit >= 1
      ? { limit: parsedLimit }
      : {}),
    ...(typeof rawCursor === 'string' && { cursor: rawCursor })
  }
}
