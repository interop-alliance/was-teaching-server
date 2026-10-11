/**
 * Helpers for stored JSON bytes that may not parse: a file read off the disk
 * or an archive entry. Each one treats bytes that are not JSON as a value it
 * leaves alone, rather than an error.
 */
import { isPlainObject } from './isPlainObject.js'

/**
 * Parses JSON text, or bytes read as UTF-8.
 * @param text {string | Buffer}
 * @returns {unknown}   `undefined` when the text does not parse
 */
export function parseJsonOrUndefined(text: string | Buffer): unknown {
  try {
    return JSON.parse(typeof text === 'string' ? text : text.toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Parses bytes that should hold a JSON object.
 * @param bytes {Buffer}
 * @returns {Record<string, unknown> | undefined}   `undefined` for bytes that
 *   do not parse, or that hold a value other than a plain object
 */
export function parseJsonObjectBytes(
  bytes: Buffer
): Record<string, unknown> | undefined {
  const parsed = parseJsonOrUndefined(bytes)
  return isPlainObject(parsed) ? parsed : undefined
}

/**
 * Removes members from a JSON object's bytes, keeping the order of the rest.
 * Bytes that do not parse as a JSON object, or that carry none of the
 * members, are returned unchanged.
 * @param options {object}
 * @param options.bytes {Buffer}
 * @param options.members {Array<string>}
 * @returns {Buffer}
 */
export function withoutJsonMembers({
  bytes,
  members
}: {
  bytes: Buffer
  members: ReadonlyArray<string>
}): Buffer {
  const parsed = parseJsonObjectBytes(bytes)
  if (parsed === undefined || !members.some(member => member in parsed)) {
    return bytes
  }
  const rest = { ...parsed }
  for (const member of members) {
    delete rest[member]
  }
  return Buffer.from(JSON.stringify(rest))
}
