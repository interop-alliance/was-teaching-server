/**
 * Backend-agnostic conditional-write precondition evaluation (the
 * `conditional-writes` feature). Both storage backends evaluate `If-Match` /
 * `If-None-Match` against the current state of a Resource, a Space or
 * Collection Description, or a Metadata object through these helpers, so the
 * 412 semantics cannot drift between them. Callers MUST invoke
 * them atomically with the write that follows (under the filesystem backend's
 * per-Resource lock, or inside the Postgres backend's row-locking
 * transaction). The current state arrives as the record's `ETag` (from
 * `etagOf`), `undefined` when the record has none: a legacy record written
 * before generations, or a metadata object never written. An `If-Match` can
 * never be satisfied against such a record, since no client holds a validator
 * for it.
 *
 * The two headers are evaluated in the order RFC 9110 section 13.2.2
 * prescribes: `If-Match` first, then `If-None-Match`. A request carrying both
 * therefore never succeeds against an absent record (`If-Match` cannot hold)
 * and never succeeds with `If-None-Match: *` against a present one, so the
 * pair is refused with 412 rather than one header silently overriding the
 * other. `If-None-Match` on a write is the RFC's full form: `*` refuses any
 * present record, and a list of validators refuses when one of them names the
 * current representation.
 */
import { PreconditionFailedError } from '../errors.js'
import { ifMatchCovers, isNotModified, type HeldValidators } from './etag.js'

/**
 * Evaluates a content-write (or delete) precondition against a Resource's
 * current state. Throws `PreconditionFailedError` (412) when it is not met.
 * `ifMatch` (update-if-unchanged) requires the Resource to exist with a
 * current ETag the validator covers; `ifNoneMatch` (create-if-absent for `*`)
 * requires the Resource to be absent, or its current ETag to be outside the
 * listed validators.
 * @param options {object}
 * @param options.resourceId {string}   for the error detail
 * @param options.exists {boolean}   whether the Resource currently exists (a
 *   tombstone counts as "does not exist")
 * @param [options.currentEtag] {string}   the Resource's current content
 *   `ETag`; absent for a legacy Resource without one
 * @param [options.ifMatch] {string}   the `If-Match` header value
 * @param [options.ifNoneMatch] {HeldValidators}   the parsed `If-None-Match`
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
  ifNoneMatch?: HeldValidators
}): void {
  assertPrecondition({
    subject: `Resource '${resourceId}'`,
    exists,
    currentEtag,
    ifMatch,
    ifNoneMatch
  })
}

/**
 * Evaluates a Collection Description write precondition against the
 * Collection's current state (the `key-epochs` / conditional-Collection-write
 * feature). Throws `PreconditionFailedError` (412) when it is not met.
 * `If-None-Match: *` is the guarded create: the write proceeds only if no
 * Description exists yet (a legacy Description with no `ETag` still exists,
 * so it still refuses). `If-Match` is the update-if-unchanged compare-and-swap
 * on the current description `ETag`. An unconditional PUT is unaffected. MUST
 * be called atomically with the write (under the filesystem backend's
 * per-Collection lock, or inside the Postgres backend's row-locking
 * transaction).
 * @param options {object}
 * @param options.collectionId {string}   for the error detail
 * @param options.exists {boolean}   whether a Description is stored
 * @param [options.currentEtag] {string}   the Collection's current description
 *   `ETag`; absent for a legacy Collection without one, or before its first
 *   write
 * @param [options.ifMatch] {string}   the `If-Match` header value
 * @param [options.ifNoneMatch] {HeldValidators}   the parsed `If-None-Match`
 * @returns {void}
 */
export function assertCollectionWritePrecondition({
  collectionId,
  exists,
  currentEtag,
  ifMatch,
  ifNoneMatch
}: {
  collectionId: string
  exists: boolean
  currentEtag?: string
  ifMatch?: string
  ifNoneMatch?: HeldValidators
}): void {
  assertPrecondition({
    subject: `Collection '${collectionId}'`,
    exists,
    currentEtag,
    ifMatch,
    ifNoneMatch
  })
}

