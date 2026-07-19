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

/**
 * Prefix of a Resource's per-Resource chunk directory
 * (`.chunks.<encodedResourceId>/`), which holds the chunk representations of a
 * chunked Resource (the `chunked-streams` feature). The leading `.` keeps the
 * directory out of the `r.`-prefixed Collection listing, and dot-escaping the
 * id segment keeps it in one filesystem-name namespace with the Resource files.
 */
export const CHUNK_DIR_PREFIX = '.chunks.'

/**
 * Builds the on-disk directory name for a Resource's chunk directory:
 * `.chunks.<encodedResourceId>`. The id segment is dot-escaped (see
 * {@link encodeFilenameSegment}) so a dotted id round-trips.
 * @param resourceId {string}
 * @returns {string}
 */
export function chunkDirName(resourceId: string): string {
  return `${CHUNK_DIR_PREFIX}${encodeFilenameSegment(resourceId)}`
}

/**
 * Largest addressable chunk index. 2^31-1 (`int4` max): the Postgres backend
 * stores the index in an `integer` column, so the shared validation caps it
 * there and both backends agree on the addressable range.
 */
export const MAX_CHUNK_INDEX = 2 ** 31 - 1

/**
 * Canonical non-negative decimal integer: `0`, or a digit run with no leading
 * zero. Rejecting non-canonical spellings (`01`, `+1`, `1e3`) keeps every chunk
 * addressable at exactly one URL (and at exactly one archive file name).
 */
const CHUNK_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/

/**
 * Parses a chunk-index segment -- the `:chunkIndex` path param, or the
 * `<index>` segment of a chunk file name (`r.<index>.<encType>.<ext>` /
 * `.meta.<index>.json`) -- into its number. Returns `undefined` unless the
 * segment is the canonical decimal spelling of an integer in
 * `[0, MAX_CHUNK_INDEX]`. The single shared predicate for the live route and
 * both backends' import paths, so a chunk index means the same thing
 * everywhere.
 * @param segment {string}
 * @returns {number | undefined}
 */
export function parseChunkIndexSegment(segment: string): number | undefined {
  if (!CHUNK_INDEX_PATTERN.test(segment)) {
    return undefined
  }
  const chunkIndex = Number(segment)
  return chunkIndex <= MAX_CHUNK_INDEX ? chunkIndex : undefined
}

/**
 * Parses a chunk directory name (`.chunks.<encodedResourceId>`) back into its
 * parent `resourceId`, reversing {@link chunkDirName}. Returns `undefined` when
 * the name is not a chunk directory (no matching prefix, or an empty id
 * segment).
 * @param dirName {string}   the basename of the directory
 * @returns {string | undefined}
 */
export function parseChunkDirName(dirName: string): string | undefined {
  if (!dirName.startsWith(CHUNK_DIR_PREFIX)) {
    return undefined
  }
  const encodedId = dirName.slice(CHUNK_DIR_PREFIX.length)
  return encodedId.length > 0 ? decodeURIComponent(encodedId) : undefined
}
