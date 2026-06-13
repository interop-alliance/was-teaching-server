/**
 * Typed shim over `@interop/http-digest-header`. The package ships its
 * declarations under `types/`, but its package.json `exports` map omits a
 * `types` condition, so NodeNext resolution cannot find them and treats the
 * import as untyped. Re-export the one function this server uses with an
 * explicit signature so the rest of the codebase stays fully typed (and the
 * runtime import resolves normally via the package's `exports`).
 */
// @ts-expect-error -- untyped import; see the file header.
import { verifyHeaderValue as _verifyHeaderValue } from '@interop/http-digest-header'

/**
 * Verifies an HTTP `Digest` header value (e.g. `mh=uEi...`) against the given
 * request body bytes, recomputing the digest and comparing.
 * @param options {object}
 * @param options.data {Buffer | Uint8Array | string}   the received body bytes
 * @param options.headerValue {string}   the `Digest` header value to check
 * @returns {Promise<{ verified: boolean, error?: Error }>}   `verified` is false
 *   on a mismatch; `error` is set when the header value was malformed
 */
export async function verifyHeaderValue(options: {
  data: Buffer | Uint8Array | string
  headerValue: string
}): Promise<{ verified: boolean; error?: Error }> {
  return _verifyHeaderValue(options)
}
