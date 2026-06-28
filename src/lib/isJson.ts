/**
 * Helper: true if a content-type denotes JSON -- `application/json` or any
 * `application/<prefix>+json` structured-suffix variant (e.g.
 * `application/ld+json`, `application/vnd.api+json`), each optionally followed
 * by parameters (`; charset=utf-8`). The `json` token is anchored to the end of
 * the media type so non-JSON types that merely begin with `json` --
 * `application/jsonl`, `application/json-seq`, `application/json5` -- are NOT
 * treated as JSON and instead take the binary blob path.
 * @param options {object}
 * @param options.contentType {string}
 * @returns {boolean}
 */
export function isJson({ contentType }: { contentType?: string }): boolean {
  return (
    typeof contentType === 'string' &&
    /^application\/(?:[^+\s;]+\+)?json\s*(?:;.*)?$/i.test(contentType)
  )
}
