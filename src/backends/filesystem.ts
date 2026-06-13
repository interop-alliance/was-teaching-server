/**
 * Filesystem persistence backend: stores Spaces, Collections, and Resources as
 * directories and files under `data/spaces/`. The default (and currently only)
 * adapter implementing the StorageBackend contract documented in types.ts.
 */
import path from 'node:path'
import { mkdir, rm, stat as fsStat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Transform, type Readable } from 'node:stream'
import fs from 'node:fs'
import jsonfs from 'fs-json-store'
import { glob } from 'glob'
import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import {
  StorageError,
  ResourceNotFoundError,
  SpaceNotFoundError,
  QuotaExceededError,
  PayloadTooLargeError
} from '../errors.js'
import * as mime from 'mime-types'
import * as tar from 'tar-stream'
import YAML from 'yaml'
import {
  UBC_MANIFEST_URL,
  SPACE_URL,
  COLLECTION_URL,
  RESOURCE_URL,
  POLICY_URL,
  META_URL,
  QUOTA_NEAR_LIMIT_FRACTION
} from '../config.default.js'
import { extractTarEntries, buildImportPlan } from '../lib/importTar.js'
import { collectionPath, resourcePath } from '../lib/paths.js'
import type {
  SpaceDescription,
  CollectionDescription,
  CollectionSummary,
  CollectionListing,
  ResourceResult,
  ResourceMetadata,
  ResourceCustomMetadata,
  ResourceInput,
  ImportStats,
  PolicyDocument,
  BackendDescriptor,
  BackendUsage,
  BackendState,
  StorageLimit,
  CollectionUsage,
  StorageBackend
} from '../types.js'

const { Store: MetadataJsonStore } = jsonfs

const execFileAsync = promisify(execFile)

/**
 * Silent logger used when no logger is injected into the backend, so the backend
 * stays quiet by default (e.g. in `defaultBackend()` before `createApp` wires
 * `fastify.log` in, or in tests).
 */
const silentLogger: FastifyBaseLogger = pino({ level: 'silent' })

/**
 * The on-disk shape of a Resource's metadata sidecar (`.meta.<resourceId>.json`,
 * see `metaSidecarFileName`). Only the server-managed timestamps and the
 * user-writable `custom` object are persisted; `contentType` / `size` are always
 * derived from the stored representation, never duplicated here.
 */
interface MetaSidecar {
  createdAt: string
  updatedAt: string
  custom?: ResourceCustomMetadata
}

/**
 * Builds the on-disk filename for a Resource's metadata sidecar:
 * `.meta.<resourceId>.json`. A dot-file kept alongside the resource
 * representation in the Collection dir (the same convention as `.policy.` /
 * `.collection.`), holding the timestamps and user-writable `custom` object.
 * @param resourceId {string}
 * @returns {string}
 */
