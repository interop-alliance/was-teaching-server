/**
 * ZCap verification: handleZcapVerify() checks the capability-invocation
 * signature against the Space controller's Ed25519 key, synthesizing the root
 * capability via the document loader.
 */
import type { IncomingHttpHeaders } from 'node:http'
import { securityLoader } from '@interop/security-document-loader'
import {
  verifyCapabilityInvocation,
  type VerifyCapabilityInvocationResult
} from '@interop/http-signature-zcap-verify'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import * as didKey from '@interop/did-method-key'
import type { IPublicKey } from '@interop/data-integrity-core'
import { AuthVerificationError, UnauthorizedError } from './errors.js'
import type { IDID, IVerificationMethod } from './types.js'

const didKeyDriver = didKey.driver()
didKeyDriver.use({
  multibaseMultikeyHeader: 'z6Mk',
  fromMultibase: Ed25519VerificationKey.from
})

/** Minimal logger surface used during verification (console / request.log). */
interface ZcapLogger {
  error: (...args: any[]) => void
}

/**
 * Verifies the capability-invocation signature on a request against the Space
 * controller's key. Throws AuthVerificationError if verification itself errors,
 * or UnauthorizedError if the capability does not verify.
 *
 * @param options {object}
 * @param options.url {string}   request URL (path), resolved against serverUrl
 * @param options.allowedTarget {string}   the capability's expected
 *   invocationTarget (full URL, including host and port)
 * @param options.allowedAction {string}   expected action, e.g. an HTTP verb
 * @param options.method {string}   the HTTP method of the request
 * @param options.headers {IncomingHttpHeaders}   the request headers (including
 *   `authorization`, `capability-invocation`, and `digest`)
 * @param options.serverUrl {string}   this server's base URL
 * @param options.spaceController {IDID}   the did:key that controls the Space
 * @param [options.requestName] {string}   human-readable request name, used in
 *   error titles
 * @param [options.logger] {ZcapLogger}   logger for verification errors;
 *   defaults to `console`
 * @returns {Promise<void>}
 */
export async function handleZcapVerify({
  url,
  allowedTarget,
  allowedAction,
  method,
  headers,
  serverUrl,
  spaceController,
  requestName = '',
  logger = console
}: {
  url: string
  allowedTarget: string
  allowedAction: string
  method: string
  headers: IncomingHttpHeaders
  serverUrl: string
  spaceController: IDID
  requestName?: string
  logger?: ZcapLogger
}): Promise<void> {
  // logger.info(`Performing zCap verification for url: ${url}`)
  let zcapVerifyResult: VerifyCapabilityInvocationResult
  try {
    zcapVerifyResult = await verifyZcap({
      url,
      allowedTarget,
      allowedAction,
      method,
      headers,
      serverUrl,
      spaceController
    })
  } catch (err) {
    logger.error('ZCAP verification failed:', err)
    throw new AuthVerificationError({ requestName, cause: err as Error })
  }

  if (!zcapVerifyResult.verified) {
    throw new UnauthorizedError({ requestName })
  }
}

/**
 * Performs the underlying capability-invocation verification: builds a document
 * loader whose `urn` protocol handler synthesizes the root capability on demand
 * (its controller is the Space controller), then calls
 * verifyCapabilityInvocation().
 *
 * @param options {object}
 * @param options.url {string}   request URL (path), resolved against serverUrl
 * @param options.allowedTarget {string}   expected invocationTarget (full URL)
 * @param options.allowedAction {string}   expected action, e.g. an HTTP verb
 * @param options.method {string}   the HTTP method of the request
 * @param options.headers {IncomingHttpHeaders}   the request headers
 * @param options.serverUrl {string}   this server's base URL
 * @param options.spaceController {IDID}   the did:key that controls the Space
 * @returns {Promise<VerifyCapabilityInvocationResult>}
 */
export async function verifyZcap({
  url,
  allowedTarget,
  allowedAction,
  method,
  headers,
  serverUrl,
  spaceController
}: {
  url: string
  allowedTarget: string
  allowedAction: string
  method: string
  headers: IncomingHttpHeaders
  serverUrl: string
  spaceController: IDID
}): Promise<VerifyCapabilityInvocationResult> {
  const fullRequestUrl = new URL(url, serverUrl).toString()
  const expected = {
    expectedAction: allowedAction,
    expectedHost: new URL(serverUrl).host,
    rootInvocationTarget: allowedTarget,
    expectedRootCapability: `urn:zcap:root:${encodeURIComponent(allowedTarget)}`,
    expectedTarget: allowedTarget
  }

  const loader = securityLoader()
  loader.setProtocolHandler({
    protocol: 'urn',
    handler: {
      get: async ({ id, url }: { id: string; url?: string }) => {
        const resolvedUrl = url || id
        const rootZcapTarget = decodeURIComponent(
          resolvedUrl.split('urn:zcap:root:')[1]!
        )
        return {
          '@context': 'https://w3id.org/zcap/v1',
          id: resolvedUrl,
          invocationTarget: rootZcapTarget,
          controller: spaceController
        }
      }
    }
  })
  const documentLoader = loader.build()

  // Returns the following object:
  // {
  //     capability, capabilityAction, controller,
  //     dereferencedChain,
  //     invoker: controller,
  //     verificationMethod,
  //     verified: true
  //   }
  return await verifyCapabilityInvocation({
    url: fullRequestUrl,
    method,
    headers: headers as Record<string, string>,
    ...expected,
    documentLoader,
    /**
     * Resolves the invocation's keyId to an Ed25519 verifier.
     * @param options {object}
     * @param options.keyId {string}   the did:key verification method URL
     * @returns {Promise<{ verifier: IVerifier, verificationMethod: IVerificationMethod }>}
     */
    async getVerifier({ keyId }) {
      const verificationMethod = await didKeyDriver.get({ url: keyId })
      const key = await Ed25519VerificationKey.from(
        verificationMethod as IPublicKey
      )
      const verifier = key.verifier()
      return {
        verifier,
        verificationMethod: verificationMethod as IVerificationMethod
      }
    },
    suite: new Ed25519Signature2020()
  })
}
