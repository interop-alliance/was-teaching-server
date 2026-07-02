/**
 * Custom error classes (each carries type / title / detail / statusCode) plus
 * handleError, the Fastify error handler installed by each route group.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

import {
  ProblemTypes,
  type ProblemType,
  type Problem
} from '@interop/storage-core'

// Re-export the wire `Problem` entry shape (one element of the `errors` array)
// so the rest of the server keeps importing it from this one module.
export type { Problem }

/**
 * Base class for the server's error hierarchy. Carries the four
 * `application/problem+json` fields (`type` / `title` / `detail` /
 * `statusCode`) plus an optional `problems` array of `{ detail, pointer }`
 * entries; `handleError` serializes these to the wire. Subclasses set their
 * distinguishing values via `super({ ... })`.
 * @param options {object}
 * @param options.type {ProblemType}   problem-kind URI (see @interop/storage-core)
 * @param options.title {string}   short human-readable summary
 * @param options.detail {string}   specific explanation of the occurrence
 * @param options.statusCode {number}   HTTP status code
 * @param [options.problems] {Problem[]}   per-field error entries
 * @param [options.cause] {Error}   the underlying error, when wrapping one
 */
export class ProblemError extends Error {
  type: ProblemType
  title: string
  detail: string
  statusCode: number
  problems?: Problem[]
  constructor({
    type,
    title,
    detail,
    statusCode,
    problems,
    cause
  }: {
    type: ProblemType
    title: string
    detail: string
    statusCode: number
    problems?: Problem[]
    cause?: Error
  }) {
    super(detail, cause ? { cause } : undefined)
    this.type = type
    this.title = title
    this.detail = detail
    this.statusCode = statusCode
    if (problems) {
      this.problems = problems
    }
  }
}

/**
 * 404 — the requested Space does not exist, or the caller is not authorized.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class SpaceNotFoundError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.NOT_FOUND,
      title: `Invalid ${requestName || 'Space'} request`,
      detail: 'Space not found or invalid authorization.',
      statusCode: 404
    })
  }
}

/**
 * 400 — the provided space id is not URL-safe / otherwise invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidSpaceIdError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.INVALID_ID,
      title: `Invalid ${requestName || 'Space'} request`,
      detail: 'Invalid space id (make sure it is URL-safe).',
      statusCode: 400
    })
  }
}

/**
 * 400 — the provided collection id is not URL-safe / otherwise invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidCollectionIdError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.INVALID_ID,
      title: `Invalid ${requestName || 'Collection'} request`,
      detail: 'Invalid collection id (make sure it is URL-safe).',
      statusCode: 400
    })
  }
}

/**
 * 400 — the provided resource id is not URL-safe / otherwise invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidResourceIdError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.INVALID_ID,
      title: `Invalid ${requestName || 'Resource'} request`,
      detail: 'Invalid resource id (make sure it is URL-safe).',
      statusCode: 400
    })
  }
}

/**
 * 409 — a `POST` create operation supplied an `id` that already exists.
 * Create-or-replace at a client-chosen id is the idempotent `PUT` path, which
 * does not conflict.
 * @param options {object}
 * @param options.kind {string}   what was being created ('Space', 'Collection',
 *   'Resource'), used in the error title and detail
 */
export class IdConflictError extends ProblemError {
  constructor({ kind }: { kind: string }) {
    const detail = `Use PUT to create-or-replace a ${kind} at a chosen id.`
    super({
      type: ProblemTypes.ID_CONFLICT,
      title: `A ${kind} with this id already exists.`,
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/id' }]
    })
  }
}

/**
 * 409 — a client-supplied id collides with a segment from the spec's Reserved
 * Path Segment Registry: the id would shadow the reserved route at that
 * position (e.g. a Collection named `export` would shadow
 * `/space/{id}/export`).
 * @param options {object}
 * @param options.kind {string}   which id position collided ('collection',
 *   'resource'), used in the error title and detail
 * @param options.id {string}   the offending reserved id
 */
export class ReservedIdError extends ProblemError {
  constructor({ kind, id }: { kind: string; id: string }) {
    const detail = `'${id}' is a reserved path segment and cannot be used as a ${kind} id.`
    super({
      type: ProblemTypes.RESERVED_ID,
      title: `Invalid ${kind} id (from reserved list).`,
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/id' }]
    })
  }
}

