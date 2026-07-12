/**
 * Default configuration: spec and FEP documentation URLs referenced by the
 * home page, error responses, and space-export manifests.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseKekMultibase } from './lib/kmsRecordCipher.js'
import type { KmsRecordKekRegistry, RecordKek } from './types.js'

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
 * Max key descriptions returned per page by
 * `GET /kms/keystores/:keystoreId/keys` (the List Keys fork extension). A
 * further page is signalled by the response's `next` cursor URL; realistic
 * keystores hold a handful of keys, so one page is the steady state.
 */
export const KEY_LIST_LIMIT = 100

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

/** TCP port the server listens on when `PORT` is unset. */
export const DEFAULT_PORT = 3002

/**
 * The default per-upload byte cap applied by BOTH backends when
 * `MAX_UPLOAD_BYTES` is unset (a default-on limit, 64 MiB). Every blob write
 * buffers through process memory on at least one path (the Postgres single
 * `bytea`, multipart's in-memory `toBuffer()`), so "no cap" would be a footgun.
 * Opt out explicitly with `MAX_UPLOAD_BYTES=unlimited`, which the backends
 * accept only where an unbounded upload is actually safe (the filesystem
 * streaming path; the Postgres backend rejects it at construction).
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/**
 * Default cap on the number of Spaces a single controller may create, applied
 * by BOTH backends when `MAX_SPACES_PER_CONTROLLER` is unset (a default-on
 * count quota). Chosen far above any teaching or conformance workload while
 * still bounding runaway creation by one controller. Opt out with
 * `MAX_SPACES_PER_CONTROLLER=unlimited`.
 */
export const DEFAULT_MAX_SPACES_PER_CONTROLLER = 100

/**
 * Default cap on the number of Collections a single Space may hold, applied by
 * BOTH backends when `MAX_COLLECTIONS_PER_SPACE` is unset (a default-on count
 * quota). Opt out with `MAX_COLLECTIONS_PER_SPACE=unlimited`.
 */
export const DEFAULT_MAX_COLLECTIONS_PER_SPACE = 100

/**
 * Default cap on the number of live Resources a single Space may hold across
 * all its Collections, applied by BOTH backends when `MAX_RESOURCES_PER_SPACE`
 * is unset (a default-on count quota). A tombstone (soft-deleted Resource) does
 * not count against it. Opt out with `MAX_RESOURCES_PER_SPACE=unlimited`.
 */
export const DEFAULT_MAX_RESOURCES_PER_SPACE = 10_000

/**
 * The validated env-derived server configuration returned by
 * {@link loadConfigFromEnv} and consumed by `start.ts`.
 */
export interface EnvConfig {
  /** The server base URL (`SERVER_URL`); required, validated. */
  serverUrl: string
  /** TCP port to listen on (`PORT`); defaults to {@link DEFAULT_PORT}. */
  port: number
  /** Postgres connection string (`DATABASE_URL`); unset selects the filesystem backend. */
  databaseUrl?: string
  /**
   * Per-Space storage quota in bytes (`STORAGE_LIMIT_PER_SPACE`). `undefined`
   * means unset -- unlimited, but `start.ts` warns to prompt an explicit
   * choice; `Infinity` means `unlimited` was set explicitly (no warning).
   */
  storageLimitPerSpace?: number
  /**
   * Per-upload size cap in bytes (`MAX_UPLOAD_BYTES`). `undefined` means unset
   * -- the backends apply the {@link DEFAULT_MAX_UPLOAD_BYTES} default;
   * `Infinity` means `unlimited` was set explicitly (no per-upload cap).
   */
  maxUploadBytes?: number
  /**
   * Max Spaces a single controller may create (`MAX_SPACES_PER_CONTROLLER`).
   * `undefined` means unset -- the backends apply the
   * {@link DEFAULT_MAX_SPACES_PER_CONTROLLER} default; `Infinity` means
   * `unlimited` was set explicitly (no cap).
   */
  maxSpacesPerController?: number
  /**
   * Max Collections a single Space may hold (`MAX_COLLECTIONS_PER_SPACE`).
   * `undefined` means unset -- the backends apply the
   * {@link DEFAULT_MAX_COLLECTIONS_PER_SPACE} default; `Infinity` means
   * `unlimited` was set explicitly (no cap).
   */
  maxCollectionsPerSpace?: number
  /**
   * Max live Resources a single Space may hold across all its Collections
   * (`MAX_RESOURCES_PER_SPACE`). `undefined` means unset -- the backends apply
   * the {@link DEFAULT_MAX_RESOURCES_PER_SPACE} default; `Infinity` means
   * `unlimited` was set explicitly (no cap).
   */
  maxResourcesPerSpace?: number
  /** Backend registration allowlist (`WAS_ENABLED_BACKENDS`); unset = permissive. */
  enabledBackendProviders?: string[]
  /**
   * At-rest KMS key-record encryption registry (`KMS_RECORD_KEK` /
   * `KMS_RECORD_KEKS` / `KMS_RECORD_CURRENT_KEK`); unset = plaintext.
   */
  kmsRecordKek?: KmsRecordKekRegistry
  /** Shared-secret provisioning gate (`WAS_ONBOARDING_TOKEN`); unset = open provisioning. */
  onboardingToken?: string
}

