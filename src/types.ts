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
  name: string
  /** the `did:key` that owns (controls) the Space */
  controller: IDID
}

/**
 * A Collection Description object — the metadata stored for a Collection.
 */
export interface CollectionDescription {
  id: string
  /** e.g. `['Collection']` */
  type: string[]
  name: string
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
 *   file extracted from a multipart upload.
 *
 * In both cases `contentType` is the content-type the bytes are stored under.
 */
export type ResourceInput =
  | { kind: 'json'; contentType: string; data: unknown }
  | { kind: 'binary'; contentType: string; stream: Readable }

/** Return shape of `importSpace()`: a per-merge tally. */
export interface ImportStats {
  collectionsCreated: number
  collectionsSkipped: number
  resourcesCreated: number
  resourcesSkipped: number
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
 * The persistence contract shared by `FileSystemBackend` and `MemoryBackend`.
 * The active backend is injected into the Fastify instance via
 * `createApp({ backend })` and read in handlers as `request.server.storage`.
 *
 * Invariants:
 * - The getters resolve to a falsy value (not throw) when the target is absent;
 *   callers test `if (!description)` and translate that into a 404.
 * - Write methods are upserts (create if absent, overwrite if present); their
 *   resolved value is implementation-defined and ignored.
 * - Delete methods are idempotent and resolve once the target is gone.
 *
 * Note: `exportSpace` resolves a tar-stream `Pack` at runtime, typed here as the
 * `Readable` it extends (tar-stream ships no types; see Phase 5 audit).
 */
export interface StorageBackend {
  writeSpace(options: {
    spaceId: string
    spaceDescription: SpaceDescription
  }): Promise<void>
  getSpaceDescription(options: {
    spaceId: string
  }): Promise<SpaceDescription | undefined>
  deleteSpace(options: { spaceId: string }): Promise<void>
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
    contentType?: string
  }): Promise<ResourceResult>
  deleteResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<void>
}

declare module 'fastify' {
  interface FastifyInstance {
    serverUrl: string
    storage: StorageBackend
  }
  interface FastifyRequest {
    zcap: ParsedZcap
  }
}
