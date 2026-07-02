/**
 * ZCap verification: handleZcapVerify() checks the capability-invocation
 * signature against the Space controller's Ed25519 key, synthesizing the root
 * capability via the document loader. Also home to the zcap *revocation*
 * verification pair (the `/kms` facet, Track C of `_spec/web-kms-roadmap.md`):
 * verifyRevocationChain() validates a to-be-revoked capability's delegation
 * chain, and handleRevocationInvocationVerify() authorizes the submission
 * under the dual-root rule (keystore root, or the revocation URL's own root
 * controlled by any chain participant -- ezcap-express's
 * `authorizeZcapRevocation` convention).
 */
import type { IncomingHttpHeaders } from 'node:http'
import { securityLoader } from '@interop/security-document-loader'
import {
  verifyCapabilityInvocation,
  type VerifyCapabilityInvocationResult
} from '@interop/http-signature-zcap-verify'
import jsigs from '@interop/jsonld-signatures'
import {
  CapabilityDelegation,
  type InspectCapabilityChain
} from '@interop/zcap'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import * as didKey from '@interop/did-method-key'
import type { IDocumentLoader, IPublicKey } from '@interop/data-integrity-core'
import {
  AuthVerificationError,
  InvalidRevocationError,
  UnauthorizedError
} from './errors.js'
import type { IDID, IVerificationMethod } from './types.js'

const didKeyDriver = didKey.driver()
didKeyDriver.use({
  multibaseMultikeyHeader: 'z6Mk',
  fromMultibase: Ed25519VerificationKey.from
})

/**
 * The root capability id convention: `urn:zcap:root:` + the url-encoded
 * invocation target (shared by WAS and webkms).
 * @param target {string}   the root invocation target (full URL)
 * @returns {string}
 */
function rootCapabilityId(target: string): string {
  return `urn:zcap:root:${encodeURIComponent(target)}`
}

/**
 * Builds a document loader whose `urn` protocol handler synthesizes
 * `urn:zcap:root:<target>` capabilities on demand, with the controller chosen
 * per target. The zcap library only dereferences a root capability it already
 * expects (per `expectedRootCapability`), so `controllerFor` sees expected
 * targets only -- it may still throw to refuse one outright.
 *
 * @param options {object}
 * @param options.controllerFor {(target: string) => IDID | string[]}   maps a
 *   decoded root invocation target to the controller(s) of its synthesized
 *   root capability
 * @returns {IDocumentLoader}
 */
function rootCapabilityLoader({
  controllerFor
}: {
  controllerFor: (target: string) => IDID | string[]
}): IDocumentLoader {
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
          controller: controllerFor(rootZcapTarget)
        }
      }
    }
  })
  return loader.build()
}

/**
 * Resolves an invocation's keyId to an Ed25519 verifier (the
 * `verifyCapabilityInvocation` HTTP-signature key hook).
 * @param options {object}
 * @param options.keyId {string}   the did:key verification method URL
 * @returns {Promise<{ verifier: object, verificationMethod: IVerificationMethod }>}
 */
