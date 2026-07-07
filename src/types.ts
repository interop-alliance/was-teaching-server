/**
 * Shared domain types for the WAS server.
 *
 * Re-exports the relevant `@interop/data-integrity-core` types (DIDs, zCaps,
 * document-loader, verifier / key material) and the shared WAS wire model from
 * `@interop/storage-core` so the rest of the codebase imports them from a
 * single place, and defines the server-local domain shapes (the parsed-zcap
 * request shape, the transport-neutral resource input, the get-resource result)
 * plus the `StorageBackend` contract.
 *
 * Also augments Fastify's types: `FastifyInstance.serverUrl` (set by
 * `fastify.decorate` in plugin.ts, read in handlers via `request.server`) and
 * `FastifyRequest.zcap` (set by the `parseAuthHeaders` hook).
 */
// Pull in @fastify/multipart's `FastifyRequest.file()` augmentation program-wide
// (the request layer calls `request.file()` without importing the plugin
// directly).
import type {} from '@fastify/multipart'
import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import type {
  IDID,
  IVerificationMethod,
  IMultikeyMethod,
  IZcap,
  IRootZcap,
  IDelegatedZcap,
  IVerifier,
  IPublicMultikey,
  IMultikeyDocument,
  IVerificationKeyPair2020
} from '@interop/data-integrity-core'
// Loader types are not re-exported from the package root (its index omits
// ./Loader); reach them via the ./loader subpath export.
import type {
  IRemoteDocument,
  IDocumentLoader
} from '@interop/data-integrity-core/loader'

// The shared WAS wire model now lives in `@interop/storage-core`. Import the
// shapes referenced by the `StorageBackend` contract below, and re-export the
// whole data-model surface so the rest of the server keeps importing it from
// this one module.
import type {
  SpaceDescription,
  CollectionDescription,
  CollectionSummary,
  CollectionResourcesList,
  ResourceMetadata,
  ResourceMetadataCustom,
  BackendDescriptor,
  BackendConnectionInput,
  BackendUsage,
  ImportStats,
  PolicyDocument
} from '@interop/storage-core'

// Surface the reused @interop/data-integrity-core types from this one module.
export type {
  IDID,
  IVerificationMethod,
  IMultikeyMethod,
  IZcap,
  IRootZcap,
  IDelegatedZcap,
  IVerifier,
  IPublicMultikey,
  IMultikeyDocument,
  IVerificationKeyPair2020,
  IRemoteDocument,
  IDocumentLoader
}

// Re-export the shared WAS wire model from `@interop/storage-core`.
export type {
  SpaceDescription,
  CollectionDescription,
  CollectionEncryption,
  BackendReference,
  SpaceSummary,
  SpaceListing,
  CollectionSummary,
  CollectionsList,
  ResourceSummary,
  CollectionResourcesList,
  ResourceMetadata,
  ResourceMetadataCustom,
  BackendDescriptor,
  BackendConnectionPublic,
  BackendConnectionInput,
  BackendRegistration,
  BackendState,
  StorageLimit,
  CollectionUsage,
  BackendUsage,
  SpaceQuotaReport,
  PolicyDocument,
  ImportStats,
  Action,
  ActionInput,
  LinkSet,
  LinkSetEntry
} from '@interop/storage-core'

/** Return shape of `getResource()`. */
export interface ResourceResult {
  resourceStream: Readable
  /** resolved content-type of the stored bytes */
  storedResourceType: string
  /**
   * The Resource's current monotonic `version` -- the value behind its HTTP
   * `ETag` strong validator (`conditional-writes` feature). Absent only for a
   * legacy Resource written before versioning.
   */
  version?: number
}

/**
 * Transport-neutral input to `writeResource`. The request layer resolves a
 * Fastify request into one of these shapes (see `resolveResourceInput` in
 * requests/resourceInput.ts) so that storage backends never depend on Fastify:
 * - `kind: 'json'` carries the parsed JSON value in `data`.
 * - `kind: 'binary'` carries a readable byte stream — a raw blob body, or the
 *   file extracted from a multipart upload. `declaredBytes` is the up-front size
 *   when known (a raw body's `Content-Length`), used for an early quota
 *   pre-flight; it is absent for multipart parts, whose size is unknown until
 *   the stream is consumed (the backend's streaming guard enforces the limit).
 *
 * In both cases `contentType` is the content-type the bytes are stored under.
 */
