/**
 * Custom error classes (each carries title / detail / statusCode) plus
 * handleError, the Fastify error handler installed by each route group.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * 404 — the requested Space does not exist, or the caller is not authorized.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param params {...*}   forwarded to Error
 */
export class SpaceNotFoundError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { requestName }: { requestName?: string } = {},
    ...params: unknown[]
  ) {
    super(params as never)
    this.title = `Invalid ${requestName || 'Space'} request`
    this.detail = 'Space not found or invalid authorization.'
    this.statusCode = 404
  }
}

/**
 * 400 — the provided space id is not URL-safe / otherwise invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param params {...*}   forwarded to Error
 */
export class InvalidSpaceIdError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { requestName }: { requestName?: string } = {},
    ...params: unknown[]
  ) {
    super(params as never)
    this.title = `Invalid ${requestName || 'Space'} request`
    this.detail = 'Invalid space id (make sure it is URL-safe).'
    this.statusCode = 400
  }
}

/**
 * 400 — the provided collection id is not URL-safe / otherwise invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param params {...*}   forwarded to Error
 */
export class InvalidCollectionIdError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { requestName }: { requestName?: string } = {},
    ...params: unknown[]
  ) {
    super(params as never)
    this.title = `Invalid ${requestName || 'Collection'} request`
    this.detail = 'Invalid collection id (make sure it is URL-safe).'
    this.statusCode = 400
  }
}

/**
 * 400 — the provided resource id is not URL-safe / otherwise invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param params {...*}   forwarded to Error
 */
export class InvalidResourceIdError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { requestName }: { requestName?: string } = {},
    ...params: unknown[]
  ) {
    super(params as never)
    this.title = `Invalid ${requestName || 'Resource'} request`
    this.detail = 'Invalid resource id (make sure it is URL-safe).'
    this.statusCode = 400
  }
}

/**
 * 400 — the Collection Description request body is missing or invalid.
 * @param params {...*}   forwarded to Error
 */
export class InvalidCollectionError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(...params: unknown[]) {
    super(params as never)
    this.title = 'Invalid Collection Description body'
    this.detail = 'Collection Description body is missing or invalid.'
    this.statusCode = 400
  }
}

/**
 * 404 — the requested Collection does not exist, or the caller is not
 * authorized.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param params {...*}   forwarded to Error
 */
export class CollectionNotFoundError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { requestName }: { requestName?: string } = {},
    ...params: unknown[]
  ) {
    super(params as never)
    this.title = `Invalid ${requestName || 'Collection'} request`
    this.detail = 'Collection not found or invalid authorization.'
    this.statusCode = 404
  }
}

/**
 * 404 — the requested Resource does not exist, or the caller is not authorized.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param params {...*}   forwarded to Error
 */
export class ResourceNotFoundError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { requestName }: { requestName?: string } = {},
    ...params: unknown[]
  ) {
    super(params as never)
    this.title = `Invalid ${requestName || 'Resource'} request`
    this.detail = 'Resource not found or invalid authorization.'
    this.statusCode = 404
  }
}

/**
 * 404 — capability invocation did not verify (reported as not-found so as not
 * to leak resource existence).
 * @param options {object}
 * @param options.requestName {string}   request name used in the error title
 * @param params {...*}   forwarded to Error
 */
export class UnauthorizedError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor({ requestName }: { requestName?: string }, ...params: unknown[]) {
    super(params as never)
    this.title = `Invalid ${requestName} request.`
    this.detail = 'URL not found or invalid authorization.'
    this.statusCode = 404
  }
}

/**
 * 401 — required `Authorization` / `Capability-Invocation` headers are missing.
 * @param params {...*}   forwarded to Error
 */
export class MissingAuthError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(...params: unknown[]) {
    super(params as never)
    this.title = 'Invalid request'
    this.detail =
      'Authorization and Capability-Invocation headers are required.'
    this.statusCode = 401
  }
}

/**
 * 400 — the `Authorization` header did not include a `keyId` parameter.
 * @param params {...*}   forwarded to Error
 */
export class MissingKeyIdError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(...params: unknown[]) {
    super(params as never)
    this.title = 'Invalid Authorization header'
    this.detail = 'Authorization header is missing the keyId parameter.'
    this.statusCode = 400
  }
}

/**
 * 400 — failed to parse the `Authorization`, `Capability-Invocation`, or
 * `Digest` headers.
 * @param options {object}
 * @param options.cause {Error}   the underlying parse error
 * @param params {...*}   forwarded to Error
 */
