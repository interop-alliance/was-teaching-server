/**
 * Backend-agnostic conditional-write precondition evaluation (the
 * `conditional-writes` feature). Both storage backends evaluate `If-Match` /
 * `If-None-Match` against a Resource's current state through these two
 * helpers, so the 412 semantics cannot drift between them. Callers MUST invoke
 * them atomically with the write that follows (under the filesystem backend's
 * per-Resource lock, or inside the Postgres backend's row-locking
 * transaction).
 */
import { PreconditionFailedError } from '../errors.js'
import { formatEtag } from './etag.js'

/**
 * Evaluates a content-write (or delete) precondition against a Resource's
 * current state. Throws `PreconditionFailedError` (412) when it is not met.
 * `ifNoneMatch` (`If-None-Match: *`, create-if-absent) takes precedence over
 * `ifMatch` when both are present (RFC9110): the write proceeds only if the
 * Resource is absent. `ifMatch` (update-if-unchanged) requires the Resource to
 * exist with a current ETag equal to the supplied validator.
 * @param options {object}
 * @param options.resourceId {string}   for the error detail
 * @param options.exists {boolean}   whether the Resource currently exists (a
 *   tombstone counts as "does not exist")
 * @param options.currentVersion {number}   the Resource's current content
 *   `version` (0 for a legacy Resource without one)
 * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
 * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *` (create-if-absent)
 * @returns {void}
 */
export function assertWritePrecondition({
  resourceId,
  exists,
  currentVersion,
  ifMatch,
  ifNoneMatch
}: {
  resourceId: string
  exists: boolean
  currentVersion: number
  ifMatch?: string
  ifNoneMatch?: boolean
}): void {
  if (ifNoneMatch) {
    if (exists) {
      throw new PreconditionFailedError({
        detail: `Resource '${resourceId}' already exists (If-None-Match: *).`
      })
    }
    return
  }

  if (ifMatch === undefined) {
    return
  }

  // `If-Match` (update-if-unchanged): the Resource must exist and its current
  // ETag must equal the supplied validator.
  if (!exists) {
    throw new PreconditionFailedError({
      detail: `Resource '${resourceId}' does not exist; If-Match cannot be satisfied.`
    })
  }
  const currentEtag = formatEtag(currentVersion)
  if (currentEtag !== ifMatch) {
    throw new PreconditionFailedError({
      detail: `Resource '${resourceId}' ETag ${currentEtag} does not match If-Match ${ifMatch}.`
    })
  }
}

/**
 * Evaluates a Collection Description write precondition against the Collection's
 * current description `version` (the `key-epochs` / conditional-Collection-write
 * feature). Throws `PreconditionFailedError` (412) when the supplied `If-Match`
 * validator does not equal the current description ETag. Only `If-Match`
 * (update-if-unchanged) is supported for Collections; a create through an
 * unconditional PUT is unaffected. MUST be called atomically with the write
 * (under the filesystem backend's per-Collection lock, or inside the Postgres
 * backend's row-locking transaction).
 * @param options {object}
 * @param options.collectionId {string}   for the error detail
 * @param options.currentVersion {number}   the Collection's current description
 *   `version` (0 for a legacy Collection without one, or before its first write)
 * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
 * @returns {void}
 */
export function assertCollectionWritePrecondition({
  collectionId,
  currentVersion,
  ifMatch
}: {
  collectionId: string
  currentVersion: number
  ifMatch?: string
}): void {
  if (ifMatch === undefined) {
    return
  }
  const currentEtag = formatEtag(currentVersion)
  if (currentEtag !== ifMatch) {
    throw new PreconditionFailedError({
      detail: `Collection '${collectionId}' ETag ${currentEtag} does not match If-Match ${ifMatch}.`
    })
  }
}

/**
 * Evaluates a metadata-write (`/meta`) precondition against a Resource's
 * current `metaVersion`. Throws `PreconditionFailedError` (412) when it is not
 * met. `If-None-Match: *` means "only if no metadata has been written yet"
 * (`metaVersion` unset); `If-Match` pins the current `metaVersion` ETag.
 * @param options {object}
 * @param options.resourceId {string}   for the error detail
 * @param [options.metaVersion] {number}   the current `metaVersion`
 *   (`undefined` until the first metadata write)
 * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
 * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *`
 * @returns {void}
 */
export function assertMetaWritePrecondition({
  resourceId,
  metaVersion,
  ifMatch,
  ifNoneMatch
}: {
  resourceId: string
  metaVersion?: number
  ifMatch?: string
  ifNoneMatch?: boolean
}): void {
  if (ifNoneMatch) {
    if (metaVersion !== undefined) {
      throw new PreconditionFailedError({
        detail: `Resource '${resourceId}' metadata already exists (If-None-Match: *).`
      })
    }
  } else if (ifMatch !== undefined) {
    const currentEtag = formatEtag(metaVersion ?? 0)
    if (currentEtag !== ifMatch) {
      throw new PreconditionFailedError({
        detail: `Resource '${resourceId}' metadata ETag ${currentEtag} does not match If-Match ${ifMatch}.`
      })
    }
  }
}