export type ResourceInput =
  | { kind: 'json'; contentType: string; data: unknown }
  | {
      kind: 'binary'
      contentType: string
      stream: Readable
      declaredBytes?: number
    }

/**
 * The parsed auth headers attached to `request.zcap` by the `parseAuthHeaders`
 * hook. `headers` is the signed-headers list string (not the request headers
 * object); `created` / `expires` are stringified unix timestamps.
 */
export interface ParsedZcap {
  keyId: string
  headers: string
  signature: string
  created: string
  expires: string
  /** the raw `Capability-Invocation` header value */
  invocation: string
  /** the raw `Digest` header value (absent on bodyless requests) */
  digest?: string
}

/**
 * The full persisted record for a registered `external` backend (spec
 * "Backends"). Secret-bearing -- its `connection` carries the write-side grant
 * material -- so it is **never** serialized to a client: only the sanitized
 * `BackendDescriptor` projection (`sanitizeBackendRecord` in `lib/backends.ts`)
 * is. Held in usable (plaintext, this increment) form because the server is the
 * token custodian; the read/write split is enforced by `getBackend` being the
 * one storage method that returns this shape.
 */
export type StoredBackendRecord = BackendDescriptor & {
  managedBy: 'external'
  provider: string
  connection: BackendConnectionInput
}

/**
 * A WebKMS keystore configuration (the `/kms` facet).
 * The wire shape is protocol-fixed by `@interop/webkms-client`, minus the
 * deliberately-dropped `meterId` / `ipAllowList` fields. Stored verbatim,
 * full-URL `id` included, so the sequence-gated update can round-trip the
 * config unchanged; the storage key is the id's last URL segment (the
 * server-generated local id).
 */
export interface KeystoreConfig {
  /** full keystore URL (`<serverUrl>/kms/keystores/<localId>`), server-assigned on create */
  id: string
  /** the DID that controls the keystore (authorizes every invocation on it) */
  controller: IDID
  /** config revision: must be 0 on create, exactly previous+1 on update */
  sequence: number
  /** opaque KMS module alias, echoed back; this server hard-wires 'local-v1' */
  kmsModule: string
}

/**
 * The full serialized form of a WebKMS-held key, INCLUDING its secret material
 * (`privateKeyMultibase` for the asymmetric pairs, `secret` for the symmetric
 * keys) -- the `key` unit of a {@link KmsKeyRecord}. Field names are
 * protocol-fixed by the webkms per-type key generators. The
 * `controller` is deliberately NOT part of it: it is always read from the live
 * keystore config at description time, so a controller change takes effect
 * immediately.
 */
export interface KmsStoredKey {
  '@context': string
  /** full key URL (`<keystoreId>/keys/<localId>`), server-assigned on generate */
  id: string
  /** the webkms key type (e.g. `Ed25519VerificationKey2020`) */
  type: string
  publicKeyMultibase?: string
  privateKeyMultibase?: string
  /** symmetric key material (HMAC / AES-KW), base64url */
  secret?: string
  /** per-key invocation chain bound, enforced at operation time */
  maxCapabilityChainLength?: number
  /** verbatim description `id` override (e.g. a did:key or did:web URL) */
  publicAlias?: string
  /** description `id` template, expanded against the key description */
  publicAliasTemplate?: string
  /**
   * At-rest ONLY: present in place of the secret fields (`privateKeyMultibase`
   * / `secret`) when the record was written under a configured record KEK
   * (`KMS_RECORD_KEK`; see `lib/kmsRecordCipher.ts`). The in-memory
   * `KmsStoredKey` the KMS module operates on is always the DECRYPTED form --
   * the decrypt seam (`decryptKeyRecord`) strips this envelope and restores the
   * secret fields before any operation reads the key. A plaintext record (the
   * default / unconfigured deployment) never carries it.
   */
  encrypted?: KmsEncryptedEnvelope
}

