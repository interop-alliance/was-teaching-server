/**
 * ZCap verification: handleZcapVerify() checks the capability-invocation
 * signature against the Space controller's Ed25519 key, synthesizing the root
 * capability via the document loader. Also home to the zcap *revocation*
 * verification pair, shared by the `/kms` and WAS route families:
 * verifyRevocationChain() validates a to-be-revoked capability's delegation
 * chain, and handleRevocationInvocationVerify() authorizes the submission
 * under the dual-root rule (the scope's root -- a keystore or a Space -- or
 * the revocation URL's own root controlled by any chain participant --
 * ezcap-express's `authorizeZcapRevocation` convention).
 *
 * A Space's controller is normally a `did:key`, resolved by the did:key driver.
 * On a Space promoted to a self-hosted `did:webvh` controller, both the
 * signature keyId and the jsigs purpose check resolve instead through
 * `lib/webvhController.ts`, which verifies the DID's history log out of local
 * storage. The log's location comes from the DID string itself, so it may live
 * in a Collection of a Space other than the one being invoked on. That branch
 * is engaged per verification (never module-global), and only when the
 * controller the chain roots in is such a DID.
 */
import type { IncomingHttpHeaders } from 'node:http'
import {
  createDefaultDidResolver,
  securityLoader
} from '@interop/security-document-loader'
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
import {
  capabilitySummaries,
  revocationChainInspector
} from './lib/revocations.js'
import {
  capabilityControllers,
  companionChainInspector,
  composeChainInspectors
} from './lib/companionClause.js'
import { isSelfHostedWebvhController } from './lib/validateDid.js'
import {
  resolveWebvhController,
  webvhDidResolverDriver,
  type WebvhResolverContext
} from './lib/webvhController.js'
import type {
  CapabilitySummary,
  IDID,
  IVerificationMethod,
  RevocationScope,
  StorageBackend
} from './types.js'

const didKeyDriver = didKey.driver()
didKeyDriver.use({
  multibaseMultikeyHeader: 'z6Mk',
  fromMultibase: Ed25519VerificationKey.from
})

/**
 * `jsonld-document-loader`'s `clone()` -- a copy of the loader carrying the
 * same static documents and protocol handlers, so the copy can be configured
 * without touching the original. It is not part of the loader type
 * `@interop/security-document-loader` publishes, so it is restated here.
 */
type CloneableLoader = ReturnType<typeof securityLoader> & {
  clone: () => CloneableLoader
}

/**
 * The shared base document loader, built once: `securityLoader()` registers
 * (and `structuredClone`s) the whole security context set on every call, which
 * is per-verification work that never varies. Every verification takes a
 * `clone()` of this loader and configures that instead, so nothing
 * request-specific -- the `urn` root-capability handler, a `did:webvh`-backed
 * DID resolver -- is ever set on this instance and no state can leak from one
 * request to the next. Its `did` protocol handler is the security loader's own
 * default resolver, a single cached did:key / did:web resolver reused across
 * requests (the no-`did:webvh` path).
 */
const baseDocumentLoader = securityLoader() as CloneableLoader

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
 * Narrows a resolver context to the requests that actually need it: the
 * `did:webvh` branch is engaged only when the controller the chain roots in is
 * a self-hosted `did:webvh`, so a `did:key`-controlled Space pays nothing for
 * it. Returns `undefined` otherwise.
 *
 * @param options {object}
 * @param [options.webvh] {WebvhResolverContext}   the request layer's storage +
 *   serverUrl, when supplied
 * @param options.controller {IDID}   the controller the chain roots in
 * @returns {WebvhResolverContext | undefined}
 */
function activeWebvhContext({
  webvh,
  controller
}: {
  webvh?: WebvhResolverContext
  controller: IDID
}): WebvhResolverContext | undefined {
  if (!webvh) {
    return undefined
  }
  return isSelfHostedWebvhController(controller, {
    serverUrl: webvh.serverUrl
  })
    ? webvh
    : undefined
}

