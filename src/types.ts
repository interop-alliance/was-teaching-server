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
   */
  listCollectionItems(options: {
    spaceId: string
    collectionId: string
    limit?: number
    cursor?: string
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
  }): Promise<(ResourceMetadata & { version?: number }) | undefined>
  /**
   * Replaces the user-writable `custom` object of a Resource's Metadata (full
   * replacement; pass `{}` to clear). Resolves `false` when the Resource does
   * not exist (this operation does not create one) so the handler can 404.
   */
  writeResourceMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    custom: ResourceMetadataCustom
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