/**
 * The at-rest envelope that replaces the secret-bearing fields of a stored
 * key's `key` when record encryption is enabled (`KMS_RECORD_KEK`; see
 * `lib/kmsRecordCipher.ts`). A fresh per-record content-encryption key (CEK,
 * `A256GCM`) encrypts the serialized secret subset; the CEK is wrapped
 * (`A256KW`) under the config-supplied KEK named by `kekId` -- the rotation
 * seam: a record keeps the `kekId` it was written under, so a rotated-in KEK
 * never forces a rewrite. Secrets never crossed the wire and still don't: this
 * shape lives only on disk, never in a client projection.
 */
export interface KmsEncryptedEnvelope {
  /** id of the KEK the CEK was wrapped under (`RecordKek.id`) */
  kekId: string
  /**
   * General JWE (JSON serialization): `A256GCM` content encryption with the
   * CEK wrapped `A256KW` under the KEK. The `protected` header is the JWE AAD.
   */
  jwe: {
    protected: string
    recipients: Array<{
      header?: Record<string, unknown>
      encrypted_key: string
    }>
    iv: string
    ciphertext: string
    tag: string
  }
  /** the secret-subset serialization inside the JWE (only `json` this increment) */
  encoding: 'json'
}

/**
 * A record-encryption key-encryption key (KEK): a raw AES-256 key plus its
 * derived, non-secret id (`RecordKek.id`, a one-way hash of the key material,
 * safe to store per record). Held only in process memory (config env), never in
 * the data tree.
 */
export interface RecordKek {
  id: string
  key: Buffer
}

/**
 * The at-rest key-record KEK registry (config `KMS_RECORD_KEK`): every KEK
 * available to UNWRAP a record (keyed by `RecordKek.id`) plus `currentKekId`,
 * the KEK that WRAPS new records. `currentKekId: null` disables encryption --
 * new records are written plaintext -- while previously registered KEKs stay
 * available for decrypt. Rotation is a config change (register a new KEK, repoint
 * `currentKekId`), never a schema migration.
 */
export interface KmsRecordKekRegistry {
  keks: Map<string, RecordKek>
  currentKekId: string | null
}

/**
 * A stored WebKMS key record (the `/kms` facet), a
 * `{keystoreId, localId, meta, key}` shape unique on `(keystoreId, localId)`.
 * Secret-bearing -- `key` carries the full serialized key material -- so a
 * record is **never** serialized to a client: only the sanitized key-description
 * projection built by the KMS module is. The storage layer treats the record as
 * an opaque unit. At rest, `key`'s secret fields are stored plaintext by default
 * or, when `KMS_RECORD_KEK` is configured, replaced by a `key.encrypted`
 * envelope (see `lib/kmsRecordCipher.ts`); either way the in-memory record the
 * KMS module operates on is the decrypted form.
 */
export interface KmsKeyRecord {
  /** the owning keystore's local id */
  keystoreId: string
  /** the key's server-generated local id (the last segment of `key.id`) */
  localId: string
  /** server-managed timestamps (ISO 8601) */
  meta: { created: string; updated: string }
  key: KmsStoredKey
}

/**
 * The public key-description projection of a KMS-held key, as returned by
 * `GenerateKeyOperation` and `GET <keyId>` (never any secret field). Its `id`
 * is the key URL, or the `publicAlias` / expanded `publicAliasTemplate` when
 * one was set at generate time; `controller` is the live keystore controller.
 */
export interface KmsKeyDescription {
  '@context': string
  id: string
  type: string
  publicKeyMultibase?: string
  controller: IDID
}

/**
 * A stored zcap revocation (the `/kms` facet), a `{capability, meta}` record.
 * Unique on `(delegator, capability.id)` within
 * its scope (the keystore tree it is stored under); `meta.expires` is the
 * record's own garbage-collection horizon -- one day past the capability's
 * `expires`, after which the capability is rejected on expiry alone and the
 * record is prunable (the one-day margin covers clock-skew grace periods).
 */
