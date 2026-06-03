/**
 * Filesystem persistence backend: stores Spaces, Collections, and Resources as
 * directories and files under `data/spaces/`. One of two interchangeable
 * backends; implements the StorageBackend contract documented in storage.js
 * (same method shape as MemoryBackend).
 */
import path from 'node:path'
import { mkdir, rm, stat as fsStat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import jsonfs from 'fs-json-store'
import { glob } from 'glob'
import { StorageError, ResourceNotFoundError, SpaceNotFoundError } from '../errors.js'
import mime from 'mime-types'
import { isJson } from '../lib/isJson.js'
import tar from 'tar-stream'
import YAML from 'yaml'
import {
  UBC_MANIFEST_URL,
  SPACE_URL,
  COLLECTION_URL,
  RESOURCE_URL
} from '../../config.default.js'
import {
  extractTarEntries,
  buildImportPlan
} from '../lib/importTar.js'

const { Store: MetadataJsonStore } = jsonfs

/**
 * Builds the on-disk filename for a resource representation:
 * `r.<resourceId>.<encodedContentType>.<ext>`.
 * @param options {object}
 * @param options.resourceId {string}
 * @param options.contentType {string}
 * @returns {string}
 */
export function fileNameFor ({ resourceId, contentType }) {
  const encodedType = encodeURIComponent(contentType)
  const extension = mime.extension(contentType) || 'blob'
  return `r.${resourceId}.${encodedType}.${extension}`
}

/**
 * Opens a read stream for a file, resolving once the stream has opened (and
 * rejecting if it errors first).
 * @param filePath {string}
 * @returns {Promise<import('node:fs').ReadStream>}
 */
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
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<string>} Created space storage directory path.
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
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<string>} Created collection storage directory path.
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

  /**
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {Promise<string|undefined>} First matching resource file path.
   */
  async _findFile ({ collectionDir, resourceId }) {
    const [filePath] = await glob(path.join(collectionDir, `r.${resourceId}*`))
    return filePath
  }

  // Spaces

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.spaceDescription {import('../storage.js').SpaceDescription}
   * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
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
   * @returns {Promise<import('../storage.js').SpaceDescription|undefined>}
   *   Resolves falsy when the Space does not exist (must not throw).
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
   * @returns {Promise<void>}
   */
  async deleteSpace ({ spaceId }) {
    return await rm(this._spaceDir(spaceId), { recursive: true })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<import('../storage.js').CollectionSummary[]>}
   */
  async listCollections ({ spaceId }) {
    const spaceDir = this._spaceDir(spaceId)
    const spaceEntries = await fs.promises.readdir(spaceDir, { withFileTypes: true })
    const collectionEntries = spaceEntries
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    const collections = []
    for (const entry of collectionEntries) {
      const collectionDescription = await this.getCollectionDescription({
        spaceId,
        collectionId: entry.name
      })
      collections.push({
        id: entry.name,
        url: `/space/${spaceId}/${entry.name}`,
        name: collectionDescription.name
      })
    }

    return collections
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<import('tar-stream').Pack>} tar-stream pack
   */
  async exportSpace ({ spaceId }) {
    const spaceDescription = await this.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Export Space' })
    }

    const sourceSpaceDir = this._spaceDir(spaceId)
    const spaceEntries = await fs.promises.readdir(sourceSpaceDir, { withFileTypes: true })
    spaceEntries.sort((a, b) => a.name.localeCompare(b.name))

    const collectionEntriesByDir = {}
    for (const entry of spaceEntries) {
      if (!entry.isDirectory()) continue
      const entries = await fs.promises.readdir(path.join(sourceSpaceDir, entry.name), { withFileTypes: true })
      collectionEntriesByDir[entry.name] = entries
        .filter(e => e.isFile())
        .sort((a, b) => a.name.localeCompare(b.name))
    }

    const spaceContents = []
    for (const entry of spaceEntries) {
      if (!entry.isDirectory()) {
        // top-level files in space (e.g. .space.<spaceId>.json)
        spaceContents.push(entry.name)
        continue
      }

      const collectionContents = []
      for (const file of collectionEntriesByDir[entry.name]) {
        if (file.name.startsWith('.collection.')) {
          collectionContents.push({ [file.name]: { url: COLLECTION_URL } })
        } else if (file.name.startsWith('r.')) {
          collectionContents.push({ [file.name]: { url: RESOURCE_URL } })
        } else {
          collectionContents.push(file.name)
        }
      }

      spaceContents.push({
        [entry.name]: {
          contents: collectionContents
        }
      })
    }

    const manifest = {
      'ubc-version': '0.1',
      contents: {
        'manifest.yml': { url: UBC_MANIFEST_URL },
        space: {
          url: SPACE_URL,
          contents: {
            [spaceId]: {
              url: SPACE_URL,
              contents: spaceContents
            }
          }
        }
      }
    }

    const pack = tar.pack()
    pack.entry({ name: 'manifest.yml' }, YAML.stringify(manifest))
    pack.entry({ name: 'space/', type: 'directory' })
    pack.entry({ name: `space/${spaceId}/`, type: 'directory' })

    for (const entry of spaceEntries) {
      const entryTarget = `space/${spaceId}/${entry.name}`

      if (entry.isDirectory()) {
        pack.entry({ name: `${entryTarget}/`, type: 'directory' })
        for (const file of collectionEntriesByDir[entry.name]) {
          const bytes = await fs.promises.readFile(path.join(sourceSpaceDir, entry.name, file.name))
          pack.entry({ name: `${entryTarget}/${file.name}` }, bytes)
        }
      } else if (entry.isFile()) {
        const bytes = await fs.promises.readFile(path.join(sourceSpaceDir, entry.name))
        pack.entry({ name: entryTarget }, bytes)
      }
    }

    pack.finalize()
    return pack
  }

  /**
   * Merges a WAS space-export tarball into an existing Space (collections and
   * resources that already exist are skipped, not overwritten).
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
  async importSpace ({ spaceId, tarStream }) {
    const entries = await extractTarEntries(tarStream)
    const { collections } = buildImportPlan(entries)
    const stats = {
      collectionsCreated: 0,
      collectionsSkipped: 0,
      resourcesCreated: 0,
      resourcesSkipped: 0
    }

    for (const { collectionId, collectionDescription, resources } of collections) {
      // check if collection already exists
      if (await this.getCollectionDescription({ spaceId, collectionId })) {
        stats.collectionsSkipped++
      } else {
        await this.writeCollection({ spaceId, collectionId, collectionDescription })
        stats.collectionsCreated++
      }

      const collectionDir = this._collectionDir({ spaceId, collectionId })

      for (const { fileName, resourceId, body } of resources) {
        if (await this._findFile({ collectionDir, resourceId })) {
          stats.resourcesSkipped++
          continue
        }

        await fs.promises.writeFile(path.join(collectionDir, fileName), body)
        stats.resourcesCreated++
      }
    }

    return stats
  }

  // Collections

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDescription {import('../storage.js').CollectionDescription}
   * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
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
   * @returns {Promise<import('../storage.js').CollectionDescription|undefined>}
   *   Resolves falsy when the Collection does not exist (must not throw).
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
   * @returns {Promise<void>}
   */
  async deleteCollection ({ spaceId, collectionId }) {
    return await rm(this._collectionDir({ spaceId, collectionId }), { recursive: true })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<import('../storage.js').CollectionListing>}
   */
  async listCollectionItems ({ spaceId, collectionId }) {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const collectionDescription = await this.getCollectionDescription({ spaceId, collectionId })
    let keys
    try {
      // Array of filename keys (see fileNameFor() for details)
      keys = await glob(path.join(collectionDir, '*'))
    } catch (err) {
      console.error(err)
    }
    const items = keys.map(fullFilepath => {
      const [, resourceId, encodedMimeType] =
        path.basename(fullFilepath, '.json').split('.')
      return {
        id: resourceId,
        url: `/space/${spaceId}/${collectionId}/${resourceId}`,
        contentType: decodeURIComponent(encodedMimeType)
      }
    })
    return {
      id: collectionId,
      url: `/space/${spaceId}/${collectionId}`,
      name: collectionDescription.name,
      type: collectionDescription.type || ['Collection'],
      totalItems: items.length,
      items
    }
  }

  // Resources

  /**
   * Creates a non-JSON resource
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.request {import('fastify').FastifyRequest}
   * @returns {Promise<void>}
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
   * @returns {Promise<import('../storage.js').ResourceResult>}
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
   * @returns {Promise<void>}
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
