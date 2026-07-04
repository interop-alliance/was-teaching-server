/**
 * Request handlers for the WebKMS keystore lifecycle (the `/kms` facet):
 * - POST /kms/keystores (Create Keystore)
 * - GET /kms/keystores?controller=<did> (List Keystores by controller)
 * - GET /kms/keystores/:keystoreId (Get Keystore config)
 * - POST /kms/keystores/:keystoreId (Update Keystore config)
 *
 * The wire contract is protocol-fixed by `@interop/webkms-client` (which is
 * also the conformance suite for it): all routes are zcap-invoked with
 * `read` / `write` actions (not HTTP verbs), the create response is the bare
 * config (201 + `Location`), list wraps in `{ results }`, and update wraps in
 * `{ config }`. The `meterId` / `ipAllowList` fields are deliberately dropped;
 * the body schemas remain `additionalProperties: false`, so supplying them is
 * rejected.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { generateId } from '@digitalcredentials/bnid'
import { handleZcapVerify } from '../zcap.js'
import { assertValidController } from '../lib/validateDid.js'
import { kmsKeystoresPath } from '../lib/paths.js'
import { fetchKeystoreAndVerify } from './keystoreContext.js'
import { verifyBodyControllerConsent } from './controllerConsent.js'
import {
  DEFAULT_KMS_MODULE,
  KEYSTORE_LIST_LIMIT,
  KMS_MAX_CHAIN_LENGTH,
  KMS_MAX_DELEGATION_TTL
} from '../config.default.js'
import {
  InvalidRequestBodyError,
  KeystoreControllerMismatchError
} from '../errors.js'
import type { IDID, KeystoreConfig } from '../types.js'

/** The keystore config fields a client may supply (create and update). */
interface KeystoreConfigBody {
  id?: string
  controller: IDID
  sequence: number
  kmsModule?: string
}

/**
 * Validates a keystore config request body against the webkms schema shape
 * (minus the dropped `meterId` / `ipAllowList`): required fields present, no
 * unknown fields (`additionalProperties: false`), `controller` a valid
 * did:key, `sequence` a non-negative integer -- exactly 0 on create; the
 * update path's previous+1 gate is the storage layer's, where it is atomic.
 * Throws `InvalidRequestBodyError` (400).
 *
 * @param options {object}
 * @param options.body {unknown}   the parsed request body
 * @param options.requestName {string}   request name used in error titles
 * @param [options.isUpdate] {boolean}   validate the update shape (requires
 *   `id`, allows any non-negative `sequence`)
 * @returns {KeystoreConfigBody}   the body, narrowed
 */
function assertKeystoreConfigBody({
  body,
  requestName,
  isUpdate = false
}: {
  body: unknown
  requestName: string
  isUpdate?: boolean
}): KeystoreConfigBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Keystore config body must be a JSON object.'
    })
  }
  const allowedKeys = isUpdate
    ? ['id', 'controller', 'sequence', 'kmsModule']
    : ['controller', 'sequence', 'kmsModule']
  for (const key of Object.keys(body)) {
    if (!allowedKeys.includes(key)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Unexpected keystore config property "${key}".`,
        pointer: `#/${key}`
      })
    }
  }
  const config = body as Partial<KeystoreConfigBody>
  assertValidController(config.controller, { requestName })
  if (
    !Number.isInteger(config.sequence) ||
    (config.sequence as number) < 0 ||
    (config.sequence as number) > Number.MAX_SAFE_INTEGER - 1
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Keystore config "sequence" must be a non-negative integer.',
      pointer: '#/sequence'
    })
  }
  if (!isUpdate && config.sequence !== 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Keystore config sequence must be "0" on create.',
      pointer: '#/sequence'
    })
  }
  if (isUpdate && typeof config.id !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Keystore config "id" is required.',
      pointer: '#/id'
    })
  }
  if (
    config.kmsModule !== undefined &&
    (typeof config.kmsModule !== 'string' || config.kmsModule.length === 0)
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Keystore config "kmsModule" must be a non-empty string.',
      pointer: '#/kmsModule'
    })
  }
  return config as KeystoreConfigBody
}