export interface RevocationRecord {
  /** the full revoked capability, stored verbatim */
  capability: { id: string; expires?: string; [key: string]: unknown }
  meta: {
    /** the party that delegated the revoked capability (its proof creator) */
    delegator: string
    /** the root object the revocation aggregates under (the keystore URL) */
    rootTarget: string
    /** server-managed creation timestamp (ISO 8601) */
    created: string
    /** GC horizon (ISO 8601); absent when the capability never expires */
    expires?: string
  }
}

/**
 * The `(capabilityId, delegator)` pair identifying one delegated capability in
 * a chain for a revocation-store lookup.
 */
export interface CapabilitySummary {
  capabilityId: string
  delegator: string
}

/**
 * A backend-adapter factory: given a registered (secret-bearing)
 * `StoredBackendRecord` and a logger, returns the live `StorageBackend` that
 * speaks to that provider. The teaching server's adapter strategy is Layer 3
 * (not spec), so this type is server-local. Keyed by `record.provider` in the
 * `BackendProviderRegistry`.
 */
export type BackendProvider = (
  record: StoredBackendRecord,
  options: { logger: FastifyBaseLogger }
) => StorageBackend

/** The injected provider-adapter registry, keyed by `record.provider`. */
export type BackendProviderRegistry = Map<string, BackendProvider>

/**
 * The persistence contract a storage backend implements (currently
 * `FileSystemBackend`; the port is designed to admit additional adapters). The
 * active backend is injected into the Fastify instance via
 * `createApp({ backend })` and read in handlers as `request.server.storage`.
 *
 * Invariants:
 * - The getters resolve to a falsy value (not throw) when the target is absent;
 *   callers test `if (!description)` and translate that into a 404.
 * - Write methods are upserts (create if absent, overwrite if present); their
 *   resolved value is implementation-defined and ignored.
 * - Delete methods are idempotent and resolve once the target is gone.
 * - Resources are identified by `resourceId` alone within a Collection; a
 *   Resource has exactly one current representation. `writeResource` replaces
 *   any existing representation, including one previously stored under a
 *   different content-type. `getResource`'s `contentType` is an advisory hint:
 *   single-representation backends return the one representation regardless, and
 *   the stored content-type comes back in `ResourceResult.storedResourceType`.
 *   Where the content-type lives is an adapter detail (filename segment /
 *   map-value field / future SQL column).
 *
 * Note: `exportSpace` resolves a tar-stream `Pack` at runtime, typed here as the
 * `Readable` it extends (tar-stream ships no types).
 */
export interface StorageBackend {
  /**
   * Optional logger the backend writes diagnostics through (Fastify's pino
   * logger, `FastifyBaseLogger`). `createApp` wires `fastify.log` here; backends
   * default to a silent pino logger until it is set.
   */
  logger?: FastifyBaseLogger

  /**
   * OPTIONAL startup hook for backends with a connection lifecycle (e.g. the
   * Postgres backend connects and applies its schema migrations here).
   * Awaited once by the plugin composition during registration, before the
   * server starts listening. Backends without startup work omit it.
   */
  init?(): Promise<void>

  /**
   * OPTIONAL shutdown hook (e.g. draining a connection pool). Wired to the
   * Fastify `onClose` hook by the plugin composition. Backends without
   * teardown work omit it.
   */
  close?(): Promise<void>

  /**
   * The per-upload size cap in bytes (spec "Quotas", `maxUploadBytes`), or
   * `undefined` for no cap. Enforced by `writeResource`; also read by the
   * request layer to bound the in-memory buffer of a multipart file part (so an
   * oversize multipart upload is rejected before it is fully buffered).
   */
  maxUploadBytes?: number

  /**
   * The backend's self-description, as advertised at
   * `GET /space/:spaceId/backends`. Synchronous: a backend knows its own
   * characteristics without any I/O.
   */
  describe(): BackendDescriptor

