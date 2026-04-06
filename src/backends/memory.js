import { Readable } from 'node:stream'
import { ResourceNotFoundError } from '../errors.js'
import { isJson } from '../lib/isJson.js'

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

  space(spaceId) {
    const space = this._spaces.get(spaceId)
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`)
    }
    return space
  }

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
   * @param options.spaceDescription {object}
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
   */
  async getSpaceDescription({spaceId}) {
    return this.space(spaceId).description
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   */
  async deleteSpace({spaceId}) {
    this._spaces.delete(spaceId)
  }

  // Collections

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDescription {object}
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
   */
  async getCollectionDescription({spaceId, collectionId}) {
    return this.collection(spaceId, collectionId).description
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   */
  async deleteCollection({spaceId, collectionId}) {
    this.space(spaceId).collections.delete(collectionId)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   */
  async listCollectionItems({spaceId, collectionId}) {
    const collection = this.collection(spaceId, collectionId)
    const rows = []
    for (const [key, {contentType}] of collection.resources) {
      const resourceId = key.split('::')[0]
      rows.push({
        id: resourceId,
        url: `/space/${spaceId}/${collectionId}/${resourceId}`,
        contentType
      })
    }
    return {
      offset: 0,
      total_rows: rows.length,
      rows
    }
  }

  // Resources

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.request {object}
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