export class KeystoreRequest {
  /**
   * POST /kms/keystores
   * Create Keystore. Authorization is the keystore-creation bootstrap rule,
   * mirroring Create Space (`SpacesRepositoryRequest.post`): the invocation
   * must be *authorized by* the `controller` DID in the request body -- signed
   * directly by it, or via a delegation chain rooted in it -- so anyone can
   * create their own keystore by proving control of the DID they name.
   * Responds 201 with `Location` and the bare config -- the client asserts a
   * string `id` on it.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async post(
    request: FastifyRequest<{ Body: KeystoreConfigBody }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Create Keystore'
    const { body } = request
    const { serverUrl, storage } = request.server

    assertKeystoreConfigBody({ body, requestName })

    // The invocation must be *authorized by* the body's controller (see
    // `verifyBodyControllerConsent`).
    await verifyBodyControllerConsent({
      request,
      controller: body.controller,
      allowedTarget: new URL(kmsKeystoresPath(), serverUrl).toString(),
      allowedAction: 'write',
      MismatchError: KeystoreControllerMismatchError,
      requestName,
      maxChainLength: KMS_MAX_CHAIN_LENGTH,
      maxDelegationTtl: KMS_MAX_DELEGATION_TTL
    })

    // Server-generated local id, per webkms-switch `generateRandom`: multibase
    // base58btc of a multihash-framed (identity, 16-byte) 128-bit random value.
    const keystoreId = await generateId({ multihash: true })
    const keystoreUrl = new URL(
      kmsKeystoresPath({ keystoreId }),
      serverUrl
    ).toString()
    const config: KeystoreConfig = {
      id: keystoreUrl,
      controller: body.controller,
      sequence: 0,
      kmsModule: body.kmsModule ?? DEFAULT_KMS_MODULE
    }
    await storage.writeKeystore({ keystoreId, config })

    reply.header('Location', keystoreUrl)
    return reply.status(201).send(config)
  }

  /**
   * GET /kms/keystores?controller=<did>
   * List Keystores by controller. The root capability for `/kms/keystores` is
   * synthesized with the `controller` *query parameter* as its controller, so
   * a caller can only list their own keystores (a failed verification is the
   * masked 404, per the server-wide convention). The query string rides the
   * request URL, so verification runs in target-attenuation mode (the same
   * `allowTargetQuery` treatment as List Collection pagination). Responds
   * `{ results }`, capped at `KEYSTORE_LIST_LIMIT`.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async list(
    request: FastifyRequest<{ Querystring: { controller?: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'List Keystores'
    const { url, method, headers, query } = request
    const { serverUrl, storage } = request.server

    // The list query schema: `controller` required, no other parameters.
    // The controller names whose keystores are being asked for
    // (and thereby the root controller the invocation must verify against).
    for (const key of Object.keys(query)) {
      if (key !== 'controller') {
        throw new InvalidRequestBodyError({
          requestName,
          detail: `Unexpected query parameter "${key}".`
        })
      }
    }
    assertValidController(query.controller, { requestName })
    const controller = query.controller as IDID

    const allowedTarget = new URL(kmsKeystoresPath(), serverUrl).toString()
    await handleZcapVerify({
      url,
      allowedTarget,
      allowedAction: 'read',
      method,
      headers,
      serverUrl,
      spaceController: controller,
      requestName,
      logger: request.log,
      allowTargetQuery: true,
      maxChainLength: KMS_MAX_CHAIN_LENGTH,
      maxDelegationTtl: KMS_MAX_DELEGATION_TTL
    })

    const configs = await storage.listKeystoresByController({ controller })
    return reply.send({ results: configs.slice(0, KEYSTORE_LIST_LIMIT) })
  }

  /**
   * GET /kms/keystores/:keystoreId
   * Get Keystore config: capability-verified against the stored config's
   * controller (`read`), responding with the bare config.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{ Params: { keystoreId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { config } = await fetchKeystoreAndVerify({
      request,
      keystoreId: request.params.keystoreId,
      allowedAction: 'read',
      requestName: 'Get Keystore'
    })
    return reply.send(config)
  }

  /**
   * POST /kms/keystores/:keystoreId
   * Update Keystore config. Verified against the *stored* config's controller
   * (`write`) -- so a controller change is authorized by the current
   * controller and takes effect immediately. The body's `id` must match the
   * keystore URL (400); the storage layer applies the update atomically iff
   * `sequence` is exactly previous+1 and `kmsModule` is unchanged (409
   * `KeystoreStateConflictError` otherwise; an omitted `kmsModule` defaults to
   * the stored one). Responds `{ config }` -- note the
   * wrapper, unlike get/create.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async update(
    request: FastifyRequest<{
      Params: { keystoreId: string }
      Body: KeystoreConfigBody
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Update Keystore'
    const { body } = request
    const { storage } = request.server
    const { keystoreId } = request.params

    assertKeystoreConfigBody({ body, requestName, isUpdate: true })

    const { config: existing } = await fetchKeystoreAndVerify({
      request,
      keystoreId,
      allowedAction: 'write',
      requestName
    })
    // The stored `id` is the keystore's full URL; the submitted config must
    // name the same keystore it is posted to.
    if (body.id !== existing.id) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: 'Configuration "id" does not match request URL.',
        pointer: '#/id'
      })
    }

    const config: KeystoreConfig = {
      id: existing.id,
      controller: body.controller,
      sequence: body.sequence,
      kmsModule: body.kmsModule ?? existing.kmsModule
    }
    // Throws the merged 409 state conflict on a sequence / kmsModule mismatch,
    // atomically with the write.
    await storage.updateKeystore({ keystoreId, config })

    return reply.send({ config })
  }
}
