/**
 * Filesystem persistence backend: stores Spaces, Collections, and Resources as
 * directories and files under `data/spaces/`. One of two interchangeable
 * backends; implements the StorageBackend contract documented in types.ts
 * (same method shape as MemoryBackend).
 */
import path from 'node:path'
import { mkdir, rm, stat as fsStat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import fs from 'node:fs'
import jsonfs from 'fs-json-store'
import { glob } from 'glob'
import {
  StorageError,
  ResourceNotFoundError,
  SpaceNotFoundError
} from '../errors.js'
import * as mime from 'mime-types'
import { isJson } from '../lib/isJson.js'
import * as tar from 'tar-stream'
import YAML from 'yaml'
import type { FastifyRequest } from 'fastify'
import {
  UBC_MANIFEST_URL,
  SPACE_URL,
  COLLECTION_URL,
  RESOURCE_URL
} from '../config.default.js'
import { extractTarEntries, buildImportPlan } from '../lib/importTar.js'
import type {
  SpaceDescription,
  CollectionDescription,
  CollectionSummary,
  CollectionListing,
  ResourceResult,
  ImportStats,
  StorageBackend
} from '../types.js'

const { Store: MetadataJsonStore } = jsonfs

/**
 * Builds the on-disk filename for a resource representation:
 * `r.<resourceId>.<encodedContentType>.<ext>`.
 * @param options {object}
 * @param options.resourceId {string}
 * @param options.contentType {string}
 * @returns {string}
 */
export function fileNameFor({
  resourceId,
  contentType
}: {
  resourceId: string
  contentType: string
}): string {
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
async function openFileStream(filePath: string): Promise<fs.ReadStream> {
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

export class FileSystemBackend implements StorageBackend {
  spacesDir: string

  constructor({ dataDir }: { dataDir: string }) {
    this.spacesDir = path.join(dataDir, 'spaces')
  }

  _spaceDir(spaceId: string): string {
    return path.join(this.spacesDir, spaceId)
  }

  _collectionDir({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return path.join(this._spaceDir(spaceId), collectionId)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<string>} Created space storage directory path.
   */
  async _ensureSpaceDir({ spaceId }: { spaceId: string }): Promise<string> {
    const spaceDir = this._spaceDir(spaceId)
    try {
      await mkdir(spaceDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        console.log(`Space "${spaceId}" already exists, overwriting.`)
      } else {
        throw new StorageError({ cause: err as Error })
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
  async _ensureCollectionDir({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<string> {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    try {
      await mkdir(collectionDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
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
  async _findFile({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): Promise<string | undefined> {
    const [filePath] = await glob(path.join(collectionDir, `r.${resourceId}*`))
    return filePath
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
    const spaceDir = await this._ensureSpaceDir({ spaceId })
    const filename = `.space.${spaceId}.json`
    const metaStore = new MetadataJsonStore<SpaceDescription>({
      file: path.join(spaceDir, filename)
    })
    await metaStore.write(spaceDescription)
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
    const spaceDir = this._spaceDir(spaceId)
    const filename = `.space.${spaceId}.json`
    const metaStore = new MetadataJsonStore<SpaceDescription>({
      file: path.join(spaceDir, filename)
    })
    return await metaStore.read()
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async deleteSpace({ spaceId }: { spaceId: string }): Promise<void> {
    return await rm(this._spaceDir(spaceId), { recursive: true })
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
    const spaceDir = this._spaceDir(spaceId)
    const spaceEntries = await fs.promises.readdir(spaceDir, {
      withFileTypes: true
    })
    const collectionEntries = spaceEntries
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    const collections: CollectionSummary[] = []
    for (const entry of collectionEntries) {
      const collectionDescription = await this.getCollectionDescription({
        spaceId,
        collectionId: entry.name
      })
      collections.push({
        id: entry.name,
        url: `/space/${spaceId}/${entry.name}`,
        name: collectionDescription!.name
      })
    }

    return collections
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<Readable>} tar-stream pack
   */
  async exportSpace({ spaceId }: { spaceId: string }): Promise<Readable> {
    const spaceDescription = await this.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Export Space' })
    }

    const sourceSpaceDir = this._spaceDir(spaceId)
    const spaceEntries = await fs.promises.readdir(sourceSpaceDir, {
      withFileTypes: true
    })
    spaceEntries.sort((a, b) => a.name.localeCompare(b.name))

    const collectionEntriesByDir: Record<string, typeof spaceEntries> = {}
    for (const entry of spaceEntries) {
      if (!entry.isDirectory()) {
        continue
      }
      const entries = await fs.promises.readdir(
        path.join(sourceSpaceDir, entry.name),
        { withFileTypes: true }
      )
      collectionEntriesByDir[entry.name] = entries
        .filter(e => e.isFile())
        .sort((a, b) => a.name.localeCompare(b.name))
    }

    const spaceContents: unknown[] = []
    for (const entry of spaceEntries) {
      if (!entry.isDirectory()) {
        // top-level files in space (e.g. .space.<spaceId>.json)
        spaceContents.push(entry.name)
        continue
      }

      const collectionContents: unknown[] = []
      for (const file of collectionEntriesByDir[entry.name] ?? []) {
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
        for (const file of collectionEntriesByDir[entry.name] ?? []) {
          const bytes = await fs.promises.readFile(
            path.join(sourceSpaceDir, entry.name, file.name)
          )
          pack.entry({ name: `${entryTarget}/${file.name}` }, bytes)
        }
      } else if (entry.isFile()) {
        const bytes = await fs.promises.readFile(
          path.join(sourceSpaceDir, entry.name)
        )
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
   * @param options.tarStream {Readable}
   * @returns {Promise<ImportStats>}
   */
  async importSpace({
    spaceId,
    tarStream
  }: {
    spaceId: string
    tarStream: Readable
  }): Promise<ImportStats> {
    const entries = await extractTarEntries(tarStream)
    const { collections } = buildImportPlan(entries)
    const stats: ImportStats = {
      collectionsCreated: 0,
      collectionsSkipped: 0,
      resourcesCreated: 0,
      resourcesSkipped: 0
    }

    for (const {
      collectionId,
      collectionDescription,
      resources
    } of collections) {
      // check if collection already exists
      if (await this.getCollectionDescription({ spaceId, collectionId })) {
        stats.collectionsSkipped++
      } else {
        await this.writeCollection({
          spaceId,
          collectionId,
          collectionDescription
        })
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
    const collectionDir = await this._ensureCollectionDir({
      spaceId,
      collectionId
    })
    const filename = `.collection.${collectionId}.json`
    const metaStore = new MetadataJsonStore<CollectionDescription>({
      file: path.join(collectionDir, filename)
    })
    await metaStore.write(collectionDescription)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<CollectionDescription|undefined>}
   *   Resolves falsy when the Collection does not exist (must not throw).
   */
  async getCollectionDescription({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionDescription | undefined> {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const filename = `.collection.${collectionId}.json`
    const metaStore = new MetadataJsonStore<CollectionDescription>({
      file: path.join(collectionDir, filename)
    })
    return await metaStore.read()
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
    return await rm(this._collectionDir({ spaceId, collectionId }), {
      recursive: true
    })
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
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const collectionDescription = await this.getCollectionDescription({
      spaceId,
      collectionId
    })
    let keys: string[] = []
    try {
      // Array of filename keys (see fileNameFor() for details)
      keys = await glob(path.join(collectionDir, '*'))
    } catch (err) {
      console.error(err)
    }
    const items = keys.map(fullFilepath => {
      const [, resourceId, encodedMimeType] = path
        .basename(fullFilepath, '.json')
        .split('.')
      return {
        id: resourceId!,
        url: `/space/${spaceId}/${collectionId}/${resourceId}`,
        contentType: decodeURIComponent(encodedMimeType!)
      }
    })
    return {
      id: collectionId,
      url: `/space/${spaceId}/${collectionId}`,
      name: collectionDescription!.name,
      type: collectionDescription!.type || ['Collection'],
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
  async writeResource({
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
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const requestContentType = request.headers['content-type']

    if (isJson({ contentType: requestContentType })) {
      const filename = fileNameFor({
        resourceId,
        contentType: requestContentType!
      })
      const resourceJsonStore = new MetadataJsonStore({
        file: path.join(collectionDir, filename)
      })
      console.log('Creating JSON resource')
      await resourceJsonStore.write(request.body)
    } else if (requestContentType?.startsWith('multipart')) {
      const data = await request.file()
      const dataContentType = data!.mimetype
      const filename = fileNameFor({ resourceId, contentType: dataContentType })
      const filePath = path.join(collectionDir, filename)
      console.log('Writing multipart file, uploaded filename:', data!.filename)
      await pipeline(data!.file, fs.createWriteStream(filePath))
    } else {
      const filename = fileNameFor({
        resourceId,
        contentType: requestContentType!
      })
      const filePath = path.join(collectionDir, filename)
      console.log('Writing non-multipart blob')
      await pipeline(request.body as Readable, fs.createWriteStream(filePath))
    }
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
    resourceId,
    contentType
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    contentType?: string
  }): Promise<ResourceResult> {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    let filePath: string | undefined
    let storedResourceType: string | false

    if (contentType) {
      filePath = path.join(
        collectionDir,
        fileNameFor({ resourceId, contentType })
      )
      storedResourceType = contentType
    } else {
      filePath = await this._findFile({ collectionDir, resourceId })
      storedResourceType = filePath ? mime.lookup(filePath) : false
    }

    if (!filePath) {
      throw new ResourceNotFoundError({ requestName: 'Get Resource' })
    }

    try {
      await fsStat(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ResourceNotFoundError({ requestName: 'Get Resource' })
      }
      throw err
    }

    return {
      resourceStream: await openFileStream(filePath),
      storedResourceType: storedResourceType as string
    }
  }

  /**
   * Deletes a given resource from storage.
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
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    // A given resourceId can have several different content type representations
    // All of them need to be deleted (we're not going to ask the user to
    //  specify which content type to delete)
    const filesForResource = await glob(
      path.join(collectionDir, `r.${resourceId}*`)
    )
    await Promise.all(filesForResource.map(filename => rm(filename)))
  }
}