/**
 * 409 — a backend reference cannot be honored. Three occurrences, distinguished
 * by `detail` / `pointer`: a Collection create/update names a `backend` id not in
 * the Space's backends-available list (the default `#/backend` detail); a
 * registration names a `provider` the server does not permit (the allowlist gate,
 * `#/provider`); or a selected backend is registered but has no live adapter yet
 * (the resolver's data-plane backstop). Spec `unsupported-backend`.
 * @param options {object}
 * @param options.backendId {string}   the unrecognized backend (or provider) id
 * @param [options.detail] {string}   a specific explanation; defaults to the
 *   backends-available message
 * @param [options.pointer] {string}   RFC 6901 JSON Pointer to the offending
 *   field; defaults to `#/backend`
 */
export class UnsupportedBackendError extends ProblemError {
  constructor({
    backendId,
    detail,
    pointer = '#/backend'
  }: {
    backendId: string
    detail?: string
    pointer?: string
  }) {
    const resolvedDetail =
      detail ??
      `Backend '${backendId}' is not in this Space's backends-available list.`
    super({
      type: ProblemTypes.UNSUPPORTED_BACKEND,
      title:
        "Unsupported backend id, check the space's 'backends available' list.",
      detail: resolvedDetail,
      statusCode: 409,
      problems: [{ detail: resolvedDetail, pointer }]
    })
  }
}

/**
 * 409 — a Collection update tried to change or clear an existing client-side
 * `encryption` marker. The marker is set-once (spec): declaring it on a
 * Collection that lacks one is allowed, but changing its scheme (or clearing
 * it) on a populated Collection would corrupt the stored, client-encrypted
 * Resources. Like the other state-conflict 409s (`id-conflict`,
 * `unsupported-backend`), it is only observable by a caller already authorized
 * to update the Collection -- it is checked after capability verification.
 */
export class EncryptionImmutableError extends ProblemError {
  constructor() {
    const detail =
      "A Collection's 'encryption' marker is set-once and cannot be changed or cleared."
    super({
      type: ProblemTypes.ENCRYPTION_IMMUTABLE,
      title: 'Collection encryption marker is immutable.',
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/encryption' }]
    })
  }
}

/**
 * 400 — a Collection create/update supplied an `encryption` marker naming a
 * `scheme` this server does not recognize and therefore cannot enforce on write.
 * Taking the spec's fail-closed SHOULD path ("Encryption Scheme Registry"), the
 * reference server rejects such a marker rather than storing it opaquely, so
 * every accepted marker is one whose non-conforming (e.g. plaintext) writes it
 * will reject. A pure body-shape rejection, checked before capability
 * verification like the other `invalid`-shaped 400s.
 * @param options {object}
 * @param options.scheme {string}   the unrecognized scheme token
 */
export class UnsupportedEncryptionSchemeError extends ProblemError {
  constructor({ scheme }: { scheme: string }) {
    const detail = `This server does not support the '${scheme}' encryption scheme.`
    super({
      type: ProblemTypes.UNSUPPORTED_ENCRYPTION_SCHEME,
      title: 'Unsupported encryption scheme.',
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/encryption/scheme' }]
    })
  }
}

/**
 * 422 — a content write into a Collection whose `encryption` marker declares a
 * recognized scheme did not conform to that scheme's envelope profile: the
 * request `Content-Type` was not the scheme's registered media type, or the body
 * was not a structurally valid envelope (spec "Encryption Scheme Registry"). The
 * server validates structure only and never decrypts. Like the write-time 409s
 * (`id-conflict`, `encryption-immutable`), it is only ever observable by a caller
 * already authorized to write the target -- it is checked after capability
 * verification, so an under-authorized caller receives the privacy-merged
 * `not-found` (404) instead.
 * @param options {object}
 * @param [options.detail] {string}   which gate failed (media type vs envelope shape)
 */