/**
 * Reads and validates the server's whole env config surface in one place
 * (fail-fast startup): a missing `SERVER_URL` or any malformed value throws
 * with the offending variable named, before the server starts listening --
 * instead of silently breaking ZCap matching at request time.
 * @param [env] {NodeJS.ProcessEnv}   defaults to `process.env`
 * @returns {EnvConfig}
 */
export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): EnvConfig {
  return {
    serverUrl: parseServerUrl(env.SERVER_URL),
    port: parsePort(env.PORT),
    databaseUrl: parseDatabaseUrl(env.DATABASE_URL),
    storageLimitPerSpace: parseStorageLimit(env.STORAGE_LIMIT_PER_SPACE),
    maxUploadBytes: parseMaxUploadBytes(env.MAX_UPLOAD_BYTES),
    maxSpacesPerController: parseCountLimit(
      env.MAX_SPACES_PER_CONTROLLER,
      'MAX_SPACES_PER_CONTROLLER'
    ),
    maxCollectionsPerSpace: parseCountLimit(
      env.MAX_COLLECTIONS_PER_SPACE,
      'MAX_COLLECTIONS_PER_SPACE'
    ),
    maxResourcesPerSpace: parseCountLimit(
      env.MAX_RESOURCES_PER_SPACE,
      'MAX_RESOURCES_PER_SPACE'
    ),
    enabledBackendProviders: parseEnabledBackends(env.WAS_ENABLED_BACKENDS),
    kmsRecordKek: parseKmsRecordKekRegistry({
      kek: env.KMS_RECORD_KEK,
      keks: env.KMS_RECORD_KEKS,
      currentKek: env.KMS_RECORD_CURRENT_KEK
    }),
    onboardingToken: parseOnboardingToken(env.WAS_ONBOARDING_TOKEN)
  }
}

/**
 * Validates a server base URL (the `serverUrl` option / `SERVER_URL` env
 * value): it must be an absolute `http:`/`https:` URL with no path, query, or
 * fragment. ZCap `invocationTarget` URLs and `Location` headers are built by
 * resolving absolute paths against this base (`new URL(path, serverUrl)`),
 * which silently drops any base path -- so a sub-path deployment would break
 * every delegated invocation. Rejected at startup instead (fail-fast).
 * @param serverUrl {string}   the candidate base URL
 * @returns {void}   throws on an invalid value
 */
export function assertValidServerUrl(serverUrl: string): void {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    throw new Error(
      `serverUrl (env SERVER_URL) must be an absolute URL; got "${serverUrl}".`
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `serverUrl (env SERVER_URL) must use http: or https:; got "${serverUrl}".`
    )
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `serverUrl (env SERVER_URL) must not include a path, query, or ` +
        `fragment -- deploying under a sub-path is not supported; ` +
        `got "${serverUrl}".`
    )
  }
}

