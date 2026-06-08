/**
 * Validation for the `controller` DID supplied in Space Description request
 * bodies. The server's only DID method is `did:key` with Ed25519 keys, whose
 * multibase encoding always begins `z6Mk` (the `0xed01` Ed25519-pub multicodec
 * prefix) followed by base58btc characters. This asserts that shape at the
 * request layer so a malformed or non-`did:key` controller is rejected on the
 * way in, rather than being stored and only failing later at
 * capability-verification time.
 */
import { InvalidControllerError } from '../errors.js'
import type { IDID } from '../types.js'

// An Ed25519 `did:key` is `did:key:` + `z6Mk` + a base58btc payload. The
// base58btc (Bitcoin) alphabet omits `0`, `O`, `I`, and `l`.
const DID_KEY_ED25519_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/

/**
 * Returns true when `value` is a syntactically valid Ed25519 `did:key` DID.
 * @param value {unknown}
 * @returns {boolean}
 */
export function isValidController(value: unknown): value is IDID {
  return typeof value === 'string' && DID_KEY_ED25519_PATTERN.test(value)
}

/**
 * Asserts that `controller` is a valid Ed25519 `did:key`, throwing
 * InvalidControllerError (400) otherwise.
 * @param controller {unknown}   the `controller` value from the request body
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {void}
 */
export function assertValidController(
  controller: unknown,
  { requestName }: { requestName?: string } = {}
): void {
  if (!isValidController(controller)) {
    throw new InvalidControllerError({ requestName })
  }
}
