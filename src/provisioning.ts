/**
 * Provisioning gate for the two open provisioning endpoints (`POST /spaces/`
 * and `POST /kms/keystores`). By default provisioning is allowed -- anyone may
 * create a Space or keystore by proving control of the controller DID named in
 * the request body (the teaching-server behavior). A deployment that wants to
 * gate provisioning supplies either an `onboardingToken` (a shared secret,
 * checked here by the stock `onboardingTokenAuthorizer`) or a custom
 * `authorizeProvisioning` callback; both flow through the same seam.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { AuthorizeProvisioning, ProvisioningDecision } from './types.js'
import {
  InvalidOnboardingTokenError,
  MissingOnboardingTokenError,
  ProvisioningNotAuthorizedError
} from './errors.js'

/**
 * The exact route URLs the provisioning gate acts on. `/spaces` (no trailing
 * slash) is included so a token-authorized request reaches the canonical-slash
 * 308 redirect instead of failing the auth-header check first.
 */
const PROVISIONING_ROUTES = new Set(['/spaces', '/spaces/', '/kms/keystores'])

/**
 * onRequest hook: the provisioning gate. Runs first in the hook chain of the
 * SpacesRepository and `/kms` route groups. For a `POST` to one of the two
 * provisioning endpoints it consults the configured `authorizeProvisioning`
 * callback: `verify` proceeds to normal zcap verification, `grant` marks the
 * request as provisioning-authorized (skipping zcap verification downstream),
 * and `deny` refuses with a 403. Every other request (and every deployment with
 * no callback configured) passes straight through, so the default zcap path is
 * unchanged.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function provisioningGate(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  // Only the two provisioning POST endpoints are gated; everything else passes.
  if (
    request.method !== 'POST' ||
    !PROVISIONING_ROUTES.has(request.routeOptions.url ?? '')
  ) {
    return
  }
  const authorize = request.server.authorizeProvisioning
  // No policy configured: default allow -- the zcap path is unchanged.
  if (!authorize) {
    return
  }
  const decision = await authorize({ request })
  if (decision === 'grant') {
    request.provisioningAuthorized = true
    return
  }
  if (decision === 'deny') {
    throw new ProvisioningNotAuthorizedError()
  }
  // 'verify': fall through to the normal zcap capability-invocation path.
}

/**
 * Builds the stock onboarding-token provisioning authorizer: a shared-secret
 * gate that requires an `Authorization: Bearer <token>` header matching the
 * configured token. A request signed with a zcap `Authorization: Signature ...`
 * also lands here -- with a token configured, provisioning requires the token,
 * full stop. Throws `MissingOnboardingTokenError` (401) when no Bearer token is
 * present and `InvalidOnboardingTokenError` (403) when it does not match; a
 * match returns `grant`.
 * @param onboardingToken {string}   the configured shared-secret token
 * @returns {AuthorizeProvisioning}
 */
export function onboardingTokenAuthorizer(
  onboardingToken: string
): AuthorizeProvisioning {
  return async function authorizeWithOnboardingToken({
    request
  }): Promise<ProvisioningDecision> {
    const header = request.headers.authorization
    const match = header?.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      throw new MissingOnboardingTokenError()
    }
    const presented = match[1] as string
    // Timing-safe comparison over fixed-length SHA-256 digests, so mismatched
    // token lengths do not leak through `timingSafeEqual`'s length check.
    const presentedDigest = createHash('sha256').update(presented).digest()
    const expectedDigest = createHash('sha256').update(onboardingToken).digest()
    if (!timingSafeEqual(presentedDigest, expectedDigest)) {
      throw new InvalidOnboardingTokenError()
    }
    return 'grant'
  }
}
