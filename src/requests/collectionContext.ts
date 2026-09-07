/**
 * Shared handler prelude: fetch a Collection Description or 404 (paralleling
 * spaceContext.ts / keystoreContext.ts). Nearly every Collection- and
 * Resource-level handler repeats the same shape after authorization -- load
 * the Collection Description for context, throw `CollectionNotFoundError`
 * when absent, then resolve the Collection's data-plane backend -- so it lives
 * here, along with the Resource-Metadata and chunk-metadata reads the
 * Resource- and chunk-level handlers share.
 */
import type { FastifyRequest } from 'fastify'
import { resolveBackend } from '../lib/backendRegistry.js'
import { deriveGovernedEncryption } from '../lib/governedLog.js'
import { collectionLogPath } from '../lib/paths.js'
import {
  CollectionNotFoundError,
  ResourceNotFoundError,
  rethrowOrWrapStorageError
} from '../errors.js'
import type {
  ChunkMetadata,
  ResourceMetadata,
  StorageBackend,
  StoredCollectionDescription,
  VersionedMetadata
} from '../types.js'

/**
 * Fetches a Collection Description as served, or throws
 * CollectionNotFoundError (404) when absent. For a Collection governed by a
 * history log (the `governed-history-logs` feature) the `encryption` member
 * is derived here from the log head, so every handler that reads the
 * description through this prelude -- describe, the envelope enforcement on
 * writes, the listing's name suppression -- sees the governed descriptor.
 * Update Collection reads the stored description directly instead, since it
 * must not persist the derived member.
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 *   and `serverUrl`
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<StoredCollectionDescription>}
 */
export async function getCollectionOrThrow({
  request,
  spaceId,
  collectionId,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  requestName: string
}): Promise<StoredCollectionDescription> {
  const { storage, serverUrl } = request.server
  const [collectionDescription, log] = await Promise.all([
    storage.getCollectionDescription({ spaceId, collectionId }),
    storage.getCollectionLog({ spaceId, collectionId })
  ])
  if (!collectionDescription) {
    throw new CollectionNotFoundError({ requestName })
  }
  if (!log) {
    return collectionDescription
  }
  return {
    ...collectionDescription,
    encryption: deriveGovernedEncryption({
      body: log.body,
      logUrl: `${serverUrl}${collectionLogPath({ spaceId, collectionId })}`
    })
  }
}

/**
 * The pair every Collection-scoped handler needs before it can touch Resource
 * bytes: the Collection Description (404 when absent) plus the Collection's
 * selected (data-plane) backend, resolved from it. Only for handlers that run
 * the two back to back -- a handler with a validation step BETWEEN them (whose
 * error must precede a backend-resolution error) keeps the calls separate.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<{ collectionDescription: CollectionDescription &
 *   StoredCollectionDescription, dataBackend: StorageBackend }>}
 */
export async function fetchCollectionAndBackend({
  request,
  spaceId,
  collectionId,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  requestName: string
}): Promise<{
  collectionDescription: StoredCollectionDescription
  dataBackend: StorageBackend
}> {
  const collectionDescription = await getCollectionOrThrow({
    request,
    spaceId,
    collectionId,
    requestName
  })
  const dataBackend = await resolveBackend({
    request,
    spaceId,
    collectionId,
    collectionDescription
  })
  return { collectionDescription, dataBackend }
}

/**
 * Reads a Resource's Metadata object from a data-plane backend, throwing
 * `ResourceNotFoundError` (404) when the Resource does not exist (or is a
 * tombstone). A typed `ProblemError` the backend raises is rethrown unchanged;
 * anything unexpected is wrapped as a 500.
 *
 * Serves both the Metadata-returning handlers (Head Resource, Get Resource
 * Metadata) and the chunk handlers' parent-Resource existence gate -- an orphan
 * chunk of an absent parent 404s exactly like the Resource route does.
 *
 * @param options {object}
 * @param options.dataBackend {StorageBackend}   the Collection's data-plane
 *   backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<ResourceMetadata & VersionedMetadata>}
 */