async function getVerifier({ keyId }: { keyId: string }) {
  const verificationMethod = await didKeyDriver.get({ url: keyId })
  const key = await Ed25519VerificationKey.from(
    verificationMethod as IPublicKey
  )
  const verifier = key.verifier()
  return {
    verifier,
    verificationMethod: verificationMethod as IVerificationMethod
  }
}

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
 * @param [options.allowTargetAttenuation] {boolean}   accept a request URL
 *   that path-extends `allowedTarget` under a capability rooted at
 *   `allowedTarget` (see `verifyZcap`)
 * @param [options.inspectCapabilityChain] {InspectCapabilityChain}   hook run
 *   against the dereferenced chain after signature verification (the
 *   revocation-check extension point; see `verifyZcap`)
 * @param [options.maxChainLength] {number}   max delegation chain length,
 *   root included (see `verifyZcap`)
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL in
 *   milliseconds (see `verifyZcap`)
 * @returns {Promise<VerifyCapabilityInvocationResult>}   the successful
 *   verification result (callers needing the dereferenced chain, e.g. the
 *   per-key `maxCapabilityChainLength` gate, read it from here)
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
  allowTargetQuery = false,
  allowTargetAttenuation = false,
  inspectCapabilityChain,
  maxChainLength,
  maxDelegationTtl
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
  allowTargetAttenuation?: boolean
  inspectCapabilityChain?: InspectCapabilityChain
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<VerifyCapabilityInvocationResult> {
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
      allowTargetQuery,
      allowTargetAttenuation,
      inspectCapabilityChain,
      maxChainLength,
      maxDelegationTtl
    })
  } catch (err) {
    logger.error('ZCAP verification failed:', err)
    throw new AuthVerificationError({ requestName, cause: err as Error })
  }

  if (!zcapVerifyResult.verified) {
    throw new UnauthorizedError({ requestName })
  }
  return zcapVerifyResult
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
 * @param [options.allowTargetAttenuation] {boolean}   when set, accept a
 *   request URL that *path*-extends `allowedTarget` (e.g. a WebKMS key
 *   operation posted to `<keystoreId>/keys/<keyId>` under a capability rooted
 *   at the keystore). The root capability is `allowedTarget`'s alone -- unlike
 *   `allowTargetQuery`, the extended URL is never itself an acceptable root --
 *   so both a root invocation by the controller and a delegated zcap whose
 *   `invocationTarget` narrows down to the request URL verify against the
 *   `allowedTarget` root (the webkms authorization model; bedrock's
 *   `rootInvocationTarget: keystore.id`).
 * @param [options.inspectCapabilityChain] {InspectCapabilityChain}   hook run
 *   against the dereferenced chain after signature verification -- the
 *   revocation-check extension point (a stored revocation of any capability
 *   in the chain fails the verification). Absent by default: the WAS route
 *   families have no revocation store yet.
 * @param [options.maxChainLength] {number}   max delegation chain length,
 *   root included (the `/kms` families pass `KMS_MAX_CHAIN_LENGTH`; absent,
 *   the zcap library's own default applies)
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL in
 *   milliseconds, measured `expires` minus the delegation proof's `created`
 *   (the `/kms` families pass `KMS_MAX_DELEGATION_TTL`; absent, unbounded)
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
  allowTargetQuery = false,
  allowTargetAttenuation = false,
  inspectCapabilityChain,
  maxChainLength,
  maxDelegationTtl
}: {
  url: string
  allowedTarget: string
  allowedAction: string
  method: string
  headers: IncomingHttpHeaders
  serverUrl: string
  spaceController: IDID
  allowTargetQuery?: boolean
  allowTargetAttenuation?: boolean
  inspectCapabilityChain?: InspectCapabilityChain
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<VerifyCapabilityInvocationResult> {
  const fullRequestUrl = new URL(url, serverUrl).toString()
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
    : allowTargetAttenuation
      ? {
          expectedAction: allowedAction,
          expectedHost: new URL(serverUrl).host,
          // The proof's invocationTarget is the invoked URL: `allowedTarget`
          // itself, or a path under it (accepted as a RESTful attenuation).
          // The only acceptable root capability is `allowedTarget`'s. The
          // array form is narrowed to `string` by the verify fork's option
          // type, but the underlying `@interop/zcap` CapabilityInvocation
          // accepts `string | string[]` -- hence the cast.
          expectedRootCapability: rootCapabilityId(allowedTarget),
          expectedTarget: [
            ...new Set([allowedTarget, fullRequestUrl])
          ] as unknown as string,
          allowTargetAttenuation: true
        }
      : {
          expectedAction: allowedAction,
          expectedHost: new URL(serverUrl).host,
          rootInvocationTarget: allowedTarget,
          expectedRootCapability: rootCapabilityId(allowedTarget),
          expectedTarget: allowedTarget
        }

  const documentLoader = rootCapabilityLoader({
    controllerFor: () => spaceController
  })

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
    getVerifier,
    inspectCapabilityChain,
    maxChainLength,
    maxDelegationTtl,
    suite: new Ed25519Signature2020()
  })
}

