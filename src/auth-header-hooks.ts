/**
 * Auth onRequest hooks: `requireAuthHeaders` (401 if Authorization /
 * Capability-Invocation are missing) and `parseAuthHeaders` (parses the auth
 * headers into `request.zcap`). Installed by every route group in routes.js.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  AuthHeaderParseError,
  MissingAuthError,
  MissingKeyIdError
} from './errors.js'
import { parseSignatureHeader } from '@interop/http-signature-header'
import type { ParsedZcap } from './types.js'

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

    // console.log('PARAMS:', request.zcap)
  } catch (err) {
    throw new AuthHeaderParseError({ cause: err as Error })
  }
  // Ensure keyId was parsed from the Authorization header
  if (!keyId) {
    throw new MissingKeyIdError()
  }
}

/**
 * onRequest hook that enforces presence of the auth-related headers. Throws
 * MissingAuthError (401) when `Authorization` or `Capability-Invocation` is
 * absent.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function requireAuthHeaders(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const { headers } = request
  if (!(headers.authorization && headers['capability-invocation'])) {
    throw new MissingAuthError()
  }
}