export class EncryptionSchemeMismatchError extends ProblemError {
  constructor({ detail }: { detail?: string } = {}) {
    const message =
      detail ??
      "Resource body does not conform to the Collection's declared encryption scheme."
    super({
      type: ProblemTypes.ENCRYPTION_SCHEME_MISMATCH,
      title: 'Encrypted Collection write does not conform to its scheme.',
      detail: message,
      statusCode: 422,
      problems: [{ detail: message }]
    })
  }
}

/**
 * 412 — a conditional write's `If-Match` / `If-None-Match` precondition
 * evaluated false: the Resource's current `ETag` did not match, or a
 * create-if-absent (`If-None-Match: *`) target already exists. Header-driven
 * and deliberately distinct from the 409 conflict kinds (`id-conflict`,
 * `reserved-id`, `unsupported-backend`). A `412` is only ever observable by a
 * caller already authorized to write the target -- the request layer checks
 * authorization before the backend evaluates the precondition.
 * @param options {object}
 * @param [options.detail] {string}   a specific explanation of the mismatch
 * @param [options.requestName] {string}   request name used in the error title
 */
export class PreconditionFailedError extends ProblemError {
  constructor({
    detail,
    requestName
  }: { detail?: string; requestName?: string } = {}) {
    const message = detail ?? 'A conditional request precondition was not met.'
    super({
      type: ProblemTypes.PRECONDITION_FAILED,
      title: requestName
        ? `Precondition Failed (${requestName})`
        : 'Precondition Failed',
      detail: message,
      statusCode: 412,
      problems: [{ detail: message }]
    })
  }
}

/**
 * 400 — a pagination `cursor` query parameter is malformed or can no longer be
 * honored (not valid base64url, not JSON, or missing its keyset position; spec
 * `invalid-cursor`). Like `precondition-failed`, it is only ever observable by a
 * caller already authorized to list the target -- the request layer checks
 * authorization before the backend validates the cursor, so an under-authorized
 * caller receives the privacy-merged `not-found` (404) instead.
 * @param options {object}
 * @param [options.detail] {string}   a specific explanation of the failure
 * @param [options.cause] {Error}   the underlying parse error, when wrapping one
 */
export class InvalidCursorError extends ProblemError {
  constructor({ detail, cause }: { detail?: string; cause?: Error } = {}) {
    const message =
      detail ??
      'The pagination cursor is malformed or can no longer be honored.'
    super({
      type: ProblemTypes.INVALID_CURSOR,
      title: 'Invalid pagination cursor',
      detail: message,
      statusCode: 400,
      problems: [{ detail: message }],
      cause
    })
  }
}

/**
 * 400 — the Collection Description request body is missing or invalid.
 */
export class InvalidCollectionError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: 'Invalid Collection Description body',
      detail: 'Collection Description body is missing or invalid.',
      statusCode: 400
    })
  }
}

/**
 * 404 — the requested Collection does not exist, or the caller is not
 * authorized.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class CollectionNotFoundError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.NOT_FOUND,
      title: `Invalid ${requestName || 'Collection'} request`,
      detail: 'Collection not found or invalid authorization.',
      statusCode: 404
    })
  }
}

/**
 * 404 — the requested Resource does not exist, or the caller is not authorized.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class ResourceNotFoundError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.NOT_FOUND,
      title: `Invalid ${requestName || 'Resource'} request`,
      detail: 'Resource not found or invalid authorization.',
      statusCode: 404
    })
  }
}

/**
 * 404 — no access-control policy document is set at the requested level
 * (reported as not-found, consistent with the privacy-merged kind).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class PolicyNotFoundError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.NOT_FOUND,
      title: `Invalid ${requestName || 'Policy'} request`,
      detail: 'Policy not found or invalid authorization.',
      statusCode: 404
    })
  }
}

/**
 * 400 — the access-control policy document is missing or malformed (it must be
 * a JSON object carrying a non-empty string `type`).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidPolicyError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: `Invalid ${requestName || 'Policy'} body`,
      detail:
        'Policy document must be a JSON object with a non-empty string "type".',
      statusCode: 400
    })
  }
}

/**
 * 404 — capability invocation did not verify (reported as not-found so as not
 * to leak resource existence).
 * @param options {object}
 * @param options.requestName {string}   request name used in the error title
 */