export async function getResourceMetadataOrThrow({
  dataBackend,
  spaceId,
  collectionId,
  resourceId,
  requestName
}: {
  dataBackend: StorageBackend
  spaceId: string
  collectionId: string
  resourceId: string
  requestName: string
}): Promise<ResourceMetadata & VersionedMetadata> {
  let metadata
  try {
    metadata = await dataBackend.getResourceMetadata({
      spaceId,
      collectionId,
      resourceId
    })
  } catch (err) {
    rethrowOrWrapStorageError({ err, requestName })
  }
  if (!metadata) {
    throw new ResourceNotFoundError({ requestName })
  }
  return metadata
}

/**
 * Reads a chunk's stored metadata (content-type, size, version) through the
 * parent-Resource existence gate, or throws `ResourceNotFoundError` (404) when
 * the parent or the chunk is absent. Shared by Head Chunk (its payload
 * headers) and by Get Chunk's conditional-read check, which needs the chunk's
 * version before deciding whether to open the byte stream.
 * @param options {object}
 * @param options.dataBackend {StorageBackend}   the Collection's data-plane
 *   backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}   the parent Resource
 * @param options.chunkIndex {number}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<ChunkMetadata>}
 */
export async function readChunkMetadataOrThrow({
  dataBackend,
  spaceId,
  collectionId,
  resourceId,
  chunkIndex,
  requestName
}: {
  dataBackend: StorageBackend
  spaceId: string
  collectionId: string
  resourceId: string
  chunkIndex: number
  requestName: string
}): Promise<ChunkMetadata> {
  let metadata
  try {
    metadata = await readGatedOnParentResource({
      dataBackend,
      spaceId,
      collectionId,
      resourceId,
      companion: dataBackend.getChunkMetadata({
        spaceId,
        collectionId,
        resourceId,
        chunkIndex
      }),
      requestName
    })
  } catch (err) {
    rethrowOrWrapStorageError({ err, requestName })
  }
  if (!metadata) {
    throw new ResourceNotFoundError({ requestName })
  }
  return metadata
}

/**
 * The chunk handlers' parent-Resource existence gate, run alongside an
 * independent companion read of the same backend (a chunk's bytes, its
 * metadata, or the chunk listing). The two reads are issued together and
 * settled, then the serial precedence applies: a rejected parent read wins
 * first, then the parent-absent 404 (`ResourceNotFoundError`), then a rejected
 * companion read; otherwise the companion's value is returned. Settling
 * (rather than `Promise.all`) keeps a companion rejection from masking the 404
 * and leaves no unhandled rejection when the gate short-circuits.
 *
 * A companion value that resolved while the gate fails is discarded, and the
 * gate hands it to `discard` first so the caller can release whatever it
 * holds: a chunk byte stream has already opened its file descriptor by the
 * time the filesystem backend resolves it, and left alone it would leak one
 * per probe of an orphan chunk.
 *
 * @param options {object}
 * @param options.dataBackend {StorageBackend}   the Collection's data-plane
 *   backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}   the parent Resource
 * @param options.companion {Promise<T>}   the independent read, already
 *   started
 * @param [options.discard] {(value: T) => void}   releases a companion value
 *   the gate discards
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<T>}
 */
export async function readGatedOnParentResource<T>({
  dataBackend,
  spaceId,
  collectionId,
  resourceId,
  companion,
  discard,
  requestName
}: {
  dataBackend: StorageBackend
  spaceId: string
  collectionId: string
  resourceId: string
  companion: Promise<T>
  discard?: (value: T) => void
  requestName: string
}): Promise<T> {
  const [parentResult, companionResult] = await Promise.allSettled([
    dataBackend.getResourceMetadata({ spaceId, collectionId, resourceId }),
    companion
  ])
  if (parentResult.status === 'rejected' || !parentResult.value) {
    if (companionResult.status === 'fulfilled') {
      discard?.(companionResult.value)
    }
    if (parentResult.status === 'rejected') {
      throw parentResult.reason
    }
    throw new ResourceNotFoundError({ requestName })
  }
  if (companionResult.status === 'rejected') {
    throw companionResult.reason
  }
  return companionResult.value
}
