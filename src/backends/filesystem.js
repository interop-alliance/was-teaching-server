import path from 'node:path'
import { mkdir, rm, stat as fsStat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import jsonfs from 'fs-json-store'
import { glob } from 'glob'
import { StorageError, ResourceNotFoundError } from '../errors.js'
import mime from 'mime-types'
import { isJson } from '../lib/isJson.js'

const { Store: MetadataJsonStore } = jsonfs

export function fileNameFor ({ resourceId, contentType }) {
  const encodedType = encodeURIComponent(contentType)
  const extension = mime.extension(contentType) || 'blob'
  return `r.${resourceId}.${encodedType}.${extension}`
}

async function openFileStream (filePath) {
  const resourceStream = fs.createReadStream(filePath)
  return new Promise((resolve, reject) => {
    resourceStream
      .on('error', error => {
        reject(new Error(`Error creating a read stream: ${error}`))
      })
      .on('open', () => {
        console.info(`GET -- Reading ${filePath}`)
        resolve(resourceStream)
      })
  })
}

export class FileSystemBackend {
  constructor ({ dataDir }) {
    this.spacesDir = path.join(dataDir, 'spaces')
  }

  _spaceDir (spaceId) {
    return path.join(this.spacesDir, spaceId)
  }

  _collectionDir ({ spaceId, collectionId }) {
    return path.join(this._spaceDir(spaceId), collectionId)
  }

  /**
   * @param spaceId {string}
   * @returns {Promise<*>} Created space storage directory.
   */
  async _ensureSpaceDir ({ spaceId }) {
    const spaceDir = this._spaceDir(spaceId)
    try {
      await mkdir(spaceDir)
    } catch (err) {
      if (err.code === 'EEXIST') {
        console.log(`Space "${spaceId}" already exists, overwriting.`)
      } else {
        throw new StorageError({ cause: err })
      }
    }
    return spaceDir
  }

  /**
   * @param spaceId {string}
   * @param collectionId {string}
   * @returns {Promise<*>} Created collection storage directory.
   */
  async _ensureCollectionDir ({ spaceId, collectionId }) {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    try {
      await mkdir(collectionDir)
    } catch (err) {
      if (err.code === 'EEXIST') {
        console.log(`Collection "${collectionId}" already exists, overwriting.`)
      } else {
        console.log('Error creating directory', err)
        throw err // http 500
      }
    }
    return collectionDir
  }

  async _findFile ({ collectionDir, resourceId }) {
    const [filePath] = await glob(path.join(collectionDir, `r.${resourceId}*`))
    return filePath
  }

  // Spaces

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.spaceDescription {object}
   * @returns {Promise<StoreEntity>}
   */
  async writeSpace ({ spaceId, spaceDescription }) {
    const spaceDir = await this._ensureSpaceDir({ spaceId })
    const filename = `.space.${spaceId}.json`
    const metaStore = new MetadataJsonStore({ file: path.join(spaceDir, filename) })
    return await metaStore.write(spaceDescription)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<object>} Returns the JSON Space description object
   */
  async getSpaceDescription ({ spaceId }) {
    const spaceDir = this._spaceDir(spaceId)
    const filename = `.space.${spaceId}.json`
    const metaStore = new MetadataJsonStore({ file: path.join(spaceDir, filename) })
    return await metaStore.read()
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<*>}
   */
  async deleteSpace ({ spaceId }) {
    return await rm(this._spaceDir(spaceId), { recursive: true })
  }

  // Collections

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDescription {object}
   * @returns {Promise<StoreEntity>}
   */
  async writeCollection ({ spaceId, collectionId, collectionDescription }) {
    const collectionDir = await this._ensureCollectionDir({ spaceId, collectionId })
    const filename = `.collection.${collectionId}.json`
    const metaStore = new MetadataJsonStore({ file: path.join(collectionDir, filename) })
    return await metaStore.write(collectionDescription)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   */
  async getCollectionDescription ({ spaceId, collectionId }) {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const filename = `.collection.${collectionId}.json`
    const metaStore = new MetadataJsonStore({ file: path.join(collectionDir, filename) })
    return await metaStore.read()
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<*>}
   */
  async deleteCollection ({ spaceId, collectionId }) {
    return await rm(this._collectionDir({ spaceId, collectionId }), { recursive: true })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   */
  async listCollectionItems ({ spaceId, collectionId }) {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    let keys
    try {
      // Array of filename keys (see fileNameFor() for details)
      keys = await glob(path.join(collectionDir, '*'))
    } catch (err) {
      console.error(err)
    }
    const rows = keys.map(fullFilepath => {
      const [, resourceId, encodedMimeType] =
        path.basename(fullFilepath, '.json').split('.')
      return {
        id: resourceId,
        url: `/space/${spaceId}/${collectionId}/${resourceId}`,
        contentType: decodeURIComponent(encodedMimeType)
      }
    })
    // Serialize using PouchDB/CouchDB results format
    // each entry in 'rows' looks like: { id, url, contentType }
    return {
      offset: 0,
      total_rows: keys.length,
      rows
    }
  }

  // Resources

  /**
   * Creates a non-JSON resource
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.request {object}
   * @returns {Promise<*>}
   */
  async writeResource ({ spaceId, collectionId, resourceId, request }) {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const requestContentType = request.headers['content-type']

    if (isJson({ contentType: requestContentType })) {
      const filename = fileNameFor({ resourceId, contentType: requestContentType })
      const resourceJsonStore = new MetadataJsonStore({ file: path.join(collectionDir, filename) })
      console.log('Creating JSON resource')
      return await resourceJsonStore.write(request.body)
    } else if (requestContentType.startsWith('multipart')) {
      const data = request.file()
      const dataContentType = data.mimetype
      const filename = fileNameFor({ resourceId, contentType: dataContentType })
      const filePath = path.join(collectionDir, filename)
      console.log('Writing multipart file, uploaded filename:', data.filename)
      await pipeline(data.file, fs.createWriteStream(filePath))
    } else {
      const filename = fileNameFor({ resourceId, contentType: requestContentType })
      const filePath = path.join(collectionDir, filename)
      console.log('Writing non-multipart blob')
      await pipeline(request.body, fs.createWriteStream(filePath))
    }
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.contentType] {string}
   */
  async getResource ({ spaceId, collectionId, resourceId, contentType }) {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    let filePath, storedResourceType

    if (contentType) {
      filePath = path.join(collectionDir, fileNameFor({ resourceId, contentType }))
      storedResourceType = contentType
    } else {
      filePath = await this._findFile({ collectionDir, resourceId })
      storedResourceType = mime.lookup(filePath)
    }

    if (!filePath) {
      throw new ResourceNotFoundError({ requestName: 'Get Resource' })
    }

    try {
      await fsStat(filePath)
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new ResourceNotFoundError({ requestName: 'Get Resource' })
      }
      throw err
    }

    return { resourceStream: await openFileStream(filePath), storedResourceType }
  }

  /**
   * Deletes a given resource from storage.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<*>}
   */
  async deleteResource ({ spaceId, collectionId, resourceId }) {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    // A given resourceId can have several different content type representations
    // All of them need to be deleted (we're not going to ask the user to
    //  specify which content type to delete)
    const filesForResource = await glob(path.join(collectionDir, `r.${resourceId}*`))
    return Promise.all(filesForResource.map(filename => rm(filename)))
  }
}
