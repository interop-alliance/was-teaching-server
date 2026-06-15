/**
 * Helpers for the HTTP `ETag` strong validator that backs conditional writes
 * (the `conditional-writes` feature). A Resource's monotonic `version` is
 * formatted as a quoted strong validator on the wire, and incoming `If-Match` /
 * `If-None-Match` request headers are normalized into write preconditions.
 */

/**
 * Formats a Resource's monotonic `version` as a quoted strong `ETag` validator
 * (e.g. version 3 to `"3"`). The quotes are part of the on-the-wire value, and
 * `If-Match` comparison is exact-string (strong) comparison.
 * @param version {number}
 * @returns {string}
 */
export function formatEtag(version: number): string {
  return `"${version}"`
}

/**
 * Normalizes the `If-Match` / `If-None-Match` request headers into the write
 * preconditions the storage layer evaluates. Only `If-None-Match: *`
 * (create-if-absent) is supported; an `If-Match` value is passed through as the
 * quoted ETag to match. A header that is absent (or, for an array-valued header,
 * not a single string) contributes no precondition.
 * @param headers {object}
 * @param [headers.if-match] {string | string[]}
 * @param [headers.if-none-match] {string | string[]}
 * @returns {{ ifMatch?: string, ifNoneMatch?: boolean }}
 */
export function parseWritePreconditions(headers: {
  'if-match'?: string | string[]
  'if-none-match'?: string | string[]
}): { ifMatch?: string; ifNoneMatch?: boolean } {
  const ifMatch = headers['if-match']
  const ifNoneMatch = headers['if-none-match']
  return {
    ...(typeof ifMatch === 'string' && { ifMatch }),
    ...(ifNoneMatch === '*' && { ifNoneMatch: true })
  }
}
