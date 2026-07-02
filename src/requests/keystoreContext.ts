/**
 * Shared WebKMS keystore context helper (the `/kms` facet): the keystore
 * analogue of `fetchSpaceAndVerify`
 * (spaceContext.ts), used by the keystore-lifecycle, key-operation, and
 * revocation request handlers.
 */
import type { FastifyRequest } from 'fastify'
import { handleZcapVerify } from '../zcap.js'
import { isUrlSafeSegment } from '../lib/validateId.js'
import { kmsKeystoresPath } from '../lib/paths.js'
import { revocationChainInspector } from '../lib/revocations.js'
import {
  KMS_MAX_CHAIN_LENGTH,
  KMS_MAX_DELEGATION_TTL
} from '../config.default.js'
import { KeystoreNotFoundError } from '../errors.js'
import type { KeystoreConfig } from '../types.js'

/**
 * Loads a keystore config by its URL param, masking an unknown (or
 * non-URL-safe) id as the 404 `KeystoreNotFoundError` -- the WAS
 * existence-masking convention. The verification-free half of
 * `fetchKeystoreAndVerify`, for handlers that need the config before they can
 * build their expected values (the revocation route).
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 * @param options.keystoreId {string}   the keystore's local id (URL param)
 * @param options.requestName {string}   request name used in error titles
 * @returns {Promise<KeystoreConfig>}   the stored config
 */
export async function fetchKeystore({
  request,
  keystoreId,
  requestName
}: {
  request: FastifyRequest
  keystoreId: string
  requestName: string
}): Promise<KeystoreConfig> {
  // A non-URL-safe id cannot name a stored keystore (ids are server-generated
  // base58 values) and must not reach the filesystem layer: same 404 masking.
  if (!isUrlSafeSegment(keystoreId)) {
    throw new KeystoreNotFoundError({ requestName })
  }
  const config = await request.server.storage.getKeystore({ keystoreId })
  if (!config) {
    throw new KeystoreNotFoundError({ requestName })
  }
  return config
}

/**
 * Loads the keystore config (404 `KeystoreNotFoundError` when absent -- the
 * WAS existence-masking convention) and verifies the capability invocation
 * against the *stored* config's controller, with the keystore URL as the root
 * invocation target. `allowedAction` is the webkms action (`read` / `write` /
 * an operation name), not the HTTP verb. The verification carries the unified
 * `/kms` delegation policy (`KMS_MAX_CHAIN_LENGTH`, `KMS_MAX_DELEGATION_TTL`;
 * the zcap library itself already requires `expires` on every delegated
 * capability) and the keystore's revocation-store chain inspector, so a
 * revoked delegation fails on every keystore-rooted route.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, and `request.server` for serverUrl + storage
 * @param options.keystoreId {string}   the keystore's local id (URL param)
 * @param options.allowedAction {string}   expected zcap action
 * @param options.requestName {string}   request name used in error titles
 * @param [options.allowTargetAttenuation] {boolean}   accept a request URL
 *   under the keystore URL (the key routes: every key operation roots in the
 *   keystore's capability, with the key URL as an attenuated target -- see
 *   `verifyZcap`)
 * @returns {Promise<{ config: KeystoreConfig, dereferencedChainLength: number }>}
 *   the stored config and the verified invocation's chain length, root
 *   included (a root invocation is 1) -- the input to the per-key
 *   `maxCapabilityChainLength` gate at operation time
 */
export async function fetchKeystoreAndVerify({
  request,
  keystoreId,
  allowedAction,
  requestName,
  allowTargetAttenuation = false
}: {
  request: FastifyRequest
  keystoreId: string
  allowedAction: string
  requestName: string
  allowTargetAttenuation?: boolean
}): Promise<{ config: KeystoreConfig; dereferencedChainLength: number }> {
  const { serverUrl, storage } = request.server
  const config = await fetchKeystore({ request, keystoreId, requestName })
  const { url, method, headers } = request
  const allowedTarget = new URL(
    kmsKeystoresPath({ keystoreId }),
    serverUrl
  ).toString()
  const zcapVerifyResult = await handleZcapVerify({
    url,
    allowedTarget,
    allowedAction,
    method,
    headers,
    serverUrl,
    spaceController: config.controller,
    requestName,
    logger: request.log,
    allowTargetAttenuation,
    inspectCapabilityChain: revocationChainInspector({ storage, keystoreId }),
    maxChainLength: KMS_MAX_CHAIN_LENGTH,
    maxDelegationTtl: KMS_MAX_DELEGATION_TTL
  })
  return {
    config,
    dereferencedChainLength: zcapVerifyResult.dereferencedChain?.length ?? 1
  }
}
