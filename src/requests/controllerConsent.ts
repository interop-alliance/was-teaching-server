/**
 * Shared handler prelude for the create-by-consent bootstrap (paralleling
 * spaceContext.ts / keystoreContext.ts): the operations that create a
 * top-level resource owned by a DID named in the request *body* (Create
 * Space, the create form of Update Space, Create Keystore) have no stored
 * controller to verify against yet, so the invocation must be *authorized by*
 * the body's controller -- signed directly by it, or via a delegation chain
 * rooted in it. Verifying against the signer instead would let anyone install
 * an unrelated, non-consenting DID as controller.
 */
import type { FastifyRequest } from 'fastify'
import { handleZcapVerify, isRootInvocation } from '../zcap.js'
import type { ProblemError } from '../errors.js'
import type { IDID } from '../types.js'

/**
 * Verifies that the invocation is authorized by `controller` (the DID named
 * in the request body). For the bare-root invocation form the signer *is* the
 * invoker, so a mismatch is rejected up front, before any signature work. The
 * delegated form instead carries a capability chain, judged by the
 * verification (which synthesizes the root capability with `controller` as
 * its controller): a delegated invocation that fails to verify is a chain not
 * rooted in the body's controller, wrapped in `MismatchError` (spec
 * `controller-mismatch`, 400). Root-form verification failures keep their
 * generic errors -- the signer already matched the controller.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, `request.zcap`, and `request.server` for serverUrl
 * @param options.controller {IDID}   the controller DID named in the request
 *   body, which must authorize the invocation
 * @param options.allowedTarget {string}   the capability's expected
 *   invocationTarget (full URL, including host and port)
 * @param options.allowedAction {string}   expected action, e.g. an HTTP verb
 * @param options.MismatchError {new (options) => ProblemError}   the
 *   operation's `controller-mismatch` error class (constructed with
 *   `{ zcapSigningDid, controller, cause? }`)
 * @param [options.requestName] {string}   human-readable request name, used
 *   in error titles
 * @param [options.maxChainLength] {number}   max delegation chain length,
 *   root included (see `verifyZcap`)
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL in
 *   milliseconds (see `verifyZcap`)
 * @returns {Promise<void>}
 */
export async function verifyBodyControllerConsent({
  request,
  controller,
  allowedTarget,
  allowedAction,
  MismatchError,
  requestName,
  maxChainLength,
  maxDelegationTtl
}: {
  request: FastifyRequest
  controller: IDID
  allowedTarget: string
  allowedAction: string
  MismatchError: new (options: {
    zcapSigningDid: string
    controller: string
    cause?: Error
  }) => ProblemError
  requestName?: string
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<void> {
  const { url, method, headers } = request
  const { serverUrl } = request.server
  // The strict `requireAuthHeaders` hook guarantees auth headers were present
  // and `parseAuthHeaders` set `request.zcap` before any calling handler.
  const { keyId, invocation } = request.zcap!
  const [zcapSigningDid] = keyId.split('#')
  const rootInvocation = isRootInvocation({ invocation })
  if (rootInvocation && zcapSigningDid !== controller) {
    throw new MismatchError({ zcapSigningDid: zcapSigningDid!, controller })
  }

  try {
    await handleZcapVerify({
      url,
      allowedTarget,
      allowedAction,
      method,
      headers,
      serverUrl,
      spaceController: controller,
      requestName,
      logger: request.log,
      // Consent verifies a chain rooted in the BODY's controller for a
      // resource that does not exist yet, so there is no keystore or Space
      // scope a revocation could have been stored under.
      revocation: 'no-revocation-scope',
      maxChainLength,
      maxDelegationTtl
    })
  } catch (err) {
    if (!rootInvocation) {
      throw new MismatchError({
        zcapSigningDid: zcapSigningDid!,
        controller,
        cause: err as Error
      })
    }
    throw err
  }
}
