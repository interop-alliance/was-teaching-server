/**
 * The zcap revocation chain-inspection hook (the `/kms` facet, Track C of
 * `_spec/web-kms-roadmap.md`; the analogue of bedrock-zcap-storage's
 * `helpers.inspectCapabilityChain`). Wired into every keystore-rooted
 * verification as the zcap library's `inspectCapabilityChain` extension
 * point, it fails a verification whose dereferenced chain contains any
 * capability with a stored revocation. Written route-family-agnostic over the
 * chain details -- only the storage lookup is keystore-scoped -- so a later
 * revocation store for the WAS route families can reuse the summary
 * extraction unchanged.
 */
import type {
  CapabilityChainDetails,
  InspectCapabilityChain
} from '@interop/zcap'
import type { CapabilitySummary, StorageBackend } from '../types.js'

/**
 * Extracts the `(capabilityId, delegator)` lookup pairs from a verified,
 * dereferenced capability chain. The root capability is skipped -- root zcaps
 * cannot be revoked -- and so is any link whose verify result carries no
 * delegator (nothing to key a revocation record on), mirroring
 * bedrock-zcap-storage's `inspectCapabilityChain` helper.
 *
 * @param options {object}
 * @param options.capabilityChain {object[]}   the dereferenced chain (root to
 *   tail)
 * @param options.capabilityChainMeta {object[]}   the per-capability verify
 *   results (the root's entry has a `null` `verifyResult`)
 * @returns {CapabilitySummary[]}
 */
export function capabilitySummaries({
  capabilityChain,
  capabilityChainMeta
}: CapabilityChainDetails): CapabilitySummary[] {
  const summaries: CapabilitySummary[] = []
  for (const [index, capability] of capabilityChain.entries()) {
    // skip the root zcap; it cannot be revoked
    if (index === 0) {
      continue
    }
    const verifyResult = capabilityChainMeta[index]?.verifyResult as {
      results?: Array<{ purposeResult?: { delegator?: { id?: string } } }>
    } | null
    const delegator = verifyResult?.results?.[0]?.purposeResult?.delegator?.id
    if (delegator) {
      summaries.push({ capabilityId: capability.id, delegator })
    }
  }
  return summaries
}

/**
 * Builds the `inspectCapabilityChain` hook for one keystore: valid when no
 * delegated capability in the chain has a stored revocation under that
 * keystore (a chain of just the root has nothing to check).
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   supplies the revocation store
 * @param options.keystoreId {string}   the keystore's local id (the store's
 *   scope)
 * @returns {InspectCapabilityChain}
 */
export function revocationChainInspector({
  storage,
  keystoreId
}: {
  storage: StorageBackend
  keystoreId: string
}): InspectCapabilityChain {
  return async details => {
    const capabilities = capabilitySummaries(details)
    if (capabilities.length === 0) {
      return { valid: true }
    }
    const revoked = await storage.isRevoked({ keystoreId, capabilities })
    if (revoked) {
      return {
        valid: false,
        error: new Error(
          'One or more capabilities in the chain have been revoked.'
        )
      }
    }
    return { valid: true }
  }
}
