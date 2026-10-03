/**
 * The validator pieces of a Space or Collection Metadata object. Such an
 * object keeps its generation and local segment out of band from its wire
 * body, beside the stamp members the body carries. The filesystem backend
 * stores the two in the object's file as the reserved `_generation` and
 * `_local` members. A read result surfaces them as `metaGeneration` and
 * `metaLocal`. This module derives the five-segment `ETag` from those parts
 * and converts between the file layout, the stored read shape, and the wire
 * body. The generic validator format lives in `lib/etag.ts`.
 */
import type { MetadataValidatorParts, WriteStamp } from '../types.js'
import { etagOf } from './etag.js'
import { stampOf } from './hlc.js'

/**
 * The five-segment `ETag` of a stored Space or Collection Metadata object:
 * its out-of-band generation and local segment beside the stamp members of
 * its body. `undefined` for an absent object (a create's prior state). A
 * record with no local segment stored reads as local 0.
 * @param [stored] {Partial<WriteStamp> & MetadataValidatorParts}
 * @returns {string | undefined}
 */
export function metadataEtagOf(
  stored?: Partial<WriteStamp> & MetadataValidatorParts
): string | undefined {
  if (stored === undefined) {
    return undefined
  }
  return etagOf({
    ...stampOf(stored),
    generation: stored.metaGeneration,
    local: stored.metaLocal ?? 0
  })
}

/**
 * The reserved members a Space or Collection Metadata file embeds beside its
 * wire body: `_generation`, the record's generation, and `_local`, the local
 * validator segment. The stamp members are wire members and are stored bare.
 */
export type EmbeddedMetadataValidator = {
  _generation?: string
  _local?: number
}

/**
 * Lifts a metadata file's on-disk layout (the wire body plus the reserved
 * `_generation` / `_local` members, the filesystem backend's convention; the
 * archive interchange shape carries `_generation` alone) into the stored read
 * shape: the two re-surfaced out of band as `metaGeneration` / `metaLocal`.
 * The inverse of `embedMetadataValidator`.
 * @param raw {T & EmbeddedMetadataValidator}
 * @returns {T & MetadataValidatorParts}
 */
export function storedMetadataFromFile<T extends object>(
  raw: T & EmbeddedMetadataValidator
): T & MetadataValidatorParts {
  const { _generation, _local, ...body } = raw
  return {
    ...(body as T),
    ...(_generation !== undefined && { metaGeneration: _generation }),
    ...(_local !== undefined && { metaLocal: _local })
  }
}

/**
 * Embeds a metadata record's generation and local segment into a wire body as
 * the reserved `_generation` / `_local` members, the layout of a metadata
 * file on disk. A missing part is left out rather than written as
 * `undefined`. An export archive entry passes no `local`, since the local
 * segment is this server's own and never travels.
 * @param options {object}
 * @param options.body {T}   the wire body, stamp members included
 * @param [options.generation] {string}
 * @param [options.local] {number}
 * @returns {T & EmbeddedMetadataValidator}
 */
export function embedMetadataValidator<T extends object>({
  body,
  generation,
  local
}: {
  body: T
  generation?: string
  local?: number
}): T & EmbeddedMetadataValidator {
  return {
    ...body,
    ...(generation !== undefined && { _generation: generation }),
    ...(local !== undefined && { _local: local })
  }
}

/**
 * Drops the out-of-band validator parts from a stored Space or Collection
 * Metadata read result, leaving the wire body (stamp members included). A
 * handler that composes an update from the stored object spreads this, and
 * the backend discards the stamp members it carries.
 * @param stored {T & MetadataValidatorParts}
 * @returns {T}
 */
export function stripMetadataValidator<T extends object>(
  stored: T & MetadataValidatorParts
): T {
  const { metaGeneration: _generation, metaLocal: _local, ...body } = stored
  return body as T
}

/**
 * Removes the local validator segment (`_local`) from a stored metadata
 * file's bytes, for an export archive entry: the segment is this server's
 * own and never travels. Bytes that do not parse as a JSON object, or that
 * carry no such member, are returned unchanged.
 * @param bytes {Buffer}
 * @returns {Buffer}
 */
export function withoutLocalSegment(bytes: Buffer): Buffer {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return bytes
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('_local' in parsed)
  ) {
    return bytes
  }
  const { _local: _dropped, ...rest } = parsed as Record<string, unknown>
  return Buffer.from(JSON.stringify(rest))
}
