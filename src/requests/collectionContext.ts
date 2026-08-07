/**
 * Shared handler prelude: fetch a Collection Description or 404 (paralleling
 * spaceContext.ts / keystoreContext.ts). Nearly every Collection- and
 * Resource-level handler repeats the same shape after authorization -- load
 * the Collection Description for context, throw `CollectionNotFoundError`
 * when absent, then resolve the Collection's data-plane backend -- so it lives
 * here, along with the Resource-Metadata read the Resource- and chunk-level
 * handlers share.
 */
import type { FastifyRequest } from 'fastify'
import { resolveBackend } from '../lib/backendRegistry.js'
import {
  CollectionNotFoundError,
  ResourceNotFoundError,
  rethrowOrWrapStorageError
} from '../errors.js'
import type {
  CollectionDescription,
  ResourceMetadata,
  StorageBackend
} from '../types.js'

/**
 * Fetches a Collection Description or throws CollectionNotFoundError (404)
 * when absent.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<CollectionDescription & { descriptionVersion?: number }>}
 */
export async function getCollectionOrThrow({
  storage,
  spaceId,
  collectionId,
  requestName
}: {
  storage: StorageBackend
  spaceId: string
  collectionId: string
  requestName: string
}): Promise<CollectionDescription & { descriptionVersion?: number }> {
  const collectionDescription = await storage.getCollectionDescription({
    spaceId,
    collectionId
  })
  if (!collectionDescription) {
    throw new CollectionNotFoundError({ requestName })
  }
  return collectionDescription
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
 *   { descriptionVersion?: number }, dataBackend: StorageBackend }>}
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
  collectionDescription: CollectionDescription & { descriptionVersion?: number }
  dataBackend: StorageBackend
}> {
  const collectionDescription = await getCollectionOrThrow({
    storage: request.server.storage,
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
 * @returns {Promise<ResourceMetadata & { version?: number,
 *   metaVersion?: number }>}
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
}): Promise<ResourceMetadata & { version?: number; metaVersion?: number }> {
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
