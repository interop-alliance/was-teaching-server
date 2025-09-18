import { parseSignatureHeader } from '@digitalbazaar/http-signature-header'

import { SpacesRepositoryRequest } from './requests/SpacesRepositoryRequest.js'
import { SpaceRequest } from './requests/SpaceRequest.js'
import { CollectionRequest } from './requests/CollectionRequest.js'
import { SPEC_URL } from '../config.default.js'
import { verifyZcap } from './zcap.js'

export async function initSpacesRepositoryRoutes (app, options) {
  // All SpacesRepository routes require auth-related headers
  // Check headers are present (throw 401 otherwise)
  app.addHook('onRequest', requireAuthHeaders)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)

  // Create a Space
  app.post('/spaces', async (request, reply) => reply.redirect('/spaces/'))
  app.post('/spaces/', SpacesRepositoryRequest.post)

  // List Spaces
  app.get('/spaces', async (request, reply) => reply.redirect('/spaces/'))
  // TODO
  app.get('/spaces/', async (request, reply) => {})
}

export async function initSpaceRoutes (app, options) {
  // All Space routes require auth-related headers
  // Check headers are present (throw 401 otherwise)
  app.addHook('onRequest', requireAuthHeaders)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)

  // Get Space info
  app.get('/space/:spaceId', SpaceRequest.get)

  // Update or Create Space
  // TODO
  app.put('/space/:spaceId', async (request, reply) => {})
  // Delete Space
  // TODO
  app.delete('/space/:spaceId', async (request, reply) => {})

  // List default '/' collection for a space
  // TODO
  app.get('/space/:spaceId/', async (request, reply) => {})
}

export async function initCollectionRoutes (app, options) {
  // All Collection routes require auth-related headers
  // Check headers are present (throw 401 otherwise)
  app.addHook('onRequest', requireAuthHeaders)
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', parseAuthHeaders)

  // Create Collection
  app.post('/space/:spaceId', async (request, reply) => reply.redirect('/space/:spaceId/'))
  app.post('/space/:spaceId/', CollectionRequest.post)
}

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

    console.log('PARAMS:', request.zcap)
  } catch(err) {
    console.error(err)
    return reply.status(400).type('application/problem+json')
      .send({
        type: `${SPEC_URL}#authorization`,
        title: 'Invalid headers.',
        errors: [{
          detail: 'Error parsing Authorization, Capability-Invocation, Digest headers.',
        }]
      })
  }
  // Ensure keyId was parsed from the Authorization header
  if (!params?.keyId) {
    return reply.status(400).type('application/problem+json')
      .send({
        type: `${SPEC_URL}#authorization`,
        title: 'Invalid Authorization header.',
        errors: [{
          detail: 'Authorization header is missing the keyId parameter.',
        }]
      })
  }
}

export async function requireAuthHeaders (request, reply) {
  const { headers } = request
  if (!(headers['authorization'] && headers['capability-invocation'])) {
    return reply.status(401).type('application/problem+json')
      .send({
        type: `${SPEC_URL}#authorization`,
        title: 'Invalid request.',
        errors: [{
          detail: 'Authorization and Capability-Invocation headers are required.',
        }]
      })
  }
}

export async function handleZcapVerify ({
  url, allowedTarget, allowedAction, method, headers, serverUrl, spaceController,
  requestName, specErrorSection, reply
}) {
  let zcapVerifyResult
  try {
    zcapVerifyResult = await verifyZcap({ url, allowedTarget, allowedAction,
      method, headers, serverUrl, spaceController })
  } catch (err) {
    console.warn('Error verifying zcap:', err)
    return reply.status(400).type('application/problem+json')
      .send({
        type: `${SPEC_URL}#${specErrorSection}`,
        title: `Invalid ${requestName} request.`,
        errors: [{
          detail: `Error verifying authorization: "${err.toString()}"`
        }]
      })
  }
  console.log('VERIFY RESULT:', zcapVerifyResult)

  if (!zcapVerifyResult.verified) {
    return reply.status(404).type('application/problem+json')
      .send({
        type: `${SPEC_URL}#{specErrorSection}`,
        title: `Invalid ${requestName} request.`,
        errors: [{
          detail: 'URL not found or invalid authorization.',
        }]
      })
  }
}
