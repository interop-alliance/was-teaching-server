/**
 * Shared page sizing for the List Collection operation's cursor-based
 * pagination and the change feed (spec "Pagination"). Both storage backends
 * clamp through these so an oversized `limit` behaves identically everywhere.
 */

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
