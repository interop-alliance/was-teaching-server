/**
 * Catalog of `type` URIs emitted in `application/problem+json` error responses.
 *
 * Per [[RFC9457]], a problem `type` identifies the *kind* of problem and is
 * reused across operations; the per-occurrence specifics live in the `errors`
 * array (`detail` / `pointer`) and the human summary in `title`. So these URIs
 * are keyed by problem-kind, not by operation -- a single `type` such as
 * `INVALID_ID` is emitted by Create / Update / Read across Spaces, Collections,
 * and Resources alike.
 *
 * **Privacy-merged kinds.** Under the spec's maximum-privacy principle, an
 * unauthorized caller MUST NOT be able to tell a missing resource from one they
 * simply cannot access. `NOT_FOUND` therefore deliberately covers both the
 * "resource absent" and "invalid authorization" conditions (Space / Collection
 * / Resource not found, and failed capability invocation) -- callers cannot use
 * `type` to probe existence.
 *
 * Each URI is a fragment anchor into the WAS specification's Error Type
 * Registry appendix.
 */

const SPEC_URL = 'https://wallet.storage/spec'

export const ProblemTypes = {
  /**
   * Privacy-merged -- the resource does not exist, OR the caller is not
   * authorized to access it. The two conditions are intentionally
   * indistinguishable; do not split this kind (see file header).
   */
  NOT_FOUND: `${SPEC_URL}#not-found`,

  /** A Space / Collection / Resource id is missing or not URL-safe. */
  INVALID_ID: `${SPEC_URL}#invalid-id`,

  /**
   * A client-supplied `id` in a `POST` create operation already exists.
   * (Create-or-replace at a chosen id is the idempotent `PUT` path, which does
   * not conflict.) Typical status 409.
   */
  ID_CONFLICT: `${SPEC_URL}#id-conflict`,

  /**
   * A client-supplied `id` collides with a segment from the spec's Reserved
   * Path Segment Registry (e.g. a Collection named `export` would shadow
   * `/space/{id}/export`). Typical status 409.
   */
  RESERVED_ID: `${SPEC_URL}#reserved-id`,

  /**
   * A Collection create/update names a `backend` id that is not in the Space's
   * backends-available list. Typical status 409.
   */
  UNSUPPORTED_BACKEND: `${SPEC_URL}#unsupported-backend`,

  /** The request body is missing or invalid (missing required fields, etc.). */
  INVALID_REQUEST_BODY: `${SPEC_URL}#invalid-request-body`,

  /** A required `Content-Type` header is missing. */
  MISSING_CONTENT_TYPE: `${SPEC_URL}#missing-content-type`,

  /** Required `Authorization` / `Capability-Invocation` headers are missing. */
  MISSING_AUTHORIZATION: `${SPEC_URL}#missing-authorization`,

  /**
   * The `Authorization`, `Capability-Invocation`, or `Digest` header is
   * malformed, unparseable, or failed verification.
   */
  INVALID_AUTHORIZATION_HEADER: `${SPEC_URL}#invalid-authorization-header`,

  /**
   * The DID that signed the capability invocation does not match the
   * `controller` supplied in a Create Space request body.
   */
  CONTROLLER_MISMATCH: `${SPEC_URL}#controller-mismatch`,

  /** An uploaded archive is not a valid WAS space export. */
  INVALID_IMPORT: `${SPEC_URL}#invalid-import`,

  /** An underlying storage operation failed (server-side fault). */
  STORAGE_ERROR: `${SPEC_URL}#storage-error`,

  /**
   * A write was rejected because the target backend's per-Space storage quota
   * is exhausted (see the spec "Quotas" section). Typical status 507.
   */
  QUOTA_EXCEEDED: `${SPEC_URL}#quota-exceeded`,

  /**
   * An upload exceeds the target backend's `maxUploadBytes` constraint (see
   * the spec "Quotas" section). Unlike `quota-exceeded`, this rejection is
   * per-request, not cumulative: smaller uploads may still succeed. Typical
   * status 413.
   */
  PAYLOAD_TOO_LARGE: `${SPEC_URL}#payload-too-large`,

  /**
   * The server does not implement this OPTIONAL operation (e.g. updating
   * Resource Metadata). Typical status 501.
   */
  UNSUPPORTED_OPERATION: `${SPEC_URL}#unsupported-operation`,

  /** Fallback for an unexpected server-side fault with no more specific kind. */
  INTERNAL_ERROR: `${SPEC_URL}#internal-error`
} as const

export type ProblemType = (typeof ProblemTypes)[keyof typeof ProblemTypes]