export class UnauthorizedError extends ProblemError {
  constructor({ requestName }: { requestName?: string }) {
    super({
      type: ProblemTypes.NOT_FOUND,
      title: `Invalid ${requestName} request.`,
      detail: 'URL not found or invalid authorization.',
      statusCode: 404
    })
  }
}

/**
 * 401 — required `Authorization` / `Capability-Invocation` headers are missing.
 */
export class MissingAuthError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.MISSING_AUTHORIZATION,
      title: 'Invalid request',
      detail: 'Authorization and Capability-Invocation headers are required.',
      statusCode: 401
    })
  }
}

/**
 * 400 — the `Authorization` header did not include a `keyId` parameter.
 */
export class MissingKeyIdError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.INVALID_AUTHORIZATION_HEADER,
      title: 'Invalid Authorization header',
      detail: 'Authorization header is missing the keyId parameter.',
      statusCode: 400
    })
  }
}

/**
 * 400 — failed to parse the `Authorization`, `Capability-Invocation`, or
 * `Digest` headers.
 * @param options {object}
 * @param options.cause {Error}   the underlying parse error
 */
export class AuthHeaderParseError extends ProblemError {
  constructor({ cause }: { cause: Error }) {
    super({
      type: ProblemTypes.INVALID_AUTHORIZATION_HEADER,
      title: 'Invalid authorization headers',
      detail:
        'Error parsing Authorization, Capability-Invocation, or Digest headers.',
      statusCode: 400,
      cause
    })
  }
}

/**
 * 400 — the `Digest` header is missing, malformed, not covered by the request
 * signature, or does not match the received body (spec "Request Body
 * Integrity"). All of these are reported as `invalid-authorization-header`.
 * @param options {object}
 * @param options.detail {string}   which of the digest conditions failed
 * @param [options.cause] {Error}   the underlying error, when wrapping one
 */
export class InvalidDigestError extends ProblemError {
  constructor({ detail, cause }: { detail: string; cause?: Error }) {
    super({
      type: ProblemTypes.INVALID_AUTHORIZATION_HEADER,
      title: 'Invalid Digest header',
      detail,
      statusCode: 400,
      cause
    })
  }
}

/**
 * 400 — an error was thrown while verifying the authorization headers.
 * @param options {object}
 * @param options.requestName {string}   request name used in the error title
 * @param options.cause {Error}   the underlying verification error
 */
export class AuthVerificationError extends ProblemError {
  constructor({ requestName, cause }: { requestName: string; cause: Error }) {
    super({
      type: ProblemTypes.INVALID_AUTHORIZATION_HEADER,
      title: `Invalid ${requestName} request.`,
      detail: 'Error verifying authorization headers.',
      statusCode: 400,
      cause
    })
  }
}

/**
 * 400 — the `controller` field is present but is not a syntactically valid
 * `did:key` DID (the only DID method this server accepts). Caught at the request
 * layer so a malformed controller is rejected on the way in rather than failing
 * later, at capability-verification time.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidControllerError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    const detail = 'The "controller" property must be a valid did:key DID.'
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: `Invalid ${requestName || 'request'} body`,
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/controller' }]
    })
  }
}

/**
 * 400 — the capability invocation on a Create Space request (via POST or
 * create-via-PUT) is not *authorized by* the `controller` in the request body:
 * it is neither signed directly by that DID nor accompanied by a delegation
 * chain rooted in it.
 * @param options {object}
 * @param options.zcapSigningDid {string}   DID that signed the invocation
 * @param options.controller {string}   controller DID supplied in the body
 * @param [options.cause] {Error}   the underlying chain-verification failure,
 *   for a delegated invocation rejected at verification time
 */
export class SpaceControllerMismatchError extends ProblemError {
  constructor({
    zcapSigningDid,
    controller,
    cause
  }: {
    zcapSigningDid: string
    controller: string
    cause?: Error
  }) {
    const detail =
      `The invocation must be authorized by the 'controller' DID in the` +
      ` request body ("${controller}"): signed by it, or via a delegation` +
      ` chain rooted in it (invocation signed by "${zcapSigningDid}").`
    super({
      type: ProblemTypes.CONTROLLER_MISMATCH,
      title: 'Invalid Create Space request',
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/controller' }],
      cause
    })
  }
}

