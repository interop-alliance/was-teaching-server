/**
 * In-memory persistence backend: stores Spaces, Collections, and Resources in
 * nested Maps. One of two interchangeable backends; implements the
 * StorageBackend contract documented in types.ts (same method shape as
 * FileSystemBackend).
 *
 * Note: `exportSpace` / `importSpace` are not implemented here (the filesystem
 * backend is the one wired into storage.ts); they throw if called.
 */
import { Readable } from 'node:stream'
import { ResourceNotFoundError } from '../errors.js'
import type {
  SpaceDescription,
  CollectionDescription,
  CollectionSummary,
  CollectionListing,
  ResourceResult,
  ResourceInput,
  ImportStats,
  StorageBackend
} from '../types.js'

/** A single stored resource representation. */
interface MemoryResource {
  data: Buffer
  contentType: string
}

/** A Collection record: its description plus keyed resource representations. */
interface MemoryCollection {
  description: CollectionDescription
  resources: Map<string, MemoryResource>
}

/** A Space record: its description plus its Collections. */
interface MemorySpace {
  description: SpaceDescription
  collections: Map<string, MemoryCollection>
}

/**
 * Consumes a readable stream and concatenates it into a single Buffer.
 * @param stream {import('node:stream').Readable}
 * @returns {Promise<Buffer>}
 */
async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export class MemoryBackend implements StorageBackend {
  _spaces: Map<string, MemorySpace>

  constructor() {
    this._spaces = new Map()
  }

  /**
   * @param spaceId {string}
   * @returns {MemorySpace} the in-memory space record
   * @throws {Error} if the Space does not exist
   */
  space(spaceId: string): MemorySpace {
    const space = this._spaces.get(spaceId)
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`)
    }
    return space
  }

  /**
   * @param spaceId {string}
   * @param collectionId {string}
   * @returns {MemoryCollection} the in-memory collection record
   * @throws {Error} if the Space or Collection does not exist
   */
  collection(spaceId: string, collectionId: string): MemoryCollection {
    const collection = this.space(spaceId).collections.get(collectionId)
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`)
    }
    return collection
  }

  // Spaces

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.spaceDescription {SpaceDescription}
   * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
   */
  async writeSpace({
    spaceId,
    spaceDescription
  }: {
    spaceId: string
    spaceDescription: SpaceDescription
  }): Promise<void> {
    const existing = this._spaces.get(spaceId)
    if (existing) {
      existing.description = spaceDescription
    } else {
      this._spaces.set(spaceId, {
        description: spaceDescription,
        collections: new Map()
      })
    }
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<SpaceDescription|undefined>}
   *   Resolves falsy when the Space does not exist (must not throw).
   */
  async getSpaceDescription({
    spaceId
  }: {
    spaceId: string
  }): Promise<SpaceDescription | undefined> {
    // Contract: resolve falsy (not throw) when the Space does not exist.
    return this._spaces.get(spaceId)?.description
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async deleteSpace({ spaceId }: { spaceId: string }): Promise<void> {
    this._spaces.delete(spaceId)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<CollectionSummary[]>}
   */
  async listCollections({
    spaceId
  }: {
    spaceId: string
  }): Promise<CollectionSummary[]> {
    const space = this.space(spaceId)
    const items: CollectionSummary[] = []
    for (const [collectionId, collection] of space.collections) {
      items.push({
        id: collectionId,
        url: `/space/${spaceId}/${collectionId}`,
        name: collection.description.name
      })
    }
    return items
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<Readable>}
   */
  async exportSpace(_options: { spaceId: string }): Promise<Readable> {
    throw new Error('exportSpace is not implemented for MemoryBackend.')
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.tarStream {Readable}
   * @returns {Promise<ImportStats>}
   */
  async importSpace(_options: {
    spaceId: string
    tarStream: Readable
  }): Promise<ImportStats> {
    throw new Error('importSpace is not implemented for MemoryBackend.')
  }

  // Collections

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDescription {CollectionDescription}
   * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
   */
  async writeCollection({
    spaceId,
    collectionId,
    collectionDescription
  }: {
    spaceId: string
    collectionId: string
    collectionDescription: CollectionDescription
  }): Promise<void> {
    const space = this.space(spaceId)
    const existing = space.collections.get(collectionId)
    if (existing) {
      existing.description = collectionDescription
    } else {
      space.collections.set(collectionId, {
        description: collectionDescription,
        resources: new Map()
      })
    }
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<CollectionDescription|undefined>}
   *   Resolves falsy when the Space/Collection is absent (must not throw).
   */
  async getCollectionDescription({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionDescription | undefined> {
    // Contract: resolve falsy (not throw) when the Space/Collection is absent.
    return this._spaces.get(spaceId)?.collections.get(collectionId)?.description
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<void>}
   */
  async deleteCollection({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<void> {
    this.space(spaceId).collections.delete(collectionId)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<CollectionListing>}
   */
  async listCollectionItems({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionListing> {
    const collection = this.collection(spaceId, collectionId)
    const items = []
    for (const [resourceId, { contentType }] of collection.resources) {
      items.push({
        id: resourceId,
        url: `/space/${spaceId}/${collectionId}/${resourceId}`,
        contentType
      })
    }
    return {
      id: collectionId,
      url: `/space/${spaceId}/${collectionId}`,
      name: collection.description.name,
      type: collection.description.type || ['Collection'],
      totalItems: items.length,
      items
    }
  }

  // Resources

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.input {ResourceInput}
   * @returns {Promise<void>}
   */
  async writeResource({
    spaceId,
    collectionId,
    resourceId,
    input
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    input: ResourceInput
  }): Promise<void> {
    const collection = this.collection(spaceId, collectionId)
    const data =
      input.kind === 'json'
        ? Buffer.from(JSON.stringify(input.data))
        : await collectStream(input.stream)

    // A Resource has a single current representation: keying by `resourceId`
    // alone means this `Map.set` overwrites any prior representation in place,
    // including one stored under a different content-type.
    collection.resources.set(resourceId, {
      data,
      contentType: input.contentType
    })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.contentType] {string}
   * @returns {Promise<ResourceResult>}
   */
  async getResource({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    // `contentType` is advisory and ignored for lookup: a Resource has a single
    // current representation, resolved by `resourceId` alone.
    contentType?: string
  }): Promise<ResourceResult> {
    const collection = this.collection(spaceId, collectionId)
    const entry = collection.resources.get(resourceId)

    if (!entry) {
      throw new ResourceNotFoundError({ requestName: 'Get Resource' })
    }

    return {
      resourceStream: Readable.from(entry.data),
      storedResourceType: entry.contentType
    }
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<void>}
   */
  async deleteResource({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<void> {
    const collection = this.collection(spaceId, collectionId)
    collection.resources.delete(resourceId)
  }
}
