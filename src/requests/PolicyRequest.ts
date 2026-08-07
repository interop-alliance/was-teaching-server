/**
 * Request handlers for access-control policy operations: get/update/delete the
 * `policy` auxiliary resource at the Space, Collection, or Resource level (the
 * level is selected by which path params are present). Reading or modifying a
 * policy is privileged: every operation verifies a capability invocation against
 * the Space controller (the read-method relaxation in auth-header-hooks.ts does
 * not apply here -- a policy is controller-managed metadata, not public data).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fetchSpaceAndVerify } from './spaceContext.js'
import { hasAuthHeaders } from '../auth-header-hooks.js'
import { assertValidIds } from '../lib/validateId.js'
import { policyPath } from '../lib/paths.js'
import {
  InvalidPolicyError,
  MissingAuthError,
  PolicyNotFoundError
} from '../errors.js'
import type { PolicyDocument } from '../types.js'

/** Path params shared by the three policy route shapes. */
interface PolicyParams {
  spaceId: string
  collectionId?: string
  resourceId?: string
}

export class PolicyRequest {
  /**
   * GET /space/:spaceId[/:collectionId[/:resourceId]]/policy
   * Read the access-control policy document set at this level.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{ Params: PolicyParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { spaceId, collectionId, resourceId } = request.params
    const { storage } = request.server
    const requestName = 'Get Policy'

    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })
    // The hook lets this safe method through unauthenticated; a policy is not
    // public data, so demand the auth headers here (401). PUT/DELETE are
    // already gated by the hook.
    if (!hasAuthHeaders(request)) {
      throw new MissingAuthError()
    }

    // Verify (capability-only): a policy is controller-managed metadata, so
    // reading it requires a valid capability invocation -- no policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: policyPath({ spaceId, collectionId, resourceId }),
      requestName
    })

    const policy = await storage.getPolicy({
      spaceId,
      collectionId,
      resourceId
    })
    if (!policy) {
      throw new PolicyNotFoundError({ requestName })
    }
    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify(policy))
  }

  /**
   * PUT /space/:spaceId[/:collectionId[/:resourceId]]/policy
   * Create or replace the access-control policy document at this level.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async put(
    request: FastifyRequest<{ Params: PolicyParams; Body: unknown }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { spaceId, collectionId, resourceId } = request.params
    const { body } = request
    const { storage } = request.server
    const requestName = 'Update Policy'

    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // A policy document must be a JSON object carrying a non-empty string
    // `type`. The set of recognized types is intentionally open (unknown types
    // are stored and fail-closed at evaluation time, see policy.ts), so this is
    // a shape check only -- it does not gate on a known-types allowlist.
    const policyType =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).type
        : undefined
    if (typeof policyType !== 'string' || policyType.trim() === '') {
      throw new InvalidPolicyError({ requestName })
    }
    const policy = body as PolicyDocument

    // Verify (capability-only): a policy is controller-managed metadata, so
    // writing it requires a valid capability invocation -- no policy fallback.
    const { allowedTarget: policyUrl } = await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: policyPath({ spaceId, collectionId, resourceId }),
      requestName
    })

    const existing = await storage.getPolicy({
      spaceId,
      collectionId,
      resourceId
    })
    await storage.writePolicy({ spaceId, collectionId, resourceId, policy })

    reply.header('Location', policyUrl)
    return existing
      ? reply.status(204).send() // update
      : reply.status(201).send(policy) // create
  }

  /**
   * DELETE /space/:spaceId[/:collectionId[/:resourceId]]/policy
   * Remove the access-control policy document at this level (idempotent).
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async delete(
    request: FastifyRequest<{ Params: PolicyParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { spaceId, collectionId, resourceId } = request.params
    const { storage } = request.server
    const requestName = 'Delete Policy'

    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Verify (capability-only): a policy is controller-managed metadata, so
    // deleting it requires a valid capability invocation -- no policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: policyPath({ spaceId, collectionId, resourceId }),
      requestName
    })

    await storage.deletePolicy({ spaceId, collectionId, resourceId })
    return reply.status(204).send()
  }
}
