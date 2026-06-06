/**
 * Per-request authorization decision. Replaces the inline `handleZcapVerify`
 * call in read handlers with a two-step decision: first try the capability
 * invocation (if auth headers are present); if that does not grant access, fall
 * back to the target's effective access-control policy (see policy.ts). Throws
 * the same errors as `handleZcapVerify` when neither path authorizes the
 * request. The decision is permissive: a policy can only broaden access, never
 * deny a valid capability holder.
 */
import type { FastifyRequest } from 'fastify'
import { handleZcapVerify } from './zcap.js'
import {
  resolveEffectivePolicy,
  policyGrants,
  type AccessAction
} from './policy.js'
import { UnauthorizedError } from './errors.js'
import type { IDID } from './types.js'

/**
 * Authorizes a request against a target, by capability invocation first and the
 * effective access-control policy second.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   the request (supplies url, method,
 *   headers, logger, and `request.server` for serverUrl + storage)
 * @param options.allowedTarget {string}   the capability's expected
 *   invocationTarget (full URL, including host and port)
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @param options.spaceController {IDID}   the did:key that controls the Space
 * @param [options.requestName] {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<void>}   resolves when authorized; throws otherwise
 */
export async function authorize({
  request,
  allowedTarget,
  spaceId,
  collectionId,
  resourceId,
  spaceController,
  requestName = ''
}: {
  request: FastifyRequest
  allowedTarget: string
  spaceId: string
  collectionId?: string
  resourceId?: string
  spaceController: IDID
  requestName?: string
}): Promise<void> {
  const { url, method, headers } = request
  const { serverUrl, storage } = request.server
  const action: AccessAction =
    method === 'GET' || method === 'HEAD' ? 'read' : 'write'

  // 1. If the caller presented a capability invocation, try it first. Success
  // authorizes the request; failure falls through to the policy check (we hold
  // the error to re-throw if the policy does not grant access either).
  let zcapError: Error | undefined
  if (headers.authorization && headers['capability-invocation']) {
    try {
      await handleZcapVerify({
        url,
        allowedTarget,
        allowedAction: method,
        method,
        headers,
        serverUrl,
        spaceController,
        requestName,
        logger: request.log
      })
      return
    } catch (err) {
      zcapError = err as Error
    }
  }

  // 2. Fall back to the target's effective access-control policy.
  const policy = await resolveEffectivePolicy({
    storage,
    spaceId,
    collectionId,
    resourceId
  })
  if (policyGrants({ policy, action })) {
    return
  }

  // Neither a capability nor a policy authorizes this request. Re-throw the
  // capability error when there was one, else a generic 404 (no leak).
  throw zcapError ?? new UnauthorizedError({ requestName })
}
