/**
 * Id sanitization for path-traversal defense. `spaceId` / `collectionId` /
 * `resourceId` values arrive from URL params, request bodies, and tar-entry
 * names, then flow into filesystem paths (and glob patterns). This validator
 * rejects anything that is not a single, URL-safe path segment -- empty, `.`,
 * `..`, a value containing `/` or `\`, or any character outside the RFC 3986
 * "unreserved" set -- so a malicious id can never escape its parent directory.
 */
import {
  InvalidSpaceIdError,
  InvalidCollectionIdError,
  InvalidResourceIdError
} from '../errors.js'

/** Which kind of id is being validated (selects the thrown error class). */
export type IdKind = 'space' | 'collection' | 'resource'

// URL-safe id charset: the RFC 3986 "unreserved" characters
// (ALPHA / DIGIT / `-` / `.` / `_` / `~`). This excludes path separators
// (`/`, `\`) and every glob metacharacter, so a validated id is safe to use
// both as a single path segment and inside a glob pattern.
const ID_PATTERN = /^[A-Za-z0-9._~-]+$/

// Reserved path segments that name auxiliary resources at the Collection /
// Resource position (`/space/{id}/policy`, `/space/{id}/linkset`, etc.). A
// client-chosen Collection or Resource id matching one of these would shadow
// the reserved route, so reject it.
const RESERVED_SEGMENTS = new Set(['policy', 'linkset'])

/**
 * Asserts that an id is a single, URL-safe path segment, throwing the typed
 * 400 error matching `kind` otherwise.
 * @param id {string}   the id parsed from a URL param, body, or tar entry
 * @param options {object}
 * @param options.kind {IdKind}   which id is being validated
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {void}
 */
export function assertValidId(
  id: string,
  { kind, requestName }: { kind: IdKind; requestName?: string }
): void {
  const valid =
    typeof id === 'string' &&
    id.length > 0 &&
    id !== '.' &&
    id !== '..' &&
    !id.includes('/') &&
    !id.includes('\\') &&
    ID_PATTERN.test(id) &&
    // Collections and Resources may not take a reserved auxiliary-resource name.
    !(kind !== 'space' && RESERVED_SEGMENTS.has(id))

  if (valid) {
    return
  }

  switch (kind) {
    case 'collection':
      throw new InvalidCollectionIdError({ requestName })
    case 'resource':
      throw new InvalidResourceIdError({ requestName })
    default:
      throw new InvalidSpaceIdError({ requestName })
  }
}

/**
 * Convenience wrapper that validates whichever of `spaceId` / `collectionId` /
 * `resourceId` are present on a request's params object. Call at the top of a
 * handler, before any storage access.
 * @param ids {object}
 * @param [ids.spaceId] {string}
 * @param [ids.collectionId] {string}
 * @param [ids.resourceId] {string}
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {void}
 */
export function assertValidIds(
  ids: { spaceId?: string; collectionId?: string; resourceId?: string },
  { requestName }: { requestName?: string } = {}
): void {
  if (ids.spaceId !== undefined) {
    assertValidId(ids.spaceId, { kind: 'space', requestName })
  }
  if (ids.collectionId !== undefined) {
    assertValidId(ids.collectionId, { kind: 'collection', requestName })
  }
  if (ids.resourceId !== undefined) {
    assertValidId(ids.resourceId, { kind: 'resource', requestName })
  }
}
