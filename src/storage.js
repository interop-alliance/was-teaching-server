import path from 'node:path'
import { FileSystemBackend } from './backends/filesystem.js'

const backend = new FileSystemBackend({
  dataDir: path.join(import.meta.dirname, '..', 'data')
})

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.spaceDescription {object}
 */
export async function writeSpace({ spaceId, spaceDescription }) {
  return backend.writeSpace({ spaceId, spaceDescription })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 */
export async function getSpaceDescription({ spaceId }) {
  return backend.getSpaceDescription({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 */
export async function deleteSpace({ spaceId }) {
  return backend.deleteSpace({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.collectionDescription {object}
 */
export async function writeCollection({ spaceId, collectionId, collectionDescription }) {
  return backend.writeCollection({ spaceId, collectionId, collectionDescription })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 */
export async function getCollectionDescription({ spaceId, collectionId }) {
  return backend.getCollectionDescription({ spaceId, collectionId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 */
export async function deleteCollection({ spaceId, collectionId }) {
  return backend.deleteCollection({ spaceId, collectionId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 */
export async function listCollectionItems({ spaceId, collectionId }) {
  return backend.listCollectionItems({ spaceId, collectionId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.request {object}
 */
export async function writeResource({ spaceId, collectionId, resourceId, request }) {
  return backend.writeResource({ spaceId, collectionId, resourceId, request })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param [options.contentType] {string}
 */
export async function getResource({ spaceId, collectionId, resourceId, contentType }) {
  return backend.getResource({ spaceId, collectionId, resourceId, contentType })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 */
export async function deleteResource({ spaceId, collectionId, resourceId }) {
  return backend.deleteResource({ spaceId, collectionId, resourceId })
}
