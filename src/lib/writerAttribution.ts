/**
 * Helpers for the client-declared writer-attribution label on a Resource (the
 * spec's "Writer attribution" section: `writerId`). An opaque string the
 * writing agent volunteers about itself, naming which writing agent produced
 * the current revision; the server stores and serves it verbatim and never
 * verifies it, computes it, or uses it as an authorization input.
 *
 * On a **content** write (`POST` / `PUT` that writes a Resource's content)
 * and on `DELETE`, the label is declared via the `Writer-Id` request header --
 * the same mechanism `Key-Epoch` uses. A `PUT .../meta` may also declare
 * `writerId` as a top-level member of the body (a sibling of `custom` and
 * `epoch`).
 *
 * Unlike `epoch`, `writerId` is declare-or-clear at EVERY level, metadata
 * writes included: a write that declares no `writerId` clears any stored
 * value, since attribution to a bygone writer is worse than none. A metadata
 * write does not preserve it on omission the way it preserves `epoch` (see
 * {@link parseMetaWriterId}).
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

/**
 * Validates and extracts the OPTIONAL top-level `writerId` member of an
 * Update Resource Metadata (`PUT .../meta`) body. A present value must be a
 * non-empty string (400 otherwise); returns `{ writerId: string }` when
 * supplied, or `{}` when the member is absent. Unlike the `epoch` stamp's
 * `parseMetaEpoch`, an absent `writerId` is not a "leave it alone" signal:
 * the caller passes this result's `writerId` straight through to
 * `writeResourceMetadata`, whose backend implementation always sets the
 * stored label from it (clearing when `undefined`) rather than preserving a
 * prior value.
 * @param options {object}
 * @param options.body {object}   the parsed request body (already known to be an object)
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {{ writerId?: string }}
 */
export function parseMetaWriterId({
  body,
  requestName
}: {
  body: Record<string, unknown>
  requestName?: string
}): { writerId?: string } {
  if (!Object.hasOwn(body, 'writerId')) {
    return {}
  }
  const value = body.writerId
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The "writerId" property must be a non-empty string.',
      pointer: '/writerId'
    })
  }
  return { writerId: value }
}
