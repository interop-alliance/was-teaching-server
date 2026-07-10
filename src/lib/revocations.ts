/**
 * The zcap revocation chain-inspection hook. Wired into every keystore-rooted
 * and Space-rooted
 * verification as the zcap library's `inspectCapabilityChain` extension
 * point, it fails a verification whose dereferenced chain contains any
 * capability with a stored revocation. Both route families share this hook;
 * they differ only in the scope the storage lookup is keyed on (a keystore or
 * a Space). Also home to the revocation-record file-name codec shared by the
 * filesystem store and both backends' Space exports.
 */
import { createHash } from 'node:crypto'
import type {
  CapabilityChainDetails,
  InspectCapabilityChain
} from '@interop/zcap'
import type {
  CapabilitySummary,
  RevocationScope,
  StorageBackend
} from '../types.js'

/**
 * The file name a revocation record is stored (and archived) under:
 * the `(delegator, capabilityId)` unique key folded into a SHA-256 digest,
 * plus `.json`. Both parts are arbitrary-length URIs, so hashing (rather than
 * encoding) keeps the name fixed-width and filesystem-safe. Shared by the
 * filesystem store and both backends' `exportSpace`, so the same record
 * always lands under the same name.
 * @param options {object}
 * @param options.delegator {string}   the revoked capability's delegator
 * @param options.capabilityId {string}   the revoked capability's id
 * @returns {string}
 */
export function revocationFileName({
  delegator,
  capabilityId
}: {
  delegator: string
  capabilityId: string
}): string {
  const digest = createHash('sha256')
    .update(`${delegator}\n${capabilityId}`)
    .digest('hex')
  return `${digest}.json`
}

/**
 * Extracts the `(capabilityId, delegator)` lookup pairs from a verified,
 * dereferenced capability chain. The root capability is skipped -- root zcaps
 * cannot be revoked -- and so is any link whose verify result carries no
 * delegator (nothing to key a revocation record on).
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
 * Builds the `inspectCapabilityChain` hook for one scope: valid when no
 * delegated capability in the chain has a stored revocation under that
 * keystore or Space (a chain of just the root has nothing to check, so a bare
 * root invocation never reaches the store).
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   supplies the revocation store
 * @param options.scope {RevocationScope}   the keystore or Space the lookup is
 *   keyed on
 * @returns {InspectCapabilityChain}
 */
export function revocationChainInspector({
  storage,
  scope
}: {
  storage: StorageBackend
  scope: RevocationScope
}): InspectCapabilityChain {
  return async details => {
    const capabilities = capabilitySummaries(details)
    if (capabilities.length === 0) {
      return { valid: true }
    }
    const revoked = await storage.isRevoked({ scope, capabilities })
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