  /**
   * Measures the storage the given Space consumes on this backend, for the
   * Space Quota report (spec "Quotas"). Resolves a `BackendUsage` entry: the
   * backend's identity plus measured `usageBytes`, derived `state`, and the
   * configured `limit`. The per-Collection `usageByCollection` breakdown is
   * included only when `includeCollections` is set (the spec's opt-in
   * `?include=collections`), so a backend for which the breakdown is expensive
   * computes it only on request. The Space is guaranteed to exist by the request
   * layer before this is called; an absent Space dir reports zero usage.
   */
  reportUsage(options: {
    spaceId: string
    includeCollections?: boolean
  }): Promise<BackendUsage>

  /**
   * Measures the storage a single Collection consumes on this backend, for the
   * per-Collection Quota report (spec "Quotas",
   * `GET /space/{id}/{cid}/quota`). Resolves a `BackendUsage` entry whose
   * `usageBytes` is scoped to the Collection, while `state` / `limit` /
   * `restrictedActions` describe the backend's overall condition (the quota is a
   * per-backend limit); the per-Collection breakdown (`usageByCollection`) is
   * omitted. OPTIONAL: a backend that cannot account per-Collection omits this
   * method, and the request layer returns `unsupported-operation` (501). The
   * Space and Collection are guaranteed to exist by the request layer.
   */
  reportCollectionUsage?(options: {
    spaceId: string
    collectionId: string
  }): Promise<BackendUsage>

  writeSpace(options: {
    spaceId: string
    spaceDescription: SpaceDescription
  }): Promise<void>
  getSpaceDescription(options: {
    spaceId: string
  }): Promise<SpaceDescription | undefined>
  deleteSpace(options: { spaceId: string }): Promise<void>
  /**
   * Enumerates every Space stored on this backend (the candidate set for the
   * List Spaces operation; the request layer filters it down to the Spaces the
   * caller is authorized to see). Resolves an empty array when nothing is
   * stored yet (must not throw on an absent storage root).
   */
  listSpaces(): Promise<SpaceDescription[]>
  listCollections(options: { spaceId: string }): Promise<CollectionSummary[]>
  exportSpace(options: { spaceId: string }): Promise<Readable>
  importSpace(options: {
    spaceId: string
    tarStream: Readable
  }): Promise<ImportStats>