/**
 * Parses the `SERVER_URL` env value: the server's base URL, used to build and
 * match ZCap `invocationTarget` URLs (host and port must match the client's
 * exactly). Required -- unset would silently break all ZCap matching, so
 * startup fails instead. The value is trimmed but otherwise preserved
 * byte-for-byte (never normalized), since capability targets compare as exact
 * strings. Validated by {@link assertValidServerUrl}.
 * @param raw {string|undefined}   the raw env value
 * @returns {string}   the trimmed, validated base URL
 */
export function parseServerUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `SERVER_URL is required: the server base URL used to build and match ` +
        `ZCap invocationTarget URLs (e.g. SERVER_URL='http://localhost:3002').`
    )
  }
  const serverUrl = raw.trim()
  assertValidServerUrl(serverUrl)
  return serverUrl
}

/**
 * Parses the `PORT` env value into the TCP port to listen on. An unset or
 * empty value returns {@link DEFAULT_PORT}.
 * @param raw {string|undefined}   the raw env value
 * @returns {number}   the port
 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535; got "${raw}".`
    )
  }
  return value
}

/**
 * Parses the `DATABASE_URL` env value: a Postgres connection string that,
 * when set, selects the PostgreSQL storage backend (unset keeps the default
 * filesystem backend). The string's shape is left to the `pg` driver, which
 * accepts several connection-string forms; an unset or empty value returns
 * `undefined`.
 * @param raw {string|undefined}   the raw env value
 * @returns {string|undefined}   the trimmed connection string, or `undefined`
 */
export function parseDatabaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  return raw.trim()
}

/**
 * Parses the at-rest key-record encryption env surface into a
 * {@link KmsRecordKekRegistry} (the optional hardening increment). Each KEK is a
 * single AES-256 key-encryption key in base58btc Multikey form
 * (`secretKeyMultibase`, header `0xa2 0x01`), whose id is derived from its
 * material (`deriveKekId`) and stored per record -- so registering a second KEK
 * for rotation is a config change, not a schema migration. Three env variables
 * feed it:
 *
 * - `KMS_RECORD_KEK` -- a single KEK (the teaching default alias);
 * - `KMS_RECORD_KEKS` -- a comma-separated list of KEKs, each registered by its
 *   derived id; the FIRST entry is the current KEK by default, so a rotation is
 *   "prepend the new KEK, keep the old one behind it". Surrounding whitespace is
 *   trimmed and empty entries ignored; a duplicate entry (same derived id twice)
 *   throws;
 * - `KMS_RECORD_CURRENT_KEK` -- optionally overrides which registered KEK wraps
 *   NEW records: a `urn:kek:sha256:<hex>` id, a multibase KEK value (its id
 *   derived), or the literal `none` (case-insensitive) which sets
 *   `currentKekId: null` -- the decrypt-only posture (old records still read, new
 *   records are written plaintext). It must name a registered KEK.
 *
 * All three unset/empty returns `undefined`, meaning encryption is disabled --
 * key records are written plaintext (the default, honest about the teaching
 * server's threat model). Setting both `KMS_RECORD_KEK` and `KMS_RECORD_KEKS` is
 * ambiguous and throws; setting `KMS_RECORD_CURRENT_KEK` with no KEK configured
 * throws. A malformed value throws (fails startup), naming the offending
 * variable (and, for a list entry, its 1-based position) but never echoing the
 * secret.
 * @param options {object}
 * @param [options.kek] {string}   the `KMS_RECORD_KEK` value
 * @param [options.keks] {string}   the `KMS_RECORD_KEKS` value
 * @param [options.currentKek] {string}   the `KMS_RECORD_CURRENT_KEK` value
 * @returns {KmsRecordKekRegistry|undefined}   the registry, or `undefined` when
 *   no KEK is configured
 */