/**
 * Extracts the controller DIDs of one capability (`controller` may be a
 * single value or an array on a synthesized root).
 * @param capability {object}   a capability from a dereferenced chain
 * @returns {string[]}
 */
function capabilityControllers(capability: {
  controller?: string | string[]
}): string[] {
  const { controller } = capability
  if (controller === undefined) {
    return []
  }
  return Array.isArray(controller) ? controller : [controller]
}

/**
 * Verifies the delegation chain of a capability submitted for revocation
 * (`CapabilityDelegation` proof purpose over the embedded chain), throwing
 * `InvalidRevocationError` (400) when it does not verify. The chain must root
 * in the keystore: its root capability's invocation target must be
 * `keystoreUrl` or a path under it (enforced where the root is synthesized,
 * so a chain aimed at another keystore -- or another service -- cannot be
 * submitted here, per ezcap-express `authorizeZcapRevocation`). The supplied
 * `inspectCapabilityChain` hook runs against the full dereferenced chain, the
 * submitted capability included -- so a chain containing an already-revoked
 * link (resubmissions included) fails verification.
 *
 * @param options {object}
 * @param options.capability {object}   the delegated capability to be revoked
 *   (the request body, verbatim)
 * @param options.keystoreUrl {string}   the keystore's full URL (the required
 *   root of the chain)
 * @param options.keystoreController {IDID}   the stored config's controller
 *   (controller of the synthesized root capability)
 * @param [options.inspectCapabilityChain] {InspectCapabilityChain}   the
 *   revocation-store hook
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @returns {Promise<{ delegator: string, chainControllers: string[] }>}   the
 *   capability's delegator (its delegation proof's controller) and every
 *   controller in its chain (the parties allowed to submit the revocation)
 */