  writeCollection(options: {
    spaceId: string
    collectionId: string
    collectionDescription: CollectionDescription
  }): Promise<void>
  getCollectionDescription(options: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionDescription | undefined>
  deleteCollection(options: {
    spaceId: string
    collectionId: string
  }): Promise<void>
  /**
   * Lists a Collection's Resources, OPTIONALLY paginated (spec "Pagination").
   * `limit` bounds the page (a backend MAY clamp an oversized value to its own
   * maximum); `cursor` is the opaque token from a prior page's `next`, naming
   * the keyset position to resume from. With neither, the first (or only) page
   * is returned. The result carries `next` -- a ready-to-follow URL with the
   * cursor and limit baked in -- if and only if a further page may follow; its
   * absence marks the last page. A malformed/un-honorable `cursor` rejects with
   * `InvalidCursorError` (400 `invalid-cursor`).
   *
   * `collectionDescription` (the caller's already-fetched control-plane
   * description) supplies the listing's `name` / `type` and encryption flag; a
   * data-plane backend selected by a Collection never holds the description
   * itself (it lives on the control plane), so it MUST be passed in for such a
   * backend.
   */
  listCollectionItems(options: {
    spaceId: string
    collectionId: string
    limit?: number
    cursor?: string
    collectionDescription?: CollectionDescription
  }): Promise<CollectionResourcesList>

  /**
   * Writes a Resource representation, bumping its monotonic `version` (the ETag
   * validator), and returns the new version. When a conditional-write
   * precondition is supplied (`conditional-writes` feature) it is evaluated
   * atomically with the write: `ifMatch` is an update-if-unchanged (the current
   * ETag must equal it), `ifNoneMatch` is a create-if-absent (`If-None-Match:
   * *`); a mismatch rejects with `precondition-failed` (412).
   */
  writeResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    input: ResourceInput
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<{ version: number }>
  getResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    /** advisory hint only; single-representation backends ignore it for lookup */
    contentType?: string
  }): Promise<ResourceResult>
  /**
   * Deletes a Resource. When `ifMatch` is supplied (`conditional-writes`), the
   * delete proceeds only if the Resource's current ETag matches, evaluated
   * atomically with the removal; a mismatch rejects with `precondition-failed`
   * (412). Without it, the delete is unconditional and idempotent.
   */
  deleteResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    ifMatch?: string
  }): Promise<void>
  getResourceMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<
    (ResourceMetadata & { version?: number; metaVersion?: number }) | undefined
  >
  /**
   * Replaces the user-writable `custom` object of a Resource's Metadata (full
   * replacement; pass `{}` to clear). Resolves `undefined` when the Resource
   * does not exist (this operation does not create one) so the handler can 404,
   * else the Resource's new `metaVersion` (the `/meta` ETag validator, bumped
   * on each metadata write independently of the content `version`).
   *
   * On an encrypted Collection `custom` is the opaque encryption envelope (an
   * arbitrary JSON object) rather than a `{ name, tags }` object; the backend
   * stores it verbatim. When `ifMatch` / `ifNoneMatch` is supplied
   * (`conditional-writes`), the write is gated on the current `metaVersion`
   * atomically, rejecting a mismatch with `precondition-failed` (412).
   */
  writeResourceMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    custom: ResourceMetadataCustom | Record<string, unknown>
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<{ metaVersion: number } | undefined>

  /**
   * OPTIONAL replication change feed (the `changes` query profile.
   * Returns the Collection's JSON-document
   * Resources and tombstones changed strictly after `checkpoint`, in change
   * order (`(updatedAt, resourceId)` ascending), capped at `limit` (a backend
   * MAY clamp an oversized value to its own maximum). With no `checkpoint`, the
   * feed starts from the beginning.
   *
   * Each document carries its monotonic content `version`, its `metaVersion`
   * (when a metadata write has occurred), `updatedAt`, and -- so metadata
   * replicates alongside content -- the user-writable `custom` object (the
   * opaque encryption envelope on an encrypted Collection). A metadata-only edit
   * re-surfaces the Resource with a bumped `updatedAt` / `metaVersion` but its
   * `version` / `data` unchanged. A tombstone (soft-deleted Resource) is
   * surfaced with `deleted: true` and no `data` so the delete replicates until
   * clients catch up. Binary (non-JSON) Resources are excluded -- attachment
   * replication is future work. The result's
   * `checkpoint` is the `{ id, updatedAt }` of the last returned document (the
   * keyset position a follow-up call resumes after), or `null` when nothing
   * changed since `checkpoint`.
   *
   * OPTIONAL: a backend that omits this method does not serve the change feed,
   * and the request layer returns `unsupported-operation` (501). The Space and
   * Collection are guaranteed to exist by the request layer.
   */
  changesSince?(options: {
    spaceId: string
    collectionId: string
    checkpoint?: { id: string; updatedAt: string }
    limit: number
  }): Promise<{
    documents: Array<{
      resourceId: string
      version: number
      metaVersion?: number
      updatedAt: string
      deleted: boolean
      data?: unknown
      custom?: unknown
    }>
    checkpoint: { id: string; updatedAt: string } | null
  }>

  /**
   * Access-control policy documents. The level is selected by which ids are
   * present: Space (`spaceId`), Collection (`+ collectionId`), or Resource
   * (`+ collectionId + resourceId`). Getters resolve falsy when absent.
   */
  getPolicy(options: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): Promise<PolicyDocument | undefined>
  writePolicy(options: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    policy: PolicyDocument
  }): Promise<void>
  deletePolicy(options: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): Promise<void>

  /**
   * Registered `external` backend records (spec "Backends"). The read/write
   * asymmetry is the secret boundary: `getBackend` is the only method that
   * returns the secret-bearing `StoredBackendRecord`; `listBackends` returns
   * sanitized `BackendDescriptor`s. A registered backend is listed but not yet
   * selectable as a Collection's `backend` this increment (the live adapter is
   * future work).
   */
  writeBackend(options: {
    spaceId: string
    backendId: string
    record: StoredBackendRecord
  }): Promise<void>
  /** The full (secret-bearing) record, or `undefined` when absent. Internal use. */
  getBackend(options: {
    spaceId: string
    backendId: string
  }): Promise<StoredBackendRecord | undefined>
  /** The Space's registered external backends, **sanitized** (no secrets). */
  listBackends(options: { spaceId: string }): Promise<BackendDescriptor[]>
  /** Idempotent: no error when the record is absent. */
  deleteBackend(options: { spaceId: string; backendId: string }): Promise<void>

  /**
   * WebKMS keystore configs (the `/kms` facet).
   * Keystores are a sibling tree to Spaces (`data/keystores/<localId>/`),
   * keyed by `keystoreId` -- the server-generated *local* id, i.e. the last
   * segment of the config's full-URL `id`. The protocol defines no keystore
   * delete.
   *
   * Writes a keystore config unconditionally (the create path; local ids are
   * server-generated 128-bit random values, so create never collides). The
   * sequence-gated update path is `updateKeystore`.
   */
  writeKeystore(options: {
    keystoreId: string
    config: KeystoreConfig
  }): Promise<void>
  getKeystore(options: {
    keystoreId: string
  }): Promise<KeystoreConfig | undefined>
  /**
   * Replaces a keystore config if and only if, atomically with the write:
   * the keystore exists, `config.sequence` is exactly the stored sequence + 1,
   * and `config.kmsModule` matches the stored one (the module is immutable).
   * Otherwise rejects with the protocol's 409 state conflict
   * (`KeystoreStateConflictError`) -- one merged conflict kind.
   */
  updateKeystore(options: {
    keystoreId: string
    config: KeystoreConfig
  }): Promise<void>
  /**
   * Every stored keystore config whose `controller` matches, sorted by local
   * id (the request layer caps the wire result). Resolves an empty array when
   * nothing is stored yet (must not throw on an absent storage root).
   */
  listKeystoresByController(options: {
    controller: IDID
  }): Promise<KeystoreConfig[]>

  /**
   * WebKMS key records, stored under their keystore
   * (`data/keystores/<keystoreId>/keys/<localId>.json`), unique on
   * `(keystoreId, localId)`. The record is opaque to the storage layer -- the
   * at-rest record cipher (`KMS_RECORD_KEK`, `lib/kmsRecordCipher.ts`) applies
   * above the backend, at the KMS orchestration seam, so no schema change is
   * needed here. The protocol defines no key delete or update -- a record is
   * immutable once inserted.
   *
   * Inserts a key record, create-only: rejects with the protocol's 409
   * duplicate conflict (`KeyIdConflictError`) when a record already exists at
   * `(keystoreId, localId)`, atomically with the write.
   */
  insertKey(options: {
    keystoreId: string
    localId: string
    record: KmsKeyRecord
  }): Promise<void>
  getKey(options: {
    keystoreId: string
    localId: string
  }): Promise<KmsKeyRecord | undefined>
  /**
   * Every stored key record under the keystore, sorted by local id (the
   * request layer caps and paginates the wire result). The record is opaque to
   * storage -- the at-rest cipher applies above the backend (as for `getKey`),
   * so records come back exactly as stored. Resolves an empty array when the
   * keystore has no keys yet (must not throw on an absent keys directory /
   * table).
   */
  listKeys(options: {
    keystoreId: string
  }): Promise<Array<{ localId: string; record: KmsKeyRecord }>>

  /**
   * WebKMS zcap revocations, stored under their keystore
   * (`data/keystores/<keystoreId>/revocations/`), unique on
   * `(delegator, capability.id)` within the keystore. The protocol defines no
   * revocation read or delete: records exist only to be consulted by the
   * chain-inspection hook, and lapse via `meta.expires` (the capability is
   * rejected on its own expiry from then on).
   *
   * Inserts a revocation record, create-only: rejects with the protocol's 409
   * duplicate (`DuplicateRevocationError`) when a record already exists at
   * `(meta.delegator, capability.id)`, atomically with the write.
   */
  insertRevocation(options: {
    keystoreId: string
    record: RevocationRecord
  }): Promise<void>
  /**
   * True when any of the given capabilities has a stored, unexpired
   * revocation under the keystore. Records past their `meta.expires` GC
   * horizon count as not revoked (the capability itself has expired) and may
   * be pruned on the way through.
   */
  isRevoked(options: {
    keystoreId: string
    capabilities: CapabilitySummary[]
  }): Promise<boolean>
}