/**
 * Builds a document loader whose `urn` protocol handler synthesizes
 * `urn:zcap:root:<target>` capabilities on demand, with the controller chosen
 * per target. The zcap library only dereferences a root capability it already
 * expects (per `expectedRootCapability`), so `controllerFor` sees expected
 * targets only -- it may still throw to refuse one outright.
 *
 * The loader is a clone of the shared `baseDocumentLoader`, so this handler and
 * the `did:webvh` resolver below are set on the clone alone and cannot outlive
 * the verification.
 *
 * When a `did:webvh` context is supplied, the loader's DID resolver also serves
 * the locally resolved controller document (and its verification-method
 * fragments), which is what lets the jsigs purpose check confirm the signing
 * method is listed under the document's `capabilityInvocation` /
 * `capabilityDelegation`.
 *
 * @param options {object}
 * @param options.controllerFor {(target: string) => IDID | string[]}   maps a
 *   decoded root invocation target to the controller(s) of its synthesized
 *   root capability
 * @param [options.webvh] {WebvhResolverContext}   engage the local `did:webvh`
 *   resolver for this verification
 * @returns {IDocumentLoader}
 */
function rootCapabilityLoader({
  controllerFor,
  webvh
}: {
  controllerFor: (target: string) => IDID | string[]
  webvh?: WebvhResolverContext
}): IDocumentLoader {
  const loader = baseDocumentLoader.clone()
  if (webvh) {
    loader.setDidResolver(didResolverWithWebvh(webvh))
  }
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
 * Builds the standard DID resolver extended with the local `did:webvh` driver.
 * Per-verification rather than module-global, because the driver closes over
 * the request's storage backend.
 *
 * @param webvh {WebvhResolverContext}
 * @returns {ReturnType<typeof createDefaultDidResolver>}
 */
function didResolverWithWebvh(webvh: WebvhResolverContext) {
  const didResolver = createDefaultDidResolver()
  // The local driver is the did-io `{ method, get }` shape, minus the key
  // *generation* half of the interface (this server only ever resolves).
  didResolver.use(
    webvhDidResolverDriver(webvh) as unknown as Parameters<
      typeof didResolver.use
    >[0]
  )
  return didResolver
}

/**
 * Resolves a `did:webvh` invocation keyId to a verifier, out of the locally
 * resolved (and log-verified) controller document. The returned
 * verificationMethod's `controller` is the bare `did:webvh` string, which is
 * what makes `@interop/zcap`'s string-compare `isController` match the promoted
 * Space's stored controller.
 *
 * @param options {object}
 * @param options.webvh {WebvhResolverContext}
 * @param options.keyId {string}   the `<did:webvh>#<fragment>` method URL
 * @returns {Promise<{ verifier: object, verificationMethod: IVerificationMethod }>}
 */
async function webvhVerifier({
  webvh,
  keyId
}: {
  webvh: WebvhResolverContext
  keyId: string
}) {
  const [did] = keyId.split('#')
  const doc = await resolveWebvhController({ ...webvh, did: did! })
  const method = (doc.verificationMethod ?? []).find(
    entry => entry.id === keyId
  )
  if (!method?.publicKeyMultibase) {
    throw new Error(
      `Verification method "${keyId}" is not in the current DID document.`
    )
  }
  // The resolved methods are `Multikey`; restate them in the suite's own shape
  // (the same fields, and `Ed25519VerificationKey.from` accepts either) so the
  // key material and the controller string are both explicit here.
  const verificationMethod = {
    id: keyId,
    type: 'Ed25519VerificationKey2020',
    controller: did,
    publicKeyMultibase: method.publicKeyMultibase
  }
  const key = await Ed25519VerificationKey.from(
    verificationMethod as IPublicKey
  )
  return {
    verifier: key.verifier(),
    verificationMethod: verificationMethod as IVerificationMethod
  }
}

/**
 * Builds the `verifyCapabilityInvocation` HTTP-signature key hook: resolves an
 * invocation's keyId to an Ed25519 verifier. `did:key` keyIds resolve through
 * the did:key driver as always; a `did:webvh` keyId resolves through the local
 * (log-verifying) controller-document resolver, when one is engaged.
 *
 * @param options {object}
 * @param [options.webvh] {WebvhResolverContext}   engage the local `did:webvh`
 *   resolver for this verification
 * @returns {(options: { keyId: string }) => Promise<{ verifier: object,
 *   verificationMethod: IVerificationMethod }>}
 */
function createGetVerifier({ webvh }: { webvh?: WebvhResolverContext } = {}) {
  return async function getVerifier({ keyId }: { keyId: string }) {
    if (webvh && keyId.startsWith('did:webvh:')) {
      return await webvhVerifier({ webvh, keyId })
    }
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
 * @param options.spaceController {IDID}   the DID that controls the Space: a
 *   `did:key`, or a self-hosted `did:webvh` on a promoted Space
 * @param [options.webvh] {WebvhResolverContext}   storage + serverUrl for the
 *   local `did:webvh` resolver; engaged whenever supplied, so a delegated
 *   capability's did:webvh controller resolves even on a did:key-controlled
 *   Space (the driver still refuses DIDs this server does not host)
 * @param [options.requestName] {string}   human-readable request name, used in
 *   error titles
 * @param [options.logger] {ZcapLogger}   logger for verification errors;
 *   defaults to `console`
 * @param [options.allowTargetQuery] {boolean}   tolerate query parameters that
 *   extend `allowedTarget` on the request URL (see `verifyZcap`)
 * @param [options.allowTargetAttenuation] {boolean}   accept a request URL
 *   that path-extends `allowedTarget` under a capability rooted at
 *   `allowedTarget` (see `verifyZcap`)
 * @param [options.attenuatedRootTarget] {string}   an ancestor target (e.g.
 *   the Space URL) whose root capability is also accepted as the root of a
 *   delegated chain that attenuates down to the request URL (see `verifyZcap`)
 * @param options.revocation {object|string}   the revocation-store check, run
 *   against the dereferenced chain after signature verification. REQUIRED so
 *   that skipping revocation is a stated decision, never an omission: pass
 *   `{ storage, scope }` -- the scope (keystore or Space) the chain roots
 *   in -- or the literal `'no-revocation-scope'` when the verified target has
 *   no scope a revocation could be stored under (a create/consent
 *   verification for a not-yet-existing resource, or a collection-level root
 *   like `/kms/keystores`).
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
  webvh,
  requestName = '',
  logger = console,
  allowTargetQuery = false,
  allowTargetAttenuation = false,
  attenuatedRootTarget,
  revocation,
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
  webvh?: WebvhResolverContext
  requestName?: string
  logger?: ZcapLogger
  allowTargetQuery?: boolean
  allowTargetAttenuation?: boolean
  attenuatedRootTarget?: string
  revocation:
    { storage: StorageBackend; scope: RevocationScope } | 'no-revocation-scope'
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<VerifyCapabilityInvocationResult> {
  // The chain inspectors, composed into the zcap library's single hook: the
  // revocation-store check (whenever the target has a scope), then the
  // companion-chain clause bounding ladder-signed delegations (whenever the
  // did:webvh resolver is engaged -- without it no did:webvh proof verifies,
  // so there is no ladder delegation to bound).
  const inspectors = [
    ...(revocation === 'no-revocation-scope'
      ? []
      : [revocationChainInspector(revocation)]),
    ...(webvh ? [companionChainInspector(webvh)] : [])
  ]
  const inspectCapabilityChain =
    inspectors.length > 0 ? composeChainInspectors(inspectors) : undefined
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
      webvh,
      allowTargetQuery,
      allowTargetAttenuation,
      attenuatedRootTarget,
      inspectCapabilityChain,
      maxChainLength,
      maxDelegationTtl
    })
  } catch (err) {
    logger.error({ err }, 'ZCAP verification failed')
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
 * @param options.spaceController {IDID}   the DID that controls the Space: a
 *   `did:key`, or a self-hosted `did:webvh` on a promoted Space
 * @param [options.webvh] {WebvhResolverContext}   storage + serverUrl for the
 *   local `did:webvh` resolver; engaged whenever supplied, so a delegated
 *   capability's did:webvh controller resolves even on a did:key-controlled
 *   Space (the driver still refuses DIDs this server does not host)
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
 *   `allowedTarget` root (the webkms authorization model, which roots the
 *   invocation target at the keystore id).
 * @param [options.attenuatedRootTarget] {string}   when set, an *ancestor*
 *   invocation target (the Space URL for the WAS route families) whose root
 *   capability is accepted -- in addition to `allowedTarget`'s own -- as the
 *   root of the invocation. This is what lets a controller delegate one
 *   capability for a whole Space (or a Collection under it, by attenuating
 *   the `invocationTarget` down at delegation time) and have the delegate
 *   invoke it against any URL underneath: the chain roots at the ancestor's
 *   root capability and narrows toward the request URL (RESTful attenuation,
 *   the same shape `allowTargetAttenuation` gives the WebKMS keystore).
 *   Root invocations of `allowedTarget`'s own root capability verify
 *   unchanged, so this only widens what the Space controller can delegate,
 *   never who can access.
 * @param [options.inspectCapabilityChain] {InspectCapabilityChain}   hook run
 *   against the dereferenced chain after signature verification -- the
 *   extension point for the revocation check (a stored revocation of any
 *   capability in the chain fails the verification, scoped to the keystore or
 *   the Space the request roots in) and the companion-chain clause
 *   (`lib/companionClause.ts`), composed by `handleZcapVerify`.
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
  webvh,
  allowTargetQuery = false,
  allowTargetAttenuation = false,
  attenuatedRootTarget,
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
  webvh?: WebvhResolverContext
  allowTargetQuery?: boolean
  allowTargetAttenuation?: boolean
  attenuatedRootTarget?: string
  inspectCapabilityChain?: InspectCapabilityChain
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<VerifyCapabilityInvocationResult> {
  const fullRequestUrl = new URL(url, serverUrl).toString()
  let expected
  if (allowTargetQuery || attenuatedRootTarget || allowTargetAttenuation) {
    // The acceptable roots: the ancestor's root capability (a delegated chain
    // rooted at e.g. the Space URL, narrowing to the request URL), the
    // `allowedTarget`'s own (a root invocation, or a delegated chain for the
    // exact target -- the pre-existing shapes, unchanged), and, under
    // `allowTargetQuery`, the query-bearing request URL's own (a controller
    // invoking the query URL directly). Under `allowTargetAttenuation` alone
    // that leaves `allowedTarget`'s own as the only acceptable root: a
    // path-extended request URL is never itself one. A one-element list is
    // matched exactly as the bare string form the option also accepts.
    const rootTargets = [
      ...(attenuatedRootTarget ? [attenuatedRootTarget] : []),
      allowedTarget,
      ...(allowTargetQuery ? [fullRequestUrl] : [])
    ]
    expected = {
      expectedAction: allowedAction,
      expectedHost: new URL(serverUrl).host,
      expectedRootCapability: [...new Set(rootTargets.map(rootCapabilityId))],
      // The proof's invocationTarget is the invoked URL: `allowedTarget`
      // itself, a path under it (accepted as a RESTful attenuation), or
      // (under `allowTargetQuery`) the query-bearing request URL.
      // The array form is narrowed to `string` by the verify fork's option
      // type, but the underlying `@interop/zcap` CapabilityInvocation
      // accepts `string | string[]` -- hence the cast.
      expectedTarget: [
        ...new Set([allowedTarget, fullRequestUrl])
      ] as unknown as string,
      allowTargetAttenuation: true
    }
  } else {
    expected = {
      expectedAction: allowedAction,
      expectedHost: new URL(serverUrl).host,
      rootInvocationTarget: allowedTarget,
      expectedRootCapability: rootCapabilityId(allowedTarget),
      expectedTarget: allowedTarget
    }
  }

  // The webvh resolver is engaged whenever a context is supplied, not only
  // when the Space controller itself is a did:webvh: a delegated capability
  // on a did:key-controlled Space (an unlock Space's management zcap) may
  // name a self-hosted did:webvh as its delegated controller, and verifying
  // its invocation requires resolving that document. This widens resolution
  // only, never authority -- the driver refuses any DID this server does not
  // host, and the chain still roots in the Space's own root capability. A
  // did:key-only verification never dereferences a webvh URL, so it pays
  // nothing beyond the driver construction.
  const documentLoader = rootCapabilityLoader({
    controllerFor: () => spaceController,
    webvh
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
    getVerifier: createGetVerifier({ webvh }),
    inspectCapabilityChain,
    maxChainLength,
    maxDelegationTtl,
    suite: new Ed25519Signature2020()
  })
}

/**
 * Verifies the delegation chain of a capability submitted for revocation
 * (`CapabilityDelegation` proof purpose over the embedded chain), throwing
 * `InvalidRevocationError` (400) when it does not verify. The chain must root
 * in the revocation's scope: its root capability's invocation target must be
 * `rootTarget` -- the keystore URL, or the Space URL for a WAS-route
 * revocation -- or a path under it (enforced where the root is synthesized,
 * so a chain aimed at another keystore or Space -- or another service --
 * cannot be submitted here, per ezcap-express `authorizeZcapRevocation`).
 * Deliberately structural only -- it does NOT consult the revocation store:
 * this runs before the invocation is authorized, and a store-dependent
 * failure here would disclose revocation state to unauthorized callers
 * (400 already-revoked vs the masked 404). The caller checks the returned
 * `capabilities` against the store after authorization.
 *
 * @param options {object}
 * @param options.capability {object}   the delegated capability to be revoked
 *   (the request body, verbatim)
 * @param options.rootTarget {string}   the scope's full URL -- the keystore or
 *   the Space -- which the chain is required to root in
 * @param options.rootController {IDID}   the scope's controller (controller of
 *   the synthesized root capability)
 * @param [options.webvh] {WebvhResolverContext}   storage + serverUrl for the
 *   local `did:webvh` resolver; engaged only when `rootController` is one
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @returns {Promise<{ delegator: string, chainControllers: string[],
 *   capabilities: CapabilitySummary[] }>}   the capability's delegator (its
 *   delegation proof's controller), every controller in its chain (the
 *   parties allowed to submit the revocation), and the chain's
 *   `(capabilityId, delegator)` pairs for the caller's post-authorization
 *   revocation-store check
 */
export async function verifyRevocationChain({
  capability,
  rootTarget,
  rootController,
  webvh,
  maxChainLength,
  maxDelegationTtl
}: {
  capability: Record<string, unknown>
  rootTarget: string
  rootController: IDID
  webvh?: WebvhResolverContext
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<{
  delegator: string
  chainControllers: string[]
  capabilities: CapabilitySummary[]
}> {
  const chainControllers: string[] = []
  let capabilities: CapabilitySummary[] = []
  const documentLoader = rootCapabilityLoader({
    controllerFor: target => {
      if (target !== rootTarget && !target.startsWith(`${rootTarget}/`)) {
        throw new Error(
          `The root capability from the revocation's delegation chain must` +
            ` have an invocation target that starts with "${rootTarget}".`
        )
      }
      return rootController
    },
    webvh: activeWebvhContext({ webvh, controller: rootController })
  })
  const suite = new Ed25519Signature2020()
  const result = (await jsigs.verify(capability, {
    documentLoader,
    suite,
    purpose: new CapabilityDelegation({
      suite,
      expectedRootCapability: rootCapabilityId(rootTarget),
      // Attenuation is always tolerated when judging revocability: a zcap
      // delegated with attenuation rules an invocation endpoint would refuse
      // can still be revoked (ezcap-express `_verifyDelegation`).
      allowTargetAttenuation: true,
      maxChainLength,
      maxDelegationTtl,
      inspectCapabilityChain: async details => {
        // Capture every controller in the dereferenced chain -- these are the
        // parties the dual-root rule lets submit this revocation -- and the
        // chain's lookup pairs for the caller's post-authorization store check.
        for (const chainCapability of details.capabilityChain) {
          chainControllers.push(...capabilityControllers(chainCapability))
        }
        capabilities = capabilitySummaries(details)
        return { valid: true }
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
  return { delegator, chainControllers, capabilities }
}

/**
 * Verifies the capability invocation on a revocation submission under the
 * dual-root rule: the invocation may root in the scope -- the keystore or the
 * Space -- (whose controller may revoke anything delegated from it, delegates
 * of a revocation capability included, via target attenuation), or in the
 * revocation URL itself, whose
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
 * @param options.rootTarget {string}   the scope's full URL (the keystore or
 *   the Space)
 * @param options.rootController {IDID}   the scope's controller
 * @param [options.webvh] {WebvhResolverContext}   storage + serverUrl for the
 *   local `did:webvh` resolver; engaged only when `rootController` is one
 * @param options.chainControllers {string[]}   every controller in the
 *   to-be-revoked capability's (already verified) chain
 * @param options.expectedAction {string}   the action the invocation must
 *   carry: the webkms `write` on `/kms`, the HTTP verb (`POST`) on the WAS
 *   route families, whose capabilities are scoped by HTTP method
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
  rootTarget,
  rootController,
  webvh,
  chainControllers,
  expectedAction,
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
  rootTarget: string
  rootController: IDID
  webvh?: WebvhResolverContext
  chainControllers: string[]
  expectedAction: string
  inspectCapabilityChain?: InspectCapabilityChain
  maxChainLength?: number
  maxDelegationTtl?: number
  requestName?: string
  logger?: ZcapLogger
}): Promise<void> {
  const fullRequestUrl = new URL(url, serverUrl).toString()
  const activeWebvh = activeWebvhContext({ webvh, controller: rootController })
  const documentLoader = rootCapabilityLoader({
    controllerFor: target => {
      if (target === rootTarget) {
        return rootController
      }
      if (target === fullRequestUrl) {
        return chainControllers
      }
      throw new Error(
        `Unexpected root capability target "${target}" on a revocation.`
      )
    },
    webvh: activeWebvh
  })

  let zcapVerifyResult: VerifyCapabilityInvocationResult
  try {
    zcapVerifyResult = await verifyCapabilityInvocation({
      url: fullRequestUrl,
      method,
      headers: headers as Record<string, string>,
      expectedAction,
      expectedHost: new URL(serverUrl).host,
      expectedRootCapability: [
        rootCapabilityId(rootTarget),
        rootCapabilityId(fullRequestUrl)
      ],
      // The invoked target is the revocation URL, a path under the scope's
      // root; accept either as a delegated zcap's (attenuated) target. The
      // array form is narrowed to `string` by the verify fork's option type
      // (see the same cast in `verifyZcap`'s attenuation branch).
      expectedTarget: [rootTarget, fullRequestUrl] as unknown as string,
      allowTargetAttenuation: true,
      documentLoader,
      getVerifier: createGetVerifier({ webvh: activeWebvh }),
      inspectCapabilityChain,
      maxChainLength,
      maxDelegationTtl,
      suite: new Ed25519Signature2020()
    })
  } catch (err) {
    logger.error({ err }, 'ZCAP revocation invocation verification failed')
    throw new AuthVerificationError({ requestName, cause: err as Error })
  }

  if (!zcapVerifyResult.verified) {
    throw new UnauthorizedError({ requestName })
  }
}
