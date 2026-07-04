/**
 * Shared handler prelude: fetch a Collection Description or 404 (paralleling
 * spaceContext.ts / keystoreContext.ts). Nearly every Collection- and
 * Resource-level handler repeats the same shape after authorization -- load
 * the Collection Description for context, throw `CollectionNotFoundError`
 * when absent -- so it lives here.
 */
import { CollectionNotFoundError } from '../errors.js'
import type { CollectionDescription, StorageBackend } from '../types.js'

/**
 * Fetches a Collection Description or throws CollectionNotFoundError (404)
 * when absent.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<CollectionDescription>}
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
}): Promise<CollectionDescription> {
  const collectionDescription = await storage.getCollectionDescription({
    spaceId,
    collectionId
  })
  if (!collectionDescription) {
    throw new CollectionNotFoundError({ requestName })
  }
  return collectionDescription
}
