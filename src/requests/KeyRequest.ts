/**
 * Request handlers for WebKMS key operations (the `/kms` facet, Track B of
 * `_spec/web-kms-roadmap.md`):
 * - POST /kms/keystores/:keystoreId/keys (GenerateKeyOperation)
 * - POST /kms/keystores/:keystoreId/keys/:keyId (Sign / Verify / DeriveSecret /
 *   WrapKey / UnwrapKey operation, dispatched by envelope `type`)
 * - GET /kms/keystores/:keystoreId/keys/:keyId (public key description)
 *
 * The wire contract is protocol-fixed by bedrock-kms-http / webkms-switch /
 * `@interop/webkms-client` (the conformance suite): operation envelopes carry
 * an optional `@context`, generate responds 200 (not 201) with a `Location`
 * header and a `{ keyId, keyDescription }` body, every other operation
 * responds 200 with its own single-field result. Every route roots its
 * capability in the **keystore** URL (never the key -- the client computes the
 * root zcap by stripping the key URL at the last `/keys/`), with the key URL
 * accepted as an attenuated target; the expected zcap action is the operation
 * name, decapitalized, minus `Operation` (`generateKey`, `sign`, ...), and
 * `read` for the description GET (a deliberate delta: bedrock leaves that
 * route entirely unauthorized).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { generateId } from '@digitalcredentials/bnid'
import { fetchKeystoreAndVerify } from './keystoreContext.js'
import {
  generateKmsKey,
  describeKmsKey,
  runKeyOperation
} from '../lib/kmsModule.js'
import { isUrlSafeSegment } from '../lib/validateId.js'
import { kmsKeysPath } from '../lib/paths.js'
import {
  InvalidRequestBodyError,
  KeyNotFoundError,
  UnauthorizedError,
  UnsupportedKeyOperationError
} from '../errors.js'
import type { KmsKeyRecord } from '../types.js'

/**
 * The operation-specific body fields of each dispatchable (non-generate)
 * operation envelope. Doubles as the recognized-operation registry: an
 * envelope `type` outside this table is the clean 400 not-supported. The
 * fields' *values* are validated by the KMS module's per-operation
 * implementations; the request layer enforces the envelope shape
 * (`additionalProperties: false`, per the webkms-switch schemas).
 */
const OPERATION_FIELDS: Record<string, string[]> = {
  SignOperation: ['verifyData'],
  VerifyOperation: ['verifyData', 'signatureValue'],
  DeriveSecretOperation: ['publicKey'],
  WrapKeyOperation: ['unwrappedKey'],
  UnwrapKeyOperation: ['wrappedKey']
}

/**
 * Derives the expected zcap action from an operation envelope `type`:
 * decapitalized, minus the `Operation` suffix (webkms-switch `_parseAction`) --
 * `SignOperation` to `sign`, `DeriveSecretOperation` to `deriveSecret`, etc.
 * @param operationType {string}
 * @returns {string}
 */
function operationAction(operationType: string): string {
  const name = operationType.slice(0, operationType.indexOf('Operation'))
  return name.charAt(0).toLowerCase() + name.slice(1)
}

/**
 * Asserts the request body is a JSON object envelope of the given operation
 * `type` carrying only the allowed keys (`additionalProperties: false`).
 * `@context` is allowed but never required -- the webkms-switch schemas make
 * it optional and `@interop/webkms-client` omits it entirely.
 *
 * @param options {object}
 * @param options.body {unknown}   the parsed request body
 * @param options.allowedKeys {string[]}   allowed keys beyond `@context`/`type`
 * @param options.requestName {string}   request name used in error titles
 * @returns {Record<string, unknown>}   the body, narrowed
 */
function assertOperationEnvelope({
  body,
  allowedKeys,
  requestName
}: {
  body: unknown
  allowedKeys: string[]
  requestName: string
}): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Operation body must be a JSON object.'
    })
  }
  const envelope = body as Record<string, unknown>
  for (const key of Object.keys(envelope)) {
    if (key !== '@context' && key !== 'type' && !allowedKeys.includes(key)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Unexpected operation property "${key}".`,
        pointer: `#/${key}`
      })
    }
  }
  return envelope
}

/**
 * Loads a key record by its URL params, masking an unknown (or non-URL-safe)
 * key id as the 404 `KeyNotFoundError`. Call after capability verification,
 * so an under-authorized caller cannot distinguish absent from forbidden.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 * @param options.keystoreId {string}   the keystore's local id (URL param)
 * @param options.keyId {string}   the key's local id (URL param)
 * @param options.requestName {string}   request name used in error titles
 * @returns {Promise<KmsKeyRecord>}
 */
