/**
 * Opaque pagination cursor codec for the List Collection operation (spec
 * "Pagination"). A cursor names the position to resume an ordered keyset scan
 * from -- here, the `resourceId` of the last item already returned. It is
 * OPAQUE to clients: the server encodes and decodes it, and the client only ever
 * echoes back the `cursor` baked into a prior page's `next` URL.
 *
 * The encoding is `base64url(JSON.stringify({ after }))`. It is deliberately not
 * a signed or encrypted token -- it leaks nothing a caller authorized to list
 * the Collection cannot already see (a `resourceId`), and a tampered cursor is
 * rejected as `invalid-cursor` rather than trusted.
 */
import { InvalidCursorError } from '../errors.js'

/**
 * Encodes a keyset position into an opaque cursor token.
 * @param after {string} - `resourceId` of the last item already returned
 * @returns {string} - base64url-encoded cursor
 */
export function encodeCursor(after: string): string {
  return Buffer.from(JSON.stringify({ after }), 'utf8').toString('base64url')
}

/**
 * Decodes an opaque cursor token back into its keyset position. Throws
 * `InvalidCursorError` (400 `invalid-cursor`) when the token is not valid
 * base64url, is not JSON, or does not carry a string `after` -- i.e. a cursor
 * the server cannot honor (malformed, tampered with, or from another context).
 * @param cursor {string}   the cursor query parameter
 * @returns {{ after: string }}
 */
export function decodeCursor(cursor: string): { after: string } {
  // base64url charset only (no `+`, `/`, or `=` padding); `Buffer` decoding is
  // lenient and would silently drop stray characters, so reject them up front.
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new InvalidCursorError()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch (err) {
    throw new InvalidCursorError({ cause: err as Error })
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { after?: unknown }).after !== 'string'
  ) {
    throw new InvalidCursorError()
  }
  return { after: (parsed as { after: string }).after }
}
