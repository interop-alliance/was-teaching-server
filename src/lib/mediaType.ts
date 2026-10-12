/**
 * Helper: the bare media type of a `Content-Type` value, with its parameters
 * (`; charset=utf-8`) stripped and lowercased for case-insensitive comparison.
 * An absent value yields the empty string.
 * @param options {object}
 * @param [options.contentType] {string}
 * @returns {string}
 */
export function bareMediaType({
  contentType
}: {
  contentType?: string
}): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase()
}

/**
 * Whether two content types name the same media type. Parameters (a
 * `charset`, a `boundary`) and case are ignored, so a write that adds
 * `; charset=utf-8` still names the stored representation's type.
 * @param stored {string}   the stored representation's content type
 * @param incoming {string}   the write's content type
 * @returns {boolean}
 */
export function sameMediaType(stored: string, incoming: string): boolean {
  return (
    bareMediaType({ contentType: stored }) ===
    bareMediaType({ contentType: incoming })
  )
}

/**
 * Whether a `Content-Type` names `multipart/form-data`, the one multipart type
 * `@fastify/multipart` parses. Parameters (the `boundary`) and case are
 * ignored. Any other `multipart/*` type is an opaque representation the server
 * stores as a blob.
 * @param options {object}
 * @param [options.contentType] {string}
 * @returns {boolean}
 */
export function isMultipartFormData({
  contentType
}: {
  contentType?: string
}): boolean {
  return bareMediaType({ contentType }) === 'multipart/form-data'
}