export async function verifyRevocationChain({
  capability,
  keystoreUrl,
  keystoreController,
  inspectCapabilityChain,
  maxChainLength,
  maxDelegationTtl
}: {
  capability: Record<string, unknown>
  keystoreUrl: string
  keystoreController: IDID
  inspectCapabilityChain?: InspectCapabilityChain
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<{ delegator: string; chainControllers: string[] }> {
  const chainControllers: string[] = []
  const documentLoader = rootCapabilityLoader({
    controllerFor: target => {
      if (target !== keystoreUrl && !target.startsWith(`${keystoreUrl}/`)) {
        throw new Error(
          `The root capability from the revocation's delegation chain must` +
            ` have an invocation target that starts with "${keystoreUrl}".`
        )
      }
      return keystoreController
    }
  })
  const suite = new Ed25519Signature2020()
  const result = (await jsigs.verify(capability, {
    documentLoader,
    suite,
    purpose: new CapabilityDelegation({
      suite,
      expectedRootCapability: rootCapabilityId(keystoreUrl),
      // Attenuation is always tolerated when judging revocability: a zcap
      // delegated with attenuation rules an invocation endpoint would refuse
      // can still be revoked (ezcap-express `_verifyDelegation`).
      allowTargetAttenuation: true,
      maxChainLength,
      maxDelegationTtl,
      inspectCapabilityChain: async details => {
        // Capture every controller in the dereferenced chain -- these are the
        // parties the dual-root rule lets submit this revocation.
        for (const chainCapability of details.capabilityChain) {
          chainControllers.push(...capabilityControllers(chainCapability))
        }
        return inspectCapabilityChain
          ? await inspectCapabilityChain(details)
          : { valid: true }
      }
    })
  })) as {
    verified: boolean
    error?: Error
    results?: Array<{
      purposeResult?: { delegator?: { id?: string } | string }
    }>
  }
  if (!result.verified) {
    throw new InvalidRevocationError({
      detail: 'The provided capability delegation is invalid.',
      cause: result.error
    })
  }
  const rawDelegator = result.results?.[0]?.purposeResult?.delegator
  const delegator =
    typeof rawDelegator === 'string' ? rawDelegator : rawDelegator?.id
  if (!delegator) {
    throw new InvalidRevocationError({
      detail: 'The capability delegation has no identifiable delegator.'
    })
  }
  return { delegator, chainControllers }
}

/**
 * Verifies the capability invocation on a revocation submission under the
 * dual-root rule: the invocation may root in the keystore (its controller may
 * revoke anything delegated from it, delegates of a revocation capability
 * included, via target attenuation), or in the revocation URL itself, whose
 * synthesized root capability is controlled by *every controller in the
 * to-be-revoked capability's chain* -- so a delegee can revoke its own zcap
 * without holding a separate capability (ezcap-express
 * `authorizeZcapRevocation`). Throws like `handleZcapVerify`:
 * `AuthVerificationError` (400) when verification errors, the 404-masked
 * `UnauthorizedError` when the invocation does not verify.
 *
 * @param options {object}
 * @param options.url {string}   request URL (path), resolved against serverUrl
 * @param options.method {string}   the HTTP method of the request
 * @param options.headers {IncomingHttpHeaders}   the request headers
 * @param options.serverUrl {string}   this server's base URL
 * @param options.keystoreUrl {string}   the keystore's full URL
 * @param options.keystoreController {IDID}   the stored config's controller
 * @param options.chainControllers {string[]}   every controller in the
 *   to-be-revoked capability's (already verified) chain
 * @param [options.inspectCapabilityChain] {InspectCapabilityChain}   the
 *   revocation-store hook, run against the *invoking* chain
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @param [options.requestName] {string}   request name used in error titles
 * @param [options.logger] {ZcapLogger}   logger for verification errors
 * @returns {Promise<void>}
 */
export async function handleRevocationInvocationVerify({
  url,
  method,
  headers,
  serverUrl,
  keystoreUrl,
  keystoreController,
  chainControllers,
  inspectCapabilityChain,
  maxChainLength,
  maxDelegationTtl,
  requestName = '',
  logger = console
}: {
  url: string
  method: string
  headers: IncomingHttpHeaders
  serverUrl: string
  keystoreUrl: string
  keystoreController: IDID
  chainControllers: string[]
  inspectCapabilityChain?: InspectCapabilityChain
  maxChainLength?: number
  maxDelegationTtl?: number
  requestName?: string
  logger?: ZcapLogger
}): Promise<void> {
  const fullRequestUrl = new URL(url, serverUrl).toString()
  const documentLoader = rootCapabilityLoader({
    controllerFor: target => {
      if (target === keystoreUrl) {
        return keystoreController
      }
      if (target === fullRequestUrl) {
        return chainControllers
      }
      throw new Error(
        `Unexpected root capability target "${target}" on a revocation.`
      )
    }
  })

  let zcapVerifyResult: VerifyCapabilityInvocationResult
  try {
    zcapVerifyResult = await verifyCapabilityInvocation({
      url: fullRequestUrl,
      method,
      headers: headers as Record<string, string>,
      expectedAction: 'write',
      expectedHost: new URL(serverUrl).host,
      expectedRootCapability: [
        rootCapabilityId(keystoreUrl),
        rootCapabilityId(fullRequestUrl)
      ],
      // The invoked target is the revocation URL, a path under the keystore;
      // accept either as a delegated zcap's (attenuated) target. The array
      // form is narrowed to `string` by the verify fork's option type (see
      // the same cast in `verifyZcap`'s attenuation branch).
      expectedTarget: [keystoreUrl, fullRequestUrl] as unknown as string,
      allowTargetAttenuation: true,
      documentLoader,
      getVerifier,
      inspectCapabilityChain,
      maxChainLength,
      maxDelegationTtl,
      suite: new Ed25519Signature2020()
    })
  } catch (err) {
    logger.error('ZCAP revocation invocation verification failed:', err)
    throw new AuthVerificationError({ requestName, cause: err as Error })
  }

  if (!zcapVerifyResult.verified) {
    throw new UnauthorizedError({ requestName })
  }
}
