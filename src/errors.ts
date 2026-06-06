/**
 * Custom error classes (each carries type / title / detail / statusCode) plus
 * handleError, the Fastify error handler installed by each route group.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

import { ProblemTypes, type ProblemType } from './problem-types.js'

/**
 * A single entry in the `errors` array of an `application/problem+json`
 * response.
 * @property detail {string}   specific explanation of this occurrence
 * @property [pointer] {string}   RFC 6901 JSON Pointer (in `#/field` form)
 *   identifying the offending part of the request body
 */
export interface Problem {
  detail: string
  pointer?: string
}

/**
 * Base class for the server's error hierarchy. Carries the four
 * `application/problem+json` fields (`type` / `title` / `detail` /
 * `statusCode`) plus an optional `problems` array of `{ detail, pointer }`
 * entries; `handleError` serializes these to the wire. Subclasses set their
 * distinguishing values via `super({ ... })`.
 * @param options {object}
 * @param options.type {ProblemType}   problem-kind URI (see problem-types.ts)
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
      detail:
        'Authorization and Capability-Invocation headers are required.',
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
 * 400 — the DID that signed the capability invocation does not match the
 * `controller` in the Create Space request body.
 * @param options {object}
 * @param options.zcapSigningDid {string}   DID that signed the invocation
 * @param options.controller {string}   controller DID supplied in the body
 */
export class SpaceControllerMismatchError extends ProblemError {
  constructor({
    zcapSigningDid,
    controller
  }: {
    zcapSigningDid: string
    controller: string
  }) {
    const detail =
      'Authorization capability signing DID' +
      ` ("${zcapSigningDid}") does not match the controller in the body ("${controller}").`
    super({
      type: ProblemTypes.CONTROLLER_MISMATCH,
      title: 'Invalid Create Space request',
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/controller' }]
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
      ...(pointer
        ? { problems: [{ detail: resolvedDetail, pointer }] }
        : {})
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
 * 400 — the uploaded archive is not a valid WAS space export.
 * @param options {object}
 * @param [options.message] {string}   detail message describing the problem
 */
export class InvalidImportError extends ProblemError {
  constructor({ message }: { message?: string } = {}) {
    super({
      type: ProblemTypes.INVALID_IMPORT,
      title: 'Invalid space import',
      detail:
        message || 'The uploaded archive is not a valid WAS space export.',
      statusCode: 400
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