export class AuthHeaderParseError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor({ cause }: { cause: Error }, ...params: unknown[]) {
    super(params as never)
    this.cause = cause
    this.title = 'Invalid authorization headers'
    this.detail =
      'Error parsing Authorization, Capability-Invocation, or Digest headers.'
    this.statusCode = 400
  }
}

/**
 * 400 — an error was thrown while verifying the authorization headers.
 * @param options {object}
 * @param options.requestName {string}   request name used in the error title
 * @param options.cause {Error}   the underlying verification error
 * @param params {...*}   forwarded to Error
 */
export class AuthVerificationError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { requestName, cause }: { requestName: string; cause: Error },
    ...params: unknown[]
  ) {
    super(params as never)
    this.cause = cause
    this.title = `Invalid ${requestName} request.`
    this.detail = 'Error verifying authorization headers.'
    this.statusCode = 400
  }
}

/**
 * 400 — the DID that signed the capability invocation does not match the
 * `controller` in the Create Space request body.
 * @param options {object}
 * @param options.zcapSigningDid {string}   DID that signed the invocation
 * @param options.controller {string}   controller DID supplied in the body
 * @param params {...*}   forwarded to Error
 */
export class SpaceControllerMismatchError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    {
      zcapSigningDid,
      controller
    }: { zcapSigningDid: string; controller: string },
    ...params: unknown[]
  ) {
    super(params as never)
    this.title = 'Invalid Create Space request'
    this.detail =
      'Authorization capability signing DID' +
      ` ("${zcapSigningDid}") does not match the controller in the body ("${controller}").`
    this.statusCode = 400
  }
}

/**
 * 500 — an underlying storage operation failed.
 * @param options {object}
 * @param options.cause {Error}   the underlying storage error
 * @param [options.requestName] {string}   request name used in the error title
 * @param params {...*}   forwarded to Error
 */
export class StorageError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { cause, requestName }: { cause: Error; requestName?: string },
    ...params: unknown[]
  ) {
    super(params as never)
    this.cause = cause
    this.title = requestName
      ? `Storage Error (${requestName}): ${cause.message}`
      : `Storage Error: ${cause.message}`
    this.detail = cause.message
    this.statusCode = 500
  }
}

/**
 * 400 — a required field of the request body is missing or invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param [options.detail] {string}   specific detail describing the problem
 * @param params {...*}   forwarded to Error
 */
export class InvalidRequestBodyError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { requestName, detail }: { requestName?: string; detail?: string } = {},
    ...params: unknown[]
  ) {
    super(params as never)
    this.title = `Invalid ${requestName || 'request'} body`
    this.detail =
      detail || 'Request body is missing one or more required fields.'
    this.statusCode = 400
  }
}

/**
 * 400 — the request is missing a required `Content-Type` header.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param params {...*}   forwarded to Error
 */
export class MissingContentTypeError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor(
    { requestName }: { requestName?: string } = {},
    ...params: unknown[]
  ) {
    super(params as never)
    this.title = `Invalid ${requestName || 'request'}`
    this.detail = 'A Content-Type header is required for this request.'
    this.statusCode = 400
  }
}

/**
 * 400 — the uploaded archive is not a valid WAS space export.
 * @param options {object}
 * @param [options.message] {string}   detail message describing the problem
 * @param params {...*}   forwarded to Error
 */
export class InvalidImportError extends Error {
  title: string
  detail: string
  statusCode: number
  constructor({ message }: { message?: string } = {}, ...params: unknown[]) {
    super(message, ...(params as []))
    this.title = 'Invalid space import'
    this.detail =
      message || 'The uploaded archive is not a valid WAS space export.'
    this.statusCode = 400
  }
}

/**
 * Fastify error handler installed by each route group. Serializes the error to
 * an `application/problem+json` response using its `statusCode` / `title` /
 * `detail` (defaulting to 500 when no statusCode is present).
 * @param error {Error & { statusCode?: number, title?: string, detail?: string }}
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<FastifyReply>}
 */
export async function handleError(
  error: Error & { statusCode?: number; title?: string; detail?: string },
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
  return (
    reply
      .status(statusCode)
      .type('application/problem+json')
      // .type('application/json')
      .send({
        // type: `${SPEC_URL}#read-space-errors`,
        title: error.title,
        errors: [{ detail: error.detail }]
      })
  )
}
