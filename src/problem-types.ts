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
   * The server does not implement this OPTIONAL operation (e.g. updating
   * Resource Metadata). Typical status 501.
   */
  UNSUPPORTED_OPERATION: `${SPEC_URL}#unsupported-operation`,

  /** Fallback for an unexpected server-side fault with no more specific kind. */
  INTERNAL_ERROR: `${SPEC_URL}#internal-error`
} as const

export type ProblemType = (typeof ProblemTypes)[keyof typeof ProblemTypes]
