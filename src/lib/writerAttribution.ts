/**
 * Helpers for the client-declared writer-attribution label on a Resource (the
 * spec's "Writer attribution" section: `writerId`). An opaque string the
 * writing agent volunteers about itself, naming which writing agent produced
 * the current content revision; the server stores and serves it verbatim and
 * never verifies it, computes it, or uses it as an authorization input.
 *
 * The label belongs to the content record. It is declared via the
 * `Writer-Id` request header on a **content** write (`POST` / `PUT` that
 * writes a Resource's content) and on `DELETE` -- the same mechanism
 * `Key-Epoch` uses -- and is declare-or-clear there: a write that declares no
 * `writerId` clears any stored value, since attribution to a bygone writer is
 * worse than none. A metadata write (`PUT .../meta`) leaves it untouched; a
 * `writerId` member in its body is not read.
 *
 * The only validation is that a present value is a non-empty string (400
 * otherwise); the server never verifies it against anything.
 */
import { InvalidRequestBodyError } from '../errors.js'

/**
 * The request header carrying the client-declared writer-attribution label on
 * a content write or a delete. Lowercase, matching how Fastify normalizes
 * request header keys (the wire header name is `Writer-Id`; HTTP header names
 * are case-insensitive).
 */
export const WRITER_ID_HEADER = 'writer-id'

/**
 * Parses the OPTIONAL `Writer-Id` request header into the writer-attribution
 * label for a content write or a delete. Resolves `{ writerId: string }` for
 * a non-empty single-valued header, `{ writerId: undefined }` when absent
 * (the write clears any stored label), and throws `invalid-request-body`
 * (400) for an empty or array-valued header.
 * @param options {object}
 * @param options.headers {object}   the Fastify request headers
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {{ writerId?: string }}
 */
export function parseWriterIdHeader({
  headers,
  requestName
}: {
  headers: Record<string, string | string[] | undefined>
  requestName?: string
}): { writerId?: string } {
  const value = headers[WRITER_ID_HEADER]
  if (value === undefined) {
    return {}
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The "Writer-Id" header must be a non-empty string.'
    })
  }
  return { writerId: value }
}
