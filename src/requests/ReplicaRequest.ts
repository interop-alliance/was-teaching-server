/**
 * Request handlers for a Space's replica registrations (the replication
 * specification): add one (`POST /space/:spaceId/replicas`), list them
 * (`GET` there), read or remove one (`GET` / `DELETE
 * /space/:spaceId/replicas/:replicaId`), and read its pull loop's runtime
 * state (`GET .../status`).
 *
 * Every method is controller-only, the reads included: the record holds the
 * pull capability, and the container rule's `controller-only` refuses any
 * delegated invocation. A registration names one source peer. Data flows
 * from `fromSpace` to `toSpace`, this Space, and nothing flows back without a
 * registration on the peer's side.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

import { ReplicaNotFoundError, ReplicaRefusedError } from '../errors.js'
import { invalidateSpaceMetadata } from '../lib/spaceMetadataCache.js'
import {
  controllerUnmappedByRemoval,
  invalidateReplicaIndex
} from '../lib/webvhLogLocation.js'
import { replicaPath, replicasPath, replicaStatusPath } from '../lib/paths.js'
import { assertValidIds, isReplicaId } from '../lib/validateId.js'
import {
  assertReplicaAcceptable,
  parseReplicaRegistration
} from '../sync/registration.js'
import type { ReplicaListing } from '../types.js'
import { fetchSpaceAndVerify } from './spaceContext.js'

/**
 * The `ETag` of a stored registration: its generation, quoted. The record
 * never changes after it is stored, so the generation alone identifies it.
 * @param generation {string}
 * @returns {string}
 */
function replicaEtag(generation: string): string {
  return `"${generation}"`
}

export class ReplicaRequest {
  /**
   * POST /space/:spaceId/replicas
   * Registers a source peer. The body is checked, then the peer is read
   * (`sync/registration.ts`), and only then is the record stored and its
   * pull loop started. Responds 201 with the record, its `ETag`, and a
   * `Location`. A duplicate id is `id-conflict` (409).
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async post(
    request: FastifyRequest<{ Params: { spaceId: string }; Body: unknown }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId },
      body
    } = request
    const { serverUrl, storage, serverSigningKey, replication } = request.server
    const requestName = 'Register Replica'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Verify (controller-only) before the body is judged, so its 400s tell
    // an unauthorized caller nothing.
    const { spaceMetadata } = await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicasPath({ spaceId }),
      requestName,
      containerRule: 'controller-only'
    })
    const record = parseReplicaRegistration({
      body,
      serverUrl,
      spaceId,
      requestName
    })
    await assertReplicaAcceptable({
      record,
      spaceId,
      spaceMetadata,
      storage,
      serverUrl,
      signingKey: serverSigningKey,
      peerFetch: replication.peerFetch,
      logger: request.log
    })

    const stored = await storage.createReplica({ spaceId, record })
    // The Space Metadata object lists the registration under `replicas` and
    // its validator advanced with it, so the cached object is stale. The
    // registration may map a peer-hosted did:webvh onto this Space's copy.
    invalidateSpaceMetadata({ storage, spaceId })
    invalidateReplicaIndex({ storage })
    replication.register({ spaceId, replicaId: record.id })

    reply.header(
      'Location',
      new URL(
        replicaPath({ spaceId, replicaId: record.id }),
        serverUrl
      ).toString()
    )
    reply.header('ETag', replicaEtag(stored.generation))
    return reply.status(201).send(stored.record)
  }

  /**
   * GET /space/:spaceId/replicas
   * Lists the Space's registrations, capabilities included.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async list(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'List Replicas'

    assertValidIds({ spaceId }, { requestName })
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicasPath({ spaceId }),
      requestName,
      containerRule: 'controller-only'
    })

    const replicas = await storage.listReplicas({ spaceId })
    return reply.status(200).send({
      url: replicasPath({ spaceId }),
      totalItems: replicas.length,
      items: replicas.map(({ record }) => record)
    } satisfies ReplicaListing)
  }

  /**
   * GET /space/:spaceId/replicas/:replicaId
   * Reads one registration back as it was written, under its `ETag`.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{
      Params: { spaceId: string; replicaId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, replicaId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Replica'

    assertValidIds({ spaceId }, { requestName })
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicaPath({ spaceId, replicaId }),
      requestName,
      containerRule: 'controller-only'
    })

    // An id no registration can carry names none, and never reaches storage.
    const stored = isReplicaId(replicaId)
      ? await storage.getReplica({ spaceId, replicaId })
      : undefined
    if (stored === undefined) {
      throw new ReplicaNotFoundError({ requestName })
    }
    reply.header('ETag', replicaEtag(stored.generation))
    return reply.status(200).send(stored.record)
  }

  /**
   * DELETE /space/:spaceId/replicas/:replicaId
   * Removes a registration and its loop state, and stops its pull loop.
   * Nothing already pulled is removed. Idempotent: 204 whether or not a
   * registration was stored. Refused with `replica-refused` (409) while the
   * registration is the only one that maps a Space's `did:webvh` controller
   * to a local copy of its log.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async delete(
    request: FastifyRequest<{
      Params: { spaceId: string; replicaId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, replicaId }
    } = request
    const { serverUrl, storage, replication } = request.server
    const requestName = 'Delete Replica'

    assertValidIds({ spaceId }, { requestName })
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicaPath({ spaceId, replicaId }),
      requestName,
      containerRule: 'controller-only'
    })

    // An id no registration can carry names none, and never reaches storage.
    if (!isReplicaId(replicaId)) {
      return reply.status(204).send()
    }
    // A did:webvh hosted on the peer resolves here only through a
    // registration. Removing the last one that maps a Space's controller
    // would leave that Space with no resolvable controller and no
    // break-glass, since re-registering and Update Space are both authorized
    // by the controller.
    const unmapped = await controllerUnmappedByRemoval({
      storage,
      serverUrl,
      spaceId,
      replicaId
    })
    if (unmapped !== undefined) {
      throw new ReplicaRefusedError({
        title: 'The replica registration cannot be removed.',
        pointer: null,
        detail:
          `Space "${unmapped.spaceId}" is controlled by "${unmapped.did}", ` +
          'which resolves only from the log this registration replicates. ' +
          'Change that controller first, or to replace the registration, ' +
          'add the new one before removing this one.'
      })
    }
    if (await storage.deleteReplica({ spaceId, replicaId })) {
      invalidateSpaceMetadata({ storage, spaceId })
      invalidateReplicaIndex({ storage })
    }
    replication.unregister({ spaceId, replicaId })
    return reply.status(204).send()
  }

  /**
   * GET /space/:spaceId/replicas/:replicaId/status
   * The runtime state of the registration's pull loop: the loop `state`, the
   * pull times, and one item per Collection it has pulled, with the stall
   * of a stalled one. It changes with every cycle, so it is not cacheable.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async status(
    request: FastifyRequest<{
      Params: { spaceId: string; replicaId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, replicaId }
    } = request
    const requestName = 'Get Replica Status'

    assertValidIds({ spaceId }, { requestName })
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicaStatusPath({ spaceId, replicaId }),
      requestName,
      containerRule: 'controller-only'
    })

    // An id no registration can carry names none, and never reaches storage.
    const status = isReplicaId(replicaId)
      ? await request.server.replication.status({ spaceId, replicaId })
      : undefined
    if (status === undefined) {
      throw new ReplicaNotFoundError({ requestName })
    }
    reply.header('Cache-Control', 'no-store')
    return reply.status(200).send(status)
  }
}
