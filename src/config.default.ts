/**
 * Default configuration: spec and FEP documentation URLs referenced by the
 * home page, error responses, and space-export manifests.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseKekMultibase } from './lib/kmsRecordCipher.js'
import type { KmsRecordKekRegistry } from './types.js'

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
 * Max number of resolved external-backend adapters held per provider-registry
 * cache (see src/lib/backendRegistry.ts), LRU-bounded. One adapter instance is
 * memoized per selected `{spaceId}/{backendId}` and reused across requests;
 * record changes bust the entry explicitly (no TTL backstop is needed because
 * the provider registry itself is fixed for an instance's lifetime).
 */
export const RESOLVED_BACKEND_CACHE_MAX = 1_000

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
 * Linkset relation URI for a Collection's `quota` report auxiliary resource
 * (RFC9264 linkset discovery; advertised at `/space/{id}/{cid}/quota`).
 */
export const QUOTA_LINK_RELATION = 'https://wallet.storage/spec#quota'

/**
 * Linkset relation URI for a Space's `backends-available` auxiliary resource
 * (RFC9264 linkset discovery; advertised at `/space/{id}/backends`).
 */
export const BACKENDS_AVAILABLE_LINK_RELATION =
  'https://wallet.storage/spec#backends-available'

/**
 * Linkset relation URI for a Space's `quotas` report auxiliary resource
 * (RFC9264 linkset discovery; advertised at `/space/{id}/quotas`).
 */
export const QUOTAS_LINK_RELATION = 'https://wallet.storage/spec#quotas'

/**
 * Fraction of a backend's configured capacity at or above which its quota
 * report `state` becomes `near-limit` (spec "Quotas"). Below this it is `ok`;
 * at or above full capacity it is `over-quota`. Only applies when a finite
 * capacity is configured (an unlimited backend is always `ok`).
 */
export const QUOTA_NEAR_LIMIT_FRACTION = 0.9

/**
 * Write-path quota usage cache TTL (see
 * `FileSystemBackend._assertSpaceHeadroom`). The quota pre-flight measures a
 * Space's on-disk usage with `du`, which walks the whole Space tree -- too
 * costly to repeat on every resource write. The measured total is cached per
 * Space for this long, with each accepted write's incoming bytes added to the
 * cached figure; deletes invalidate the entry. The TTL bounds the drift of
 * that optimistic accounting (overwrites that replaced rather than added
 * bytes, streamed bodies of undeclared size) -- the quota is a documented
 * soft limit, and the TTL bounds the re-measurement window.
 */
export const QUOTA_USAGE_CACHE_TTL = 5_000 // milliseconds

/**
 * The single in-process KMS module this server hard-wires.
 * A keystore created without one gets this alias, and it is immutable thereafter.
 */
export const DEFAULT_KMS_MODULE = 'local-v1'

/**
 * Max keystore configs returned by `GET /kms/keystores?controller=...` (the
 * webkms protocol's list cap).
 */
export const KEYSTORE_LIST_LIMIT = 100

/**
 * Max capability delegation chain length accepted on `/kms` invocations, the
 * root capability included (webkms-switch's `maxChainLength` default). A
 * per-key `maxCapabilityChainLength` (1-10, set at generate time) may narrow
 * this further for key operations; it can never widen it.
 */
export const KMS_MAX_CHAIN_LENGTH = 10

/**
 * Max time-to-live of a delegated capability accepted on `/kms` invocations,
 * measured `expires` minus the delegation proof's `created`, in milliseconds
 * (90 days -- webkms-switch's `maxDelegationTtl` default). One unified bound
 * for every `/kms` route family:
 * revocation plus the mandatory `expires` is the real control.
 */
export const KMS_MAX_DELEGATION_TTL = 90 * 24 * 60 * 60 * 1000

/**
 * Parses the `KMS_RECORD_KEK` env value into the at-rest key-record encryption
 * registry (the optional hardening increment; see
 * `_spec/encrypted-kms-plan.md`). The value is a single AES-256 key-encryption
 * key in base58btc Multikey form (`secretKeyMultibase`, header `0xa2 0x01`);
 * an unset or empty value returns `undefined`, meaning encryption is disabled --
 * key records are written plaintext (the default, honest about the teaching
 * server's threat model). When set, the KEK's id is derived from its material
 * (`deriveKekId`) and stored per record, so multi-KEK rotation later is a config
 * change, not a schema migration. A malformed value throws (fails startup).
 * @param raw {string|undefined}   the raw env value
 * @returns {KmsRecordKekRegistry|undefined}   the registry, or `undefined` when unset
 */
export function parseKmsRecordKek(
  raw: string | undefined
): KmsRecordKekRegistry | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  const kek = parseKekMultibase(raw.trim())
  return { keks: new Map([[kek.id, kek]]), currentKekId: kek.id }
}

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

/**
 * Parses the `MAX_UPLOAD_BYTES` env value into a per-upload size cap in bytes
 * (spec "Quotas", the backend's `maxUploadBytes` constraint). v1 accepts a plain
 * non-negative integer number of bytes; an unset or empty value returns
 * `undefined`, meaning the backend advertises and enforces no per-upload cap
 * (distinct from the cumulative per-Space quota). A single upload exceeding the
 * cap is rejected with `payload-too-large` (413), while smaller uploads still
 * succeed.
 * @param raw {string|undefined}   the raw env value
 * @returns {number|undefined}   the per-upload cap in bytes, or `undefined`
 */
export function parseMaxUploadBytes(
  raw: string | undefined
): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `MAX_UPLOAD_BYTES must be a non-negative integer number of bytes; ` +
        `got "${raw}".`
    )
  }
  return value
}

/**
 * Parses the `WAS_ENABLED_BACKENDS` env value into the server-wide registration
 * allowlist: the backend `provider` names a client may register (spec
 * "Backends"). A comma-separated list (e.g. `gdrive,s3`); surrounding whitespace
 * and empty entries are ignored. An unset or empty value returns `undefined`,
 * meaning no allowlist is configured -- any provider may be registered (the
 * permissive default, preserving prior behavior). When set, a registration whose
 * `provider` is not listed is rejected with `unsupported-backend` (409).
 * @param raw {string|undefined}   the raw env value
 * @returns {string[]|undefined}   the allowed provider names, or `undefined`
 */
export function parseEnabledBackends(
  raw: string | undefined
): string[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  const providers = raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
  return providers.length > 0 ? providers : undefined
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
export const META_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/#resource-metadata-data-model'
