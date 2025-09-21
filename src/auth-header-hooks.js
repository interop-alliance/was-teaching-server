import { AuthHeaderParseError, MissingAuthError, MissingKeyIdError } from './errors.js'
import { parseSignatureHeader } from '@digitalbazaar/http-signature-header'

/**
 * Adds a request.zcap property, which contains the three parsed auth-related
 * request headers.
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
 * @param request
 * @param reply
 * @returns {Promise<void>}
 */
export async function parseAuthHeaders (request, reply) {
  const { headers } = request

  let params
  try {
    // { keyId, headers, signature, created, expires }
    ({ params } = parseSignatureHeader(headers.authorization))
    request.zcap = { ...params }
    request.zcap.invocation = headers['capability-invocation']
    request.zcap.digest = headers['digest']

    // console.log('PARAMS:', request.zcap)
  } catch(err) {
    throw new AuthHeaderParseError({ cause: err })
  }
  // Ensure keyId was parsed from the Authorization header
  if (!params?.keyId) {
    throw new MissingKeyIdError()
  }
}

export async function requireAuthHeaders (request, reply) {
  const { headers } = request
  if (!(headers['authorization'] && headers['capability-invocation'])) {
    throw new MissingAuthError()
  }
}
