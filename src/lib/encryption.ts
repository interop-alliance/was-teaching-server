/**
 * Collection client-side encryption marker helpers (spec "Encrypted
 * Collections"). A Collection MAY carry a non-secret `encryption` marker
 * declaring that its Resources are client-encrypted and naming the scheme; any
 * authorized reader discovers it by reading the Collection Description and then
 * decrypts with its own keys. The server never decrypts: it validates only the
 * marker's *shape* and enforces *set-once* immutability, storing the value
 * opaquely. This mirrors the backend-selection helpers in lib/backends.ts
 * (validate on write / preserve on read), kept separate because encryption is a
 * per-Collection client concern, not a backend capability.
 */
import type { CollectionEncryption } from '../types.js'
import { InvalidRequestBodyError, EncryptionImmutableError } from '../errors.js'

/**
 * Validates a client-supplied Collection `encryption` marker and returns the
 * normalized value to persist, or `undefined` when absent (plaintext). Shape
 * only: a present value must be an object with a non-empty string `scheme`;
 * anything else is `invalid-request-body` (400, pointer `#/encryption`). The
 * server never decrypts, so it does **not** gate on the `scheme` value -- an
 * unknown future scheme still round-trips. The whole marker object is preserved
 * (not reduced to `{ scheme }`) so future public-reference fields a newer client
 * may add (e.g. recipient key references) survive an older server unchanged.
 *
 * @param options {object}
 * @param [options.encryption] {unknown}   the request body's `encryption` value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {CollectionEncryption | undefined}   the marker to store, or undefined
 */
export function assertSupportedEncryption({
  encryption,
  requestName
}: {
  encryption?: unknown
  requestName?: string
}): CollectionEncryption | undefined {
  if (encryption === undefined) {
    return undefined
  }
  const scheme = (encryption as { scheme?: unknown })?.scheme
  if (
    typeof encryption !== 'object' ||
    encryption === null ||
    typeof scheme !== 'string' ||
    scheme.length === 0
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "encryption" must be an object with a non-empty string "scheme".',
      pointer: '#/encryption'
    })
  }
  // Store opaquely (only `scheme` is typed today; preserve any extra fields).
  return encryption as CollectionEncryption
}

/**
 * Enforces set-once immutability of a Collection's `encryption` marker on
 * update. Call only when an `incoming` marker was supplied (and shape-validated)
 * by the request. Declaring a marker on a Collection that lacks one is allowed
 * (`absent -> present`: late declaration / migration of a pre-marker
 * Collection); re-sending the same `scheme` is a no-op. Changing the `scheme` of
 * an existing marker is rejected with `encryption-immutable` (409) -- it would
 * corrupt the stored, client-encrypted Resources. (Clearing is not expressible:
 * an absent body `encryption` leaves the existing marker untouched, and an
 * explicit non-object is already a 400 in `assertSupportedEncryption`.) The
 * `scheme` is the immutable identity; comparison deliberately ignores any
 * future public-reference fields, whose evolution (e.g. adding a recipient) is a
 * separate, allowed operation.
 *
 * @param options {object}
 * @param [options.existing] {CollectionEncryption}   the persisted marker
 * @param options.incoming {CollectionEncryption}   the validated request marker
 * @returns {void}
 */
export function assertEncryptionTransition({
  existing,
  incoming
}: {
  existing?: CollectionEncryption
  incoming: CollectionEncryption
}): void {
  if (existing !== undefined && existing.scheme !== incoming.scheme) {
    throw new EncryptionImmutableError()
  }
}
