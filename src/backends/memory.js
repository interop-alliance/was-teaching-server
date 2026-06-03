/**
 * In-memory persistence backend: stores Spaces, Collections, and Resources in
 * nested Maps. One of two interchangeable backends; implements the
 * StorageBackend contract documented in storage.js (same method shape as
 * FileSystemBackend).
 */
import { Readable } from 'node:stream'
import { ResourceNotFoundError } from '../errors.js'
import { isJson } from '../lib/isJson.js'

/**
 * Consumes a readable stream and concatenates it into a single Buffer.
 * @param stream {import('node:stream').Readable}
 * @returns {Promise<Buffer>}
 */
async function collectStream(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export class MemoryBackend {
  constructor() {
    // Map<spaceId, {
    //    description,
    //    collections: Map<collectionId,
    //      { description, resources: Map<key, { data, contentType }> }>
    // }>
    // resource key format: `${resourceId}::${contentType}`
    this._spaces = new Map()
  }

  /**
   * @param spaceId {string}
   * @returns {{ description: import('../storage.js').SpaceDescription,
   *   collections: Map<string, object> }} the in-memory space record
   * @throws {Error} if the Space does not exist
   */
  space(spaceId) {
    const space = this._spaces.get(spaceId)
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`)
    }
    return space
  }

  /**
   * @param spaceId {string}
   * @param collectionId {string}
   * @returns {{ description: import('../storage.js').CollectionDescription,
   *   resources: Map<string, { data: Buffer, contentType: string }> }} the
   *   in-memory collection record
   * @throws {Error} if the Space or Collection does not exist
   */
  collection(spaceId, collectionId) {
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
   * @param options.spaceDescription {import('../storage.js').SpaceDescription}
   * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
   */
  async writeSpace({spaceId, spaceDescription}) {
    if (this._spaces.has(spaceId)) {
      this._spaces.get(spaceId).description = spaceDescription
    } else {
      this._spaces.set(spaceId, {description: spaceDescription, collections: new Map()})
    }
    return spaceDescription
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<import('../storage.js').SpaceDescription|undefined>}
   *   Resolves falsy when the Space does not exist (must not throw).
   */
  async getSpaceDescription({spaceId}) {
    // Contract: resolve falsy (not throw) when the Space does not exist.
    return this._spaces.get(spaceId)?.description
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async deleteSpace({spaceId}) {
    this._spaces.delete(spaceId)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<import('../storage.js').CollectionSummary[]>}
   */
  async listCollections({spaceId}) {
    const space = this.space(spaceId)
    const items = []
    for (const [collectionId, collection] of space.collections) {
      items.push({
        id: collectionId,
        url: `/space/${spaceId}/${collectionId}`,
        name: collection.description.name
      })
    }
    return items
  }

  // Collections

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDescription {import('../storage.js').CollectionDescription}
   * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
   */
  async writeCollection({spaceId, collectionId, collectionDescription}) {
    const space = this.space(spaceId)
    if (space.collections.has(collectionId)) {
      space.collections.get(collectionId).description = collectionDescription
    } else {
      space.collections.set(collectionId, {description: collectionDescription, resources: new Map()})
    }
    return collectionDescription
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<import('../storage.js').CollectionDescription|undefined>}
   *   Resolves falsy when the Space/Collection is absent (must not throw).
   */
  async getCollectionDescription({spaceId, collectionId}) {
    // Contract: resolve falsy (not throw) when the Space/Collection is absent.
    return this._spaces.get(spaceId)?.collections.get(collectionId)?.description
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<void>}
   */
  async deleteCollection({spaceId, collectionId}) {
    this.space(spaceId).collections.delete(collectionId)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<import('../storage.js').CollectionListing>}
   */
  async listCollectionItems({spaceId, collectionId}) {
    const collection = this.collection(spaceId, collectionId)
    const items = []
    for (const [key, {contentType}] of collection.resources) {
      const resourceId = key.split('::')[0]
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
   * @param options.request {import('fastify').FastifyRequest}
   * @returns {Promise<void>}
   */
  async writeResource({spaceId, collectionId, resourceId, request}) {
    const collection = this.collection(spaceId, collectionId)
    const requestContentType = request.headers['content-type']
    let data, dataContentType

    if (isJson({contentType: requestContentType})) {
      data = Buffer.from(JSON.stringify(request.body))
      dataContentType = requestContentType
    } else if (requestContentType.startsWith('multipart')) {
      const file = request.file()
      dataContentType = file.mimetype
      data = await collectStream(file.file)
    } else {
      data = await collectStream(request.body)
      dataContentType = requestContentType
    }

    collection.resources.set(`${resourceId}::${dataContentType}`,
      {data, contentType: dataContentType})
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.contentType] {string}
   * @returns {Promise<import('../storage.js').ResourceResult>}
   */
  async getResource({spaceId, collectionId, resourceId, contentType}) {
    const collection = this.collection(spaceId, collectionId)
    let entry

    if (contentType) {
      entry = collection.resources.get(`${resourceId}::${contentType}`)
    } else {
      for (const [key, value] of collection.resources) {
        if (key.startsWith(`${resourceId}::`)) {
          entry = value
          break
        }
      }
    }

    if (!entry) {
      throw new ResourceNotFoundError({requestName: 'Get Resource'})
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
  async deleteResource({spaceId, collectionId, resourceId}) {
    const collection = this.collection(spaceId, collectionId)
    for (const key of collection.resources.keys()) {
      if (key.startsWith(`${resourceId}::`)) {
        collection.resources.delete(key)
      }
    }
  }
}