/**
 * Decision returned by an {@link AuthorizeProvisioning} callback for a
 * provisioning request (`POST /spaces/` or `POST /kms/keystores`):
 * - `verify` -- proceed with normal zcap capability-invocation verification;
 * - `grant` -- the callback itself authorized the request (e.g. a valid
 *   onboarding token); skip zcap verification for this request;
 * - `deny` -- refuse provisioning (403).
 */
export type ProvisioningDecision = 'verify' | 'grant' | 'deny'

/**
 * Provisioning gate callback: decides whether a request to one of the two open
 * provisioning endpoints (`POST /spaces/`, `POST /kms/keystores`) may proceed.
 * May instead throw a `ProblemError` subclass to return a custom status/body.
 * @param options {object}
 * @param options.request {import('fastify').FastifyRequest}   the provisioning request
 * @returns {ProvisioningDecision | Promise<ProvisioningDecision>}
 */
export type AuthorizeProvisioning = (options: {
  request: FastifyRequest
}) => ProvisioningDecision | Promise<ProvisioningDecision>

declare module 'fastify' {
  interface FastifyInstance {
    serverUrl: string
    storage: StorageBackend
    /**
     * The provider-adapter registry: maps a registered backend's `provider` to
     * the factory that builds its live `StorageBackend` adapter. Read by the
     * resolver (lib/backendRegistry.ts). Empty in production this stage (no
     * real adapter yet); injected in tests. Set by `fastify.decorate` in
     * plugin.ts.
     */
    backendProviders: BackendProviderRegistry
    /**
     * The optional server-wide registration allowlist: the backend `provider`
     * names a client may register (config `WAS_ENABLED_BACKENDS`). `undefined`
     * means no allowlist -- any provider may be registered (permissive
     * default).
     */
    enabledBackendProviders?: string[]
    /**
     * The at-rest key-record encryption registry (config `KMS_RECORD_KEK`): the
     * KEK(s) available to unwrap stored WebKMS key records plus the
     * `currentKekId` selecting the one that wraps NEW records. `undefined` (or
     * `currentKekId: null`) means encryption is disabled -- records are written
     * plaintext (the teaching default). Read at the KMS orchestration seam
     * (`KeyRequest`), never inside a backend (records stay opaque to storage).
     * Set by `fastify.decorate` in plugin.ts.
     */
    kmsRecordKek?: KmsRecordKekRegistry
    /**
     * The optional provisioning gate for the two open provisioning endpoints
     * (`POST /spaces/`, `POST /kms/keystores`). `undefined` means allow (the
     * teaching default -- anyone may provision by proving control of the body's
     * controller DID). Set by `fastify.decorate` in plugin.ts, either from the
     * `authorizeProvisioning` option or the built-in onboarding-token check.
     */
    authorizeProvisioning?: AuthorizeProvisioning
  }
  interface FastifyRequest {
    /**
     * Set by the provisioning gate when a request to a provisioning endpoint
     * was authorized by the configured provisioning policy (e.g. a valid
     * onboarding token) instead of a capability invocation. When set, the auth
     * and digest hooks and the handler's controller-consent check are skipped
     * (the request carries a Bearer token, not an HTTP Signature).
     */
    provisioningAuthorized?: boolean
    /**
     * Set by the `parseAuthHeaders` hook when auth headers are present. Absent
     * for anonymous reads (the `requireAuthHeaders` hook lets safe methods
     * through without auth so a fallback policy can grant access).
     */
    zcap?: ParsedZcap
    /**
     * The exact request body bytes, captured by the `captureRawBody`
     * preParsing hook for JSON/text bodies so `verifyBodyDigest` can recompute
     * the `Digest` header against what the client signed (re-serializing the
     * parsed body is not guaranteed byte-identical). Absent for streamed
     * (multipart / tar) bodies, which are left unbuffered.
     */
    rawBody?: Buffer
  }
}
