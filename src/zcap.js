import { securityLoader } from '@digitalcredentials/security-document-loader'
import { verifyCapabilityInvocation } from '@interop-alliance/http-signature-zcap-verify'
import { Ed25519VerificationKey2020 } from '@digitalcredentials/ed25519-verification-key-2020'
import { Ed25519Signature2020 } from '@digitalcredentials/ed25519-signature-2020'
import * as didKey from '@digitalcredentials/did-method-key'
import { AuthVerificationError, UnauthorizedError } from './errors.js'

const didKeyDriver = didKey.driver()
didKeyDriver.use({
  multibaseMultikeyHeader: 'z6Mk',
  fromMultibase: Ed25519VerificationKey2020.from
});

export async function handleZcapVerify ({
  url, allowedTarget, allowedAction, method, headers, serverUrl, spaceController,
  requestName
}) {
  let zcapVerifyResult
  try {
    zcapVerifyResult = await verifyZcap({ url, allowedTarget, allowedAction,
      method, headers, serverUrl, spaceController })
  } catch (err) {
    throw new AuthVerificationError({ requestName, cause: err })
  }
  // console.log('VERIFY RESULT:', zcapVerifyResult)

  if (!zcapVerifyResult.verified) {
    throw new UnauthorizedError({ requestName })
  }
}

export async function verifyZcap ({
  url, allowedTarget, allowedAction, method, headers, serverUrl, spaceController
}) {
  // console.log('HEADERS:', headers)
  const fullRequestUrl = (new URL(url, serverUrl)).toString()
  const expected = {
    expectedAction: allowedAction,
    expectedHost: (new URL(serverUrl)).host,
    rootInvocationTarget: allowedTarget,
    expectedRootCapability: `urn:zcap:root:${encodeURIComponent(allowedTarget)}`,
    expectedTarget: allowedTarget
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