export function parseKmsRecordKekRegistry({
  kek,
  keks,
  currentKek
}: {
  kek?: string
  keks?: string
  currentKek?: string
}): KmsRecordKekRegistry | undefined {
  const kekSet = kek !== undefined && kek.trim() !== ''
  const keksSet = keks !== undefined && keks.trim() !== ''
  const currentSet = currentKek !== undefined && currentKek.trim() !== ''

  if (kekSet && keksSet) {
    throw new Error(
      'Set only one of KMS_RECORD_KEK or KMS_RECORD_KEKS, not both (ambiguous).'
    )
  }

  // Build the ordered registry: each KEK keyed by its derived id, in config
  // order (the first entry is the default current KEK).
  const registry = new Map<string, RecordKek>()
  const order: RecordKek[] = []

  if (kekSet) {
    const parsed = parseKekMultibase(kek!.trim())
    registry.set(parsed.id, parsed)
    order.push(parsed)
  } else if (keksSet) {
    let position = 0
    for (const entry of keks!.split(',')) {
      const trimmed = entry.trim()
      if (trimmed === '') {
        continue // empty entries are ignored (like WAS_ENABLED_BACKENDS)
      }
      position += 1
      const parsed = parseKekMultibase(
        trimmed,
        `KMS_RECORD_KEKS entry ${position}`
      )
      if (registry.has(parsed.id)) {
        throw new Error(
          `KMS_RECORD_KEKS entry ${position} duplicates an earlier KEK ` +
            `(same derived kekId); register each KEK only once.`
        )
      }
      registry.set(parsed.id, parsed)
      order.push(parsed)
    }
  }

  // No KEK material at all (all unset, or a list of only empty entries): a
  // dangling KMS_RECORD_CURRENT_KEK is an error; otherwise encryption is off.
  if (registry.size === 0) {
    if (currentSet) {
      throw new Error(
        'KMS_RECORD_CURRENT_KEK is set but no KEK is configured; ' +
          'set KMS_RECORD_KEK or KMS_RECORD_KEKS.'
      )
    }
    return undefined
  }

  const currentKekId = currentSet
    ? resolveCurrentKekId(currentKek!.trim(), registry)
    : order[0]!.id
  return { keks: registry, currentKekId }
}

/**
 * Resolves a `KMS_RECORD_CURRENT_KEK` value to a registered `kekId` (or `null`
 * for the literal `none`, the decrypt-only posture). The value is either a
 * `urn:kek:sha256:<hex>` id or a multibase KEK whose id is derived; either way
 * it must match a KEK already in `registry`. Throws on an unregistered target,
 * naming the variable but never echoing the secret.
 * @param value {string}   the trimmed `KMS_RECORD_CURRENT_KEK` value
 * @param registry {Map<string, RecordKek>}   the registered KEKs, by id
 * @returns {string|null}   the resolved current `kekId`, or `null` for `none`
 */
function resolveCurrentKekId(
  value: string,
  registry: Map<string, RecordKek>
): string | null {
  if (value.toLowerCase() === 'none') {
    return null // decrypt-only: keep KEKs for unwrap, write new records plaintext
  }
  const kekId = value.startsWith('urn:kek:sha256:')
    ? value
    : parseKekMultibase(value, 'KMS_RECORD_CURRENT_KEK').id
  if (!registry.has(kekId)) {
    throw new Error(
      'KMS_RECORD_CURRENT_KEK names a KEK that is not registered ' +
        '(no matching KMS_RECORD_KEK / KMS_RECORD_KEKS entry).'
    )
  }
  return kekId
}

/**
 * Parses the `STORAGE_LIMIT_PER_SPACE` env value into a per-Space capacity in
 * bytes (spec "Quotas"). Accepts a plain non-negative integer number of bytes,
 * or the literal `unlimited` (case-insensitive, trimmed) which returns
 * `Infinity` -- an explicitly acknowledged unlimited quota (no startup
 * warning). An unset or empty value returns `undefined`, meaning no limit is
 * configured (still unlimited, but `start.ts` warns to prompt an explicit
 * choice). A malformed value throws.
 * @param raw {string|undefined}   the raw env value
 * @returns {number|undefined}   capacity in bytes, `Infinity` for `unlimited`,
 *   or `undefined` when unset
 */
