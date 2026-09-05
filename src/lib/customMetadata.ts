/**
 * Validator for the user-writable `custom` object of a Metadata write body,
 * shared by the Resource-level (`PUT .../{resourceId}/meta`) and
 * Collection-level (`PUT .../{collectionId}/meta`) update handlers -- the two
 * carry the same `{ name, tags }` shape and must reject the same malformed
 * bodies with the same JSON-Pointer problem details.
 */
import { InvalidRequestBodyError } from '../errors.js'
import { isPlainObject } from './isPlainObject.js'
import { assertJsonObjectBody } from './requestBody.js'
import { assertEncryptedMetaConforms } from './encryption.js'
import type { CollectionEncryption, ResourceMetadataCustom } from '../types.js'

/**
 * Validates and extracts the user-writable `custom` object from a Metadata
 * update request body on a **plaintext** Collection. The body MUST be a JSON
 * object; any top-level property other than `custom` is ignored (so a client may
 * GET-modify-PUT the whole Metadata object). A missing `custom` clears all
 * user-writable properties (returns `{}`). Throws `InvalidRequestBodyError`
 * (400) when the body or `custom` shape is wrong.
 *
 * On an **encrypted** Collection this shape check does not apply -- `custom` is
 * the opaque encryption envelope, validated structurally by
 * `assertEncryptedMetaConforms` instead (a `422` on non-conformance). Both
 * `putMeta` handlers branch on the Collection's `encryption` descriptor after
 * authorization.
 * @param options {object}
 * @param options.body {unknown}   the parsed request body
 * @param options.requestName {string}   request name for the 400 error title
 * @returns {ResourceMetadataCustom}
 */
export function parseCustomMetadata({
  body,
  requestName
}: {
  body: unknown
  requestName: string
}): ResourceMetadataCustom {
  const { custom } = assertJsonObjectBody({
    body,
    requestName,
    detail: 'Request body must be a JSON object.'
  })
  if (custom === undefined) {
    return {}
  }
  if (!isPlainObject(custom)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom` property must be a JSON object.',
      pointer: '/custom'
    })
  }
  const { name, tags } = custom
  if (name !== undefined && typeof name !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom.name` property must be a string.',
      pointer: '/custom/name'
    })
  }
  if (tags !== undefined && !isPlainObject(tags)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom.tags` property must be a JSON object.',
      pointer: '/custom/tags'
    })
  }
  // Tag values MUST be strings (spec: values SHOULD be strings; the wire type
  // models them as `Record<string, string>`).
  if (
    tags !== undefined &&
    Object.values(tags).some(value => typeof value !== 'string')
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Every `custom.tags` value must be a string.',
      pointer: '/custom/tags'
    })
  }
  return {
    ...(name !== undefined && { name }),
    ...(tags !== undefined && { tags: tags as Record<string, string> })
  }
}

/**
 * Resolves the `custom` value a Metadata update (`PUT .../meta`) stores,
 * branching on the target Collection's `encryption` descriptor. On an encrypted
 * Collection the `custom` value MUST be a conforming envelope of the scheme
 * (stored opaquely, `422` on a plaintext/malformed value); on a plaintext
 * Collection it MUST be a well-formed `{ name, tags }` object (`400` otherwise).
 * Shared by the Resource-level and Collection-level update handlers, which call
 * it after authorization and the 404-if-missing check, so a 422/400 is
 * observable only to a caller authorized to write the target.
 * @param options {object}
 * @param options.collectionDescription {{ encryption?: CollectionEncryption }}
 *   the target Collection's stored description
 * @param options.body {Record<string, unknown>}   the parsed request body
 * @param options.requestName {string}   request name for the 400 error title
 * @returns {ResourceMetadataCustom | Record<string, unknown>}
 */
export function resolveMetadataCustom({
  collectionDescription,
  body,
  requestName
}: {
  collectionDescription: { encryption?: CollectionEncryption }
  body: Record<string, unknown>
  requestName: string
}): ResourceMetadataCustom | Record<string, unknown> {
  if (collectionDescription.encryption?.scheme !== undefined) {
    const { custom } = body
    assertEncryptedMetaConforms({ collectionDescription, custom })
    return custom as Record<string, unknown>
  }
  return parseCustomMetadata({ body, requestName })
}
