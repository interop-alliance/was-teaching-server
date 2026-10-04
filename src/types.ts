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

import type { EtagValidator, HeldValidators } from './lib/etag.js'
import type { ServerSigningKey } from './lib/serverIdentity.js'
import type { ExportAttestor } from './lib/exportProvenance.js'
import type { ImportPlan } from './lib/importTar.js'
import type {
  BlindedIndexQuery,
  BlindedIndexQueryPage
} from './lib/blindedIndex.js'
import type {
  EqualityQuery,
  EqualityQueryPage,
  EqualityCandidate,
  EqualityValue,
  NormalizedIndexDeclaration
} from './lib/equalityIndex.js'

// The shared WAS wire model now lives in `@interop/storage-core`. Import the
// shapes referenced by the `StorageBackend` contract below, and re-export the
// whole data-model surface so the rest of the server keeps importing it from
// this one module.
import type {
  SpaceMetadata,
  CollectionsList,
  CollectionResourcesList,
  ResourceMetadata,
  ResourceMetadataCustom,
  CollectionMetadata,
  BackendDescriptor,
  BackendConnectionInput,
  BackendUsage,
  ImportStats,
  PolicyDocument,
  ServiceDescription,
  ServiceDescriptionVersionEntry,
  WriteStamp,
  ResourceMetaStamp
} from '@interop/storage-core'

// Surface the blinded-index query shapes referenced by the `StorageBackend`
// contract (`queryByBlindedIndex`) from this one module.
export type { BlindedIndexQuery, BlindedIndexQueryPage }

// Surface the equality-index query shapes referenced by the `StorageBackend`
// contract (`queryByEquality` / `findEqualityUniqueViolation`) from this one
// module, alongside the blinded-index ones.
export type {
  EqualityQuery,
  EqualityQueryPage,
  EqualityCandidate,
  EqualityValue,
  NormalizedIndexDeclaration
}

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
  SpaceMetadata,
  BackendReference,
  SpaceSummary,
  SpaceListing,
  CollectionSummary,
  CollectionsList,
  ResourceSummary,
  CollectionResourcesList,
  CollectionIndexDeclaration,
  CollectionEncryption,
  CollectionEncryptionEpoch,
  CollectionEncryptionRecipient,
  CollectionRevisions,
  ResourceMetadata,
  ResourceMetadataCustom,
  CollectionMetadata,
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
  LinkSetEntry,
  ServiceDescription,
  ServiceDescriptionVersionEntry,
  PwsVersionEntry,
  AuthzProfileVersionEntry,
  WriteStamp,
  ResourceMetaStamp
} from '@interop/storage-core'

/**
 * The Encrypted Collections profile's version entry in a `ServiceDescription`
 * (profile "The version entry"). Its sibling entries, `PwsVersionEntry` and
 * `AuthzProfileVersionEntry`, are owned by `@interop/storage-core`; this one
 * lives here until that package carries it too.
 *
 * - `features` -- the profile's optional affordances this server serves, as
 *   listed by `ENCRYPTED_COLLECTIONS_FEATURES` in `serviceDescription.ts`.
 */
export interface EncryptedCollectionsVersionEntry extends ServiceDescriptionVersionEntry {
  features?: string[]
}

/**
 * The stored parts of a record's `ETag` validator a read result carries: the
 * record's `generation` and the write stamp of its last write (see
 * `lib/etag.ts`). The request layer derives the `ETag` from them
 * (`etagOf`).
 */
export type RecordValidatorParts = { generation?: string } & Partial<WriteStamp>

/**
 * Return shape of `getResource()`: the byte stream and its content-type,
 * beside the content record's validator parts.
 */
export interface ResourceResult extends RecordValidatorParts {
  resourceStream: Readable
  /** resolved content-type of the stored bytes */
  storedResourceType: string
}

/**
 * Return shape of `getChunkMetadata()` (the `chunked-streams` feature): a
 * chunk's stored content-type / size, beside its own validator parts -- the
 * HEAD payload headers.
 */
export interface ChunkMetadata extends RecordValidatorParts {
  contentType: string
  size: number
}

/**
 * Return shape of `listChunks()` (the `chunked-streams` feature): a Resource's
 * stored chunks in ascending `index` order (the discovery/reassembly listing),
 * with their `count`. `count` is the number of chunks listed, not their total
 * byte size.
 */
export interface ChunkListing {
  count: number
  chunks: Array<{
    index: number
    size: number
    contentType: string
  }>
}

/**
 * Transport-neutral input to `writeResource`. The request layer resolves a
 * Fastify request into one of these shapes (see `resolveResourceInput` in
 * requests/resourceInput.ts) so that storage backends never depend on Fastify:
 * - `kind: 'json'` carries the parsed JSON value in `data`.
 * - `kind: 'binary'` carries a readable byte stream — a raw blob body, or the
 *   file extracted from a multipart upload. `declaredBytes` is the up-front size
 *   when known, used for an early quota pre-flight. A raw stream body takes it
 *   from `Content-Length` and leaves it absent when that header is missing or
 *   malformed (the backend's streaming guard then enforces the limit). A
 *   buffered body carries its exact length. That covers a `text/plain` string
 *   and a multipart file part, which the request layer drains into memory
 *   before handing it over.
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
 * The at-rest key-record KEK registry (config `KMS_RECORD_KEK` /
 * `KMS_RECORD_KEKS` / `KMS_RECORD_CURRENT_KEK`): every KEK available to UNWRAP a
 * record (keyed by `RecordKek.id`) plus `currentKekId`,
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
 * The object a revocation aggregates under, and the unit a revocation lookup
 * is scoped to: a keystore (the `/kms` route family) or a Space (the WAS route
 * families). A revocation stored under one scope has no effect on the other --
 * a chain rooted in a Space is only ever inspected against that Space's store.
 */
