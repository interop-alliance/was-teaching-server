/**
 * Validator for the user-writable `custom` object of a Metadata write body,
 * shared by the Resource-level (`PUT .../{resourceId}/meta`) and
 * Collection-level (`PUT .../{collectionId}/meta`) update handlers -- the two
 * carry the same `{ name, tags }` shape and must reject the same malformed
 * bodies with the same JSON-Pointer problem details.
 */
import { InvalidRequestBodyError } from '../errors.js'
import type { ResourceMetadataCustom } from '../types.js'

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
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Request body must be a JSON object.'
    })
  }
  const { custom } = body as Record<string, unknown>
  if (custom === undefined) {
    return {}
  }
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom` property must be a JSON object.',
      pointer: '/custom'
    })
  }
  const { name, tags } = custom as Record<string, unknown>
  if (name !== undefined && typeof name !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom.name` property must be a string.',
      pointer: '/custom/name'
    })
  }
  if (
    tags !== undefined &&
    (typeof tags !== 'object' || tags === null || Array.isArray(tags))
  ) {
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
    Object.values(tags as Record<string, unknown>).some(
      value => typeof value !== 'string'
    )
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
