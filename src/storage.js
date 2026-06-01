/**
 * Storage facade: module-level async functions that forward to the active
 * backend. Request handlers must go through here rather than importing a
 * backend directly. Backend is currently hardcoded to FileSystemBackend.
 *
 * The functions below are the canonical signatures of the StorageBackend
 * contract. Every backend (FileSystemBackend, MemoryBackend) implements this
 * same set of methods with these signatures and return shapes. When adding a
 * storage method, add it here and to every backend.
 *
 * Contract invariants:
 * - The getters (`getSpaceDescription`, `getCollectionDescription`) MUST
 *   resolve to a falsy value when the target does not exist — callers test
 *   `if (!description)` and translate that into a 404. They MUST NOT throw for
 *   the not-found case.
 * - Write methods are upserts (create if absent, overwrite if present).
 * - Delete methods are idempotent and resolve when the target is gone.
 */

/**
 * @typedef {object} SpaceDescription
 * @property {string} id
 * @property {string[]} type            e.g. ['Space']
 * @property {string} name
 * @property {string} controller        the did:key that owns the Space
 */

/**
 * @typedef {object} CollectionDescription
 * @property {string} id
 * @property {string[]} type            e.g. ['Collection']
 * @property {string} name
 */

/**
 * @typedef {object} CollectionSummary    one entry of a listCollections() result
 * @property {string} id
 * @property {string} url                 relative URL, /space/:spaceId/:collectionId
 * @property {string} name
 */

/**
 * @typedef {object} ResourceSummary       one entry of a CollectionListing's items
 * @property {string} id
 * @property {string} url                  relative URL of the Resource
 * @property {string} contentType
 */

/**
 * @typedef {object} CollectionListing      return shape of listCollectionItems()
 * @property {string} id
 * @property {string} url
 * @property {string} name
 * @property {string[]} type
 * @property {number} totalItems
 * @property {ResourceSummary[]} items
 */

/**
 * @typedef {object} ResourceResult         return shape of getResource()
 * @property {import('node:stream').Readable} resourceStream
 * @property {string} storedResourceType    resolved content-type of the bytes
 */
import path from 'node:path'
import { FileSystemBackend } from './backends/filesystem.js'

const backend = new FileSystemBackend({
  dataDir: path.join(import.meta.dirname, '..', 'data')
})

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.spaceDescription {SpaceDescription}
 * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
 */
export async function writeSpace({ spaceId, spaceDescription }) {
  return backend.writeSpace({ spaceId, spaceDescription })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {Promise<SpaceDescription|undefined>} Resolves falsy if the Space
 *   does not exist (must not throw for not-found).
 */
export async function getSpaceDescription({ spaceId }) {
  return backend.getSpaceDescription({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {Promise<void>}
 */
export async function deleteSpace({ spaceId }) {
  return backend.deleteSpace({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {Promise<CollectionSummary[]>}
 */
export async function listCollections({ spaceId }) {
  return backend.listCollections({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.collectionDescription {CollectionDescription}
 * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
 */
export async function writeCollection({ spaceId, collectionId, collectionDescription }) {
  return backend.writeCollection({ spaceId, collectionId, collectionDescription })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<CollectionDescription|undefined>} Resolves falsy if the
 *   Collection does not exist (must not throw for not-found).
 */
export async function getCollectionDescription({ spaceId, collectionId }) {
  return backend.getCollectionDescription({ spaceId, collectionId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<void>}
 */
export async function deleteCollection({ spaceId, collectionId }) {
  return backend.deleteCollection({ spaceId, collectionId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<CollectionListing>}
 */
export async function listCollectionItems({ spaceId, collectionId }) {
  return backend.listCollectionItems({ spaceId, collectionId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.request {object}   the Fastify request (body / multipart file)
 * @returns {Promise<void>}
 */
export async function writeResource({ spaceId, collectionId, resourceId, request }) {
  return backend.writeResource({ spaceId, collectionId, resourceId, request })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param [options.contentType] {string}   if omitted, the backend picks a
 *   stored representation for the resourceId
 * @returns {Promise<ResourceResult>}
 */
export async function getResource({ spaceId, collectionId, resourceId, contentType }) {
  return backend.getResource({ spaceId, collectionId, resourceId, contentType })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {Promise<void>}
 */
export async function deleteResource({ spaceId, collectionId, resourceId }) {
  return backend.deleteResource({ spaceId, collectionId, resourceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {Promise<import('tar-stream').Pack>} a tar stream of the Space.
 */
export async function exportSpace({ spaceId }) {
  return backend.exportSpace({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.tarStream {import('node:stream').Readable}
 * @returns {Promise<{
 *   collectionsCreated: number,
 *   collectionsSkipped: number,
 *   resourcesCreated: number,
 *   resourcesSkipped: number
 * }>}
 */
export async function importSpace({ spaceId, tarStream }) {
  return backend.importSpace({ spaceId, tarStream })
}
