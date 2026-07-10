/**
 * Auth onRequest hooks: `requireAuthHeaders` (401 if Authorization /
 * Capability-Invocation are missing), `requireAuthHeadersOrPublicRead` (same,
 * but safe methods pass through unauthenticated), and `parseAuthHeaders`
 * (parses the auth headers into `request.zcap`). Every route group in
 * routes.js installs `requireAuthHeadersOrPublicRead` then `parseAuthHeaders`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  AuthHeaderParseError,
  MissingAuthError,
  MissingKeyIdError
} from './errors.js'
import { parseSignatureHeader } from '@interop/http-signature-header'
import { isValidController } from './lib/validateDid.js'
import type { IDID, ParsedZcap } from './types.js'

/**
 * Adds a request.zcap property, which contains the three parsed auth-related
 * request headers (`Authorization:`, `Capability-Invocation:`, and `Digest:`)
 *
 * Example Authorization header:
 *  Signature keyId="did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD#z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD",
 *    headers="(key-id) (created) (expires) (request-target) host capability-invocation content-type digest",
 *    signature="6GoRQ+rW69wBhNyERkafAXEZXZArezHvGRNUWC0HNI4Ss1xAiiMHdayS5aA2R6hLuYRNw6h9J9eCmQVMuHE1Bw==",
 *    created="1758150502",expires="1758151102"
 *
 * Example Capability-Invocation header:
 *  zcap id="urn:zcap:root:http%3A%2F%2Flocalhost%3A42957%2Fspaces%2F",action="POST"
 *
 * Example Digest header:
 *  mh=uEiCPO-qYr-z0GYV5F75-N1l8Rhjv4xIkKZsnbTZeZ7emSA
 *
 * Example request.zcap object value from above headers:
 * {
 *   keyId: 'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD#z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD',
 *   headers: '(key-id) (created) (expires) (request-target) host capability-invocation content-type digest',
 *   signature: '0SXR+S2EiipdjzS9ahNyM9Zdfe2r3fZHJFTaYwK6HGq4dbWkJkiZkvg8DcvXUGxolF9AVc6LEtmbOfAGDAAVBg==',
 *   created: '1758151067',
 *   expires: '1758151667',
 *   invocation: 'zcap id="urn:zcap:root:http%3A%2F%2Flocalhost%3A40767%2Fspaces%2F",action="POST"',
 *   digest: 'mh=uEiCPO-qYr-z0GYV5F75-N1l8Rhjv4xIkKZsnbTZeZ7emSA'
 * }
 *
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function parseAuthHeaders(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const { headers } = request

  // A provisioning-authorized request (e.g. a valid onboarding token) carries a
  // Bearer token, not an HTTP Signature -- there is no zcap to parse.
  if (request.provisioningAuthorized) {
    return
  }

  // No Authorization header presented (e.g. an anonymous read that a fallback
  // policy may authorize). Leave `request.zcap` unset; the handler decides.
  if (!headers.authorization) {
    return
  }

  let keyId: string | undefined
  try {
    // { keyId, headers, signature, created, expires }
    const { params } = parseSignatureHeader(headers.authorization ?? '')
    keyId = params.keyId
    request.zcap = {
      ...params,
      invocation: headers['capability-invocation'],
      digest: headers.digest
    } as ParsedZcap
  } catch (err) {
    throw new AuthHeaderParseError({ cause: err as Error })
  }
  // Ensure keyId was parsed from the Authorization header
  if (!keyId) {
    throw new MissingKeyIdError()
  }
}

/**
 * The DID of the party that signed this request's capability invocation, taken
 * from the parsed `keyId` with its verification-method fragment stripped
 * (`did:key:z6Mk...#z6Mk...` to `did:key:z6Mk...`). Under a delegated
 * capability this is the delegatee -- whoever actually invoked -- not the Space
 * controller.
 *
 * Resolves to `undefined` when the request carries no parsed invocation (an
 * anonymous read of a public Resource, or a provisioning-token request), or
 * when the stripped `keyId` is not a syntactically valid `did:key`. Callers
 * recording it as server-managed provenance therefore treat it as optional,
 * and never persist a value that failed to narrow to a DID.
 *
 * @param request {import('fastify').FastifyRequest}
 * @returns {IDID | undefined}
 */
export function invokerDid(request: FastifyRequest): IDID | undefined {
  const did = request.zcap?.keyId.split('#')[0]
  return isValidController(did) ? did : undefined
}

/**
 * onRequest hook that enforces presence of the auth-related headers. Throws
 * MissingAuthError (401) when `Authorization` or `Capability-Invocation` is
 * absent. For route groups where every operation, reads included, is
 * privileged: the WebKMS `/kms` group uses it (every webkms route is
 * zcap-invoked; the protocol has no public reads). No WAS group qualifies --
 * even the SpacesRepository group lets anonymous List Spaces reads through,
 * answered with the spec's empty-items 200.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function requireAuthHeaders(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  // A provisioning-authorized request (onboarding token) carries no capability
  // invocation and a Bearer -- not Signature -- Authorization header.
  if (request.provisioningAuthorized) {
    return
  }
  const { headers } = request
  if (!(headers.authorization && headers['capability-invocation'])) {
    throw new MissingAuthError()
  }
}

/**
 * Like `requireAuthHeaders`, but lets safe (read) methods through without auth
 * so the handler can decide what an anonymous read sees: a fallback
 * access-control policy (e.g. a world-readable Resource), or for List Spaces
 * the empty-items 200. The handler still denies anonymous reads that no policy
 * authorizes. Unsafe methods (writes) still require auth. Used by every route
 * group.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function requireAuthHeadersOrPublicRead(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  // A provisioning-authorized request (onboarding token) carries no capability
  // invocation and a Bearer -- not Signature -- Authorization header.
  if (request.provisioningAuthorized) {
    return
  }
  const { headers, method } = request
  if (headers.authorization && headers['capability-invocation']) {
    return
  }
  // Safe methods may proceed unauthenticated; authorize() decides via policy.
  if (method === 'GET' || method === 'HEAD') {
    return
  }
  throw new MissingAuthError()
}