async function fetchKeyRecord({
  request,
  keystoreId,
  keyId,
  requestName
}: {
  request: FastifyRequest
  keystoreId: string
  keyId: string
  requestName: string
}): Promise<KmsKeyRecord> {
  if (!isUrlSafeSegment(keyId)) {
    throw new KeyNotFoundError({ requestName })
  }
  const record = await request.server.storage.getKey({
    keystoreId,
    localId: keyId
  })
  if (!record) {
    throw new KeyNotFoundError({ requestName })
  }
  return record
}

/**
 * Asserts a `GenerateKeyOperation`'s object `invocationTarget`: a required
 * non-empty string `type`, an optional integer `maxCapabilityChainLength`
 * (1-10; the chain includes the root, so 1 means controller-only), and at
 * most one of `publicAlias` / `publicAliasTemplate` (non-empty strings).
 *
 * @param options {object}
 * @param options.invocationTarget {unknown}   the envelope's invocationTarget
 * @param options.requestName {string}   request name used in error titles
 * @returns {object}   the narrowed target fields
 */
function assertGenerateKeyTarget({
  invocationTarget,
  requestName
}: {
  invocationTarget: unknown
  requestName: string
}): {
  type: string
  maxCapabilityChainLength?: number
  publicAlias?: string
  publicAliasTemplate?: string
} {
  if (
    typeof invocationTarget !== 'object' ||
    invocationTarget === null ||
    Array.isArray(invocationTarget)
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Operation "invocationTarget" must be an object.',
      pointer: '#/invocationTarget'
    })
  }
  const allowedKeys = [
    'type',
    'maxCapabilityChainLength',
    'publicAlias',
    'publicAliasTemplate'
  ]
  for (const key of Object.keys(invocationTarget)) {
    if (!allowedKeys.includes(key)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Unexpected invocationTarget property "${key}".`,
        pointer: `#/invocationTarget/${key}`
      })
    }
  }
  const target = invocationTarget as {
    type?: unknown
    maxCapabilityChainLength?: unknown
    publicAlias?: unknown
    publicAliasTemplate?: unknown
  }
  if (typeof target.type !== 'string' || target.type.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'invocationTarget "type" must be a non-empty string.',
      pointer: '#/invocationTarget/type'
    })
  }
  if (
    target.maxCapabilityChainLength !== undefined &&
    (!Number.isInteger(target.maxCapabilityChainLength) ||
      (target.maxCapabilityChainLength as number) < 1 ||
      (target.maxCapabilityChainLength as number) > 10)
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'invocationTarget "maxCapabilityChainLength" must be an integer' +
        ' between 1 and 10.',
      pointer: '#/invocationTarget/maxCapabilityChainLength'
    })
  }
  for (const aliasField of ['publicAlias', 'publicAliasTemplate'] as const) {
    const value = target[aliasField]
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.length === 0)
    ) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `invocationTarget "${aliasField}" must be a non-empty string.`,
        pointer: `#/invocationTarget/${aliasField}`
      })
    }
  }
  if (
    target.publicAlias !== undefined &&
    target.publicAliasTemplate !== undefined
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Only one of "publicAlias" or "publicAliasTemplate" may be given.',
      pointer: '#/invocationTarget/publicAlias'
    })
  }
  return target as {
    type: string
    maxCapabilityChainLength?: number
    publicAlias?: string
    publicAliasTemplate?: string
  }
}

