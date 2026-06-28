/**
 * On-disk resource-filename codec: the single shared home for encoding a
 * Resource's representation file name (`r.<resourceId>.<encodedContentType>.<ext>`)
 * and decoding it back. Kept low-level (no imports from `src/backends/` or
 * `importTar.ts`) so both the filesystem backend and the tar importer can depend
 * on it without an import cycle.
 */
import * as mime from 'mime-types'

/**
 * Percent-encodes a filename segment so it carries no literal `.`, the
 * structural delimiter of `r.<resourceId>.<encodedContentType>.<ext>`.
 * `encodeURIComponent` leaves `.` unescaped, so escape it explicitly to `%2E`;
 * `decodeURIComponent` reverses both. This keeps resource ids and content-types
 * that legitimately contain dots (e.g. `index.html`, `application/vnd.api+json`)
 * unambiguously parseable -- without it, a dotted id mis-splits and is read back
 * under the wrong id and content-type. For dot-free segments (the common case)
 * the result is byte-identical to the previous `encodeURIComponent`-only scheme.
 * @param segment {string}
 * @returns {string}
 */
export function encodeFilenameSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\./g, '%2E')
}

/**
 * Builds the on-disk filename for a resource representation:
 * `r.<resourceId>.<encodedContentType>.<ext>`. Both the `resourceId` and
 * content-type segments are dot-escaped (see {@link encodeFilenameSegment}) so
 * the three `.` separators are the only literal dots.
 * @param options {object}
 * @param options.resourceId {string}
 * @param options.contentType {string}
 * @returns {string}
 */
export function fileNameFor({
  resourceId,
  contentType
}: {
  resourceId: string
  contentType: string
}): string {
  const encodedId = encodeFilenameSegment(resourceId)
  const encodedType = encodeFilenameSegment(contentType)
  const extension = mime.extension(contentType) || 'blob'
  return `r.${encodedId}.${encodedType}.${extension}`
}

/**
 * Parses an on-disk resource filename (`r.<resourceId>.<encodedContentType>.<ext>`)
 * back into its components, reversing the dot-escaping {@link fileNameFor}
 * applies. Returns the exact stored content-type (decoded from the filename
 * segment, more reliable than `mime.lookup` on the extension), falling back to
 * the spec default `application/octet-stream` if unparseable.
 * @param fileName {string}   the basename of the resource file
 * @returns {{ resourceId: string, contentType: string }}
 */
export function parseResourceFileName(fileName: string): {
  resourceId: string
  contentType: string
} {
  const [, encodedId, encodedType] = fileName.split('.')
  return {
    resourceId: encodedId ? decodeURIComponent(encodedId) : '',
    contentType: encodedType
      ? decodeURIComponent(encodedType)
      : 'application/octet-stream'
  }
}
