/**
 * Default configuration: spec and FEP documentation URLs referenced by the
 * home page, error responses, and space-export manifests.
 */
import fs from 'node:fs'
import path from 'node:path'

// package.json sits a level above both src/ (dev, via tsx) and dist/ (prod),
// so '../package.json' from import.meta.dirname resolves in either layout.
const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json')

/** Server version, read from package.json at startup. */
export const SERVER_VERSION = JSON.parse(
  fs.readFileSync(packageJsonPath, 'utf8')
).version as string

/**
 * Space Description cache (see src/requests/spaceContext.ts). The description is
 * read on every authorized handler, so it is memoized per storage backend.
 * Writes invalidate the entry explicitly; the short TTL is a backstop that also
 * bounds staleness when several server processes share one storage backend (so
 * one process's cache cannot serve another process's write indefinitely).
 */
export const SPACE_DESCRIPTION_CACHE_TTL = 5_000 // milliseconds
/** Max number of Space Descriptions held per backend cache (LRU-bounded). */
export const SPACE_DESCRIPTION_CACHE_MAX = 1_000

/**
 * Linkset relation URI for the access-control `policy` auxiliary resource
 * (RFC9264 linkset discovery; see src/policy.ts and the linkset handlers).
 */
export const POLICY_LINK_RELATION = 'https://wallet.storage/spec#policy'

/**
 * Linkset relation URI for a Collection's selected `backend` auxiliary resource
 * (RFC9264 linkset discovery; advertised at `/space/{id}/{cid}/backend`).
 */
export const BACKEND_LINK_RELATION = 'https://wallet.storage/spec#backend'

/**
 * Fraction of a backend's configured capacity at or above which its quota
 * report `state` becomes `near-limit` (spec "Quotas"). Below this it is `ok`;
 * at or above full capacity it is `over-quota`. Only applies when a finite
 * capacity is configured (an unlimited backend is always `ok`).
 */
export const QUOTA_NEAR_LIMIT_FRACTION = 0.9

/**
 * Parses the `STORAGE_LIMIT_PER_SPACE` env value into a per-Space capacity in
 * bytes (spec "Quotas"). v1 accepts a plain non-negative integer number of
 * bytes; an unset or empty value returns `undefined`, meaning each Space has no
 * configured limit (the backend reports and enforces an unlimited quota).
 * @param raw {string|undefined}   the raw env value
 * @returns {number|undefined}   capacity in bytes, or `undefined` when unset
 */
export function parseStorageLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `STORAGE_LIMIT_PER_SPACE must be a non-negative integer number of ` +
        `bytes; got "${raw}".`
    )
  }
  return value
}

export const SPEC_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/'
export const UBC_MANIFEST_URL =
  'https://codeberg.org/fediverse/fep/src/branch/main/fep/6fcd/fep-6fcd.md#manifest-file'
export const SPACE_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/#spaces'
export const COLLECTION_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/#collection-data-model'
export const RESOURCE_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/#resource-data-model'
export const POLICY_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/#policy'