/**
 * 500 — an underlying storage operation failed.
 * @param options {object}
 * @param options.cause {Error}   the underlying storage error
 * @param [options.requestName] {string}   request name used in the error title
 */
export class StorageError extends ProblemError {
  constructor({ cause, requestName }: { cause: Error; requestName?: string }) {
    super({
      type: ProblemTypes.STORAGE_ERROR,
      title: requestName
        ? `Storage Error (${requestName}): ${cause.message}`
        : `Storage Error: ${cause.message}`,
      detail: cause.message,
      statusCode: 500,
      cause
    })
  }
}

/**
 * Rethrows a structured failure from a storage call unchanged (any
 * `ProblemError`, e.g. a 507 quota-exceeded raised by the backend), preserving
 * its status code; wraps anything else -- a genuinely unexpected fault -- as a
 * 500 `StorageError`. For use in request handlers' catch blocks around storage
 * operations.
 * @param options {object}
 * @param options.err {unknown}   the caught error
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {never}
 */
export function rethrowOrWrapStorageError({
  err,
  requestName
}: {
  err: unknown
  requestName?: string
}): never {
  if (err instanceof ProblemError) {
    throw err
  }
  throw new StorageError({ cause: err as Error, requestName })
}

/**
 * 507 — a write was rejected because the target backend's per-Space storage
 * quota is exhausted (spec "Quotas"). Distinct from `payload-too-large` (413),
 * which is a per-request upload-size limit rather than a cumulative one.
 * @param options {object}
 * @param options.spaceId {string}   the Space whose quota is exhausted
 * @param options.capacityBytes {number}   the configured per-Space limit
 * @param [options.requestName] {string}   request name used in the error title
 */
export class QuotaExceededError extends ProblemError {
  constructor({
    spaceId,
    capacityBytes,
    requestName
  }: {
    spaceId: string
    capacityBytes: number
    requestName?: string
  }) {
    super({
      type: ProblemTypes.QUOTA_EXCEEDED,
      title: `Insufficient Storage${requestName ? ` (${requestName})` : ''}`,
      detail: `Space '${spaceId}' storage quota of ${capacityBytes} bytes is exhausted.`,
      statusCode: 507
    })
  }
}

/**
 * 413 — an upload exceeds the target backend's per-request `maxUploadBytes`
 * constraint. Distinct from `quota-exceeded` (507): this limit is per-request,
 * not cumulative, so smaller uploads may still succeed.
 * @param options {object}
 * @param options.maxUploadBytes {number}   the backend's per-upload limit
 * @param options.backendId {string}   the backend enforcing the limit
 * @param [options.uploadBytes] {number}   the upload's size, when known up
 *   front (a streamed upload without a Content-Length only reveals the
 *   overflow, not the total)
 */
export class PayloadTooLargeError extends ProblemError {
  constructor({
    maxUploadBytes,
    backendId,
    uploadBytes
  }: {
    maxUploadBytes: number
    backendId: string
    uploadBytes?: number
  }) {
    const detail =
      uploadBytes === undefined
        ? `Upload exceeds 'maxUploadBytes' of ${maxUploadBytes} for backend '${backendId}'.`
        : `Upload size ${uploadBytes} exceeds 'maxUploadBytes' of ${maxUploadBytes} for backend '${backendId}'.`
    super({
      type: ProblemTypes.PAYLOAD_TOO_LARGE,
      title: "Upload exceeds the backend's maximum upload size.",
      detail,
      statusCode: 413
    })
  }
}

/**
 * 400 — a required field of the request body is missing or invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param [options.detail] {string}   specific detail describing the problem
 * @param [options.pointer] {string}   RFC 6901 JSON Pointer (`#/field` form)
 *   to the offending body field
 */
export class InvalidRequestBodyError extends ProblemError {
  constructor({
    requestName,
    detail,
    pointer
  }: { requestName?: string; detail?: string; pointer?: string } = {}) {
    const resolvedDetail =
      detail || 'Request body is missing one or more required fields.'
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: `Invalid ${requestName || 'request'} body`,
      detail: resolvedDetail,
      statusCode: 400,
      ...(pointer ? { problems: [{ detail: resolvedDetail, pointer }] } : {})
    })
  }
}