export type RevocationScope = { keystoreId: string } | { spaceId: string }

/**
 * A stored zcap revocation, a `{capability, meta}` record. Unique on
 * `(delegator, capability.id)` within
 * its scope (the keystore or Space it is stored under); `meta.expires` is the
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
    /**
     * the root object the revocation aggregates under (the keystore URL, or
     * the Space URL for a WAS-route revocation)
     */
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
 * `StoredBackendRecord`, a logger, and the hosting server's origin id, returns
 * the live `StorageBackend` that speaks to that provider. The adapter exposes
 * that `originId` as its own and mints no stamps of its own. The teaching
 * server's adapter strategy is Layer 3 (not spec), so this type is
 * server-local. Keyed by `record.provider` in the `BackendProviderRegistry`.
 */
export type BackendProvider = (
  record: StoredBackendRecord,
  options: { logger: FastifyBaseLogger; originId: string }
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
 * Note: `exportSpace` resolves a Node `Readable`. The archive codec
 * (`@interop/space-archive`) is isomorphic and resolves a streamx-based
 * tar-stream `Pack`; each backend wraps it with `Readable.from` before
 * returning it.
 */
/**
 * The out-of-band `ETag` validator parts a stored Space or Collection Metadata
 * object carries beside its wire body: the generation minted by the record's
 * first write and kept for its life, and the local segment (`metaLocal`), a
 * counter this server advances when the served object changes through a
 * derived member and resets to 0 on every stamped write. The rest of the
 * validator is the write stamp, which the body carries as wire members
 * (`updatedAt`, `updatedAtCounter`, `originId`). One validator covers the
 * whole object -- configuration and annotation writes alike. The handler
 * strips these two from the wire body and sets the `ETag` header from them
 * and the stamp.
 */
export interface MetadataValidatorParts {
  metaGeneration?: string
  metaLocal?: number
}

/**
 * A stored Collection Metadata object as the backends surface it: the merged
 * wire body (configuration members beside `createdAt`, `updatedAt`, `custom`,
 * `epoch`) plus the out-of-band validator parts.
 */
export type StoredCollectionMetadata = CollectionMetadata &
  MetadataValidatorParts

/**
 * A stored Space Metadata object as the backends surface it: the wire body
 * plus the out-of-band validator parts.
 */
export type StoredSpaceMetadata = SpaceMetadata & MetadataValidatorParts

/**
 * A Collection's governing history log as stored (the
 * `governed-history-logs` feature): the JSON Lines body verbatim, plus its
 * own `ETag` validator parts, the generation minted by the guarded create and
 * the write stamp each write mints, independent of the Collection Metadata
 * object's validator. The filesystem backend's log file and the export
 * archive's log entry hold this layout.
 */
export type StoredCollectionLog = {
  body: string
  generation: string
} & WriteStamp

/**
 * A Collection's governing history log as a backend hands it over: the JSON
 * Lines body verbatim beside the log's own validator, so a reader formats the
 * `ETag` without assembling it from the stored layout.
 */
export interface CollectionLogResult {
  body: string
  validator: EtagValidator
}

/**
 * The write-once recheck a Resource or chunk write runs inside its critical
 * section. The backend hands it the Collection's governing history log as
 * read under the write's lock (`undefined` when it has none), and it answers
 * whether that log declares the Collection write-once.
 */
export type ImmutableUnder = (context: {
  log?: CollectionLogResult
}) => Promise<boolean>

/**
 * The persistence contract every backend implements. No write creates a
 * container implicitly. `writeSpace` is the only write that creates a Space,
 * and `writeCollection` (or an import) the only one that creates a Collection.
 * Every other write into a Space refuses with a 404 when the Space, and where
 * the write names one the Collection, has no Metadata object at the moment of
 * the write. The check is atomic with the write against a concurrent Delete
 * Space or Delete Collection.
 */
/**
 * What a Collection Metadata write's `assertTransition` check is handed,
 * read under the backend's per-Collection lock: the current object (`prior`,
 * `undefined` on a create) and the Collection's governing history log
 * (`log`, `undefined` when it has none).
 */
export interface CollectionTransitionContext {
  prior?: StoredCollectionMetadata
  log?: CollectionLogResult
}

export interface StorageBackend {
  /**
   * Optional logger the backend writes diagnostics through (Fastify's pino
   * logger, `FastifyBaseLogger`). `createApp` wires `fastify.log` here; backends
   * default to a silent pino logger until it is set.
   */
  logger?: FastifyBaseLogger

  /**
   * The store's origin id: the origin half of a write's replicated identity,
   * `[A-Za-z0-9_-]{1,64}`, stable for the store's life and unique among every
   * server a Space may replicate to. A primary backend is obtained from an
   * async factory (`FileSystemBackend.open()`, `PostgresBackend.open()`) that
   * reads or mints the id before it resolves (`WAS_ORIGIN_ID` when set, else
   * a minted id, refusing a mismatch with the stored one), so a backend in
   * hand always carries it. A data-plane adapter carries the hosting server's
   * id. Advertised on `/service` as `originId` on the core
   * `https://w3id.org/pws` entry.
   */
  readonly originId: string

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

  /**
   * Writes a Space Metadata object (full replacement), minting its write
   * stamp from the backend's clock inside the per-Space lock, resetting its
   * local validator segment to 0, and returning the new validator (the `ETag`
   * behind conditional Space writes). The stamp members (`updatedAt`,
   * `updatedAtCounter`, `originId`) are stored as wire members of the body;
   * any the supplied document carries are discarded. The server-managed
   * `createdBy` is authoritative, never taken from `spaceMetadata`: the backend
   * drops any value carried in that (client-supplied) document and records
   * `createdBy` from the first write's invoker, preserving it verbatim on every
   * later write. Omitting `createdBy` on a first write leaves it unrecorded
   * rather than letting the body supply one. `ifMatch` / `ifNoneMatch` are
   * evaluated atomically with the write on the same terms as
   * `writeCollection`'s: `ifNoneMatch` is the guarded create (412
   * `precondition-failed` when the Space exists), `ifMatch` the
   * compare-and-swap on the current `ETag`. The generation and local segment
   * travel only in the `ETag` header -- they are kept OUT of the wire body,
   * and a backend strips any validator-bearing member the supplied document
   * carries through `normalizeMetadataWrite` before storing it.
   */
  writeSpace(options: {
    spaceId: string
    spaceMetadata: SpaceMetadata
    /** DID of the invoker; recorded as `createdBy` on first write only */
    createdBy?: IDID
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    /**
     * Invoked atomically with the write (inside the backend's per-Space lock
     * or advisory-locked transaction) against the freshly re-read current
     * object (`undefined` on a create); throwing aborts the write. Lets a
     * write authorized against an unlocked read pin itself to that read.
     */
    assertTransition?: (prior?: StoredSpaceMetadata) => void | Promise<void>
  }): Promise<EtagValidator>
  /**
   * Reads a Space Metadata object. Resolves falsy when the Space does not
   * exist. `metaGeneration` / `metaLocal` are the out-of-band `ETag`
   * validator parts; the stamp members ride in the body.
   */
  getSpaceMetadata(options: {
    spaceId: string
  }): Promise<StoredSpaceMetadata | undefined>
  deleteSpace(options: { spaceId: string }): Promise<void>
  /**
   * Enumerates every Space stored on this backend (the candidate set for the
   * List Spaces operation; the request layer filters it down to the Spaces the
   * caller is authorized to see). Resolves an empty array when nothing is
   * stored yet (must not throw on an absent storage root).
   */
  listSpaces(): Promise<SpaceMetadata[]>
  /**
   * Lists a Space's Collections, OPTIONALLY cursor-paginated (spec
   * "Pagination"), on the same keyset machinery as `listCollectionItems`:
   * `limit` bounds the page (a backend MAY clamp an oversized value to its own
   * maximum, and applies its default when absent); `cursor` is the opaque token
   * from a prior page's `next`, naming the keyset position (a Collection id) to
   * resume strictly after. The result carries `next` -- a ready-to-follow URL
   * with the cursor and limit baked in -- if and only if a further page may
   * follow; its absence marks the last page. `totalItems` is the FULL count of
   * the Space's Collections (free to compute for this listing, so always
   * present). Each summary carries `public` -- true iff a `PublicCanRead`
   * access-control policy is attached to that Collection -- so a client need
   * not issue one policy probe per listed Collection; only the page's
   * Collections are probed. A malformed/un-honorable `cursor` rejects with
   * `InvalidCursorError` (400 `invalid-cursor`).
   */
  listCollections(options: {
    spaceId: string
    limit?: number
    cursor?: string
  }): Promise<CollectionsList>
  /**
   * Packs the Space as a tar archive: its Collections, Resources (including
   * tombstones), policies, metadata sidecars, and the Space's zcap revocation
   * records (so a revoked capability stays revoked across an export/import
   * round-trip). Backend registration records (secret material) do NOT
   * travel. `service` is this server's Service Description, written into the
   * archive verbatim as its `service.json` entry so an importer can read which
   * specification versions and feature set the contents were written under; an
   * export run with none (a backend called directly, outside a request) writes
   * no such entry. With an `attestor` (a server with an identity), the
   * archive also carries `provenance.jsonl`, one signed statement per
   * exported object built by `attestArchiveEntries` over the entry tree
   * packed, and `did.jsonl`, the attestor's DID log snapshot; without one it
   * carries neither.
   */
  exportSpace(options: {
    spaceId: string
    service?: ServiceDescription
    attestor?: ExportAttestor
  }): Promise<Readable>
  /**
   * Merges a Space-export archive into an existing Space, skip-not-overwrite
   * per item; the archive's revocation records are restored under this
   * Space's scope on the same terms (already-stored records are skipped).
   *
   * The backend persists what it is handed. `plan` is the archive's merge
   * plan with its provenance already judged, and `provenance` the verdict
   * counts, both built by `prepareImportPlan`; the counts are returned as the
   * stats' `provenance` member unchanged.
   *
   * The archived Space Metadata object's user-writable members are applied
   * only when `restoreSpaceMetadata` asks for it -- the Import Space handler
   * asks under an invocation of the Space's root capability and not under a
   * delegated chain; the backend holds no authorization decision of its own
   * -- and only over a Space that already has a stored Metadata object:
   * `name` is restored, and `type`, immutable once a Space exists, is checked
   * against the destination's (a different set of types refuses the import
   * with `InvalidImportError` before anything is written). Server-derived
   * members and `controller` are never restored. The outcome is the
   * `spaceMetadata` member of the stats: `'restored'`, `'skipped'` when the
   * archive carried an entry that was not applied (the option unset, or a
   * Space with no stored object yet), or `'absent'` when it carried none that
   * parses as a JSON object.
   */
  importSpace(options: {
    spaceId: string
    plan: ImportPlan
    provenance: ImportStats['provenance']
    restoreSpaceMetadata?: boolean
  }): Promise<ImportStats>

  /**
   * Writes a Collection Metadata object (full replacement of the merged
   * object: the configuration members beside the annotation members `custom`
   * and `epoch`), minting its write stamp inside the per-Collection lock,
   * resetting its local validator segment to 0, and returning the new
   * validator (the `ETag` behind conditional Collection writes).
   * Server-managed members are the backend's: `createdBy` on the same terms as
   * `writeSpace`'s, `createdAt` set by the creating write and preserved, the
   * stamp members (`updatedAt`, `updatedAtCounter`, `originId`) by every
   * write. `custom` is
   * stored verbatim (`{ name, tags }` on a plaintext Collection, the opaque
   * encryption envelope on an encrypted one) and an absent or empty `custom`
   * clears it; an absent `epoch` clears the stored stamp, since it describes
   * the envelope this write replaces. When `ifMatch` is supplied it is
   * evaluated atomically with the write: the current `ETag` must equal it (an
   * update-if-unchanged compare-and-swap), else `precondition-failed` (412).
   * `ifNoneMatch` (`If-None-Match: *`) is the guarded create: the write
   * proceeds only if the Collection does not exist yet, else
   * `precondition-failed` (412), evaluated under the same lock. The
   * generation and local segment travel only in the `ETag` header -- they are
   * kept OUT of the wire body.
   */
  writeCollection(options: {
    spaceId: string
    collectionId: string
    collectionMetadata: CollectionMetadata
    /** DID of the invoker; recorded as `createdBy` on first write only */
    createdBy?: IDID
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    /**
     * Invoked atomically with the write (inside the backend's per-Collection
     * lock / row-locking transaction) against the freshly re-read current
     * object (`undefined` on a create) and the Collection's governing
     * history log as of the same lock (`undefined` when it has none);
     * throwing aborts the write. Carries the request layer's
     * state-transition checks -- e.g. the epoch append-only rule, and the
     * refusal of a direct `encryption` write on a log-governed Collection --
     * which are otherwise evaluated against a pre-lock read and could miss a
     * concurrent write. The log is handed over rather than re-read by the
     * callback, so the recheck costs no second read and sees the log the
     * lock covers.
     */
    assertTransition?: (
      context: CollectionTransitionContext
    ) => void | Promise<void>
  }): Promise<EtagValidator>
  /**
   * Reads a Collection Metadata object. Resolves falsy when the Collection
   * does not exist. `metaGeneration` / `metaLocal` are the out-of-band `ETag`
   * validator parts (the handler strips them from the wire body and sets the
   * `ETag` header from them and the body's stamp members).
   */
  getCollectionMetadata(options: {
    spaceId: string
    collectionId: string
  }): Promise<StoredCollectionMetadata | undefined>
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
   * `collectionMetadata` (the caller's already-fetched control-plane
   * object) supplies the listing's `name` / `type` and encryption flag; a
   * data-plane backend selected by a Collection never holds the Collection
   * Metadata itself (it lives on the control plane), so it MUST be passed in
   * for such a backend.
   */
  listCollectionItems(options: {
    spaceId: string
    collectionId: string
    limit?: number
    cursor?: string
    collectionMetadata?: CollectionMetadata
  }): Promise<CollectionResourcesList>

  /**
   * Writes a Resource representation, minting the content record's write
   * stamp inside the per-Resource lock (over the stamp it replaces, so the new
   * one sorts above it), and returns the new validator (the stamp under the
   * Resource's `generation`). When a conditional-write precondition is
   * supplied (`conditional-writes` feature) it is evaluated
   * atomically with the write: `ifMatch` is an update-if-unchanged (the current
   * ETag must equal it), `ifNoneMatch` is a create-if-absent (`If-None-Match:
   * *`); a mismatch rejects with `precondition-failed` (412).
   *
   * A backend carrying the `blinded-index-query` feature also enforces the EDV
   * unique-attribute invariant on JSON writes: an `indexed` blinded attribute
   * marked `unique: true` whose (HMAC key id, name, value) triple is already
   * claimed by another live document in the same Collection rejects with
   * `UniqueAttributeConflictError` (409), evaluated atomically with the write
   * (see `lib/blindedIndex.ts`). Conflicts require `unique: true` on both
   * sides, and a document keeping its own unique attribute across an update
   * never self-conflicts.
   *
   * A backend carrying the `equality-query` feature enforces the analogous
   * plaintext unique-attribute invariant when the request layer passes
   * `uniqueIndexes` (the target Collection's normalized `unique: true`
   * declarations, resolved from its control-plane description): a write whose
   * extracted value for a `unique` content-sourced attribute is already claimed
   * by a different live Resource in the same Collection rejects with
   * `UniqueAttributeConflictError` (409), evaluated atomically with the write
   * (see `lib/equalityIndex.ts`). Unlike the blinded invariant this is
   * Collection-level, so a conflict does not require the other side to opt in.
   */
  writeResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    input: ResourceInput
    /**
     * The target Collection's normalized `unique: true` index declarations,
     * passed by the request layer only when the Collection declares any. The
     * backend enforces the plaintext unique-attribute claim atomically with the
     * write (409 `UniqueAttributeConflictError`), for the content-sourced
     * entries a content write can claim.
     */
    uniqueIndexes?: NormalizedIndexDeclaration[]
    /**
     * DID of the party whose capability invocation authorized this write (the
     * signing key's DID, fragment stripped). Recorded as the Resource's
     * server-managed `createdBy` on the FIRST write and preserved verbatim by
     * every later write, exactly as `createdAt` is -- so it names the creator,
     * not the last writer. Omitted by callers with no resolved invoker (a
     * direct backend call), in which case no `createdBy` is recorded.
     */
    createdBy?: IDID
    /**
     * The client-declared key epoch this content was encrypted under (the
     * `key-epochs` feature). Stored opaquely on the Resource's metadata and
     * returned by reads; a content write with no epoch CLEARS any stored stamp
     * (the new ciphertext's epoch is unknown). The server never computes or
     * verifies it.
     */
    epoch?: string
    /**
     * The client-declared writer-attribution label naming the writing agent
     * that produced this revision (spec "Writer attribution"). Stored
     * opaquely and returned by reads; a content write with no `writerId`
     * CLEARS any stored label, on the same declare-or-clear terms as `epoch`.
     * The server never verifies it, computes it, or uses it in any
     * authorization decision.
     */
    writerId?: string
    /**
     * `true` when the target Collection is write-once (its `revisions`
     * descriptor sets `immutable`). Evaluated inside the write's critical
     * section, after the preconditions: over a live Resource, a write whose
     * content type and bytes equal the stored representation is a no-op that
     * returns the current validator (no new stamp, no feed position), and any
     * other write is refused with `ResourceImmutableError` (409). A write to
     * an absent id or over a tombstone is an ordinary create. The media type
     * is compared without its parameters.
     *
     * A recheck callback when the request layer read the Collection as not
     * write-once. That read ran before the write's lock, and a governing
     * history log's guarded create can declare `immutable` in between. Over
     * a live Resource the backend calls it with the log it reads under the
     * write's lock, and applies the rule when it answers `true`. A log's
     * guarded create cannot land between that read and the write.
     */
    immutable?: true | ImmutableUnder
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator>
  /**
   * Reads a Resource's current representation. Throws `ResourceNotFoundError`
   * (404) when no Resource is stored under the id, or only its tombstone.
   */
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
   * (412). Without it, the delete is unconditional and idempotent. Deleting a
   * Resource cascade-deletes any chunks stored under it (the `chunked-streams`
   * feature), so chunks never outlive their parent.
   */
  deleteResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    ifMatch?: string
    /**
     * The client-declared writer-attribution label naming the deleting agent
     * (spec "Writer attribution"). A deletion is a revision like any other:
     * where the backend keeps a tombstone, this is the label it carries,
     * declared fresh by THIS delete rather than inherited from the Resource's
     * prior `writerId`. Absent clears it, the same as an absent value does on
     * a content write.
     */
    writerId?: string
  }): Promise<void>
  /**
   * Reads a Resource's Metadata object. The content record's stamp members
   * are top-level wire members and the `/meta` record's stamp and generation
   * the nested `meta` object; `generation` is the content record's
   * generation, out of band (the handler strips it from the wire body and
   * derives the content `ETag` from it and the top-level stamp). The
   * Metadata's own `createdBy` rides along in it.
   */
  getResourceMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<(ResourceMetadata & { generation?: string }) | undefined>
  /**
   * Replaces the user-writable `custom` object of a Resource's Metadata (full
   * replacement; pass `{}` to clear). Resolves `undefined` when the Resource
   * does not exist (this operation does not create one) so the handler can 404,
   * else the `/meta` object's new ETag validator: its own generation, minted
   * by the first metadata write, with the stamp this write mints. The write
   * moves the nested `meta` record only; the content record's stamp, `ETag`,
   * and `writerId` are left as they are.
   *
   * On an encrypted Collection `custom` is the opaque encryption envelope (an
   * arbitrary JSON object) rather than a `{ name, tags }` object; the backend
   * stores it verbatim. When `ifMatch` / `ifNoneMatch` is supplied
   * (`conditional-writes`), the write is gated on the current `/meta` `ETag`
   * atomically (`If-None-Match: *` passes only while there is none), rejecting
   * a mismatch with `precondition-failed` (412).
   */
  writeResourceMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    custom: ResourceMetadataCustom | Record<string, unknown>
    /**
     * The target Collection's normalized `unique: true` index declarations,
     * passed by the request layer only when the Collection declares any. The
     * backend enforces the plaintext unique-attribute claim atomically with the
     * metadata write (409 `UniqueAttributeConflictError`), for the
     * custom-sourced entries a metadata write can claim (see
     * `lib/equalityIndex.ts`).
     */
    uniqueIndexes?: NormalizedIndexDeclaration[]
    /**
     * The client-declared key epoch (the `key-epochs` feature), a sibling of
     * `custom`. Unlike `custom` (full replacement), an OMITTED `epoch`
     * PRESERVES the stored value -- the stamp describes the content write, not
     * the metadata write -- while a supplied value replaces it. Stored opaquely.
     */
    epoch?: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator | undefined>

  /**
   * Reads a Collection's governing history log (the `governed-history-logs`
   * feature): the JSON Lines body as last written, with its validator.
   * Resolves `undefined` when the Collection has no log (it is not governed)
   * or does not exist.
   */
  getCollectionLog(options: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionLogResult | undefined>
  /**
   * Replaces a Collection's governing history log with `body` (the `/log`
   * transport's guarded create under `ifNoneMatch`, or its compare-and-swap
   * append under `ifMatch`, which carries the prior bytes forward). The
   * precondition is evaluated on the log's current `ETag` atomically with the
   * write (`precondition-failed`, 412, on a mismatch). Resolves `undefined`
   * when the Collection does not exist (this operation never creates one). A
   * `body` equal to the stored log, byte for byte, is a no-op once the
   * precondition passes: the current validator is resolved, `assertTransition`
   * is not invoked, and nothing is written.
   *
   * The write mints the log's own stamp, and also advances the Collection
   * Metadata object's local validator segment without minting a stamp for it:
   * the served object's `encryption` member is derived from the log head, so
   * its `ETag` must change with it. The write is serialized with Collection
   * Metadata writes, so `assertTransition` and a concurrent
   * `writeCollection`'s own callback each see the other's outcome.
   */
  writeCollectionLog(options: {
    spaceId: string
    collectionId: string
    body: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    /**
     * Invoked atomically with the write against the freshly re-read current
     * log (`undefined` on a create) and Collection Metadata object; throwing
     * aborts the write. Carries the request layer's line contract and
     * descriptor-transition checks.
     */
    assertTransition?: (context: {
      prior?: CollectionLogResult
      collectionMetadata: StoredCollectionMetadata
    }) => void | Promise<void>
  }): Promise<EtagValidator | undefined>

  /**
   * Writes one chunk of a chunked Resource (the `chunked-streams` feature),
   * keyed by `(spaceId, collectionId, resourceId, chunkIndex)`. Same upload-cap
   * / quota guards, stamp minting under the chunk's `generation` (the ETag
   * validator), and atomic
   * `ifMatch` / `ifNoneMatch` precondition semantics as `writeResource`;
   * differences:
   * - the body is opaque bytes + content-type (the server never parses it), so
   *   no encryption-conformance or unique-index enforcement applies;
   * - the stamp minted is the chunk's OWN, independent of the parent's;
   * - the parent Resource MUST already exist, else `ResourceNotFoundError`
   *   (404), so orphan chunks cannot accumulate;
   * - a chunk carries no server-managed `createdBy` / epoch / user Metadata.
   */
  writeChunk(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
    input: ResourceInput
    /**
     * `writeResource`'s `immutable` option (the flag, or the recheck
     * callback), applied against a stored chunk at the index.
     */
    immutable?: true | ImmutableUnder
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator>
  /**
   * Reads a chunk's bytes, resolving the same `ResourceResult` shape as
   * `getResource`; rejects with `ResourceNotFoundError` when absent.
   */
  getChunk(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<ResourceResult>
  /**
   * Reads a chunk's stored content-type / size / validator parts (the HEAD
   * payload headers). Resolves `undefined` when the chunk is absent.
   */
  getChunkMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<ChunkMetadata | undefined>
  /**
   * Deletes one chunk. Resolves `true` when a chunk was removed and `false`
   * when none was stored at that index (the handler 404s on `false` -- unlike
   * `deleteResource`, chunk deletes are not silently idempotent, mirroring the
   * EDV chunk contract). An `ifMatch` precondition is evaluated atomically
   * with the removal (`precondition-failed` 412 on mismatch).
   */
  deleteChunk(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
    ifMatch?: string
  }): Promise<boolean>
  /**
   * Lists a Resource's stored chunks in ascending `index` order -- the
   * discovery/reassembly listing (the server never reassembles; a reader
   * learns the chunk set here). Resolves an empty listing when the Resource
   * has no chunks (including when the Resource itself is absent -- existence
   * is the parent routes' concern).
   */
  listChunks(options: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<ChunkListing>

  /**
   * OPTIONAL replication change feed (the `changes` query profile). Returns
   * the Collection's JSON-document Resources and tombstones whose feed
   * position is strictly after `afterPosition`, in ascending feed position
   * order, capped at `limit` (a backend MAY clamp an oversized value to its
   * own maximum). With no `afterPosition`, the feed starts from the
   * beginning.
   *
   * The feed position is a per-Collection sequence, a positive integer
   * starting at 1. Every Resource-level write in the Collection takes the
   * next one: a content write, a metadata write, a soft delete, and a
   * Resource written by an import. A chunk write takes none, so it never
   * moves its parent Resource. The backend assigns the position inside the
   * per-Collection critical section that makes the write visible to this
   * method, so no write can land at or before a position already returned.
   * Positions are unique within a Collection but need not be contiguous. A
   * position is one server's fact about its own feed: it is never exported
   * or replicated, and an import assigns fresh ones. A Resource stored before
   * feed positions existed has none and is absent from the feed until it is
   * rewritten. The request layer wraps the position in the opaque wire
   * checkpoint; a backend never sees that string.
   *
   * The counter has a generation, minted with the first position it hands
   * out and kept for the Collection's life. It is removed with the
   * Collection, so a Collection re-created under the same id, by hand or by
   * an import, restarts at 1 under a fresh one. The result's `feedGeneration`
   * is that generation, absent while the Collection has handed out no
   * position. The request layer puts it in the checkpoint and refuses a
   * checkpoint that carries another, so a reader holding one from before a
   * re-create restarts rather than skipping the new feed's first positions.
   *
   * Each document carries the content record's write stamp (`updatedAt`,
   * `updatedAtCounter`, `originId`), the `/meta` record's stamp and generation
   * as `meta` (when a metadata write has occurred), the server-managed
   * `createdBy` (the creator's DID, when one was recorded -- so provenance
   * replicates and does not have to be fetched per Resource from `/meta`),
   * and -- so metadata replicates alongside content -- the user-writable
   * `custom` object (the opaque encryption envelope on an encrypted
   * Collection). Out of band from those members, it also carries the content
   * record's `validator` and, once metadata has been written, the `/meta`
   * record's `metaValidator`. The request layer formats them as the wire
   * document's `etag` and `metaEtag`, the quoted strong validators a replica
   * can send back as `If-Match` without a GET per Resource. A tombstone keeps
   * its `createdBy`, as it keeps its `createdAt`. A metadata-only edit
   * re-surfaces the Resource at a new feed position, with a new `meta` stamp
   * but its content stamp and `data` unchanged. The stamps have no ordering
   * role in the feed, which is ordered by feed position. A tombstone
   * (soft-deleted Resource) is surfaced with `deleted: true` and no `data` so
   * the delete replicates until clients catch up. Binary (non-JSON) Resources
   * are excluded -- attachment replication is future work. Each document
   * carries its `feedPosition`. The result's `checkpoint` is the last returned
   * document's feed position (what a follow-up call passes as
   * `afterPosition`), or `null` when nothing changed since `afterPosition`.
   *
   * OPTIONAL: a backend that omits this method does not serve the change feed,
   * and the request layer returns `unsupported-operation` (501). The Space and
   * Collection are guaranteed to exist by the request layer.
   */
  changesSince?(options: {
    spaceId: string
    collectionId: string
    afterPosition?: number
    limit: number
  }): Promise<{
    documents: Array<
      {
        resourceId: string
        // The document's position in the Collection's changes feed.
        feedPosition: number
        // The content record's validator, which the request layer formats as
        // the wire `etag`. Absent when the record has none.
        validator?: EtagValidator
        // The `/meta` record's stamp and generation, present once metadata has
        // been written.
        meta?: ResourceMetaStamp
        // The `/meta` record's validator, which the request layer formats as
        // the wire `metaEtag`. Absent when no metadata has been written.
        metaValidator?: EtagValidator
        createdBy?: IDID
        deleted: boolean
        data?: unknown
        // Omitted when unset, never `null`: the handler projects this straight
        // onto the wire `ChangeDocument.custom`, which admits no null.
        custom?: ResourceMetadataCustom | Record<string, unknown>
        /**
         * The client-declared key epoch the Resource was encrypted under (the
         * `key-epochs` feature), when one was stamped. Rides the feed so a
         * replicating reader picks the right epoch key without a `/meta` fetch.
         */
        epoch?: string
        /**
         * The Resource's writer-attribution label (spec "Writer attribution"),
         * when one was stamped. Rides the feed so a replica recognizes its own
         * writes echoed back. A tombstone carries the label the deleting write
         * declared, if any.
         */
        writerId?: string
      } & WriteStamp
    >
    checkpoint: number | null
    // The feed counter's generation; absent until the first position.
    feedGeneration?: string
  }>

  /**
   * OPTIONAL blinded-index query (the `blinded-index` query profile; the
   * `blinded-index-query` feature token). Evaluates an EDV query -- `equals`
   * (OR across elements of an AND within each element's blinded `{name:
   * value}` pairs) or `has` (every named blinded attribute present) -- against
   * the HMAC-blinded `indexed` entries of the Collection's live JSON
   * documents, scoped to the `query.index` HMAC key id. Matching is opaque
   * string comparison; the backend performs no cryptography. With `count`,
   * resolves only the match total; otherwise a page of the matching stored
   * documents verbatim, in ascending `resourceId` order, paginated with the
   * standard opaque cursor (`cursor` present iff `hasMore`; a malformed one
   * rejects with `invalid-cursor` 400). Both first-party backends answer
   * through `lib/blindedIndex.ts` so semantics cannot drift.
   *
   * OPTIONAL: a backend that omits this method does not serve the profile,
   * and the request layer returns `unsupported-operation` (501). The Space and
   * Collection are guaranteed to exist by the request layer.
   */
  queryByBlindedIndex?(options: {
    spaceId: string
    collectionId: string
    query: BlindedIndexQuery
    count?: boolean
    limit?: number
    cursor?: string
  }): Promise<{ count: number } | BlindedIndexQueryPage>

  /**
   * OPTIONAL plaintext equality query (the `equality` query profile; the
   * `equality-query` feature token). Evaluates an equality query -- `equals`
   * (OR across elements of an AND within each element's `{name: value}` pairs)
   * or `has` (every named attribute present with an indexable value) -- over
   * the attributes the server extracts from the Collection's live Resources per
   * the `plaintext.indexes` declaration. `indexes` is the NORMALIZED
   * declaration array: the request layer resolves it from the control-plane
   * description (a data-plane backend does not hold the description) and
   * passes it in. Matching
   * is strict JSON equality (no coercion); a content-sourced attribute reads a
   * JSON Resource's stored content, a custom-sourced one reads the `custom`
   * metadata object (so blobs are queryable too). With `count`, resolves only
   * the match total; otherwise a page of matching documents (`{ id, data?,
   * custom? }`) in ascending `resourceId` order, paginated with the standard
   * opaque cursor (`cursor` present iff `hasMore`; a malformed one rejects with
   * `invalid-cursor` 400). Both first-party backends answer through
   * `lib/equalityIndex.ts` so semantics cannot drift.
   *
   * OPTIONAL: a backend that omits this method does not serve the profile, and
   * the request layer returns `unsupported-operation` (501). The Space and
   * Collection are guaranteed to exist by the request layer.
   */
  queryByEquality?(options: {
    spaceId: string
    collectionId: string
    query: EqualityQuery
    indexes: NormalizedIndexDeclaration[]
    count?: boolean
    limit?: number
    cursor?: string
  }): Promise<{ count: number } | EqualityQueryPage>

  /**
   * OPTIONAL declare-time uniqueness scan for the `equality` profile: given the
   * Collection's normalized `unique: true` declarations, scans its already-
   * stored live Resources for two DIFFERENT Resources that claim the same
   * `(name, value)`, resolving the first such `{ name, value }` or `undefined`
   * when none exists. The request layer runs it when a Collection update ADDS a
   * unique claim, rejecting a found violation with `id-conflict` (409) so a
   * unique claim is never acknowledged over already-conflicting data.
   *
   * OPTIONAL: paired with `queryByEquality` on backends carrying the
   * `equality-query` feature. The Space and Collection are guaranteed to exist
   * by the request layer.
   */
  findEqualityUniqueViolation?(options: {
    spaceId: string
    collectionId: string
    indexes: NormalizedIndexDeclaration[]
  }): Promise<{ name: string; value: EqualityValue } | undefined>

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
   * ZCap revocations, stored under their scope -- a keystore
   * (`data/keystores/<keystoreId>/revocations/`) or a Space
   * (`data/space-revocations/<spaceId>/`, kept out of the Space tree so a
   * revocation directory can never be mistaken for, or collide with, a
   * Collection). Unique on `(delegator, capability.id)` within the scope.
   * Neither protocol defines a revocation read or delete: records exist only
   * to be consulted by the chain-inspection hook, and lapse via
   * `meta.expires` (the capability is rejected on its own expiry from then
   * on). Deleting a Space deletes its revocations with it.
   *
   * Inserts a revocation record, create-only: rejects with the protocol's 409
   * duplicate (`DuplicateRevocationError`) when a record already exists at
   * `(meta.delegator, capability.id)`, atomically with the write. The scope
   * must exist. A Space scope is re-checked under the lock that Delete Space
   * takes, so an insert under a Space with no Metadata object rejects with
   * `SpaceNotFoundError` (404), and one racing a Delete Space is either
   * refused or removed by it. An insert under an absent keystore rejects with
   * `StorageError` (the request layer 404-masks unknown scopes long before
   * this).
   */
  insertRevocation(options: {
    scope: RevocationScope
    record: RevocationRecord
  }): Promise<void>
  /**
   * True when any of the given capabilities has a stored, unexpired
   * revocation under the scope. Records past their `meta.expires` GC
   * horizon count as not revoked (the capability itself has expired) and may
   * be pruned on the way through.
   */
  isRevoked(options: {
    scope: RevocationScope
    capabilities: CapabilitySummary[]
  }): Promise<boolean>
}

/**
 * Decision returned by an {@link AuthorizeProvisioning} callback for a
 * provisioning request (`POST /spaces/`, Create Space by Id at
 * `PUT /space/:spaceId/meta`, or `POST /kms/keystores`). Any other value is
 * refused as `deny`:
 * - `verify` -- proceed with normal zcap capability-invocation verification;
 * - `grant` -- the callback itself authorized the request (e.g. a valid
 *   onboarding token); skip zcap verification for this request;
 * - `deny` -- refuse provisioning (403).
 */
export type ProvisioningDecision = 'verify' | 'grant' | 'deny'

/**
 * Provisioning gate callback: decides whether a request to one of the open
 * provisioning endpoints (`POST /spaces/`, Create Space by Id at
 * `PUT /space/:spaceId/meta`, `POST /kms/keystores`) may proceed. A `PUT` to
 * the Metadata object of a Space that already exists is an update, and does
 * not reach the callback.
 * May instead throw a `ProblemError` subclass to return a custom status/body.
 * @param options {object}
 * @param options.request {import('fastify').FastifyRequest}   the provisioning request
 * @returns {ProvisioningDecision | Promise<ProvisioningDecision>}
 */
export type AuthorizeProvisioning = (options: {
  request: FastifyRequest
}) => ProvisioningDecision | Promise<ProvisioningDecision>

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Marks a POST route as a read (safe in the RFC 9110 sense), so the
     * `no-store` hook in `routes.ts` leaves its response cacheable.
     */
    safe?: boolean
  }
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
     * The at-rest key-record encryption registry (config `KMS_RECORD_KEK` /
     * `KMS_RECORD_KEKS` / `KMS_RECORD_CURRENT_KEK`): the KEK(s) available to
     * unwrap stored WebKMS key records plus the
     * `currentKekId` selecting the one that wraps NEW records. `undefined` (or
     * `currentKekId: null`) means encryption is disabled -- records are written
     * plaintext (the teaching default). Read at the KMS orchestration seam
     * (`KeyRequest`), never inside a backend (records stay opaque to storage).
     * Set by `fastify.decorate` in plugin.ts.
     */
    kmsRecordKek?: KmsRecordKekRegistry
    /**
     * The server's export-signing key, derived from the seed (config
     * `WAS_SERVER_KEY_SEED`) and advertised on `/service`; `undefined` means
     * the server has no signing key. Set by `fastify.decorate` in plugin.ts.
     */
    serverSigningKey?: ServerSigningKey
    /**
     * The optional provisioning gate for the open provisioning endpoints
     * (`POST /spaces/`, Create Space by Id, `POST /kms/keystores`).
     * `undefined` means allow (the teaching default -- anyone may provision by
     * proving control of the body's controller DID). Set by
     * `fastify.decorate` in plugin.ts, either from the `authorizeProvisioning`
     * option or the built-in onboarding-token check.
     */
    authorizeProvisioning?: AuthorizeProvisioning
    /**
     * Whether the service description's `instance` member carries the server
     * version (plugin option `discloseVersion`, config
     * `WAS_DISCLOSE_VERSION`). Read wherever a handler builds the description
     * outside the `/service` route -- today the Export Space handler, which
     * puts it in the archive. Set by `fastify.decorate` in plugin.ts.
     */
    discloseVersion: boolean
  }
  interface FastifyRequest {
    /**
     * Set by the provisioning gate when a request to a provisioning endpoint
     * was authorized by the configured provisioning policy (e.g. a valid
     * onboarding token) instead of a capability invocation. The group hook
     * chain wraps its auth and digest hooks in `unlessProvisioningAuthorized`,
     * which skips them when this is set, and the handler skips its
     * controller-consent check (the request carries a Bearer token, not an
     * HTTP Signature).
     */
    provisioningAuthorized?: boolean
    /**
     * Set by `consultProvisioningPolicy` once it has put this request to the
     * configured provisioning policy, so the policy is consulted at most once
     * per request.
     */
    provisioningPolicyConsulted?: boolean
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
    /**
     * For a signed multipart body: the `Digest` verdict over the whole body,
     * settled at end-of-stream (rejects with `InvalidDigestError` on a
     * mismatch). Set by `captureRawBody`, awaited by the multipart write path
     * after the parts are consumed and before anything is stored.
     */
    multipartDigest?: Promise<void>
  }
}