/**
 * Evaluates a Space Description write precondition against the Space's
 * current state, on the same terms as
 * {@link assertCollectionWritePrecondition}: `If-None-Match: *` is the guarded
 * create (412 when a Description exists), `If-Match` the compare-and-swap on
 * the current description `ETag`. MUST be called atomically with the write.
 * @param options {object}
 * @param options.spaceId {string}   for the error detail
 * @param options.exists {boolean}   whether a Description is stored
 * @param [options.currentEtag] {string}   the Space's current description
 *   `ETag`; absent for a legacy Space without one
 * @param [options.ifMatch] {string}   the `If-Match` header value
 * @param [options.ifNoneMatch] {HeldValidators}   the parsed `If-None-Match`
 * @returns {void}
 */
export function assertSpaceWritePrecondition({
  spaceId,
  exists,
  currentEtag,
  ifMatch,
  ifNoneMatch
}: {
  spaceId: string
  exists: boolean
  currentEtag?: string
  ifMatch?: string
  ifNoneMatch?: HeldValidators
}): void {
  assertPrecondition({
    subject: `Space '${spaceId}'`,
    exists,
    currentEtag,
    ifMatch,
    ifNoneMatch
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
 * @param [options.ifMatch] {string}   the `If-Match` header value
 * @param [options.ifNoneMatch] {HeldValidators}   the parsed `If-None-Match`
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
  ifNoneMatch?: HeldValidators
}): void {
  assertPrecondition({
    subject: `Resource '${resourceId}' metadata`,
    exists: currentEtag !== undefined,
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
 * @param [options.ifMatch] {string}   the `If-Match` header value
 * @param [options.ifNoneMatch] {HeldValidators}   the parsed `If-None-Match`
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
  ifNoneMatch?: HeldValidators
}): void {
  assertPrecondition({
    subject: `Collection '${collectionId}' metadata`,
    exists: currentEtag !== undefined,
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
 * @param [options.ifMatch] {string}   the `If-Match` header value
 * @param [options.ifNoneMatch] {HeldValidators}   the parsed `If-None-Match`
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
  ifNoneMatch?: HeldValidators
}): void {
  assertPrecondition({
    subject: `Collection '${collectionId}' history log`,
    exists: currentEtag !== undefined,
    currentEtag,
    ifMatch,
    ifNoneMatch
  })
}

/**
 * The one evaluation every assert above runs, parameterized by the phrase
 * naming the subject in the 412 detail. `If-Match` is evaluated first: the
 * record must exist and its current `ETag` must be covered by the validator
 * (`*`, or one of the listed strong validators; a record with no `ETag`
 * matches nothing). `If-None-Match` is evaluated next: `*` refuses any
 * existing record, `ETag` or not, and a list refuses when it names the current
 * `ETag`.
 * @param options {object}
 * @param options.subject {string}   the subject phrase for the error detail
 * @param options.exists {boolean}   whether the record is stored
 * @param [options.currentEtag] {string}   the record's current `ETag`
 * @param [options.ifMatch] {string}   the `If-Match` header value
 * @param [options.ifNoneMatch] {HeldValidators}   the parsed `If-None-Match`
 * @returns {void}
 */
function assertPrecondition({
  subject,
  exists,
  currentEtag,
  ifMatch,
  ifNoneMatch
}: {
  subject: string
  exists: boolean
  currentEtag?: string
  ifMatch?: string
  ifNoneMatch?: HeldValidators
}): void {
  if (ifMatch !== undefined) {
    if (!exists) {
      throw new PreconditionFailedError({
        detail: `${subject} does not exist; If-Match cannot be satisfied.`
      })
    }
    if (!ifMatchCovers({ ifMatch, currentEtag })) {
      throw new PreconditionFailedError({
        detail: `${subject} ETag ${currentEtag ?? '(none)'} does not match If-Match ${ifMatch}.`
      })
    }
  }
  if (ifNoneMatch === undefined || !exists) {
    return
  }
  if (ifNoneMatch === '*') {
    throw new PreconditionFailedError({
      detail: `${subject} already exists (If-None-Match: *).`
    })
  }
  if (isNotModified({ held: ifNoneMatch, etag: currentEtag })) {
    throw new PreconditionFailedError({
      detail: `${subject} ETag ${currentEtag} is named by If-None-Match.`
    })
  }
}
