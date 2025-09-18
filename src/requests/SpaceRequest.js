import path from 'node:path'
import { FlexDocStore } from 'flex-docstore'
import { verifyCapabilityInvocation } from
  '@interop-alliance/http-signature-zcap-verify'
import { Ed25519Signature2020 } from '@digitalcredentials/ed25519-signature-2020'
import * as didKey from '@digitalcredentials/did-method-key'
import { Ed25519VerificationKey2020 } from '@digitalcredentials/ed25519-verification-key-2020'
import { securityLoader } from '@digitalcredentials/security-document-loader'
import { SPEC_URL } from '../../config.default.js'

const didKeyDriver = didKey.driver()
didKeyDriver.use({
  multibaseMultikeyHeader: 'z6Mk',
  fromMultibase: Ed25519VerificationKey2020.from
});

export class SpaceRequest {
  /**
   * Request handler for GET /space/:spaceId
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async get (request, reply) {
    const { params: { spaceId }, url, method, headers } = request

    const spaceDescription = await getSpace({ spaceId })
    if (!spaceDescription) {
      return reply.status(404).type('application/problem+json')
        .send({
          type: `${SPEC_URL}#read-space-errors`,
          title: 'Invalid Get Space request.',
          errors: [{
            detail: 'Space not found or invalid authorization.',
          }]
        })
    }
    const spaceController = spaceDescription.controller

    let zcapVerifyResult
    try {
      zcapVerifyResult = await verifySpaceZcap({ spaceId, url, method, headers,
        serverUrl: this.serverUrl, spaceController })
    } catch (err) {
      console.warn('Error verifying zcap:', err)
      return reply.status(400).type('application/problem+json')
        .send({
          type: `${SPEC_URL}#read-space-errors`,
          title: 'Invalid Get Space request.',
          errors: [{
            detail: `Error verifying authorization: "${err.toString()}"`
          }]
        })
    }
    console.log('VERIFY RESULT:', zcapVerifyResult)

    if (!zcapVerifyResult.verified) {
      return reply.status(404).type('application/problem+json')
        .send({
          type: `${SPEC_URL}#read-space-errors`,
          title: 'Invalid Get Space request.',
          errors: [{
            detail: 'Space not found or invalid authorization.',
          }]
        })
    }

    return reply.status(200).send(spaceDescription)
  }
}

export async function verifySpaceZcap (
  { spaceId, url, method, headers, serverUrl, spaceController }
) {
  const fullRequestUrl = (new URL(url, serverUrl)).toString()
  const expectedTarget = new URL(`/space/${spaceId}`, serverUrl)
  const expected = {
    expectedAction: 'GET',
    expectedHost: expectedTarget.host,
    rootInvocationTarget: expectedTarget.toString(),
    expectedRootCapability: `urn:zcap:root:${encodeURIComponent(expectedTarget.toString())}`,
    expectedTarget: expectedTarget.toString()
  }

  const loader = securityLoader()
  loader.setProtocolHandler({
    protocol: 'urn',
    handler: {
      get: async ({ id, url }) => {
        url = url || id
        const rootZcapTarget = decodeURIComponent(url.split('urn:zcap:root:')[1])
        return {
          '@context': 'https://w3id.org/zcap/v1',
          id: url,
          invocationTarget: rootZcapTarget,
          controller: spaceController
        }
      }
    }
  })
  const documentLoader = loader.build()

  // {
  //     capability, capabilityAction, controller,
  //     dereferencedChain,
  //     invoker: controller,
  //     verificationMethod,
  //     verified: true
  //   }
  return await verifyCapabilityInvocation({
    url: fullRequestUrl, method, headers, ...expected, documentLoader,
    async getVerifier ({ keyId }) {
      const verificationMethod = await didKeyDriver.get({url: keyId});
      const key = await Ed25519VerificationKey2020.from(verificationMethod);
      const verifier = key.verifier();
      return { verifier, verificationMethod }
    },
    suite: new Ed25519Signature2020()
  })
}

export async function getSpace ({ spaceId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')
  const spaceDir = path.join(spacesRepository, spaceId)
  const storage = FlexDocStore.using('files', { dir: spaceDir, extension: '.json' })

  return storage.get('.space')
}