/**
 * 400 — the request is missing a required `Content-Type` header.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class MissingContentTypeError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.MISSING_CONTENT_TYPE,
      title: `Invalid ${requestName || 'request'}`,
      detail: 'A Content-Type header is required for this request.',
      statusCode: 400
    })
  }
}

/**
 * 501 — the server does not implement this OPTIONAL operation (e.g. updating
 * Resource Metadata, which is not yet supported).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class UnsupportedOperationError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.UNSUPPORTED_OPERATION,
      title: `Unsupported ${requestName || 'operation'}`,
      detail: 'This server does not implement this optional operation.',
      statusCode: 501
    })
  }
}

/**
 * 400 — the uploaded archive is not a valid WAS space export.
 * @param options {object}
 * @param [options.message] {string}   detail message describing the problem
 * @param [options.cause] {Error}   the underlying error, when wrapping one
 */
export class InvalidImportError extends ProblemError {
  constructor({ message, cause }: { message?: string; cause?: Error } = {}) {
    super({
      type: ProblemTypes.INVALID_IMPORT,
      title: 'Invalid space import',
      detail:
        message || 'The uploaded archive is not a valid WAS space export.',
      statusCode: 400,
      cause
    })
  }
}

// WebKMS facet errors (`/kms`). The webkms
// protocol is status-code driven -- `@interop/webkms-client` distinguishes
// only 404 and 409 -- so these reuse the nearest WAS problem-kind URIs rather
// than minting a parallel registry for a non-WAS route family.

/**
 * 404 — the requested keystore does not exist, or the caller is not
 * authorized (the WAS existence-masking convention, kept for consistency
 * within this server).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class KeystoreNotFoundError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.NOT_FOUND,
      title: `Invalid ${requestName || 'Keystore'} request`,
      detail: 'Keystore not found or invalid authorization.',
      statusCode: 404
    })
  }
}

/**
 * 400 — the capability invocation on a Create Keystore request is not
 * *authorized by* the `controller` in the request body: it is neither signed
 * directly by that DID nor accompanied by a delegation chain rooted in it.
 * The keystore-creation bootstrap rule, mirroring Create Space.
 * @param options {object}
 * @param options.zcapSigningDid {string}   DID that signed the invocation
 * @param options.controller {string}   controller DID supplied in the body
 * @param [options.cause] {Error}   the underlying chain-verification failure,
 *   for a delegated invocation rejected at verification time
 */
export class KeystoreControllerMismatchError extends ProblemError {
  constructor({
    zcapSigningDid,
    controller,
    cause
  }: {
    zcapSigningDid: string
    controller: string
    cause?: Error
  }) {
    const detail =
      `The invocation must be authorized by the 'controller' DID in the` +
      ` request body ("${controller}"): signed by it, or via a delegation` +
      ` chain rooted in it (invocation signed by "${zcapSigningDid}").`
    super({
      type: ProblemTypes.CONTROLLER_MISMATCH,
      title: 'Invalid Create Keystore request',
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/controller' }],
      cause
    })
  }
}

/**
 * 409 — a keystore config update could not be applied: the supplied `sequence`
 * is not exactly the stored sequence + 1, or the immutable `kmsModule` does
 * not match. One merged conflict kind; the client distinguishes only the 409
 * status.
 * `ID_CONFLICT` is the nearest WAS problem kind (a 409 state conflict on an
 * identified record) -- the webkms protocol has no type registry of its own.
 */
export class KeystoreStateConflictError extends ProblemError {
  constructor() {
    const detail =
      'Could not update keystore configuration: sequence must be exactly the' +
      ' stored sequence + 1 and "kmsModule" cannot change.'
    super({
      type: ProblemTypes.ID_CONFLICT,
      title: 'Keystore configuration state conflict.',
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/sequence' }]
    })
  }
}