export function parseStorageLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  if (raw.trim().toLowerCase() === 'unlimited') {
    return Infinity
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `STORAGE_LIMIT_PER_SPACE must be a non-negative integer number of ` +
        `bytes, or "unlimited"; got "${raw}".`
    )
  }
  return value
}

/**
 * Parses the `MAX_UPLOAD_BYTES` env value into a per-upload size cap in bytes
 * (spec "Quotas", the backend's `maxUploadBytes` constraint). Accepts a plain
 * non-negative integer number of bytes, or the literal `unlimited`
 * (case-insensitive, trimmed) which returns `Infinity` -- explicitly no cap.
 * An unset or empty value returns `undefined`, meaning not configured: the
 * backends apply the {@link DEFAULT_MAX_UPLOAD_BYTES} default (a default-on
 * limit). A single upload exceeding the cap is rejected with
 * `payload-too-large` (413), while smaller uploads still succeed. A malformed
 * value throws.
 * @param raw {string|undefined}   the raw env value
 * @returns {number|undefined}   the per-upload cap in bytes, `Infinity` for
 *   `unlimited`, or `undefined` when unset
 */
export function parseMaxUploadBytes(
  raw: string | undefined
): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  if (raw.trim().toLowerCase() === 'unlimited') {
    return Infinity
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `MAX_UPLOAD_BYTES must be a non-negative integer number of bytes, or ` +
        `"unlimited"; got "${raw}".`
    )
  }
  return value
}

/**
 * Parses one of the count-quota env values (`MAX_SPACES_PER_CONTROLLER`,
 * `MAX_COLLECTIONS_PER_SPACE`, `MAX_RESOURCES_PER_SPACE`) into a maximum count.
 * Accepts a plain non-negative integer, or the literal `unlimited`
 * (case-insensitive, trimmed) which returns `Infinity` -- explicitly no cap. An
 * unset or empty value returns `undefined`, meaning not configured: the backends
 * apply the matching default-on limit ({@link DEFAULT_MAX_SPACES_PER_CONTROLLER}
 * and friends). A malformed value throws, naming the variable and the
 * `unlimited` escape hatch.
 * @param raw {string|undefined}   the raw env value
 * @param name {string}   the env variable name, for the error message
 * @returns {number|undefined}   the max count, `Infinity` for `unlimited`, or
 *   `undefined` when unset
 */
export function parseCountLimit(
  raw: string | undefined,
  name: string
): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  if (raw.trim().toLowerCase() === 'unlimited') {
    return Infinity
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative integer, or "unlimited"; got "${raw}".`
    )
  }
  return value
}

/**
 * Normalizes a count-quota constructor option to the internal instance field
 * both backends store: an unset option (`undefined`) applies the default-on
 * `fallback` limit; a non-finite option (`Infinity`, from an explicit
 * `unlimited`) becomes `undefined` (no cap); a finite value passes through.
 * Shared so the two backends cannot drift on the mapping (the same posture as
 * the `maxUploadBytes` normalization each backend already applies), letting each
 * count guard keep its plain `!== undefined` test.
 * @param value {number|undefined}   the constructor option
 * @param fallback {number}   the default-on limit applied when unset
 * @returns {number|undefined}   the internal limit, or `undefined` for no cap
 */
export function normalizeCountLimit(
  value: number | undefined,
  fallback: number
): number | undefined {
  if (value === undefined) {
    return fallback
  }
  return Number.isFinite(value) ? value : undefined
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

/**
 * Parses the `WAS_ONBOARDING_TOKEN` env value into the shared-secret onboarding
 * token gating the two open provisioning endpoints (`POST /spaces/`,
 * `POST /kms/keystores`). An unset or empty/whitespace-only value returns
 * `undefined`, meaning the feature is off -- provisioning is authorized by
 * proving control of the body's controller DID (the teaching default). When
 * set, those two endpoints instead require an `Authorization: Bearer <token>`
 * header matching this value, which then substitutes for zcap verification.
 * @param raw {string|undefined}   the raw env value
 * @returns {string|undefined}   the trimmed token, or `undefined` when unset
 */
export function parseOnboardingToken(
  raw: string | undefined
): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  return raw.trim()
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
