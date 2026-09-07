/**
 * Backend-agnostic conditional-write precondition evaluation (the
 * `conditional-writes` feature). Both storage backends evaluate `If-Match` /
 * `If-None-Match` against the current state of a Resource, a Collection
 * Description, or a Metadata object through these helpers, so the 412 semantics
 * cannot drift between them. Callers MUST invoke
 * them atomically with the write that follows (under the filesystem backend's
 * per-Resource lock, or inside the Postgres backend's row-locking
 * transaction). The current state arrives as the record's `ETag` (from
 * `etagOf`), `undefined` when the record has none: a legacy record written
 * before generations, or a metadata object never written. An `If-Match` can
 * never be satisfied against such a record, since no client holds a validator
 * for it.
 */
import { PreconditionFailedError } from '../errors.js'

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
 * @param [options.currentEtag] {string}   the Resource's current content
 *   `ETag`; absent for a legacy Resource without one
 * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
 * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *` (create-if-absent)
 * @returns {void}
 */
export function assertWritePrecondition({
  resourceId,
  exists,
  currentEtag,
  ifMatch,
  ifNoneMatch
}: {
  resourceId: string
  exists: boolean
  currentEtag?: string
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
  assertEtagMatches({
    subject: `Resource '${resourceId}'`,
    currentEtag,
    ifMatch
  })
}

/**
 * Evaluates a Collection Description write precondition against the Collection's
 * current description `ETag` (the `key-epochs` / conditional-Collection-write
 * feature). Throws `PreconditionFailedError` (412) when the supplied `If-Match`
 * validator does not equal it. Only `If-Match` (update-if-unchanged) is
 * supported for Collections; a create through an unconditional PUT is
 * unaffected. MUST be called atomically with the write (under the filesystem
 * backend's per-Collection lock, or inside the Postgres backend's row-locking
 * transaction).
 * @param options {object}
 * @param options.collectionId {string}   for the error detail
 * @param [options.currentEtag] {string}   the Collection's current description
 *   `ETag`; absent for a legacy Collection without one, or before its first
 *   write
 * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
 * @returns {void}
 */
export function assertCollectionWritePrecondition({
  collectionId,
  currentEtag,
  ifMatch
}: {
  collectionId: string
  currentEtag?: string
  ifMatch?: string
}): void {
  if (ifMatch === undefined) {
    return
  }
  assertEtagMatches({
    subject: `Collection '${collectionId}'`,
    currentEtag,
    ifMatch
  })
}

/**
 * Evaluates a metadata-write (`/meta`) precondition against a Resource's
 * current metadata `ETag`. Throws `PreconditionFailedError` (412) when it is
 * not met. `If-None-Match: *` means "only if no metadata has been written yet"
 * (no metadata `ETag`); `If-Match` pins the current one.
 * @param options {object}
 * @param options.resourceId {string}   for the error detail
 * @param [options.currentEtag] {string}   the current metadata `ETag`
 *   (`undefined` until the first metadata write)
 * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
 * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *`
 * @returns {void}
 */
export function assertMetaWritePrecondition({
  resourceId,
  currentEtag,
  ifMatch,
  ifNoneMatch
}: {
  resourceId: string
  currentEtag?: string
  ifMatch?: string
  ifNoneMatch?: boolean
}): void {
  assertMetaPrecondition({
    subject: `Resource '${resourceId}'`,
    currentEtag,
    ifMatch,
    ifNoneMatch
  })
}

/**
 * Evaluates a metadata-write (`/meta`) precondition against a **Collection's**
 * current metadata `ETag` -- the Collection-level sibling of
 * {@link assertMetaWritePrecondition}, with identical 412 semantics. The
 * Collection's metadata validator is independent of its description validator,
 * so this never consults the description (see
 * {@link assertCollectionWritePrecondition} for that one).
 * @param options {object}
 * @param options.collectionId {string}   for the error detail
 * @param [options.currentEtag] {string}   the current metadata `ETag`
 *   (`undefined` until the first metadata write)
 * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
 * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *`
 * @returns {void}
 */
export function assertCollectionMetaWritePrecondition({
  collectionId,
  currentEtag,
  ifMatch,
  ifNoneMatch
}: {
  collectionId: string
  currentEtag?: string
  ifMatch?: string
  ifNoneMatch?: boolean
}): void {
  assertMetaPrecondition({
    subject: `Collection '${collectionId}'`,
    currentEtag,
    ifMatch,
    ifNoneMatch
  })
}

/**
 * Evaluates a Collection history-log write's precondition (the
 * `governed-history-logs` feature) against the log's current `ETag`:
 * `If-None-Match: *` is the guarded create (no log yet), `If-Match` the
 * compare-and-swap append.
 * @param options {object}
 * @param options.collectionId {string}   for the error detail
 * @param [options.currentEtag] {string}   the current log `ETag` (`undefined`
 *   until the log is created)
 * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
 * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *`
 * @returns {void}
 */
export function assertCollectionLogWritePrecondition({
  collectionId,
  currentEtag,
  ifMatch,
  ifNoneMatch
}: {
  collectionId: string
  currentEtag?: string
  ifMatch?: string
  ifNoneMatch?: boolean
}): void {
  if (ifNoneMatch) {
    if (currentEtag !== undefined) {
      throw new PreconditionFailedError({
        detail: `Collection '${collectionId}' history log already exists (If-None-Match: *).`
      })
    }
  } else if (ifMatch !== undefined) {
    assertEtagMatches({
      subject: `Collection '${collectionId}' history log`,
      currentEtag,
      ifMatch
    })
  }
}

/**
 * The shared body of the two metadata-write precondition asserts, parameterized
 * only by the phrase naming the subject in the 412 detail (`Resource '<id>'` /
 * `Collection '<id>'`). `If-None-Match: *` means "only if no metadata has been
 * written yet" (no metadata `ETag`); `If-Match` pins the current one.
 * @param options {object}
 * @param options.subject {string}   the subject phrase for the error detail
 * @param [options.currentEtag] {string}   the current metadata `ETag`
 * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
 * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *`
 * @returns {void}
 */
function assertMetaPrecondition({
  subject,
  currentEtag,
  ifMatch,
  ifNoneMatch
}: {
  subject: string
  currentEtag?: string
  ifMatch?: string
  ifNoneMatch?: boolean
}): void {
  if (ifNoneMatch) {
    if (currentEtag !== undefined) {
      throw new PreconditionFailedError({
        detail: `${subject} metadata already exists (If-None-Match: *).`
      })
    }
  } else if (ifMatch !== undefined) {
    assertEtagMatches({ subject: `${subject} metadata`, currentEtag, ifMatch })
  }
}

/**
 * The `If-Match` comparison itself: exact-string (strong) equality between the
 * supplied validator and the record's current `ETag`. A record with no `ETag`
 * matches nothing.
 * @param options {object}
 * @param options.subject {string}   the subject phrase for the error detail
 * @param [options.currentEtag] {string}
 * @param options.ifMatch {string}
 * @returns {void}
 */
function assertEtagMatches({
  subject,
  currentEtag,
  ifMatch
}: {
  subject: string
  currentEtag?: string
  ifMatch: string
}): void {
  if (currentEtag !== ifMatch) {
    throw new PreconditionFailedError({
      detail: `${subject} ETag ${currentEtag ?? '(none)'} does not match If-Match ${ifMatch}.`
    })
  }
}