/**
 * 404 — the requested KMS-held key does not exist, or the caller is not
 * authorized (the same existence-masking as `KeystoreNotFoundError`).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class KeyNotFoundError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.NOT_FOUND,
      title: `Invalid ${requestName || 'Key'} request`,
      detail: 'Key not found or invalid authorization.',
      statusCode: 404
    })
  }
}

/**
 * 409 — a key record already exists at `(keystoreId, localId)`. Key local ids
 * are server-generated 128-bit random values, so this is effectively
 * unreachable through the API; the storage layer still enforces insert-once
 * semantics (a unique-index insert), and
 * `@interop/webkms-client` maps a 409 on generate to its `DuplicateError`.
 */
export class KeyIdConflictError extends ProblemError {
  constructor() {
    const detail = 'Duplicate key identifier.'
    super({
      type: ProblemTypes.ID_CONFLICT,
      title: 'A key with this id already exists.',
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/id' }]
    })
  }
}

/**
 * 400 — a well-formed key operation names an operation this KMS does not serve
 * for the key's type (e.g. `VerifyOperation` on an asymmetric key -- custody
 * is the criterion: asymmetric verify needs only the public key and is
 * client-local), or an operation type it does not recognize at all. A clean
 * 400.
 * @param options {object}
 * @param options.operationType {string}   the operation envelope's `type`
 * @param [options.keyType] {string}   the target key's type, when known
 */
export class UnsupportedKeyOperationError extends ProblemError {
  constructor({
    operationType,
    keyType
  }: {
    operationType: string
    keyType?: string
  }) {
    const detail = keyType
      ? `Unsupported operation "${operationType}" for key type "${keyType}".`
      : `Unknown operation type "${operationType}".`
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: 'Unsupported key operation.',
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/type' }]
    })
  }
}

/**
 * 400 — a submitted zcap revocation cannot be accepted: the body is not a
 * revocable delegated capability (root zcaps cannot be revoked), its id does
 * not match the revocation URL, its chain does not root in the keystore being
 * posted to, or its delegation chain fails verification (a chain containing
 * an already-revoked capability included -- resubmitting a stored revocation
 * therefore lands here, per ezcap-express's `authorizeZcapRevocation`; the
 * 409 duplicate is reserved for a write race at the store).
 * @param options {object}
 * @param options.detail {string}   which of the revocation conditions failed
 * @param [options.cause] {Error}   the underlying chain-verification failure
 */
export class InvalidRevocationError extends ProblemError {
  constructor({ detail, cause }: { detail: string; cause?: Error }) {
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: 'Invalid Revoke Capability request',
      detail,
      statusCode: 400,
      cause
    })
  }
}

/**
 * 409 — a revocation record already exists at `(delegator, capabilityId)`
 * (`@interop/webkms-client` maps a 409 to its `DuplicateError`). Reached only
 * on a concurrent-submission race:
 * a sequential resubmission fails the chain verification first (the chain now
 * contains a revoked capability) and is the 400 `InvalidRevocationError`.
 */
export class DuplicateRevocationError extends ProblemError {
  constructor() {
    const detail = 'Duplicate revocation.'
    super({
      type: ProblemTypes.ID_CONFLICT,
      title: 'This capability is already revoked.',
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/id' }]
    })
  }
}

/**
 * Fastify error handler installed by each route group. Serializes the error to
 * an `application/problem+json` response using its `type` / `title` / `detail`
 * (or `problems`), defaulting to a 500 internal error when no statusCode is
 * present. The spec requires `type` and `title`, so both always fall back to a
 * sensible value.
 * @param error {Error & { statusCode?: number, type?: string, title?: string, detail?: string, problems?: Problem[] }}
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<FastifyReply>}
 */
export async function handleError(
  error: Error & {
    statusCode?: number
    type?: string
    title?: string
    detail?: string
    problems?: Problem[]
  },
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const statusCode = error.statusCode || 500
  // Log server-side faults (5xx, e.g. a StorageError and its underlying
  // `cause`) here through the request logger -- rather than in the error
  // constructors -- so logging lives in one place. Client errors (4xx) are
  // expected and not logged.
  if (statusCode >= 500) {
    request.log.error({ err: error }, error.title || 'Request error')
  }
  return reply
    .status(statusCode)
    .type('application/problem+json')
    .send({
      type: error.type || ProblemTypes.INTERNAL_ERROR,
      title: error.title || 'Request error',
      errors: error.problems ?? [{ detail: error.detail }]
    })
}
