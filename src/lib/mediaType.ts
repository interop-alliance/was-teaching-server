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
