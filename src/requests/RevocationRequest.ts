/**
 * Request handler for WebKMS zcap revocation (the `/kms` facet):
 * - POST /kms/keystores/:keystoreId/zcaps/revocations/:revocationId
 *
 * The wire contract is protocol-fixed by ezcap-express's
 * `authorizeZcapRevocation` / `@interop/webkms-client` (the conformance
 * suite): `:revocationId` is the to-be-revoked capability's id, URL-encoded;
 * the body is that capability, verbatim; success is 204 with no body. The
 * submission is authorized under the dual-root rule -- an invocation rooted
 * in the keystore, or in the revocation URL itself, whose synthesized root is
 * controlled by every controller in the to-be-revoked capability's (fully
 * verified) chain -- so a delegee can revoke its own zcap without holding a
 * separate capability. Root zcaps cannot be revoked. The stored revocation is
 * consulted by the chain-inspection hook on every subsequent keystore-rooted
 * verification (`lib/revocations.ts`).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  handleRevocationInvocationVerify,
  verifyRevocationChain
} from '../zcap.js'
import { revocationChainInspector } from '../lib/revocations.js'
import {
  KMS_MAX_CHAIN_LENGTH,
  KMS_MAX_DELEGATION_TTL
} from '../config.default.js'
import { InvalidRevocationError } from '../errors.js'
import type { RevocationRecord } from '../types.js'
import { fetchKeystore } from './keystoreContext.js'

/** One day in milliseconds -- the revocation record's GC margin. */
const ONE_DAY = 24 * 60 * 60 * 1000

export class RevocationRequest {
  /**
   * POST /kms/keystores/:keystoreId/zcaps/revocations/:revocationId
   * Revoke a delegated capability. The body capability's chain is verified
   * first (it must root in this keystore; a chain containing an
   * already-revoked link -- resubmissions included -- is the 400
   * `InvalidRevocationError`, per ezcap-express), which yields the chain's
   * controllers for the dual-root invocation check. The stored record expires
   * one day after the capability itself does (from then on the capability is
   * rejected on expiry alone; the margin covers clock-skew grace periods).
   * Responds 204, no body; a concurrent duplicate
   * insert is the 409 `DuplicateRevocationError`.
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
    const { url, method, headers, body } = request
    const { serverUrl, storage } = request.server

    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      typeof body.id !== 'string'
    ) {
      throw new InvalidRevocationError({
        detail: 'The revocation body must be a capability with a string "id".'
      })
    }
    if (body.id.startsWith('urn:zcap:root:')) {
      throw new InvalidRevocationError({
        detail: 'A root capability cannot be revoked.'
      })
    }
    // The submitted capability must be the one the URL names (the client
    // frames the id with `encodeURIComponent` into the final path segment).
    if (body.id !== revocationId) {
      throw new InvalidRevocationError({
        detail: 'The capability "id" does not match the revocation URL.'
      })
    }

    // 404-masks an unknown keystore before any verification work.
    const config = await fetchKeystore({ request, keystoreId, requestName })
    const keystoreUrl = config.id
    const inspectCapabilityChain = revocationChainInspector({
      storage,
      keystoreId
    })

    // Verify the to-be-revoked capability's own delegation chain (400 when
    // invalid); its controllers feed the dual-root invocation check below.
    const { delegator, chainControllers } = await verifyRevocationChain({
      capability: body,
      keystoreUrl,
      keystoreController: config.controller,
      inspectCapabilityChain,
      maxChainLength: KMS_MAX_CHAIN_LENGTH,
      maxDelegationTtl: KMS_MAX_DELEGATION_TTL
    })

    await handleRevocationInvocationVerify({
      url,
      method,
      headers,
      serverUrl,
      keystoreUrl,
      keystoreController: config.controller,
      chainControllers,
      inspectCapabilityChain,
      maxChainLength: KMS_MAX_CHAIN_LENGTH,
      maxDelegationTtl: KMS_MAX_DELEGATION_TTL,
      requestName,
      logger: request.log
    })

    const capability = body as RevocationRecord['capability']
    const record: RevocationRecord = {
      capability,
      meta: {
        delegator,
        rootTarget: keystoreUrl,
        created: new Date().toISOString(),
        ...(capability.expires && {
          expires: new Date(
            Date.parse(capability.expires) + ONE_DAY
          ).toISOString()
        })
      }
    }
    await storage.insertRevocation({ keystoreId, record })

    return reply.status(204).send()
  }
}
