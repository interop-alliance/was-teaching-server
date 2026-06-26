/**
 * Request handlers for registering an `external` backend against a Space (spec
 * "Backends"): register (`POST`), replace (`PUT`), and deregister (`DELETE`) a
 * backend record. Authorization is the Space controller's key (capability-only,
 * no policy fallback), exactly like Create Collection / Delete Space.
 *
 * The write body is secret-bearing (`BackendConnectionInput`), but every
 * response returns the **sanitized** `BackendDescriptor` (via
 * `sanitizeBackendRecord`), so a client response can never carry the secret. A
 * registered backend is inert this increment: it is listed but not yet
 * selectable as a Collection's `backend` (the live provider adapter is future
 * work).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fetchSpaceAndVerify } from './spaceContext.js'
import { assertValidIds } from '../lib/validateId.js'
import {
  DEFAULT_BACKEND_ID,
  assertValidBackendId,
  buildBackendRecord,
  parseBackendRegistration,
  sanitizeBackendRecord
} from '../lib/backends.js'
import { backendsPath, registeredBackendPath } from '../lib/paths.js'
import { InvalidRequestBodyError, IdConflictError } from '../errors.js'

export class BackendRequest {
  /**
   * POST /space/:spaceId/backends
   * Registers a new `external` backend. Rejects the reserved `default` id and a
   * duplicate id (checked after capability verification so an unauthorized
   * caller cannot probe ids). Responds 201 with the sanitized descriptor.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async post(
    request: FastifyRequest<{
      Params: { spaceId: string }
      Body: unknown
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId },
      body
    } = request
    const { serverUrl, storage } = request.server
    const requestName = 'Register Backend'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })
    const registration = parseBackendRegistration(body, { requestName })
    assertValidBackendId(registration.id, { requestName })

    // Verify (capability-only): registering a backend requires a valid
    // capability invocation by the Space controller; no policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: backendsPath({ spaceId }),
      requestName
    })

    // After verification (so an unauthorized caller cannot probe ids): the
    // `default` id is reserved for the server backend, and POST must not replace
    // an existing record (create-or-replace by id is PUT's job).
    if (registration.id === DEFAULT_BACKEND_ID) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `"${DEFAULT_BACKEND_ID}" is the reserved server backend id and cannot be registered.`,
        pointer: '#/id'
      })
    }
    if (await storage.getBackend({ spaceId, backendId: registration.id })) {
      throw new IdConflictError({ kind: 'Backend' })
    }

    const record = buildBackendRecord(registration)
    await storage.writeBackend({ spaceId, backendId: record.id, record })

    const createdUrl = new URL(
      registeredBackendPath({ spaceId, backendId: record.id }),
      serverUrl
    ).toString()
    reply.header('Location', createdUrl)
    return reply.status(201).send(sanitizeBackendRecord(record))
  }

  /**
   * PUT /space/:spaceId/backends/:backendId
   * Upsert (the re-consent path): create-or-replace a backend record at a chosen
   * id. The body `id` (when present) must match the path id, and `default` is
   * rejected. Responds 201 + Location + sanitized body on create, 204 on update.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async put(
    request: FastifyRequest<{
      Params: { spaceId: string; backendId: string }
      Body: unknown
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, backendId },
      body
    } = request
    const { serverUrl, storage } = request.server
    const requestName = 'Register Backend'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })
    assertValidBackendId(backendId, { requestName })
    const registration = parseBackendRegistration(body, { requestName })

    // The backend `id` is immutable: a body `id`, when present, must match the
    // URL id; and `default` is the reserved server backend id.
    if (registration.id !== backendId) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Backend "id" (${registration.id}) does not match the URL backend id (${backendId}).`,
        pointer: '#/id'
      })
    }
    if (backendId === DEFAULT_BACKEND_ID) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `"${DEFAULT_BACKEND_ID}" is the reserved server backend id and cannot be registered.`,
        pointer: '#/id'
      })
    }

    // Verify (capability-only): no policy fallback for a write.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: registeredBackendPath({ spaceId, backendId }),
      requestName
    })

    const existing = await storage.getBackend({ spaceId, backendId })
    const record = buildBackendRecord(registration)
    await storage.writeBackend({ spaceId, backendId, record })

    if (existing) {
      return reply.status(204).send()
    }
    const createdUrl = new URL(
      registeredBackendPath({ spaceId, backendId }),
      serverUrl
    ).toString()
    reply.header('Location', createdUrl)
    return reply.status(201).send(sanitizeBackendRecord(record))
  }

  /**
   * DELETE /space/:spaceId/backends/:backendId
   * Deregisters a backend. Idempotent (204 even if the record was absent).
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async delete(
    request: FastifyRequest<{
      Params: { spaceId: string; backendId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, backendId }
    } = request
    const { storage } = request.server
    const requestName = 'Deregister Backend'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })
    assertValidBackendId(backendId, { requestName })

    // Verify (capability-only): no policy fallback for a write.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: registeredBackendPath({ spaceId, backendId }),
      requestName
    })

    await storage.deleteBackend({ spaceId, backendId })
    return reply.status(204).send()
  }
}
