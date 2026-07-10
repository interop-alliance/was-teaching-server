/**
 * Request handlers for zcap revocation, one per route family:
 * - POST /kms/keystores/:keystoreId/zcaps/revocations/:revocationId
 * - POST /space/:spaceId/zcaps/revocations/:revocationId
 *
 * Both share one submission flow (`submitRevocation`), differing only in the
 * scope the revocation aggregates under -- a keystore or a Space -- the action
 * the invocation must carry (the webkms `write` vs the WAS route families'
 * HTTP verb), and the `/kms` delegation policy the WAS families do not impose.
 *
 * The wire contract is protocol-fixed by ezcap-express's
 * `authorizeZcapRevocation` / `@interop/webkms-client` (the conformance
 * suite): `:revocationId` is the to-be-revoked capability's id, URL-encoded;
 * the body is that capability, verbatim; success is 204 with no body. The
 * submission is authorized under the dual-root rule -- an invocation rooted
 * in the scope, or in the revocation URL itself, whose synthesized root is
 * controlled by every controller in the to-be-revoked capability's (fully
 * verified) chain -- so a delegee can revoke its own zcap without holding a
 * separate capability. Root zcaps cannot be revoked. The stored revocation is
 * consulted by the chain-inspection hook on every subsequent verification
 * rooted in that scope (`lib/revocations.ts`).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  handleRevocationInvocationVerify,
  verifyRevocationChain
} from '../zcap.js'
import { revocationChainInspector } from '../lib/revocations.js'
import { spacePath } from '../lib/paths.js'
import {
  KMS_MAX_CHAIN_LENGTH,
  KMS_MAX_DELEGATION_TTL
} from '../config.default.js'
import { InvalidRevocationError } from '../errors.js'
import type { IDID, RevocationRecord, RevocationScope } from '../types.js'
import { fetchKeystore } from './keystoreContext.js'
import { fetchSpace } from './spaceContext.js'

/** One day in milliseconds -- the revocation record's GC margin. */
const ONE_DAY = 24 * 60 * 60 * 1000

/**
 * The scope-agnostic revocation submission: validate the body capability,
 * verify its delegation chain (it must root in `rootTarget`), which yields
 * the chain's controllers for the dual-root invocation check, then -- only
 * once the invocation is authorized -- reject a chain containing an
 * already-revoked link (resubmissions included) with the 400
 * `InvalidRevocationError`, per ezcap-express, and store the record. The
 * store check runs strictly AFTER the 404-masking authorization so an
 * unauthorized caller cannot probe whether a capability is revoked (a
 * 400-vs-404 oracle otherwise). The record expires one day after the
 * capability itself does (from then on the capability is rejected on expiry
 * alone; the margin covers clock-skew grace periods).
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, and `request.server` for serverUrl + storage
 * @param options.revocationId {string}   the URL's revocation id (the
 *   to-be-revoked capability's id, already URL-decoded by the router)
 * @param options.scope {RevocationScope}   the keystore or Space the record is
 *   stored under
 * @param options.rootTarget {string}   the scope's full URL (the required root
 *   of the revoked capability's chain, and one of the two accepted invocation
 *   roots)
 * @param options.rootController {IDID}   the scope's controller
 * @param options.expectedAction {string}   the action the invocation must
 *   carry (`write` on `/kms`, `POST` on the WAS route families)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @returns {Promise<void>}
 */
