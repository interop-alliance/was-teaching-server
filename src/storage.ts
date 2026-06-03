/**
 * Storage facade: module-level async functions that forward to the active
 * backend. Request handlers must go through here rather than importing a
 * backend directly. Backend is currently hardcoded to FileSystemBackend.
 *
 * The functions below are the canonical signatures of the StorageBackend
 * contract (see src/types.ts). Every backend (FileSystemBackend, MemoryBackend)
 * implements this same set of methods with these signatures and return shapes.
 * When adding a storage method, add it here, to the StorageBackend interface,
 * and to every backend.
 *
 * Contract invariants:
 * - The getters (`getSpaceDescription`, `getCollectionDescription`) MUST
 *   resolve to a falsy value when the target does not exist — callers test
 *   `if (!description)` and translate that into a 404. They MUST NOT throw for
 *   the not-found case.
 * - Write methods are upserts (create if absent, overwrite if present).
 * - Delete methods are idempotent and resolve when the target is gone.
 */
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { FastifyRequest } from 'fastify'
import { FileSystemBackend } from './backends/filesystem.js'
import type {
  SpaceDescription,
  CollectionDescription,
  CollectionSummary,
  CollectionListing,
  ResourceResult,
  ImportStats
} from './types.js'

const backend = new FileSystemBackend({
  dataDir: path.join(import.meta.dirname, '..', 'data')
})

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.spaceDescription {SpaceDescription}
 * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
 */
export async function writeSpace({
  spaceId,
  spaceDescription
}: {
  spaceId: string
  spaceDescription: SpaceDescription
}): Promise<void> {
  return backend.writeSpace({ spaceId, spaceDescription })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {Promise<SpaceDescription|undefined>} Resolves falsy if the Space
 *   does not exist (must not throw for not-found).
 */
export async function getSpaceDescription({
  spaceId
}: {
  spaceId: string
}): Promise<SpaceDescription | undefined> {
  return backend.getSpaceDescription({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {Promise<void>}
 */
export async function deleteSpace({
  spaceId
}: {
  spaceId: string
}): Promise<void> {
  return backend.deleteSpace({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {Promise<CollectionSummary[]>}
 */
export async function listCollections({
  spaceId
}: {
  spaceId: string
}): Promise<CollectionSummary[]> {
  return backend.listCollections({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.collectionDescription {CollectionDescription}
 * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
 */
export async function writeCollection({
  spaceId,
  collectionId,
  collectionDescription
}: {
  spaceId: string
  collectionId: string
  collectionDescription: CollectionDescription
}): Promise<void> {
  return backend.writeCollection({
    spaceId,
    collectionId,
    collectionDescription
  })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<CollectionDescription|undefined>} Resolves falsy if the
 *   Collection does not exist (must not throw for not-found).
 */
export async function getCollectionDescription({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): Promise<CollectionDescription | undefined> {
  return backend.getCollectionDescription({ spaceId, collectionId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<void>}
 */
export async function deleteCollection({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): Promise<void> {
  return backend.deleteCollection({ spaceId, collectionId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<CollectionListing>}
 */
export async function listCollectionItems({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): Promise<CollectionListing> {
  return backend.listCollectionItems({ spaceId, collectionId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.request {import('fastify').FastifyRequest}   the Fastify
 *   request (body / multipart file)
 * @returns {Promise<void>}
 */
export async function writeResource({
  spaceId,
  collectionId,
  resourceId,
  request
}: {
  spaceId: string
  collectionId: string
  resourceId: string
  request: FastifyRequest
}): Promise<void> {
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
export async function getResource({
  spaceId,
  collectionId,
  resourceId,
  contentType
}: {
  spaceId: string
  collectionId: string
  resourceId: string
  contentType?: string
}): Promise<ResourceResult> {
  return backend.getResource({ spaceId, collectionId, resourceId, contentType })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {Promise<void>}
 */
export async function deleteResource({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): Promise<void> {
  return backend.deleteResource({ spaceId, collectionId, resourceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {Promise<Readable>} a tar stream of the Space.
 */
export async function exportSpace({
  spaceId
}: {
  spaceId: string
}): Promise<Readable> {
  return backend.exportSpace({ spaceId })
}

/**
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.tarStream {import('node:stream').Readable}
 * @returns {Promise<ImportStats>}
 */
export async function importSpace({
  spaceId,
  tarStream
}: {
  spaceId: string
  tarStream: Readable
}): Promise<ImportStats> {
  return backend.importSpace({ spaceId, tarStream })
}
