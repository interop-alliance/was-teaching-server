/**
 * Request-body shape guards shared by the request handlers: the "must be a JSON
 * object" check and the "no properties beyond an allowlist" check, both failing
 * with `InvalidRequestBodyError` (400). Handlers keep their own field-level
 * validation; these cover only the envelope shape every strict body shares.
 */
import { InvalidRequestBodyError } from '../errors.js'
import { isPlainObject } from './isPlainObject.js'

/**
 * Asserts a parsed body is a plain JSON object (not null, not an array) and
 * narrows it.
 * @param options {object}
 * @param options.body {unknown}   the parsed request body
 * @param options.requestName {string}   request name used in the error title
 * @param options.detail {string}   problem detail for the failure
 * @returns {Record<string, unknown>}   the body, narrowed
 */
export function assertJsonObjectBody({
  body,
  requestName,
  detail
}: {
  body: unknown
  requestName: string
  detail: string
}): Record<string, unknown> {
  if (!isPlainObject(body)) {
    throw new InvalidRequestBodyError({ requestName, detail })
  }
  return body
}

/**
 * Asserts an object carries no keys outside `allowedKeys`. The failure names
 * the offending key as `Unexpected <label> "<key>".`, with a JSON pointer of
 * `<pointerPrefix>/<key>` when a prefix is given (omit it for query strings,
 * which have no body pointer).
 * @param options {object}
 * @param options.value {Record<string, unknown>}   the object to check
 * @param options.allowedKeys {string[]}   the permitted property names
 * @param options.requestName {string}   request name used in the error title
 * @param options.label {string}   what the object is, for the detail text
 *   (e.g. `operation property`, `query parameter`)
 * @param [options.pointerPrefix] {string}   JSON pointer to the object
 *   (`#` for the body root, `#/invocationTarget` for a nested object)
 * @returns {void}
 */
export function assertOnlyAllowedKeys({
  value,
  allowedKeys,
  requestName,
  label,
  pointerPrefix
}: {
  value: Record<string, unknown>
  allowedKeys: readonly string[]
  requestName: string
  label: string
  pointerPrefix?: string
}): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Unexpected ${label} "${key}".`,
        ...(pointerPrefix !== undefined && {
          // RFC 6901 reference-token escaping: `~` then `/`, in that order.
          pointer: `${pointerPrefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
        })
      })
    }
  }
}
