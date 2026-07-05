/**
 * Backend-agnostic derivation of the quota-report condition fields (spec
 * "Quotas"). Both storage backends build their `BackendUsage` entries through
 * this helper so the `state` / `limit` / `restrictedActions` thresholds cannot
 * drift between them; only the usage *measurement* (a `du` pass vs a
 * transactional counter) is backend-specific.
 */
import { QUOTA_NEAR_LIMIT_FRACTION } from '../config.default.js'
import type {
  Action,
  BackendState,
  BackendUsage,
  StorageLimit
} from '../types.js'

/**
 * Builds the backend-identity and condition fields shared by the Space and
 * per-Collection quota reports. `usageBytes` is what the report shows (the
 * Space total or a single Collection's slice); `spaceTotalBytes` drives the
 * `state` / `restrictedActions`, which are backend-wide (the quota is a
 * per-Space limit) and so always measured against the Space total. The
 * `constraints.maxUploadBytes` cap is advertised when configured.
 * @param options {object}
 * @param options.usageBytes {number}   the usage figure to report
 * @param options.spaceTotalBytes {number}   the Space total, for state
 * @param [options.capacityBytes] {number}   the configured per-Space limit
 * @param [options.maxUploadBytes] {number}   the per-upload cap to advertise
 * @param options.id {string}   the backend's id (from `describe()`)
 * @param [options.name] {string}   the backend's display name
 * @param options.managedBy {string}   the backend's custody mode
 * @returns {Omit<BackendUsage, 'measuredAt' | 'usageByCollection'>}
 */
export function backendUsageFields({
  usageBytes,
  spaceTotalBytes,
  capacityBytes,
  maxUploadBytes,
  id,
  name,
  managedBy
}: {
  usageBytes: number
  spaceTotalBytes: number
  capacityBytes?: number
  maxUploadBytes?: number
  id: string
  name?: string
  managedBy: BackendUsage['managedBy']
}): Omit<BackendUsage, 'measuredAt' | 'usageByCollection'> {
  const limit: StorageLimit =
    capacityBytes === undefined
      ? { isUnlimited: true }
      : { capacityBytes, isUnlimited: false }

  let state: BackendState = 'ok'
  let restrictedActions: Action[] = []
  if (capacityBytes !== undefined) {
    if (spaceTotalBytes >= capacityBytes) {
      state = 'over-quota'
      // The backend is full: writes are restricted, reads/deletes still work.
      restrictedActions = ['POST', 'PUT']
    } else if (spaceTotalBytes >= capacityBytes * QUOTA_NEAR_LIMIT_FRACTION) {
      state = 'near-limit'
    }
  }

  return {
    id,
    ...(name !== undefined && { name }),
    managedBy,
    state,
    usageBytes,
    limit,
    ...(maxUploadBytes !== undefined && {
      constraints: { maxUploadBytes }
    }),
    restrictedActions
  }
}