export function metaSidecarFileName(resourceId: string): string {
  return `.meta.${resourceId}.json`
}

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
  /**
   * Per-Space storage capacity, in bytes (spec "Quotas"). `undefined` means no
   * configured limit -- the backend reports an unlimited quota (state always
   * `ok`) and skips write-path enforcement. A finite value drives the
   * `near-limit` / `over-quota` state thresholds (see `reportUsage`) and is
   * enforced on the write path: `writeResource` and `importSpace` reject writes
   * that would push a Space over capacity with `QuotaExceededError` (507).
   */
  capacityBytes?: number
  /**
   * Largest single upload the backend accepts, in bytes (spec "Quotas", the
   * `maxUploadBytes` constraint). `undefined` means no per-upload cap. Distinct
   * from `capacityBytes` (the cumulative per-Space quota): a write larger than
   * this cap is rejected with `PayloadTooLargeError` (413) even when the Space
   * has ample headroom, while smaller writes still succeed. Advertised in quota
   * reports under `constraints.maxUploadBytes` and enforced on `writeResource`.
   */
  maxUploadBytes?: number

  constructor({
    dataDir,
    logger,
    capacityBytes,
    maxUploadBytes
  }: {
    dataDir: string
    logger?: FastifyBaseLogger
    capacityBytes?: number
    maxUploadBytes?: number
  }) {
    this.spacesDir = path.join(dataDir, 'spaces')
    this.logger = logger ?? silentLogger
    this.capacityBytes = capacityBytes
    this.maxUploadBytes = maxUploadBytes
  }

  /**
   * Self-description advertised at `GET /space/:spaceId/backends`. The
   * filesystem backend is the single server-configured default: it stores both
   * JSON documents and binary blobs on disk, so its data survives restarts.
   * @returns {BackendDescriptor}
   */
  describe(): BackendDescriptor {
    return {
      id: 'default',
      name: 'Server Filesystem',
      managedBy: 'server',
      storageMode: ['document', 'blob'],
      persistence: 'durable'
    }
  }

  /**
   * Measures disk usage under the Space dir with `du`, returning the grand total
   * and a per-Collection breakdown in one pass. `du -d 1 -B 1` (GNU coreutils)
   * reports each immediate subdirectory (one per Collection) plus the Space dir
   * itself (the total, which also covers top-level Space files such as the
   * `.space.` / `.policy.` documents), all in bytes. An absent Space dir (ENOENT
   * before the dir is provisioned) reports zero usage rather than throwing.
   * @param spaceDir {string}
   * @returns {Promise<{ total: number, byCollection: CollectionUsage[] }>}
   */
  async _diskUsage(
    spaceDir: string
  ): Promise<{ total: number; byCollection: CollectionUsage[] }> {
    let stdout: string
    try {
      ;({ stdout } = await execFileAsync('du', [
        '-d',
        '1',
        '-B',
        '1',
        spaceDir
      ]))
    } catch (err) {
      // `du` exits non-zero (with an ENOENT-style stderr) when the dir is
      // absent; treat that as zero usage. Anything else is a real failure.
      if (
        (err as NodeJS.ErrnoException).code === 'ENOENT' ||
        /No such file or directory/.test((err as Error).message)
      ) {
        return { total: 0, byCollection: [] }
      }
      throw new StorageError({ cause: err as Error })
    }

    const rootResolved = path.resolve(spaceDir)
    let total = 0
    const byCollection: CollectionUsage[] = []
    for (const line of stdout.split('\n')) {
      if (!line) {
        continue
      }
      const tab = line.indexOf('\t')
      const usageBytes = Number(line.slice(0, tab))
      const entryPath = line.slice(tab + 1)
      if (path.resolve(entryPath) === rootResolved) {
        // The summary line for the Space dir itself is the grand total.
        total = usageBytes
      } else {
        // Every immediate subdirectory is a Collection (see `listCollections`).
        byCollection.push({ id: path.basename(entryPath), usageBytes })
      }
    }
    byCollection.sort((a, b) => a.id.localeCompare(b.id))
    return { total, byCollection }
  }

  /**
   * Measures the bytes this Space consumes on disk for the Space Quota report
   * (spec "Quotas"). `usageBytes` is the `du` total under the Space dir
   * (Collection dirs plus top-level Space files); `usageByCollection` breaks the
   * per-Collection totals out (they sum to slightly less than `usageBytes`,
   * since the Space-level files belong to no Collection).
   *
   * The per-Collection breakdown is always included for now. The spec makes it
   * opt-in via `?include=collections`, but a query string in the request URL
   * currently breaks ZCap invocationTarget matching (the signed root capability
   * target would include the query), so the breakdown is returned unconditionally
   * pending an upstream fix; see the `quotas` handler.
   *
   * `state` / `restrictedActions` derive from usage vs `capacityBytes`: an
   * unlimited backend is always `ok`; a finite capacity yields `near-limit` at
   * `QUOTA_NEAR_LIMIT_FRACTION` of capacity and `over-quota` (with reads/deletes
   * still allowed, but `POST`/`PUT` restricted) at or above full.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<BackendUsage>}
   */
  async reportUsage({ spaceId }: { spaceId: string }): Promise<BackendUsage> {
    const spaceDir = this._spaceDir(spaceId)
    const measuredAt = new Date().toISOString()

    const { total: usageBytes, byCollection: usageByCollection } =
      await this._diskUsage(spaceDir)

    return {
      ...this._backendUsageFields({ usageBytes, spaceTotalBytes: usageBytes }),
      measuredAt,
      usageByCollection
    }
  }

  /**
   * Measures the bytes a single Collection consumes on disk for the
   * per-Collection Quota report (spec "Quotas", `GET /space/{id}/{cid}/quota`).
   * `usageBytes` is scoped to the Collection (its slice of the one-pass
   * `_diskUsage` breakdown; zero if the Collection dir is empty or absent),
   * while `state` / `limit` / `restrictedActions` describe the backend's overall
   * condition (derived from the Space total -- the quota is a per-backend limit,
   * not per-Collection). The per-Collection `usageByCollection` breakdown is
   * omitted (a single Collection is the whole report).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<BackendUsage>}
   */
  async reportCollectionUsage({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<BackendUsage> {
    const spaceDir = this._spaceDir(spaceId)
    const measuredAt = new Date().toISOString()

    const { total: spaceTotalBytes, byCollection } =
      await this._diskUsage(spaceDir)
    const usageBytes =
      byCollection.find(entry => entry.id === collectionId)?.usageBytes ?? 0

    return {
      ...this._backendUsageFields({ usageBytes, spaceTotalBytes }),
      measuredAt
    }
  }

  /**
   * Builds the backend-identity and condition fields shared by the Space and
   * per-Collection quota reports. `usageBytes` is what the report shows (the
   * Space total or a single Collection's slice); `spaceTotalBytes` drives the
   * `state` / `restrictedActions`, which are backend-wide (the quota is a
   * per-Space limit) and so always measured against the Space total. The
   * `constraints.maxUploadBytes` cap is advertised when configured.
   * @param options {object}
   * @param options.usageBytes {number}   the usage figure to report
   * @param options.spaceTotalBytes {number}   the Space total, for state
   * @returns {Omit<BackendUsage, 'measuredAt' | 'usageByCollection'>}
   */
  _backendUsageFields({
    usageBytes,
    spaceTotalBytes
  }: {
    usageBytes: number
    spaceTotalBytes: number
  }): Omit<BackendUsage, 'measuredAt' | 'usageByCollection'> {
    const limit: StorageLimit =
      this.capacityBytes === undefined
        ? { isUnlimited: true }
        : { capacityBytes: this.capacityBytes, isUnlimited: false }

    let state: BackendState = 'ok'
    let restrictedActions: string[] = []
    if (this.capacityBytes !== undefined) {
      if (spaceTotalBytes >= this.capacityBytes) {
        state = 'over-quota'
        // The backend is full: writes are restricted, reads/deletes still work.
        restrictedActions = ['POST', 'PUT']
      } else if (
        spaceTotalBytes >=
        this.capacityBytes * QUOTA_NEAR_LIMIT_FRACTION
      ) {
        state = 'near-limit'
      }
    }

    const { id, name, managedBy } = this.describe()
    return {
      id,
      name,
      managedBy,
      state,
      usageBytes,
      limit,
      ...(this.maxUploadBytes !== undefined && {
        constraints: { maxUploadBytes: this.maxUploadBytes }
      }),
      restrictedActions
    }
  }

  /**
   * Quota pre-flight for the write path (spec "Quotas"): measures the Space's
   * current on-disk usage and returns the remaining headroom in bytes against
   * `capacityBytes`. Throws `QuotaExceededError` (507) when the Space is already
   * at or over capacity, or when a known `incomingBytes` would not fit. Callers
   * pass the configured `capacityBytes` explicitly (an unlimited backend skips
   * enforcement entirely and never calls this).
   *
   * This is a soft limit under concurrency: two simultaneous writes can each pass
   * against the same usage snapshot and jointly overshoot. The per-write
   * streaming guard (`_quotaGuard`) still bounds each individual write.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.capacityBytes {number}   the configured per-Space limit
   * @param [options.incomingBytes] {number}   known size of the pending write
   * @returns {Promise<number>}   remaining headroom in bytes
   */
  async _assertSpaceHeadroom({
    spaceId,
    capacityBytes,
    incomingBytes = 0
  }: {
    spaceId: string
    capacityBytes: number
    incomingBytes?: number
  }): Promise<number> {
    const { total: usageBytes } = await this._diskUsage(this._spaceDir(spaceId))
    const headroom = capacityBytes - usageBytes
    if (headroom <= 0 || incomingBytes > headroom) {
      throw new QuotaExceededError({ spaceId, capacityBytes })
    }
    return headroom
  }

  /**
   * A pass-through `Transform` that counts the bytes flowing through it and
   * aborts the pipeline with `QuotaExceededError` (507) once the cumulative total
   * would exceed `headroomBytes`. Hard-caps a streamed blob write whose size is
   * not known up front (so the pre-flight check alone cannot catch it), e.g. a
   * multipart upload or a body without `Content-Length`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.capacityBytes {number}   the configured per-Space limit
   * @param options.headroomBytes {number}   max bytes this write may add
   * @returns {Transform}
   */
  _quotaGuard({
    spaceId,
    capacityBytes,
    headroomBytes
  }: {
    spaceId: string
    capacityBytes: number
    headroomBytes: number
  }): Transform {
    let written = 0
    return new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length
        if (written > headroomBytes) {
          callback(new QuotaExceededError({ spaceId, capacityBytes }))
          return
        }
        callback(null, chunk)
      }
    })
  }

  /**
   * A pass-through `Transform` that counts the bytes flowing through it and
   * aborts the pipeline with `PayloadTooLargeError` (413) once the cumulative
   * total exceeds `maxUploadBytes`. Caps a single streamed upload whose size is
   * not known up front (e.g. a multipart part or a body without
   * `Content-Length`), independently of the cumulative Space quota.
   * @param options {object}
   * @param options.maxUploadBytes {number}   the per-upload cap in bytes
   * @returns {Transform}
   */
  _uploadCapGuard({ maxUploadBytes }: { maxUploadBytes: number }): Transform {
    const backendId = this.describe().id
    let written = 0
    return new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length
        if (written > maxUploadBytes) {
          callback(new PayloadTooLargeError({ maxUploadBytes, backendId }))
          return
        }
        callback(null, chunk)
      }
    })
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
   * Enumerates every Space stored on this backend (each immediate subdirectory
   * of the spaces root), sorted by Space id. An absent spaces root (nothing
   * stored yet) resolves an empty list, not an error; a directory without a
   * readable description file (e.g. a partially deleted Space) is skipped.
   * @returns {Promise<SpaceDescription[]>}
   */
  async listSpaces(): Promise<SpaceDescription[]> {
    let rootEntries: fs.Dirent[]
    try {
      rootEntries = await fs.promises.readdir(this.spacesDir, {
        withFileTypes: true
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw new StorageError({ cause: err as Error })
    }
    const spaceEntries = rootEntries
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    const spaces: SpaceDescription[] = []
    for (const entry of spaceEntries) {
      const spaceDescription = await this.getSpaceDescription({
        spaceId: entry.name
      })
      if (spaceDescription) {
        spaces.push(spaceDescription)
      }
    }
    return spaces
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
        url: collectionPath({ spaceId, collectionId: entry.name }),
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
        } else if (file.name.startsWith('.meta.')) {
          collectionContents.push({ [file.name]: { url: META_URL } })
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

    // Quota pre-flight (spec "Quotas"): reject a bulk import that would not fit
    // in the Space's remaining headroom before writing anything. Sums every
    // staged resource body; duplicates the merge below skips are counted too, so
    // this is a conservative (early-rejecting) estimate.
    if (this.capacityBytes !== undefined) {
      let incomingBytes = 0
      for (const { resources } of collections) {
        for (const { body } of resources) {
          incomingBytes += body.length
        }
      }
      await this._assertSpaceHeadroom({
        spaceId,
        capacityBytes: this.capacityBytes,
        incomingBytes
      })
    }

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
      resourcePolicies,
      resourceMetadata
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

        // A metadata sidecar travels with a newly-created resource (preserving
        // its timestamps and user-writable `custom`); an absent one leaves
        // `getResourceMetadata` to fall back to the file's stat times.
        const metadataBytes = resourceMetadata.get(resourceId)
        if (metadataBytes) {
          await fs.promises.writeFile(
            this._metaSidecarPath({ collectionDir, resourceId }),
            metadataBytes
          )
        }

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
    const items = await Promise.all(
      keys.map(async fullFilepath => {
        const { resourceId, contentType } = parseResourceFileName(
          path.basename(fullFilepath)
        )
        // Surface the user-writable `custom.name` (spec: updating it updates the
        // name shown in Collection listings) from the Resource's sidecar.
        const sidecar = await this._readMetaSidecar({
          collectionDir,
          resourceId
        })
        const name = sidecar?.custom?.name
        return {
          id: resourceId,
          url: resourcePath({ spaceId, collectionId, resourceId }),
          contentType,
          ...(name !== undefined && { name })
        }
      })
    )
    return {
      id: collectionId,
      url: collectionPath({ spaceId, collectionId }),
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

    const { capacityBytes, maxUploadBytes } = this

    if (input.kind === 'json') {
      // JSON bodies are fully in memory, so their serialized size is known up
      // front and the pre-flight checks alone suffice (no streaming guard). The
      // per-upload cap (413) is checked before the cumulative quota (507).
      const incomingBytes = Buffer.byteLength(JSON.stringify(input.data))
      if (maxUploadBytes !== undefined && incomingBytes > maxUploadBytes) {
        throw new PayloadTooLargeError({
          maxUploadBytes,
          backendId: this.describe().id,
          uploadBytes: incomingBytes
        })
      }
      if (capacityBytes !== undefined) {
        await this._assertSpaceHeadroom({
          spaceId,
          capacityBytes,
          incomingBytes
        })
      }
      const resourceJsonStore = new MetadataJsonStore({ file: filePath })
      this.logger.info('Creating JSON resource')
      await resourceJsonStore.write(input.data)
    } else {
      this.logger.info('Writing blob')
      // Pre-flight the declared size (when present) against the per-upload cap,
      // then stream through guards that hard-cap a body whose size is omitted or
      // understated: the upload cap (413) and, when a quota is configured, the
      // Space headroom (507). On overflow either guard removes the partial file
      // before surfacing the error.
      if (
        maxUploadBytes !== undefined &&
        input.declaredBytes !== undefined &&
        input.declaredBytes > maxUploadBytes
      ) {
        throw new PayloadTooLargeError({
          maxUploadBytes,
          backendId: this.describe().id,
          uploadBytes: input.declaredBytes
        })
      }
      const guards: Transform[] = []
      if (maxUploadBytes !== undefined) {
        guards.push(this._uploadCapGuard({ maxUploadBytes }))
      }
      if (capacityBytes !== undefined) {
        const headroomBytes = await this._assertSpaceHeadroom({
          spaceId,
          capacityBytes,
          incomingBytes: input.declaredBytes ?? 0
        })
        guards.push(this._quotaGuard({ spaceId, capacityBytes, headroomBytes }))
      }
      try {
        await pipeline([
          input.stream,
          ...guards,
          fs.createWriteStream(filePath)
        ])
      } catch (err) {
        if (
          err instanceof QuotaExceededError ||
          err instanceof PayloadTooLargeError
        ) {
          await rm(filePath, { force: true })
        }
        throw err
      }
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

    // Maintain the server-managed timestamps: a content write sets `createdAt`
    // on first write and bumps `updatedAt`, preserving any user-writable
    // `custom` already stored in the sidecar.
    const now = new Date().toISOString()
    const prior = await this._readMetaSidecar({ collectionDir, resourceId })
    await this._writeMetaSidecar({
      collectionDir,
      resourceId,
      sidecar: {
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
        ...(prior?.custom && { custom: prior.custom })
      }
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
   * Builds the on-disk path for a Resource's metadata sidecar
   * (`.meta.<resourceId>.json`) in its Collection dir.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {string}
   */
  _metaSidecarPath({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): string {
    const filePath = path.join(collectionDir, metaSidecarFileName(resourceId))
    this._assertContained(filePath)
    return filePath
  }

  /**
   * Reads a Resource's metadata sidecar. Resolves `undefined` when none has been
   * written yet (e.g. a Resource created before sidecars existed).
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {Promise<MetaSidecar|undefined>}
   */
  async _readMetaSidecar({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): Promise<MetaSidecar | undefined> {
    const metaStore = new MetadataJsonStore<MetaSidecar>({
      file: this._metaSidecarPath({ collectionDir, resourceId })
    })
    return await metaStore.read()
  }

  /**
   * Writes a Resource's metadata sidecar (full replacement).
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param options.sidecar {MetaSidecar}
   * @returns {Promise<void>}
   */
  async _writeMetaSidecar({
    collectionDir,
    resourceId,
    sidecar
  }: {
    collectionDir: string
    resourceId: string
    sidecar: MetaSidecar
  }): Promise<void> {
    const metaStore = new MetadataJsonStore<MetaSidecar>({
      file: this._metaSidecarPath({ collectionDir, resourceId })
    })
    await metaStore.write(sidecar)
  }

  /**
   * Reads the metadata of a Resource's current representation: the REQUIRED
   * server-managed fields (`contentType`, `size`, both derived from the stored
   * file), plus the OPTIONAL `createdAt` / `updatedAt` timestamps and the
   * user-writable `custom` object read from the sidecar. For a Resource written
   * before sidecars existed, the timestamps fall back to the file's birth/modify
   * times and `custom` is omitted. Resolves `undefined` when the Resource is
   * absent (including a delete race on `stat`).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<ResourceMetadata|undefined>}
   */
  async getResourceMetadata({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<ResourceMetadata | undefined> {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const filePath = await this._findFile({ collectionDir, resourceId })
    if (!filePath) {
      return undefined
    }

    let stats
    try {
      stats = await fsStat(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined
      }
      throw err
    }

    // Derive the stored content-type from the filename segment (the exact type
    // it was written under), as `getResource` does.
    const { contentType } = parseResourceFileName(path.basename(filePath))

    const sidecar = await this._readMetaSidecar({ collectionDir, resourceId })
    const createdAt = sidecar?.createdAt ?? stats.birthtime.toISOString()
    const updatedAt = sidecar?.updatedAt ?? stats.mtime.toISOString()
    const hasCustom = sidecar?.custom && Object.keys(sidecar.custom).length > 0

    return {
      contentType,
      size: stats.size,
      createdAt,
      updatedAt,
      ...(hasCustom && { custom: sidecar!.custom })
    }
  }

  /**
   * Replaces the user-writable `custom` object of a Resource's metadata sidecar
   * (full replacement; `{}` clears it), bumping `updatedAt`. Does not create a
   * Resource: resolves `false` when the Resource is absent so the handler can
   * 404. The two REQUIRED server-managed fields are untouched (they are derived
   * from the stored representation, never written here).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.custom {ResourceCustomMetadata}
   * @returns {Promise<boolean>}   `false` when the Resource does not exist
   */
  async writeResourceMetadata({
    spaceId,
    collectionId,
    resourceId,
    custom
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    custom: ResourceCustomMetadata
  }): Promise<boolean> {
    const collectionDir = this._collectionDir({ spaceId, collectionId })
    const filePath = await this._findFile({ collectionDir, resourceId })
    if (!filePath) {
      return false
    }

    const now = new Date().toISOString()
    const prior = await this._readMetaSidecar({ collectionDir, resourceId })
    // Fall back to the file's birth time for `createdAt` if the Resource
    // predates sidecars (so a meta write does not lose its creation time).
    let createdAt = prior?.createdAt
    if (!createdAt) {
      try {
        createdAt = (await fsStat(filePath)).birthtime.toISOString()
      } catch {
        createdAt = now
      }
    }
    const hasCustom = Object.keys(custom).length > 0
    await this._writeMetaSidecar({
      collectionDir,
      resourceId,
      sidecar: {
        createdAt,
        updatedAt: now,
        ...(hasCustom && { custom })
      }
    })
    return true
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
    // The Metadata object is deleted together with the Resource (spec "Resource
    // Metadata Data Model"); sweep its sidecar too.
    await rm(this._metaSidecarPath({ collectionDir, resourceId }), {
      force: true
    })
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
