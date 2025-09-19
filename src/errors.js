import { SPEC_URL } from '../config.default.js'

export class SpaceNotFoundError extends Error {
  constructor ({ requestName } = {}, ...params) {
    super(params)
    this.title = `Invalid ${requestName || 'Space'} request`
    this.detail = 'Space not found or invalid authorization.'
    this.statusCode = 404
  }
}

export class CollectionNotFoundError extends Error {
  constructor ({ requestName } = {}, ...params) {
    super(params)
    this.title = `Invalid ${requestName || 'Collection'} request`
    this.detail = 'Collection not found or invalid authorization.'
    this.statusCode = 404
  }
}

export class UnauthorizedError extends Error {
  constructor ({ requestName }, ...params) {
    super(params)
    this.title = `Invalid ${requestName} request.`
    this.detail = 'URL not found or invalid authorization.'
    this.statusCode = 404
  }
}

export class MissingAuthError extends Error {
  constructor (...params) {
    super(params)
    this.title = 'Invalid request'
    this.detail = 'Authorization and Capability-Invocation headers are required.'
    this.statusCode = 401
  }
}

export class MissingKeyIdError extends Error {
  constructor (...params) {
    super(params)
    this.title = 'Invalid Authorization header'
    this.detail = 'Authorization header is missing the keyId parameter.'
    this.statusCode = 400
  }
}

export class AuthHeaderParseError extends Error {
  constructor ({ cause }, ...params) {
    super(params)
    this.cause = cause
    this.title = 'Invalid authorization headers'
    this.detail = 'Error parsing Authorization, Capability-Invocation, or Digest headers.'
    this.statusCode = 400
  }
}

export class AuthVerificationError extends Error {
  constructor ({ requestName, cause }, ...params) {
    super(params)
    this.cause = cause
    this.title = `Invalid ${requestName} request.`
    this.detail = 'Error verifying authorization headers.'
    this.statusCode = 400
  }
}

export class SpaceControllerMismatchError extends Error {
  constructor ({ zcapSigningDid, controller }, ...params) {
    super(params)
    this.title = 'Invalid Create Space request'
    this.detail = 'Authorization capability signing DID' +
      ` ("${zcapSigningDid}") does not match the controller in the body ("${controller}").`
    this.statusCode = 400
  }
}

export async function handleError (error, request, reply) {
  return reply
    .status(error.statusCode || 500)
    .type('application/problem+json')
    // .type('application/json')
    .send({
      // type: `${SPEC_URL}#read-space-errors`,
      title: error.title,
      errors: [{ detail: error.detail }]
    })
}