async function submitRevocation({
  request,
  revocationId,
  scope,
  rootTarget,
  rootController,
  expectedAction,
  requestName,
  maxChainLength,
  maxDelegationTtl
}: {
  request: FastifyRequest
  revocationId: string
  scope: RevocationScope
  rootTarget: string
  rootController: IDID
  expectedAction: string
  requestName: string
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<void> {
  const { url, method, headers, body } = request
  const { serverUrl, storage } = request.server

  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).id !== 'string'
  ) {
    throw new InvalidRevocationError({
      detail: 'The revocation body must be a capability with a string "id".'
    })
  }
  const capabilityBody = body as Record<string, unknown> & { id: string }
  if (capabilityBody.id.startsWith('urn:zcap:root:')) {
    throw new InvalidRevocationError({
      detail: 'A root capability cannot be revoked.'
    })
  }
  // The submitted capability must be the one the URL names (the client
  // frames the id with `encodeURIComponent` into the final path segment).
  if (capabilityBody.id !== revocationId) {
    throw new InvalidRevocationError({
      detail: 'The capability "id" does not match the revocation URL.'
    })
  }

  // Verify the to-be-revoked capability's own delegation chain (400 when
  // invalid); its controllers feed the dual-root invocation check below.
  // Structural only -- the revocation store is not consulted until after
  // authorization (see below).
  const { delegator, chainControllers, capabilities } =
    await verifyRevocationChain({
      capability: capabilityBody,
      rootTarget,
      rootController,
      maxChainLength,
      maxDelegationTtl
    })

  await handleRevocationInvocationVerify({
    url,
    method,
    headers,
    serverUrl,
    rootTarget,
    rootController,
    chainControllers,
    expectedAction,
    // The *invoking* chain is checked against the store as on every other
    // route: a revoked capability cannot authorize a revocation.
    inspectCapabilityChain: revocationChainInspector({ storage, scope }),
    maxChainLength,
    maxDelegationTtl,
    requestName,
    logger: request.log
  })

  // The caller is authorized; NOW consult the store for the to-be-revoked
  // chain. A chain containing an already-revoked link (resubmissions
  // included) is the 400, per ezcap-express; the 409 duplicate stays
  // reserved for a write race at the store. Running this after the masked
  // authorization keeps revocation state undisclosed to unauthorized callers.
  if (await storage.isRevoked({ scope, capabilities })) {
    throw new InvalidRevocationError({
      detail:
        'The capability (or a capability in its chain) is already revoked.'
    })
  }

  const capability = capabilityBody as RevocationRecord['capability']
  // Compute the record's GC expiry only from a parseable `expires`; an
  // unparseable one yields `NaN`, and `new Date(NaN).toISOString()` would
  // throw a `RangeError` (500). Omitting `expires` here just drops the GC
  // margin -- the capability is still rejected on its own expiry.
  const expiresMs = capability.expires ? Date.parse(capability.expires) : NaN
  const record: RevocationRecord = {
    capability,
    meta: {
      delegator,
      rootTarget,
      created: new Date().toISOString(),
      ...(Number.isFinite(expiresMs) && {
        expires: new Date(expiresMs + ONE_DAY).toISOString()
      })
    }
  }
  await storage.insertRevocation({ scope, record })
}

export class RevocationRequest {
  /**
   * POST /kms/keystores/:keystoreId/zcaps/revocations/:revocationId
   * Revoke a capability delegated from a keystore. Carries the unified `/kms`
   * delegation policy, and the webkms `write` action. Responds 204, no body; a
   * concurrent duplicate insert is the 409 `DuplicateRevocationError`.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async post(
    request: FastifyRequest<{
      Params: { keystoreId: string; revocationId: string }
      Body: Record<string, unknown>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Revoke Capability'
    const { keystoreId, revocationId } = request.params

    // 404-masks an unknown keystore before any verification work.
    const config = await fetchKeystore({ request, keystoreId, requestName })

    await submitRevocation({
      request,
      revocationId,
      scope: { keystoreId },
      rootTarget: config.id,
      rootController: config.controller,
      expectedAction: 'write',
      requestName,
      maxChainLength: KMS_MAX_CHAIN_LENGTH,
      maxDelegationTtl: KMS_MAX_DELEGATION_TTL
    })

    return reply.status(204).send()
  }

  /**
   * POST /space/:spaceId/zcaps/revocations/:revocationId
   * Revoke a capability delegated from a Space -- the WAS-route sibling of
   * `post`, scoped to the Space rather than a keystore. The revoked capability
   * is rejected from then on wherever a Space-rooted chain is verified: the
   * write/privileged routes (`fetchSpaceAndVerify`) and the capability leg of
   * the read routes (`authorize`). The invoked action is the HTTP verb, since
   * WAS capabilities are scoped by HTTP method. No delegation-policy caps
   * apply, matching the rest of the WAS route families.
   *
   * Responds 204, no body; a concurrent duplicate insert is the 409
   * `DuplicateRevocationError`.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async postSpace(
    request: FastifyRequest<{
      Params: { spaceId: string; revocationId: string }
      Body: Record<string, unknown>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Revoke Capability'
    const { spaceId, revocationId } = request.params
    const { serverUrl } = request.server

    // 404-masks an unknown Space before any verification work.
    const spaceDescription = await fetchSpace({ request, spaceId, requestName })

    await submitRevocation({
      request,
      revocationId,
      scope: { spaceId },
      rootTarget: new URL(spacePath({ spaceId }), serverUrl).toString(),
      rootController: spaceDescription.controller,
      expectedAction: request.method,
      requestName
    })

    return reply.status(204).send()
  }
}
