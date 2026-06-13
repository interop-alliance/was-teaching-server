/**
 * Shared domain types for the WAS server.
 *
 * Re-exports the relevant `@interop/data-integrity-core` types (DIDs, zCaps,
 * document-loader, verifier / key material) so the rest of the codebase imports
 * them from a single place, and defines the server-local domain shapes (Space /
 * Collection / Resource descriptions and summaries, the parsed-zcap request
 * shape, import stats) plus the `StorageBackend` contract.
 *
 * Also augments Fastify's types: `FastifyInstance.serverUrl` (set by
 * `fastify.decorate` in server.ts, read in handlers via `request.server`) and
 * `FastifyRequest.zcap` (set by the `parseAuthHeaders` hook).
 */
// Pull in @fastify/multipart's `FastifyRequest.file()` augmentation program-wide
// (the request layer calls `request.file()` without importing the plugin
// directly).
import type {} from '@fastify/multipart'
import type { FastifyBaseLogger } from 'fastify'
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

/**
 * A Space Description object — the metadata stored for a Space.
 */
export interface SpaceDescription {
  id: string
  /** e.g. `['Space']` */
  type: string[]
  /** optional human-readable name for the Space (see spec) */
  name?: string
  /** the `did:key` that owns (controls) the Space */
  controller: IDID
  /**
   * URL of the Space's linkset resource (RFC9264), where auxiliary resources
   * such as the access-control `policy` are discovered. Attached at response
   * time, not persisted.
   */
  linkset?: string
}

/**
 * A Collection Description object — the metadata stored for a Collection.
 */
export interface CollectionDescription {
  id: string
  /** e.g. `['Collection']` */
  type: string[]
  name: string
  /**
   * The storage backend selected for this Collection (spec "Collection Backend
   * Selected"). Identified by `id`, which MUST be one of the Space's
   * backends-available. Omitted by a client at create time, the server fills it
   * with the default `{ id: 'default' }`; persisted thereafter.
   */
  backend?: { id: string }
  /**
   * URL of the Collection's linkset resource (RFC9264); see
   * `SpaceDescription.linkset`. Attached at response time, not persisted.
   */
  linkset?: string
}

/**
 * An access-control policy document attached to a Space, Collection, or
 * Resource (the `policy` reserved resource at each level). A `type`-discriminated
 * open shape: v1 recognizes only `{ "type": "PublicCanRead" }` (see
 * `policy.ts`). Unrecognized `type` values grant nothing (fail-closed), so the
 * request falls through to the normal zcap-only authorization decision. Policies
 * are permissive-only: they can broaden access beyond what a capability grants,
 * never restrict a valid capability holder.
 */
export interface PolicyDocument {
  type: string
  [key: string]: unknown
}

/** One entry of a `listCollections()` result. */
export interface CollectionSummary {
  id: string
  /** relative URL, `/space/:spaceId/:collectionId` */
  url: string
  name: string
}

/** One entry of a `CollectionListing`'s items. */
export interface ResourceSummary {
  id: string
  /** relative URL of the Resource */
  url: string
  contentType: string
  /** human-readable name from the Resource's `custom.name`, when set */
  name?: string
}

/** Return shape of `listCollectionItems()`. */
export interface CollectionListing {
  id: string
  url: string
  name: string
  type: string[]
  totalItems: number
  items: ResourceSummary[]
}

/**
 * The user-writable portion of a Resource's Metadata object (spec "Resource
 * Metadata Data Model"), nested under `custom`. Set via Update Resource Metadata
 * (`PUT .../meta`); a full replacement, so any property omitted is cleared.
 */
export interface ResourceCustomMetadata {
  /**
   * Human-readable name for the Resource. The same `name` returned by List
   * Collection -- updating it here updates the name shown in listings.
   */
  name?: string
  /** Application-defined annotations; values SHOULD be strings. */
  tags?: Record<string, unknown>
}

/**
 * A Resource Metadata object (spec "Resource Metadata Data Model"), addressable
 * at the reserved `/meta` segment under a Resource. `contentType` and `size` are
 * the REQUIRED server-managed fields; `createdAt` / `updatedAt` are the OPTIONAL
 * server-managed timestamps, and `custom` holds the user-writable properties.
 */
export interface ResourceMetadata {
  /** MIME type of the stored representation */
  contentType: string
  /** length in bytes of the stored representation */
  size: number
  /** RFC3339 date-time the Resource was created */
  createdAt?: string
  /** RFC3339 date-time the Resource's content or custom metadata last changed */
  updatedAt?: string
  /** user-writable properties (omitted when none are set) */
  custom?: ResourceCustomMetadata
}

/**
 * A Backend description object (spec "Backend Data Model"), as returned in the
 * array at `GET /space/:spaceId/backends`. The spec only REQUIRES `id` and
 * defines defaults for the rest; this server always populates all five fields
 * so a client can pick a `backend` for a Collection knowingly.
 *
 * - `id` -- the registration id under the Space (`default` for the single
 *   server-configured backend this reference server ships with).
 * - `name` -- a human-readable label.
 * - `managedBy` -- who operates the backend: `server` (configured server-side)
 *   or `external` (a Bring Your Own Storage provider registered by the client).
 *   Spec default: `server`.
 * - `storageMode` -- which representations the backend can store: `document`
 *   (structured JSON) and/or `blob` (opaque binary). Spec default: both.
 * - `persistence` -- whether the storage engine keeps data on persistent media
 *   that survives a restart (`durable`) or only in memory (`volatile`). Spec
 *   default: `durable`.
 */
