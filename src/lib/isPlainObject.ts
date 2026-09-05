/**
 * Helper: true for a plain (non-null, non-array) object -- the shape a JSON
 * request body, a `custom` metadata block, or an indexable `content` source
 * must have. Narrows to `Record<string, unknown>` so call sites do not re-derive
 * the same three-part check by hand.
 * @param value {unknown}
 * @returns {boolean}
 */
export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
