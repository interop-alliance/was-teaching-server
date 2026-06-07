/**
 * Filesystem persistence backend: stores Spaces, Collections, and Resources as
 * directories and files under `data/spaces/`. The default (and currently only)
 * adapter implementing the StorageBackend contract documented in types.ts.
 */
import path from 'node:path'
import { mkdir, rm, stat as fsStat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import fs from 'node:fs'
import jsonfs from 'fs-json-store'
import { glob } from 'glob'
import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import {
  StorageError,
  ResourceNotFoundError,
  SpaceNotFoundError
} from '../errors.js'
import * as mime from 'mime-types'
import * as tar from 'tar-stream'
import YAML from 'yaml'
import {
  UBC_MANIFEST_URL,
  SPACE_URL,
  COLLECTION_URL,
  RESOURCE_URL,
  POLICY_URL
} from '../config.default.js'
import { extractTarEntries, buildImportPlan } from '../lib/importTar.js'
import type {
  SpaceDescription,
  CollectionDescription,
  CollectionSummary,
  CollectionListing,
  ResourceResult,
  ResourceInput,
  ImportStats,
  PolicyDocument,
  StorageBackend
} from '../types.js'

const { Store: MetadataJsonStore } = jsonfs

/**
 * Silent logger used when no logger is injected into the backend, so the backend
 * stays quiet by default (e.g. in `defaultBackend()` before `createApp` wires
 * `fastify.log` in, or in tests).
 */
const silentLogger: FastifyBaseLogger = pino({ level: 'silent' })

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
 * Parses an on-disk resource filename (`r.<resourceId>.<encodedContentType>.<ext>`)
 * back into its components. Returns the exact stored content-type (decoded from
 * the filename segment, more reliable than `mime.lookup` on the extension),
 * falling back to the spec default `application/octet-stream` if unparseable.
 * @param fileName {string}   the basename of the resource file
 * @returns {{ resourceId: string, contentType: string }}
 */
export function parseResourceFileName(fileName: string): {
  resourceId: string
  contentType: string
} {
  const [, resourceId, encodedType] = fileName.split('.')
  return {
    resourceId: resourceId!,
    contentType: encodedType
      ? decodeURIComponent(encodedType)
      : 'application/octet-stream'
  }
}

/**
 * Opens a read stream for a file, resolving once the stream has opened (and
 * rejecting if it errors first).
 * @param filePath {string}
 * @param logger {FastifyBaseLogger}
 * @returns {Promise<import('node:fs').ReadStream>}
 */
async function openFileStream(
  filePath: string,
  logger: FastifyBaseLogger
): Promise<fs.ReadStream> {
  const resourceStream = fs.createReadStream(filePath)
  return new Promise((resolve, reject) => {
    resourceStream
      .on('error', error => {
        reject(new Error(`Error creating a read stream: ${error}`))
      })
      .on('open', () => {
        logger.info(`GET -- Reading ${filePath}`)
        resolve(resourceStream)
      })
  })
}

export class FileSystemBackend implements StorageBackend {
  spacesDir: string
  logger: FastifyBaseLogger

  constructor({
    dataDir,
    logger
  }: {
    dataDir: string
    logger?: FastifyBaseLogger
  }) {
    this.spacesDir = path.join(dataDir, 'spaces')
    this.logger = logger ?? silentLogger
  }

  /**
   * Defense in depth: asserts that a built path stays within the storage root,
   * so a malformed id that somehow slips past request-layer validation can
   * never escape `spacesDir` (path traversal). The request and tar-import
   * layers reject such ids first; this is the last line of defense.
   * @param targetPath {string}
   * @returns {void}
   */
  _assertContained(targetPath: string): void {
    const root = path.resolve(this.spacesDir)
    const resolved = path.resolve(targetPath)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new StorageError({
        cause: new Error(
          `Resolved path "${resolved}" escapes the storage root.`
        )
      })
    }
  }

  _spaceDir(spaceId: string): string {
    const spaceDir = path.join(this.spacesDir, spaceId)
    this._assertContained(spaceDir)
    return spaceDir
  }

  _collectionDir({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    const collectionDir = path.join(this._spaceDir(spaceId), collectionId)
    this._assertContained(collectionDir)
    return collectionDir
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<string>} Created space storage directory path.
   */
  async _ensureSpaceDir({ spaceId }: { spaceId: string }): Promise<string> {
    const spaceDir = this._spaceDir(spaceId)
    // Ensure the parent spaces/ directory exists (the dataDir may be brand new,
    // e.g. a per-suite temp dir); the space dir itself is created non-recursively
    // below so its EEXIST case can be detected.
    await mkdir(this.spacesDir, { recursive: true })
    try {
      await mkdir(spaceDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        this.logger.info(`Space "${spaceId}" already exists, overwriting.`)
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
        this.logger.info(
          `Collection "${collectionId}" already exists, overwriting.`
        )
      } else {
        this.logger.error({ err }, 'Error creating directory')
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
    // The trailing `.` anchors to the filename's segment boundary
    // (`r.<resourceId>.<encodedType>.<ext>`) so a resourceId that is a prefix of
    // another (e.g. `note` vs `notebook`) does not match the longer one.
    const [filePath] = await glob(path.join(collectionDir, `r.${resourceId}.*`))
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
        } else if (file.name.startsWith('.policy.')) {
          collectionContents.push({ [file.name]: { url: POLICY_URL } })
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
    const { spacePolicy, collections } = buildImportPlan(entries)
    const stats: ImportStats = {
      collectionsCreated: 0,
      collectionsSkipped: 0,
      resourcesCreated: 0,
      resourcesSkipped: 0,
      policiesCreated: 0,
      policiesSkipped: 0
    }

    // Space-level policy: restore it when the destination has none (the import
    // target Space pre-exists, so this fills in a missing policy without
    // clobbering one the destination already carries).
    if (spacePolicy) {
      if (await this.getPolicy({ spaceId })) {
        stats.policiesSkipped++
      } else {
        await this.writePolicy({ spaceId, policy: spacePolicy })
        stats.policiesCreated++
      }
    }

    for (const {
      collectionId,
      collectionDescription,
      collectionPolicy,
      resources,
      resourcePolicies
    } of collections) {
      // check if collection already exists
      const collectionExisted = Boolean(
        await this.getCollectionDescription({ spaceId, collectionId })
      )
      if (collectionExisted) {
        stats.collectionsSkipped++
      } else {
        await this.writeCollection({
          spaceId,
          collectionId,
          collectionDescription
        })
        stats.collectionsCreated++
      }

      // A collection-level policy travels with a newly-created collection; for
      // an existing (skipped) collection, leave its access policy untouched.
      if (collectionPolicy) {
        if (collectionExisted) {
          stats.policiesSkipped++
        } else {
          await this.writePolicy({
            spaceId,
            collectionId,
            policy: collectionPolicy
          })
          stats.policiesCreated++
        }
      }

      const collectionDir = this._collectionDir({ spaceId, collectionId })

      for (const { fileName, resourceId, body } of resources) {
        if (await this._findFile({ collectionDir, resourceId })) {
          stats.resourcesSkipped++
          // A resource-level policy travels with a newly-created resource only.
          if (resourcePolicies.has(resourceId)) {
            stats.policiesSkipped++
          }
          continue
        }

        await fs.promises.writeFile(path.join(collectionDir, fileName), body)
        stats.resourcesCreated++

        const resourcePolicy = resourcePolicies.get(resourceId)
        if (resourcePolicy) {
          await this.writePolicy({
            spaceId,
            collectionId,
            resourceId,
            policy: resourcePolicy
          })
          stats.policiesCreated++
        }
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
      this.logger.error({ err })
    }
    const items = keys.map(fullFilepath => {
      const { resourceId, contentType } = parseResourceFileName(
        path.basename(fullFilepath)
      )
      return {
        id: resourceId,
        url: `/space/${spaceId}/${collectionId}/${resourceId}`,
        contentType
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
   * Writes a resource representation (JSON value or byte stream) to disk.
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
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const filename = fileNameFor({ resourceId, contentType: input.contentType })
    const filePath = path.join(collectionDir, filename)
    this._assertContained(filePath)

    if (input.kind === 'json') {
      const resourceJsonStore = new MetadataJsonStore({ file: filePath })
      this.logger.info('Creating JSON resource')
      await resourceJsonStore.write(input.data)
    } else {
      this.logger.info('Writing blob')
      await pipeline(input.stream, fs.createWriteStream(filePath))
    }

    // A Resource has a single current representation: remove any prior
    // representation stored under a different content-type (its filename
    // differs). Write-new-then-prune (not delete-then-write) so the resource is
    // never momentarily absent.
    const existing = await glob(path.join(collectionDir, `r.${resourceId}.*`))
    await Promise.all(
      existing
        .filter(name => path.resolve(name) !== path.resolve(filePath))
        .map(name => rm(name))
    )
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
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const filePath = await this._findFile({ collectionDir, resourceId })

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

    // Derive the stored content-type from the filename segment (the exact type
    // it was written under), not from `mime.lookup` on the extension.
    const { contentType: storedResourceType } = parseResourceFileName(
      path.basename(filePath)
    )

    return {
      resourceStream: await openFileStream(filePath, this.logger),
      storedResourceType
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
    // A Resource has a single current representation, so this normally matches
    // one file. The glob-all delete remains as defensive cleanup (idempotent,
    // and would sweep up any stray prior-representation file). The trailing `.`
    // anchors to the filename's segment boundary so a resourceId that is a
    // prefix of another (e.g. `note` vs `notebook`) is not swept up too.
    const filesForResource = await glob(
      path.join(collectionDir, `r.${resourceId}.*`)
    )
    await Promise.all(filesForResource.map(filename => rm(filename)))
  }

  // Policies

  /**
   * Builds the on-disk path for a policy document. Stored as a dot-file keyed by
   * the entity id, alongside the matching `.space.` / `.collection.` description:
   * Space policy in the space dir, Collection and Resource policy in the
   * collection dir (the keying id differs, so they never collide).
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {string}
   */
  _policyFile({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): string {
    const dir =
      collectionId !== undefined
        ? this._collectionDir({ spaceId, collectionId })
        : this._spaceDir(spaceId)
    const filename = `.policy.${resourceId ?? collectionId ?? spaceId}.json`
    const filePath = path.join(dir, filename)
    this._assertContained(filePath)
    return filePath
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {Promise<PolicyDocument|undefined>}
   *   Resolves falsy when no policy is set at that level (must not throw).
   */
  async getPolicy({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): Promise<PolicyDocument | undefined> {
    const metaStore = new MetadataJsonStore<PolicyDocument>({
      file: this._policyFile({ spaceId, collectionId, resourceId })
    })
    return await metaStore.read()
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.policy {PolicyDocument}
   * @returns {Promise<void>}
   */
  async writePolicy({
    spaceId,
    collectionId,
    resourceId,
    policy
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    policy: PolicyDocument
  }): Promise<void> {
    // Ensure the containing directory exists (Space or Collection dir).
    if (collectionId !== undefined) {
      await this._ensureCollectionDir({ spaceId, collectionId })
    } else {
      await this._ensureSpaceDir({ spaceId })
    }
    const metaStore = new MetadataJsonStore<PolicyDocument>({
      file: this._policyFile({ spaceId, collectionId, resourceId })
    })
    await metaStore.write(policy)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {Promise<void>}   idempotent (no error if absent)
   */
  async deletePolicy({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): Promise<void> {
    await rm(this._policyFile({ spaceId, collectionId, resourceId }), {
      force: true
    })
  }
}