export interface BackendDescriptor {
  id: string
  name: string
  managedBy: 'server' | 'external'
  storageMode: Array<'document' | 'blob'>
  persistence: 'durable' | 'volatile'
}

/**
 * A backend's current condition in a quota report (spec "Quotas"). `ok`,
 * `near-limit`, and `over-quota` are derived from usage vs the configured limit;
 * `unreachable` is reserved for `external` backends whose provider cannot be
 * queried (the server-managed filesystem backend never reports it).
 */
export type BackendState = 'ok' | 'near-limit' | 'over-quota' | 'unreachable'

/**
 * The storage limit for a backend (spec "Quotas"). When `isUnlimited` is `true`,
 * `capacityBytes` MAY be omitted (the filesystem backend omits it unless a
 * capacity was configured).
 */
export interface StorageLimit {
  capacityBytes?: number
  isUnlimited: boolean
}

/** One Collection's consumption within a backend's `usageByCollection` array. */
export interface CollectionUsage {
  id: string
  usageBytes: number
}

/**
 * One backend's entry in a Space Quota report (spec "Quotas"). Combines the
 * backend's identifying properties (`id` / `name` / `managedBy`, from its
 * `describe()`) with the measured usage for the reporting Space.
 *
 * - `usageBytes` -- total bytes this Space consumes on this backend.
 * - `restrictedActions` -- uppercase HTTP verbs (the WAS Authorization action
 *   vocabulary) currently unavailable on the backend; e.g. a full backend
 *   reports `["POST", "PUT"]` while still permitting reads and deletes.
 * - `measuredAt` -- when the usage numbers were measured (distinct from the
 *   report's top-level `respondedAt`).
 * - `usageByCollection` -- per-Collection breakdown. The spec makes this opt-in
 *   via `?include=collections`, but this server returns it unconditionally for
 *   now (a query string breaks ZCap target matching); the field stays optional
 *   to leave room for the compact form once that is resolved.
 */
export interface BackendUsage {
  id: string
  name: string
  managedBy: 'server' | 'external'
  state: BackendState
  usageBytes: number
  limit: StorageLimit
  constraints?: { maxUploadBytes: number }
  restrictedActions: string[]
  measuredAt: string
  usageByCollection?: CollectionUsage[]
}

/**
 * The Space Quota report (spec "Quotas"), returned by
 * `GET /space/:spaceId/quotas`: a measurement timestamp plus one `BackendUsage`
 * entry per backend registered for the Space (this reference server ships a
 * single backend, so the array has one entry).
 */
export interface SpaceQuotaReport {
  respondedAt: string
  backends: BackendUsage[]
}

/** Return shape of `getResource()`. */
export interface ResourceResult {
  resourceStream: Readable
  /** resolved content-type of the stored bytes */
  storedResourceType: string
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

/** Return shape of `importSpace()`: a per-merge tally. */
export interface ImportStats {
  collectionsCreated: number
  collectionsSkipped: number
  resourcesCreated: number
  resourcesSkipped: number
  policiesCreated: number
  policiesSkipped: number
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
 * `Readable` it extends (tar-stream ships no types; see Phase 5 audit).
 */
export interface StorageBackend {
  /**
   * Optional logger the backend writes diagnostics through (Fastify's pino
   * logger, `FastifyBaseLogger`). `createApp` wires `fastify.log` here; backends
   * default to a silent pino logger until it is set.
   */
  logger?: FastifyBaseLogger

  /**
   * The backend's self-description, as advertised at
   * `GET /space/:spaceId/backends`. Synchronous: a backend knows its own
   * characteristics without any I/O.
   */
  describe(): BackendDescriptor

  /**
   * Measures the storage the given Space consumes on this backend, for the
   * Space Quota report (spec "Quotas"). Resolves a `BackendUsage` entry: the
   * backend's identity plus measured `usageBytes`, derived `state`, the
   * configured `limit`, and a per-Collection `usageByCollection` breakdown. The
   * Space is guaranteed to exist by the request layer before this is called; an
   * absent Space dir reports zero usage.
   */
  reportUsage(options: { spaceId: string }): Promise<BackendUsage>

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
  listCollectionItems(options: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionListing>

  writeResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    input: ResourceInput
  }): Promise<void>
  getResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    /** advisory hint only; single-representation backends ignore it for lookup */
    contentType?: string
  }): Promise<ResourceResult>
  deleteResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<void>
  getResourceMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<ResourceMetadata | undefined>
  /**
   * Replaces the user-writable `custom` object of a Resource's Metadata (full
   * replacement; pass `{}` to clear). Resolves `false` when the Resource does
   * not exist (this operation does not create one) so the handler can 404.
   */
  writeResourceMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    custom: ResourceCustomMetadata
  }): Promise<boolean>

  // Access-control policy documents. The level is selected by which ids are
  // present: Space (`spaceId`), Collection (`+ collectionId`), or Resource
  // (`+ collectionId + resourceId`). Getters resolve falsy when absent.
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
}

declare module 'fastify' {
  interface FastifyInstance {
    serverUrl: string
    storage: StorageBackend
  }
  interface FastifyRequest {
    // Set by the `parseAuthHeaders` hook when auth headers are present. Absent
    // for anonymous reads (the `requireAuthHeaders` hook lets safe methods
    // through without auth so a fallback policy can grant access).
    zcap?: ParsedZcap
    // The exact request body bytes, captured by the `captureRawBody` preParsing
    // hook for JSON/text bodies so `verifyBodyDigest` can recompute the `Digest`
    // header against what the client signed (re-serializing the parsed body is
    // not guaranteed byte-identical). Absent for streamed (multipart / tar)
    // bodies, which are left unbuffered.
    rawBody?: Buffer
  }
}
