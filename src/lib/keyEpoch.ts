/**
 * Helpers for the client-declared key-epoch stamp on encrypted-Collection
 * Resources (the `key-epochs` feature). A writer declares which epoch key
 * encrypted a Resource's content so a reader can pick the right key BEFORE
 * attempting decryption; the value is advisory metadata the server stores
 * opaquely and never computes or verifies (a write may race a rotation).
 *
 * On a **content** write the epoch is declared via the `WAS-Key-Epoch` request
 * header -- one mechanism that works uniformly for JSON, raw-stream binary, and
 * multipart writes. It is deliberately NOT signature-covered (like `If-Match`):
 * it is advisory client-declared metadata, not part of the capability
 * invocation. A content write stores the header's value when present and CLEARS
 * the stamp when absent -- the new ciphertext's epoch is unknown, and a stale
 * stamp is worse than none (a reader falls back to `currentEpoch` and can try
 * other epochs). A `PUT .../meta` may also declare `epoch` as a top-level member
 * of the body (a sibling of `custom`), where omitting it PRESERVES the stored
 * value -- see the `putMeta` handler.
 *
 * The only validation is that a present value is a non-empty string (400
 * otherwise); the server never checks it against the Collection marker's epochs.
 */
import { InvalidRequestBodyError } from '../errors.js'

/** The request header carrying the client-declared key-epoch on a content write. */
export const KEY_EPOCH_HEADER = 'was-key-epoch'

/**
 * Parses the OPTIONAL `WAS-Key-Epoch` request header into the epoch stamp for a
 * content write. Resolves `{ epoch: string }` for a non-empty single-valued
 * header, `{ epoch: undefined }` when absent (the content write clears any
 * stored stamp), and throws `invalid-request-body` (400) for an empty or
 * array-valued header.
 * @param options {object}
 * @param options.headers {object}   the Fastify request headers
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {{ epoch?: string }}
 */
export function parseKeyEpochHeader({
  headers,
  requestName
}: {
  headers: Record<string, string | string[] | undefined>
  requestName?: string
}): { epoch?: string } {
  const value = headers[KEY_EPOCH_HEADER]
  if (value === undefined) {
    return {}
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The "WAS-Key-Epoch" header must be a non-empty string.'
    })
  }
  return { epoch: value }
}

/**
 * Validates and extracts the OPTIONAL top-level `epoch` member of an Update
 * Resource Metadata (`PUT .../meta`) body. Unlike a content write, a metadata
 * write PRESERVES the stored epoch when the member is omitted (the stamp
 * describes the content write, not the metadata write); a present value must be
 * a non-empty string (400 otherwise). Returns `{ epoch: string }` when supplied,
 * or `{}` when the member is absent (preserve).
 * @param options {object}
 * @param options.body {object}   the parsed request body (already known to be an object)
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {{ epoch?: string }}
 */
export function parseMetaEpoch({
  body,
  requestName
}: {
  body: Record<string, unknown>
  requestName?: string
}): { epoch?: string } {
  if (!Object.hasOwn(body, 'epoch')) {
    return {}
  }
  const value = body.epoch
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The "epoch" property must be a non-empty string.',
      pointer: '/epoch'
    })
  }
  return { epoch: value }
}