export class KeyRequest {
  /**
   * POST /kms/keystores/:keystoreId/keys
   * Generate Key (`GenerateKeyOperation`). The envelope's `invocationTarget`
   * is an *object* (`{ type, maxCapabilityChainLength?, publicAlias? |
   * publicAliasTemplate? }`), unlike every other operation's string. Verified
   * against the keystore's controller with the `generateKey` action; the new
   * key's local id is server-generated (the same bnid multihash scheme as
   * keystore ids, per webkms-switch `generateRandom`). Responds 200 with a
   * `Location` header and `{ keyId, keyDescription }` -- the client reads the
   * key id from the *body*, never the header.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async generate(
    request: FastifyRequest<{
      Params: { keystoreId: string }
      Body: Record<string, unknown>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Generate Key'
    const { keystoreId } = request.params
    const { storage } = request.server

    const envelope = assertOperationEnvelope({
      body: request.body,
      allowedKeys: ['invocationTarget'],
      requestName
    })
    if (envelope.type !== 'GenerateKeyOperation') {
      throw new InvalidRequestBodyError({
        requestName,
        detail: 'Operation "type" must be "GenerateKeyOperation".',
        pointer: '#/type'
      })
    }
    const target = assertGenerateKeyTarget({
      invocationTarget: envelope.invocationTarget,
      requestName
    })

    const { config } = await fetchKeystoreAndVerify({
      request,
      keystoreId,
      allowedAction: 'generateKey',
      requestName,
      allowTargetAttenuation: true
    })

    // Server-generated local id, per webkms-switch `generateRandom`: multibase
    // base58btc of a multihash-framed (identity, 16-byte) 128-bit random value.
    const localId = await generateId({ multihash: true })
    const keyId = `${config.id}/keys/${localId}`
    const { key, keyDescription } = await generateKmsKey({
      keyId,
      type: target.type,
      controller: config.controller,
      maxCapabilityChainLength: target.maxCapabilityChainLength,
      publicAlias: target.publicAlias,
      publicAliasTemplate: target.publicAliasTemplate
    })
    const now = new Date().toISOString()
    await storage.insertKey({
      keystoreId,
      localId,
      record: { keystoreId, localId, meta: { created: now, updated: now }, key }
    })

    // 200 (not the keystore create's 201) with a Location header, per
    // webkms-switch `runOperationMiddleware`.
    reply.header('Location', keyId)
    return reply.send({ keyId, keyDescription })
  }

  /**
   * POST /kms/keystores/:keystoreId/keys/:keyId
   * Key operation dispatch by envelope `type` (Sign / Verify / DeriveSecret /
   * WrapKey / UnwrapKey). The envelope's string `invocationTarget` must equal
   * the request URL exactly (400, per webkms-switch); the expected zcap action
   * is the decapitalized operation name, verified against the keystore's
   * controller with the key URL as an attenuated target. An operation the KMS
   * does not recognize -- or does not serve for the key's type, e.g.
   * `VerifyOperation` on an asymmetric key -- is a clean 400 not-supported.
   * Responds 200 with the operation's single-field result.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async operation(
    request: FastifyRequest<{
      Params: { keystoreId: string; keyId: string }
      Body: Record<string, unknown>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Key Operation'
    const { keystoreId, keyId } = request.params
    const { serverUrl } = request.server

    if (
      typeof request.body !== 'object' ||
      request.body === null ||
      typeof (request.body as Record<string, unknown>).type !== 'string'
    ) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: 'Operation body must be a JSON object with a string "type".',
        pointer: '#/type'
      })
    }
    const operationType = (request.body as Record<string, unknown>)
      .type as string
    const operationFields = OPERATION_FIELDS[operationType]
    if (operationFields === undefined) {
      // Unknown-but-well-formed operation types (GenerateKeyOperation included:
      // it is only dispatchable at the keys-collection URL) are not served.
      throw new UnsupportedKeyOperationError({ operationType })
    }
    const envelope = assertOperationEnvelope({
      body: request.body,
      allowedKeys: ['invocationTarget', ...operationFields],
      requestName
    })
    // The envelope names the key it operates on; it must be the key it was
    // posted to (webkms-switch's invocation-target-vs-request-URL 400).
    const fullRequestUrl = new URL(
      kmsKeysPath({ keystoreId, keyId }),
      serverUrl
    ).toString()
    if (envelope.invocationTarget !== fullRequestUrl) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: 'Operation "invocationTarget" does not match the request URL.',
        pointer: '#/invocationTarget'
      })
    }

    const { dereferencedChainLength } = await fetchKeystoreAndVerify({
      request,
      keystoreId,
      allowedAction: operationAction(operationType),
      requestName,
      allowTargetAttenuation: true
    })
    const record = await fetchKeyRecord({
      request,
      keystoreId,
      keyId,
      requestName
    })
    // Per-key invocation chain bound, set at generate time and enforced at
    // operation time (bedrock-kms-module-core `_checkZcapInvocationRules`).
    // The chain includes the root, so a bound of 1 means controller-only. An
    // over-long chain is an authorization failure: masked 404, per the
    // server-wide convention.
    if (
      record.key.maxCapabilityChainLength !== undefined &&
      dereferencedChainLength > record.key.maxCapabilityChainLength
    ) {
      throw new UnauthorizedError({ requestName })
    }

    const result = await runKeyOperation({
      key: record.key,
      operation: envelope
    })
    return reply.send(result)
  }

  /**
   * GET /kms/keystores/:keystoreId/keys/:keyId
   * Public key description: capability-verified against the keystore's
   * controller (`read`, with the key URL as an attenuated target -- a
   * deliberate delta from bedrock, which serves this route without any
   * authorization). The description's `controller` is the keystore's *live*
   * controller, and the `publicAlias` / `publicAliasTemplate` override is
   * re-applied on every read, so descriptions are stable (the client caches
   * them for five minutes).
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{
      Params: { keystoreId: string; keyId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Get Key Description'
    const { keystoreId, keyId } = request.params

    const { config } = await fetchKeystoreAndVerify({
      request,
      keystoreId,
      allowedAction: 'read',
      requestName,
      allowTargetAttenuation: true
    })
    const record = await fetchKeyRecord({
      request,
      keystoreId,
      keyId,
      requestName
    })

    return reply.send(
      describeKmsKey({ key: record.key, controller: config.controller })
    )
  }
}
