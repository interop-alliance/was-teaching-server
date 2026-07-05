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
