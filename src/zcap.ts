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
 * Returns true when a `Capability-Invocation` header value is the bare root
 * form (`zcap id="urn:zcap:root:..."` -- the signer invokes the root capability
 * directly), false when it embeds a delegated capability
 * (`zcap capability="<base64url(gzip(json))>"`). The check is safe on the raw
 * header: a `capability=` substring cannot occur inside the root form's
 * url-encoded `id` (where `=` is percent-encoded).
 *
 * @param options {object}
 * @param options.invocation {string}   the raw `Capability-Invocation` header
 * @returns {boolean}
 */
export function isRootInvocation({
  invocation
}: {
  invocation: string
}): boolean {
  return !invocation.includes('capability=')
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
 * @param [options.allowTargetQuery] {boolean}   tolerate query parameters that
 *   extend `allowedTarget` on the request URL (see `verifyZcap`)
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
  logger = console,
  allowTargetQuery = false
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
  allowTargetQuery?: boolean
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
      spaceController,
      allowTargetQuery
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
 * @param [options.allowTargetQuery] {boolean}   when set, accept a request URL
 *   that adds query parameters to `allowedTarget` (e.g. List Collection's
 *   `?limit`/`cursor`) as authorized by a capability for the bare target. The
 *   spec requires that pagination parameters select a page within an
 *   already-authorized target without changing the target a capability must
 *   match. The zcap library otherwise requires the capability's
 *   `invocationTarget` to equal the full request URL exactly, so this enables
 *   target attenuation (the library treats a `?`-query suffix as a valid RESTful
 *   attenuation) and admits both the bare-target root capability (a delegate
 *   following `next`) and the query-bearing one (a controller invoking the URL
 *   directly). The actual gate -- the bare-target root capability -- is
 *   unchanged. (TODO: the `/quotas` endpoint should adopt this too, so its
 *   per-Collection breakdown can return to the spec's `?include=collections`
 *   opt-in.)
 * @returns {Promise<VerifyCapabilityInvocationResult>}
 */
export async function verifyZcap({
  url,
  allowedTarget,
  allowedAction,
  method,
  headers,
  serverUrl,
  spaceController,
  allowTargetQuery = false
}: {
  url: string
  allowedTarget: string
  allowedAction: string
  method: string
  headers: IncomingHttpHeaders
  serverUrl: string
  spaceController: IDID
  allowTargetQuery?: boolean
}): Promise<VerifyCapabilityInvocationResult> {
  const fullRequestUrl = new URL(url, serverUrl).toString()
  const rootCapabilityId = (target: string): string =>
    `urn:zcap:root:${encodeURIComponent(target)}`
  const expected = allowTargetQuery
    ? {
        expectedAction: allowedAction,
        expectedHost: new URL(serverUrl).host,
        // `expectedTarget` must equal the proof's invocationTarget (the full
        // request URL incl. query); accept either root capability id so both a
        // bare-target delegate and a controller invoking the query URL verify.
        expectedRootCapability: [
          ...new Set([
            rootCapabilityId(allowedTarget),
            rootCapabilityId(fullRequestUrl)
          ])
        ],
        expectedTarget: fullRequestUrl,
        allowTargetAttenuation: true
      }
    : {
        expectedAction: allowedAction,
        expectedHost: new URL(serverUrl).host,
        rootInvocationTarget: allowedTarget,
        expectedRootCapability: rootCapabilityId(allowedTarget),
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
