/**
 * Filesystem persistence backend: stores Spaces, Collections, and Resources as
 * directories and files under `data/spaces/`, and WebKMS keystores under the
 * sibling `data/keystores/` tree. The default (and currently only) adapter
 * implementing the StorageBackend contract documented in types.ts.
 */
import path from 'node:path'
import { mkdir, rm, stat as fsStat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Transform, type Readable } from 'node:stream'
import fs from 'node:fs'
import jsonfs from 'fs-json-store'
import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import {
  StorageError,
  ResourceNotFoundError,
  SpaceNotFoundError,
  QuotaExceededError,
  CountQuotaExceededError,
  PayloadTooLargeError,
  KeystoreStateConflictError,
  KeyIdConflictError,
  DuplicateRevocationError
} from '../errors.js'
import * as tar from 'tar-stream'
import YAML from 'yaml'
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_SPACES_PER_CONTROLLER,
  DEFAULT_MAX_COLLECTIONS_PER_SPACE,
  DEFAULT_MAX_RESOURCES_PER_SPACE,
  QUOTA_USAGE_CACHE_TTL,
  normalizeCountLimit
} from '../config.default.js'
import {
  extractTarEntries,
  buildImportPlan,
  metaSidecarFileId
} from '../lib/importTar.js'
import { collectionPath, collectionsPath, resourcePath } from '../lib/paths.js'
import {
  encodeFilenameSegment,
  fileNameFor,
  parseResourceFileName,
  chunkDirName,
  CHUNK_DIR_PREFIX,
  isRepresentationFileName
} from '../lib/resourceFileName.js'
import { sanitizeBackendRecord } from '../lib/backends.js'
import { backendUsageFields } from '../lib/backendUsage.js'
import { assertEncryptedWriteConforms } from '../lib/encryption.js'
import { encodeCursor, decodeCursor } from '../lib/cursor.js'
import {
  buildExportManifest,
  EXPORT_ENTRY_MTIME
} from '../lib/exportManifest.js'
import { revocationFileName } from '../lib/revocations.js'
import { policyGrants } from '../policy.js'
import { KeyedMutex } from '../lib/keyedMutex.js'
import { isJson } from '../lib/isJson.js'
import { normalizeDescriptionWrite } from '../lib/collectionDescription.js'
import {
  atomicWriteFile,
  atomicCreateFile,
  tempPathFor,
  commitTempFile
} from '../lib/atomicFile.js'
import {
  DEFAULT_PAGE_SIZE,
  clampPageSize,
  compareCodeUnits
} from '../lib/pagination.js'
import {
  runBlindedIndexQuery,
  collectUniqueBlindedTerms,
  assertNoUniqueBlindedConflict
} from '../lib/blindedIndex.js'
import type {
  BlindedIndexQuery,
  BlindedIndexQueryPage
} from '../lib/blindedIndex.js'
import {
  runEqualityQuery,
  assertNoUniqueEqualityConflict,
  findEqualityUniqueViolation
} from '../lib/equalityIndex.js'
import type {
  EqualityQuery,
  EqualityQueryPage,
  EqualityCandidate,
  EqualityValue,
  NormalizedIndexDeclaration
} from '../lib/equalityIndex.js'
import {
  assertWritePrecondition,
  assertMetaWritePrecondition,
  assertCollectionWritePrecondition
} from '../lib/preconditions.js'
import type {
  SpaceDescription,
  CollectionDescription,
  CollectionSummary,
  CollectionsList,
  CollectionResourcesList,
  ResourceResult,
  ChunkMetadata,
  ChunkListing,
  ResourceMetadata,
  ResourceMetadataCustom,
  ResourceInput,
  ImportStats,
  PolicyDocument,
  BackendDescriptor,
  BackendUsage,
  CollectionUsage,
  StorageBackend,
  StoredBackendRecord,
  KeystoreConfig,
  KmsKeyRecord,
  RevocationRecord,
  RevocationScope,
  CapabilitySummary,
  IDID
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
 * see `metaSidecarFileName`). Only the server-managed timestamps, the monotonic
 * `version`, and the user-writable `custom` object are persisted; `contentType`
 * / `size` are always derived from the stored representation, never duplicated
 * here.
 *
 * `createdBy` is the DID of whoever created the Resource (spec "Resource
 * Metadata Data Model"): an OPTIONAL server-managed property, absent when no
 * creator was recorded.
 *
 * `version` is the per-Resource monotonic counter that backs the HTTP `ETag`
 * strong validator (see `formatEtag`): it starts at 1 on first content write and
 * increments on each subsequent content write. It is `undefined` only for a
 * Resource written before versioning existed (a legacy sidecar), in which case
 * the backend treats the current version as 0.
 *
 * `metaVersion` is the independent monotonic counter for the `/meta`
 * sub-resource (spec V2 metadata versioning): it starts at 1 on first metadata
 * write and increments on each subsequent one, backing the `/meta` ETag. It is
 * kept separate from `version` so a metadata-only edit does not bump the content
 * ETag (preserving the content-ETag contract), and is `undefined` until the
 * first metadata write. A content write preserves it unchanged.
 *
 * `deleted` marks a **tombstone**: a soft delete that drops the content
 * representation but keeps the sidecar so the change feed (replication) still
 * surfaces it. A
 * tombstone has no `r.<id>...` content file, so it is invisible to every normal
 * read path (which gates on the content file via `#findFile`); only the
 * (future) change feed reads it. `contentType` records the representation's
 * last-known content-type, which the content filename no longer carries once it
 * is gone -- present only on a tombstone (a live Resource derives its
 * content-type from the filename).
 */
interface MetaSidecar {
  createdAt: string
  updatedAt: string
  // DID of the Resource's creator, set from the invoker of the first content
  // write and thereafter preserved verbatim (as `createdAt` is), including
  // across a tombstone. Server-managed: never sourced from the request body,
  // and not reachable from the user-writable `custom`. Absent on a sidecar
  // written before `createdBy` was recorded, or by a caller with no invoker.
  createdBy?: IDID
  version?: number
  metaVersion?: number
  // On a plaintext Collection `custom` is `{ name, tags }`; on an encrypted
  // Collection it is the opaque encryption envelope (an arbitrary JSON object),
  // stored verbatim -- the server never decrypts it.
  custom?: ResourceMetadataCustom | Record<string, unknown>
  // The client-declared key epoch the current content was encrypted under (the
  // `key-epochs` feature). Stored opaquely: a content write sets it from the
  // `WAS-Key-Epoch` header (clearing it when absent -- the new ciphertext's
  // epoch is unknown), while a metadata write PRESERVES it unless the `/meta`
  // body supplies a new value. The server never computes or verifies it.
  epoch?: string
  deleted?: boolean
  contentType?: string
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
  /**
   * Root of the WebKMS keystore tree (`data/keystores/<localId>/`), a sibling
   * of `spacesDir` -- the `/kms` facet is deliberately separable from Spaces
   * (own route family, own storage tree).
   */
  keystoresDir: string
  /**
   * Root of the Space zcap revocation tree (`data/space-revocations/<spaceId>/`),
   * a sibling of `spacesDir` rather than a subdirectory of each Space. Space
   * revocations deliberately live OUTSIDE the Space's own directory because
   * `listCollections` and `#countLiveResources` treat every subdirectory of a
   * Space dir as a Collection -- a `revocations/` dir nested inside a Space would
   * surface as a phantom Collection (and could collide with a real one), so it
   * gets its own root.
   */
  spaceRevocationsDir: string
  logger: FastifyBaseLogger
  /**
   * Per-Space storage capacity, in bytes (spec "Quotas"). `undefined` means no
   * configured limit -- the backend reports an unlimited quota (state always
   * `ok`) and skips write-path enforcement. A finite value drives the
   * `near-limit` / `over-quota` state thresholds (see `reportUsage`) and is
   * enforced on the write path: `writeResource` and `importSpace` reject writes
   * that would push a Space over capacity with `QuotaExceededError` (507). The
   * constructor normalizes a non-finite ctor option (`Infinity`) to `undefined`.
   */
  capacityBytes?: number
  /**
   * Largest single upload the backend accepts, in bytes (spec "Quotas", the
   * `maxUploadBytes` constraint). `undefined` means no per-upload cap. Distinct
   * from `capacityBytes` (the cumulative per-Space quota): a write larger than
   * this cap is rejected with `PayloadTooLargeError` (413) even when the Space
   * has ample headroom, while smaller writes still succeed. Advertised in quota
   * reports under `constraints.maxUploadBytes` and enforced on `writeResource`.
   * The constructor normalizes an unset ctor option to
   * {@link DEFAULT_MAX_UPLOAD_BYTES} (a default-on cap) and a non-finite option
   * (`Infinity`) to `undefined` (explicitly no cap).
   */
  maxUploadBytes?: number
  /**
   * Max Spaces a single controller may create (spec "Quotas", a default-on
   * count quota). `undefined` means no cap. Enforced on the Space create path
   * (`writeSpace`): a new Space whose `controller` already owns this many
   * Spaces is rejected with `CountQuotaExceededError` (507); overwriting an
   * existing Space never trips it. The constructor normalizes an unset ctor
   * option to {@link DEFAULT_MAX_SPACES_PER_CONTROLLER} and a non-finite option
   * (`Infinity`) to `undefined` (explicitly no cap). Soft under concurrency,
   * like the byte quota.
   */
  maxSpacesPerController?: number
  /**
   * Max Collections a single Space may hold (spec "Quotas", a default-on count
   * quota). `undefined` means no cap. Enforced on the Collection create path
   * (`writeCollection`); overwriting an existing Collection description never
   * trips it. Normalized like {@link maxSpacesPerController}.
   */
  maxCollectionsPerSpace?: number
  /**
   * Max live Resources a single Space may hold across all its Collections (spec
   * "Quotas", a default-on count quota). `undefined` means no cap. Enforced on
   * the Resource create path (`writeResource`); a tombstone does not count, and
   * a write over an existing live Resource never trips it. Normalized like
   * {@link maxSpacesPerController}.
   */
  maxResourcesPerSpace?: number

  /**
   * Per-Resource write serialization (the `conditional-writes` feature). A
   * content write or delete that carries a precondition reads the current
   * `version`, evaluates `If-Match` / `If-None-Match`, and writes -- all under
   * this lock, keyed per Resource -- so two concurrent writers cannot both
   * observe the same prior version and both succeed. Single-instance only.
   */
  #writeMutex = new KeyedMutex()

  /**
   * Per-Space usage totals for the write-path quota pre-flight, so
   * `#assertSpaceHeadroom` does not spawn `du` (a whole-Space tree walk) on
   * every resource write. Entries live `QUOTA_USAGE_CACHE_TTL` ms; each
   * accepted write adds its incoming bytes to the cached total, and deletes
   * invalidate the Space's entry. Quota reports (`reportUsage`) always
   * re-measure. Single-instance only, like `#writeMutex`.
   */
  #usageCache = new Map<string, { usageBytes: number; expiresAt: number }>()

  constructor({
    dataDir,
    logger,
    capacityBytes,
    maxUploadBytes,
    maxSpacesPerController,
    maxCollectionsPerSpace,
    maxResourcesPerSpace
  }: {
    dataDir: string
    logger?: FastifyBaseLogger
    capacityBytes?: number
    maxUploadBytes?: number
    maxSpacesPerController?: number
    maxCollectionsPerSpace?: number
    maxResourcesPerSpace?: number
  }) {
    this.spacesDir = path.join(dataDir, 'spaces')
    this.keystoresDir = path.join(dataDir, 'keystores')
    // A sibling of spacesDir, NOT nested under each Space: a `revocations/` dir
    // inside a Space dir would be mistaken for a Collection (see the
    // `spaceRevocationsDir` property doc).
    this.spaceRevocationsDir = path.join(dataDir, 'space-revocations')
    this.logger = logger ?? silentLogger
    // A non-finite `capacityBytes` (`Infinity` from an explicit `unlimited`)
    // behaves exactly like unset inside the backend: no configured limit.
    this.capacityBytes =
      capacityBytes !== undefined && Number.isFinite(capacityBytes)
        ? capacityBytes
        : undefined
    // Normalize the per-upload cap so every downstream guard keeps its plain
    // `!== undefined` test: an unset option applies the default-on cap; a
    // non-finite option (`Infinity`) means explicitly no cap (the streaming
    // write path this backend uses makes an unbounded upload safe).
    this.maxUploadBytes =
      maxUploadBytes === undefined
        ? DEFAULT_MAX_UPLOAD_BYTES
        : Number.isFinite(maxUploadBytes)
          ? maxUploadBytes
          : undefined
    // Count quotas normalize like `maxUploadBytes`: an unset option applies the
    // default-on limit, a non-finite option (`Infinity`) means explicitly no
    // cap, so every guard keeps its plain `!== undefined` test.
    this.maxSpacesPerController = normalizeCountLimit(
      maxSpacesPerController,
      DEFAULT_MAX_SPACES_PER_CONTROLLER
    )
    this.maxCollectionsPerSpace = normalizeCountLimit(
      maxCollectionsPerSpace,
      DEFAULT_MAX_COLLECTIONS_PER_SPACE
    )
    this.maxResourcesPerSpace = normalizeCountLimit(
      maxResourcesPerSpace,
      DEFAULT_MAX_RESOURCES_PER_SPACE
    )
  }

  /**
   * Self-description advertised at `GET /space/:spaceId/backends`. The
   * filesystem backend is the single server-configured default: it stores both
   * JSON documents and binary blobs on disk, so its data survives restarts.
   *
   * It advertises the `conditional-writes` affordance: it exposes a per-Resource
   * `version` as an HTTP `ETag` validator and honors `If-Match` / `If-None-Match`
   * write preconditions atomically (returning `412 precondition-failed` on a
   * mismatch). It also advertises `chunked-streams`: chunk addressing for large
   * Resources (`/{resourceId}/chunks/{n}`), each chunk stored opaquely like a
   * binary Resource representation.
   * (Client-side encryption is deliberately not a backend feature: encrypted
   * documents are opaque client-encrypted JSON this backend already stores
   * faithfully, with no server cooperation.)
   * @returns {Required<Omit<BackendDescriptor, 'provider' | 'connection'>>}
   */
  describe(): Required<Omit<BackendDescriptor, 'provider' | 'connection'>> {
    // The wire type only REQUIRES `id`; this backend always populates every
    // field except the `external`-only `provider` / `connection` (the default
    // backend is server-managed), so its return is the stricter
    // `Required<Omit<..., 'provider' | 'connection'>>` (which also lets
    // `reportUsage` read a non-optional `managedBy` off `describe()`).
    return {
      id: 'default',
      name: 'Server Filesystem',
      managedBy: 'server',
      storageMode: ['document', 'blob'],
      persistence: 'durable',
      // `changes-query`: serves the `changes` profile of the reserved `query`
      // endpoint -- the replication change feed (`changesSince`).
      // `blinded-index-query`: serves the `blinded-index` profile -- EDV
      // blinded-attribute queries (`queryByBlindedIndex`).
      // `key-epochs`: multi-recipient encrypted Collections -- per-epoch wrapped
      // keys on the `encryption` marker, a client-declared `epoch` stamp on
      // Resources, and conditional (`If-Match`) Collection Description writes.
      // `chunked-streams`: chunk addressing (`/{resourceId}/chunks/{n}`) for a
      // large Resource, each chunk stored opaquely (bytes + content-type).
      // `equality-query`: serves the `equality` profile -- server-extracted
      // plaintext attribute equality over a Collection's declared `indexes`
      // (`queryByEquality`), plus the GET `filter[attr]=value` equality filter.
      features: [
        'conditional-writes',
        'changes-query',
        'blinded-index-query',
        'equality-query',
        'key-epochs',
        'chunked-streams'
      ]
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
  async #diskUsage(
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
   * The per-Collection `usageByCollection` breakdown is included only when
   * `includeCollections` is set -- the spec's `?include=collections` opt-in (see
   * the `quotas` handler, which now tolerates the query string via the
   * `allowTargetQuery` ZCap path). On the filesystem the breakdown is free (the
   * one `du -d 1` pass yields it alongside the total), but it is still omitted by
   * default to keep the hot-path payload lean and match the wire contract.
   *
   * `state` / `restrictedActions` derive from usage vs `capacityBytes`: an
   * unlimited backend is always `ok`; a finite capacity yields `near-limit` at
   * `QUOTA_NEAR_LIMIT_FRACTION` of capacity and `over-quota` (with reads/deletes
   * still allowed, but `POST`/`PUT` restricted) at or above full.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.includeCollections] {boolean}   include the per-Collection
   *   breakdown (spec `?include=collections`)
   * @returns {Promise<BackendUsage>}
   */
  async reportUsage({
    spaceId,
    includeCollections = false
  }: {
    spaceId: string
    includeCollections?: boolean
  }): Promise<BackendUsage> {
    const spaceDir = this.#spaceDir(spaceId)
    const measuredAt = new Date().toISOString()

    const { total: usageBytes, byCollection: usageByCollection } =
      await this.#diskUsage(spaceDir)

    return {
      ...this.#backendUsageFields({ usageBytes, spaceTotalBytes: usageBytes }),
      measuredAt,
      ...(includeCollections && { usageByCollection })
    }
  }

  /**
   * Measures the bytes a single Collection consumes on disk for the
   * per-Collection Quota report (spec "Quotas", `GET /space/{id}/{cid}/quota`).
   * `usageBytes` is scoped to the Collection (its slice of the one-pass
   * `#diskUsage` breakdown; zero if the Collection dir is empty or absent),
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
    const spaceDir = this.#spaceDir(spaceId)
    const measuredAt = new Date().toISOString()

    const { total: spaceTotalBytes, byCollection } =
      await this.#diskUsage(spaceDir)
    const usageBytes =
      byCollection.find(entry => entry.id === collectionId)?.usageBytes ?? 0

    return {
      ...this.#backendUsageFields({ usageBytes, spaceTotalBytes }),
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
  #backendUsageFields({
    usageBytes,
    spaceTotalBytes
  }: {
    usageBytes: number
    spaceTotalBytes: number
  }): Omit<BackendUsage, 'measuredAt' | 'usageByCollection'> {
    const { id, name, managedBy } = this.describe()
    return backendUsageFields({
      usageBytes,
      spaceTotalBytes,
      capacityBytes: this.capacityBytes,
      maxUploadBytes: this.maxUploadBytes,
      id,
      name,
      managedBy
    })
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
   * streaming guard (`#quotaGuard`) still bounds each individual write.
   *
   * The `du` measurement (a whole-Space tree walk) is cached per Space for
   * `QUOTA_USAGE_CACHE_TTL` ms (see `#usageCache`): between re-measurements
   * each accepted write's `incomingBytes` is added to the cached total, so a
   * burst of writes costs one tree walk, not one per write.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.capacityBytes {number}   the configured per-Space limit
   * @param [options.incomingBytes] {number}   known size of the pending write
   * @returns {Promise<number>}   remaining headroom in bytes
   */
  async #assertSpaceHeadroom({
    spaceId,
    capacityBytes,
    incomingBytes = 0
  }: {
    spaceId: string
    capacityBytes: number
    incomingBytes?: number
  }): Promise<number> {
    let cached = this.#usageCache.get(spaceId)
    if (!cached || cached.expiresAt <= Date.now()) {
      const { total } = await this.#diskUsage(this.#spaceDir(spaceId))
      cached = {
        usageBytes: total,
        expiresAt: Date.now() + QUOTA_USAGE_CACHE_TTL
      }
      this.#usageCache.set(spaceId, cached)
    }
    const headroom = capacityBytes - cached.usageBytes
    if (headroom <= 0 || incomingBytes > headroom) {
      throw new QuotaExceededError({ spaceId, capacityBytes })
    }
    // Count the accepted write against the cached total so writes within the
    // TTL accumulate rather than each re-admitting against the same snapshot.
    cached.usageBytes += incomingBytes
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
  #quotaGuard({
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
  #uploadCapGuard({ maxUploadBytes }: { maxUploadBytes: number }): Transform {
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
   * Defense in depth: asserts that a built path stays within the given storage
   * root (`spacesDir` by default; `keystoresDir` for the keystore tree), so a
   * malformed id that somehow slips past request-layer validation can never
   * escape it (path traversal). The request and tar-import layers reject such
   * ids first; this is the last line of defense.
   * @param targetPath {string}
   * @param [rootDir] {string}   the containing root; defaults to `spacesDir`
   * @returns {void}
   */
  #assertContained(targetPath: string, rootDir: string = this.spacesDir): void {
    const root = path.resolve(rootDir)
    const resolved = path.resolve(targetPath)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new StorageError({
        cause: new Error(
          `Resolved path "${resolved}" escapes the storage root.`
        )
      })
    }
  }

  #spaceDir(spaceId: string): string {
    const spaceDir = path.join(this.spacesDir, spaceId)
    this.#assertContained(spaceDir)
    return spaceDir
  }

  /**
   * The directory holding one Space's zcap revocation records, under the
   * sibling `spaceRevocationsDir` root (see that property's doc for why it is
   * not inside the Space dir), guarded against escaping it.
   * @param spaceId {string}
   * @returns {string}
   */
  #spaceRevocationDir(spaceId: string): string {
    const dir = path.join(this.spaceRevocationsDir, spaceId)
    this.#assertContained(dir, this.spaceRevocationsDir)
    return dir
  }

  #collectionDir({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    const collectionDir = path.join(this.#spaceDir(spaceId), collectionId)
    this.#assertContained(collectionDir)
    return collectionDir
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<string>} Created space storage directory path.
   */
  async #ensureSpaceDir({ spaceId }: { spaceId: string }): Promise<string> {
    const spaceDir = this.#spaceDir(spaceId)
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
  async #ensureCollectionDir({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<string> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
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
   * Lists every on-disk file belonging to a single Resource: the
   * representation(s) whose name starts with `r.<encodedResourceId>.` in the
   * Collection dir. The trailing `.` anchors to the filename's segment boundary
   * (`r.<encodedResourceId>.<encodedType>.<ext>`) so a resourceId that is a
   * prefix of another (e.g. `note` vs `notebook`) does not match the longer one;
   * the id is dot-escaped to match the stored name (see `fileNameFor`). A Resource
   * normally has a single current representation, so this usually returns one
   * path; it returns more only transiently while a prior representation under a
   * different content-type is being pruned. An absent Collection dir resolves an
   * empty list (it holds no such files).
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {Promise<string[]>}   full paths, in directory order
   */
  async #resourceFilesFor({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): Promise<string[]> {
    const prefix = `r.${encodeFilenameSegment(resourceId)}.`
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(collectionDir, {
        withFileTypes: true
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
    return entries
      .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
      .map(entry => path.join(collectionDir, entry.name))
  }

  /**
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {Promise<string|undefined>} First matching resource file path.
   */
  async #findFile({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): Promise<string | undefined> {
    const [filePath] = await this.#resourceFilesFor({
      collectionDir,
      resourceId
    })
    return filePath
  }

  // Spaces

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.spaceDescription {SpaceDescription}
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Space's `createdBy` on first write only
   * @returns {Promise<void>} Resolved value is implementation-defined and ignored.
   */
  async writeSpace({
    spaceId,
    spaceDescription,
    createdBy
  }: {
    spaceId: string
    spaceDescription: SpaceDescription
    createdBy?: IDID
  }): Promise<void> {
    // Prior description, read once and reused below: for the create-path quota
    // check (a brand-new Space has none yet) and to resolve `createdBy`.
    const prior = await this.getSpaceDescription({ spaceId })

    // Count quota (create path only): a brand-new Space (no description yet)
    // must not push its controller past `maxSpacesPerController`. Overwriting an
    // existing Space's description never trips it. Space creation is rare, so
    // the O(all Spaces) enumeration is acceptable; soft under concurrency, like
    // the byte quota.
    if (this.maxSpacesPerController !== undefined && !prior) {
      const { controller } = spaceDescription
      const spaces = await this.listSpaces()
      const owned = spaces.filter(
        space => space.controller === controller
      ).length
      if (owned >= this.maxSpacesPerController) {
        throw new CountQuotaExceededError({
          scope: 'Spaces per controller',
          limit: this.maxSpacesPerController
        })
      }
    }

    // `createdBy` names the Space's creator, not its last writer: taken from
    // this write's invoker only when this write CREATES the description, and
    // preserved verbatim afterward -- including preserved-as-absent, so a Space
    // created with no invoker (a token-provisioned create) never has a later
    // writer backfilled into it as its creator. The client-supplied
    // `spaceDescription` is wire input and may carry its own `createdBy` --
    // discard it, since the server alone is authoritative for this field.
    const { createdBy: _suppliedCreatedBy, ...rest } = spaceDescription
    const creator = prior ? prior.createdBy : createdBy

    const spaceDir = await this.#ensureSpaceDir({ spaceId })
    const filename = `.space.${spaceId}.json`
    // Durable full replacement: `MetadataJsonStore.read` parses plain JSON, so
    // an atomically-written JSON string round-trips through the same read path.
    await atomicWriteFile({
      filePath: path.join(spaceDir, filename),
      data: JSON.stringify({
        ...rest,
        ...(creator !== undefined && { createdBy: creator })
      })
    })
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
    const spaceDir = this.#spaceDir(spaceId)
    const filename = `.space.${spaceId}.json`
    const metaStore = new MetadataJsonStore<SpaceDescription>({
      file: path.join(spaceDir, filename)
    })
    return await metaStore.read()
  }

  /**
   * Removes a Space and everything scoped to it. The Space's zcap revocations
   * live in a sibling root (`spaceRevocationsDir`), not under the Space dir, so
   * they are removed explicitly here rather than falling out of the Space dir
   * rm.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async deleteSpace({ spaceId }: { spaceId: string }): Promise<void> {
    // Freed bytes: drop the cached quota usage so the next write re-measures.
    this.#usageCache.delete(spaceId)
    // Remove this Space's revocations, which sit outside the Space dir.
    await rm(this.#spaceRevocationDir(spaceId), {
      recursive: true,
      force: true
    })
    // `force: true` keeps delete idempotent (the `StorageBackend` contract):
    // removing an absent Space resolves rather than rejecting with `ENOENT`.
    return await rm(this.#spaceDir(spaceId), { recursive: true, force: true })
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
   * Counts the live Resources across every Collection of a Space, for the
   * Resource count quota (`maxResourcesPerSpace`). Enumerates each Collection
   * dir and counts distinct Resource ids that have a live representation file
   * (`r.<id>...`); a tombstone (a `.meta.` sidecar with no `r.` file) does not
   * count. An absent Space dir counts zero (not yet provisioned). Soft under
   * concurrency, like the byte quota -- measured at check time by enumeration.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<number>}   the number of live Resources
   */
  async #countLiveResources({ spaceId }: { spaceId: string }): Promise<number> {
    const spaceDir = this.#spaceDir(spaceId)
    let spaceEntries: fs.Dirent[]
    try {
      spaceEntries = await fs.promises.readdir(spaceDir, {
        withFileTypes: true
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0
      }
      throw new StorageError({ cause: err as Error })
    }
    let count = 0
    for (const entry of spaceEntries) {
      if (!entry.isDirectory()) {
        continue
      }
      const collectionDir = path.join(spaceDir, entry.name)
      const files = await fs.promises.readdir(collectionDir)
      // A live Resource has one representation file; count distinct ids so a
      // transient second representation (mid content-type swap) is not
      // double-counted.
      const liveIds = new Set<string>()
      for (const fileName of files) {
        if (!isRepresentationFileName(fileName)) {
          continue
        }
        liveIds.add(parseResourceFileName(fileName).resourceId)
      }
      count += liveIds.size
    }
    return count
  }

  /**
   * Every Collection id in the Space, in code-unit ascending order -- the
   * keyset order the paginated `listCollections` seeks within. The unpaginated
   * full-enumeration path: `listCollections` builds one page from it, while the
   * internal full-Space callers (import count-quota seeding, create count-quota)
   * that must see EVERY Collection rather than a single page read it directly.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<string[]>}
   */
  async #collectionIds({ spaceId }: { spaceId: string }): Promise<string[]> {
    const spaceDir = this.#spaceDir(spaceId)
    const spaceEntries = await fs.promises.readdir(spaceDir, {
      withFileTypes: true
    })
    // Sort in code-unit order -- the SAME ordering the cursor seek
    // (`collectionId > after`) uses, so the keyset stays consistent
    // (localeCompare could disagree with the `>` operator and break paging).
    return spaceEntries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort(compareCodeUnits)
  }

  /**
   * Lists a Space's Collections, OPTIONALLY cursor-paginated (spec
   * "Pagination"), mirroring `listCollectionItems`: a stable total order
   * (ascending by Collection id, code-unit), a `cursor` that resumes at the
   * first id strictly greater than its anchor, a `limit` clamped to
   * `[1, MAX_PAGE_SIZE]` (default `DEFAULT_PAGE_SIZE`), and a `next` present
   * only when a further page may follow. `totalItems` is the full Collection
   * count of the Space -- free here, since the whole directory is enumerated.
   * Each summary's `public` flag is the Collection's `PublicCanRead` policy
   * state, probed inline for the page's Collections only (O(page size)).
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.limit] {number}   requested page size
   * @param [options.cursor] {string}   opaque cursor from a prior page's `next`
   * @returns {Promise<CollectionsList>}
   */
  async listCollections({
    spaceId,
    limit,
    cursor
  }: {
    spaceId: string
    limit?: number
    cursor?: string
  }): Promise<CollectionsList> {
    const ids = await this.#collectionIds({ spaceId })

    // The full count is free (we enumerated the whole Space), so keep returning
    // `totalItems` -- the count of every Collection, not the page.
    const totalItems = ids.length

    // Seek to the first id strictly after the cursor's anchor. Keyset stability:
    // a missing anchor (deleted between pages) does not break the scan, since we
    // resume at the first id greater than it.
    let startIndex = 0
    if (cursor !== undefined) {
      const { after } = decodeCursor(cursor)
      const found = ids.findIndex(id => id > after)
      startIndex = found === -1 ? ids.length : found
    }

    // Clamp `limit` to `[1, MAX_PAGE_SIZE]`, defaulting when absent.
    const pageSize =
      limit === undefined ? DEFAULT_PAGE_SIZE : clampPageSize(limit)

    // Take `pageSize + 1` from the seek point to detect a further page without a
    // second pass; the page is the first `pageSize`.
    const window = ids.slice(startIndex, startIndex + pageSize + 1)
    const hasMore = window.length > pageSize
    const pageIds = hasMore ? window.slice(0, pageSize) : window

    const items: CollectionSummary[] = []
    for (const collectionId of pageIds) {
      const collectionDescription = await this.getCollectionDescription({
        spaceId,
        collectionId
      })
      // Probe the collection-level policy inline so a client need not issue one
      // policy request per listed Collection (an N+1). Only page items are read,
      // so this stays O(page size). `public` is true iff a `PublicCanRead`
      // policy is attached (via the shared `policyGrants` recognizer, which
      // fail-closes any other/unrecognized policy type to false).
      const policy = await this.getPolicy({ spaceId, collectionId })
      items.push({
        id: collectionId,
        url: collectionPath({ spaceId, collectionId }),
        // `name` is optional on the wire type; a stored Collection normally has
        // one (create defaults it to the id). Fall back to the dir name for a
        // description-less directory too (e.g. one left by a policy write to a
        // never-created Collection) -- reading `.name` off `undefined` here would
        // 500 the entire Space listing.
        name: collectionDescription?.name ?? collectionId,
        public: policyGrants({ policy, action: 'read', logger: this.logger })
      })
    }

    // `next` is present iff a further page may follow; its absence marks the last
    // page (the authoritative end-of-list signal). The cursor (the last id on
    // this page) and the page size are baked into the URL so the client follows
    // it verbatim without constructing query parameters.
    let next: string | undefined
    if (hasMore) {
      const lastId = pageIds[pageIds.length - 1]!
      next = `${collectionsPath({ spaceId })}?limit=${pageSize}&cursor=${encodeCursor(lastId)}`
    }

    return {
      url: collectionsPath({ spaceId }),
      totalItems,
      items,
      ...(next !== undefined && { next })
    }
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

    const sourceSpaceDir = this.#spaceDir(spaceId)
    const spaceEntries = (
      await fs.promises.readdir(sourceSpaceDir, { withFileTypes: true })
    ).filter(
      // Backend registration records (.backend.<id>.json) hold plaintext
      // connection material and do NOT travel in a Space export; after import
      // the user re-registers (re-runs consent + POST /backends). importSpace
      // ignores unrecognized space-level files, so this is symmetric.
      entry => !(entry.isFile() && entry.name.startsWith('.backend.'))
    )
    spaceEntries.sort((a, b) => a.name.localeCompare(b.name))

    const collectionEntriesByDir: Record<string, typeof spaceEntries> = {}
    // Per-Resource chunk directories (`.chunks.<encId>/`; the `chunked-streams`
    // feature) are subdirectories of a Collection dir, so the file filter below
    // skips them. Gather each one's files here so a chunked Resource's chunks
    // travel in the export, keyed by Collection then by chunk-directory name.
    const chunkDirsByCollection: Record<
      string,
      Array<{ dirName: string; files: string[] }>
    > = {}
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
      const chunkDirs: Array<{ dirName: string; files: string[] }> = []
      for (const sub of entries
        .filter(e => e.isDirectory() && e.name.startsWith(CHUNK_DIR_PREFIX))
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const files = (
          await fs.promises.readdir(
            path.join(sourceSpaceDir, entry.name, sub.name),
            { withFileTypes: true }
          )
        )
          .filter(e => e.isFile())
          .map(e => e.name)
          .sort((a, b) => a.localeCompare(b))
        chunkDirs.push({ dirName: sub.name, files })
      }
      chunkDirsByCollection[entry.name] = chunkDirs
    }

    // Space-scoped zcap revocations travel with the export. They live in the
    // sibling `spaceRevocationsDir` root (see that property's doc), so the
    // Space-dir walk above never sees them; they pack under a top-level
    // `revocations/` dir -- outside `space/<spaceId>/`, where a subdirectory
    // would read as a Collection on import.
    const revocationsDir = this.#spaceRevocationDir(spaceId)
    let revocationFiles: string[] = []
    try {
      revocationFiles = (
        await fs.promises.readdir(revocationsDir, { withFileTypes: true })
      )
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError({ cause: err as Error })
      }
    }

    const manifest = buildExportManifest({
      spaceId,
      entries: spaceEntries.map(entry =>
        entry.isDirectory()
          ? {
              name: entry.name,
              // The Collection's own files, then each chunked Resource's chunk
              // files listed by their `.chunks.<encId>/<file>` relative path
              // (the manifest mirrors the pack order below).
              files: [
                ...(collectionEntriesByDir[entry.name] ?? []).map(
                  file => file.name
                ),
                ...(chunkDirsByCollection[entry.name] ?? []).flatMap(
                  ({ dirName, files }) =>
                    files.map(file => `${dirName}/${file}`)
                )
              ]
            }
          : // top-level files in space (e.g. .space.<spaceId>.json)
            { name: entry.name }
      ),
      revocationFiles
    })

    // Fixed mtime on every entry so the archive is byte-reproducible (see
    // EXPORT_ENTRY_MTIME).
    const mtime = EXPORT_ENTRY_MTIME
    const pack = tar.pack()
    pack.entry({ name: 'manifest.yml', mtime }, YAML.stringify(manifest))
    pack.entry({ name: 'space/', type: 'directory', mtime })
    pack.entry({ name: `space/${spaceId}/`, type: 'directory', mtime })

    for (const entry of spaceEntries) {
      const entryTarget = `space/${spaceId}/${entry.name}`

      if (entry.isDirectory()) {
        pack.entry({ name: `${entryTarget}/`, type: 'directory', mtime })
        for (const file of collectionEntriesByDir[entry.name] ?? []) {
          const bytes = await fs.promises.readFile(
            path.join(sourceSpaceDir, entry.name, file.name)
          )
          pack.entry({ name: `${entryTarget}/${file.name}`, mtime }, bytes)
        }
        // A chunked Resource's chunk directory and its files, packed under the
        // Collection so `.chunks.<encId>/<file>` round-trips on import.
        for (const { dirName, files } of chunkDirsByCollection[entry.name] ??
          []) {
          pack.entry({
            name: `${entryTarget}/${dirName}/`,
            type: 'directory',
            mtime
          })
          for (const file of files) {
            const bytes = await fs.promises.readFile(
              path.join(sourceSpaceDir, entry.name, dirName, file)
            )
            pack.entry(
              { name: `${entryTarget}/${dirName}/${file}`, mtime },
              bytes
            )
          }
        }
      } else if (entry.isFile()) {
        const bytes = await fs.promises.readFile(
          path.join(sourceSpaceDir, entry.name)
        )
        pack.entry({ name: entryTarget, mtime }, bytes)
      }
    }

    if (revocationFiles.length > 0) {
      pack.entry({ name: 'revocations/', type: 'directory', mtime })
      for (const name of revocationFiles) {
        const bytes = await fs.promises.readFile(
          path.join(revocationsDir, name)
        )
        pack.entry({ name: `revocations/${name}`, mtime }, bytes)
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
    const { spacePolicy, collections, revocations } = buildImportPlan(entries)

    // Pre-flight pass over every staged resource, before writing anything, so a
    // rejected import leaves the Space untouched. Three checks, each of which the
    // PUT/POST write routes already enforce and which import MUST inherit too:
    //  - per-upload size cap (413): reject any single body over `maxUploadBytes`;
    //  - fail-closed encryption (422): when the target Collection declares a
    //    recognized `encryption` scheme, every incoming resource body MUST be a
    //    conforming envelope of it (a plaintext body under an encrypted
    //    Collection would otherwise store server-visible plaintext);
    //  - cumulative quota (507): sum bodies and check remaining Space headroom.
    // The effective encryption marker is the merged-into Collection's existing
    // one, else the import's own Collection description (a new Collection). Skips
    // (existing ids) are counted conservatively, as for the quota estimate.
    const {
      capacityBytes,
      maxUploadBytes,
      maxCollectionsPerSpace,
      maxResourcesPerSpace
    } = this
    let incomingBytes = 0
    for (const {
      collectionId,
      collectionDescription,
      resources,
      chunkFiles
    } of collections) {
      const existing = await this.getCollectionDescription({
        spaceId,
        collectionId
      })
      const effectiveEncryption = existing
        ? existing.encryption
        : collectionDescription.encryption
      for (const { fileName, body } of resources) {
        if (maxUploadBytes !== undefined && body.length > maxUploadBytes) {
          throw new PayloadTooLargeError({
            maxUploadBytes,
            backendId: this.describe().id,
            uploadBytes: body.length
          })
        }
        if (effectiveEncryption?.scheme !== undefined) {
          const { contentType } = parseResourceFileName(fileName)
          let parsedBody: unknown
          try {
            parsedBody = JSON.parse(body.toString('utf8'))
          } catch {
            parsedBody = undefined
          }
          assertEncryptedWriteConforms({
            collectionDescription: { encryption: effectiveEncryption },
            contentType,
            body: parsedBody
          })
        }
        incomingBytes += body.length
      }
      // Chunk files (the `chunked-streams` feature) inherit the per-upload cap
      // and quota estimate, but NOT the encryption-conformance check: a chunk is
      // opaque bytes, not a JSON envelope of the Collection's scheme.
      for (const { body } of chunkFiles) {
        if (maxUploadBytes !== undefined && body.length > maxUploadBytes) {
          throw new PayloadTooLargeError({
            maxUploadBytes,
            backendId: this.describe().id,
            uploadBytes: body.length
          })
        }
        incomingBytes += body.length
      }
    }
    if (capacityBytes !== undefined) {
      await this.#assertSpaceHeadroom({
        spaceId,
        capacityBytes,
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

    // Count quotas: measure the Space's existing live Collections/Resources
    // ONCE here, then track running totals as the apply loop creates items, so
    // an import cannot push the Space past `maxCollectionsPerSpace` /
    // `maxResourcesPerSpace`. Only brand-new items count -- a re-imported
    // existing id is skipped and does not -- mirroring the per-create
    // write-path guards without re-enumerating the Space per item.
    const collectionIds = new Set(await this.#collectionIds({ spaceId }))
    let liveResourceCount =
      maxResourcesPerSpace !== undefined
        ? await this.#countLiveResources({ spaceId })
        : 0

    for (const {
      collectionId,
      collectionDescription,
      collectionPolicy,
      resources,
      resourcePolicies,
      resourceMetadata,
      chunkFiles
    } of collections) {
      // check if collection already exists
      const collectionExisted = Boolean(
        await this.getCollectionDescription({ spaceId, collectionId })
      )
      if (collectionExisted) {
        stats.collectionsSkipped++
      } else {
        // A brand-new Collection (one whose id the Space did not already hold,
        // even as a description-less directory) counts against the cap; filling
        // in the description of an existing directory does not.
        if (
          maxCollectionsPerSpace !== undefined &&
          !collectionIds.has(collectionId) &&
          collectionIds.size >= maxCollectionsPerSpace
        ) {
          throw new CountQuotaExceededError({
            scope: 'Collections per Space',
            limit: maxCollectionsPerSpace
          })
        }
        collectionIds.add(collectionId)
        await this.#persistCollection({
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

      const collectionDir = this.#collectionDir({ spaceId, collectionId })

      for (const { fileName, resourceId, body } of resources) {
        // Skip anything the destination already has for this id: a live
        // representation (`#findFile`) OR a sidecar (`readMetaSidecar`, which
        // includes a `deleted:true` tombstone). Checking only `#findFile` would
        // let an import write content back over a soft-deleted (tombstoned)
        // resource -- resurrecting it while its `deleted:true` sidecar remains,
        // yielding a served-but-tombstoned resource and an inconsistent feed.
        const resourceExists =
          Boolean(await this.#findFile({ collectionDir, resourceId })) ||
          Boolean(await this.readMetaSidecar({ collectionDir, resourceId }))
        if (resourceExists) {
          stats.resourcesSkipped++
          // A resource-level policy travels with a newly-created resource only.
          if (resourcePolicies.has(resourceId)) {
            stats.policiesSkipped++
          }
          continue
        }

        // A new live Resource counts against the per-Space cap.
        if (maxResourcesPerSpace !== undefined) {
          if (liveResourceCount >= maxResourcesPerSpace) {
            throw new CountQuotaExceededError({
              scope: 'Resources per Space',
              limit: maxResourcesPerSpace
            })
          }
          liveResourceCount++
        }

        await atomicWriteFile({
          filePath: path.join(collectionDir, fileName),
          data: body
        })
        stats.resourcesCreated++

        // A metadata sidecar travels with a newly-created resource (preserving
        // its timestamps and user-writable `custom`); an absent one leaves
        // `getResourceMetadata` to fall back to the file's stat times.
        const metadataBytes = resourceMetadata.get(resourceId)
        if (metadataBytes) {
          await atomicWriteFile({
            filePath: this.#metaSidecarPath({ collectionDir, resourceId }),
            data: metadataBytes
          })
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

      // Carry tombstones: a soft-deleted Resource (see `deleteResource`) exports
      // as a `.meta.` sidecar with no paired `r.` content file, so it never
      // appears in `resources` above. Restore each such ORPHAN sidecar that is a
      // tombstone (`deleted: true`) -- writing only the sidecar re-creates the
      // tombstone. A non-tombstone orphan sidecar is anomalous (a Resource with
      // no representation) and is skipped. Merge semantics match resources:
      // anything the destination already has for that id (a live Resource or an
      // existing tombstone) is left untouched.
      const importedResourceIds = new Set(resources.map(r => r.resourceId))
      for (const [resourceId, metadataBytes] of resourceMetadata) {
        if (importedResourceIds.has(resourceId)) {
          continue
        }
        let sidecar: MetaSidecar | undefined
        try {
          sidecar = JSON.parse(metadataBytes.toString('utf8'))
        } catch {
          continue
        }
        if (sidecar?.deleted !== true) {
          continue
        }
        const exists =
          Boolean(await this.#findFile({ collectionDir, resourceId })) ||
          Boolean(await this.readMetaSidecar({ collectionDir, resourceId }))
        if (exists) {
          stats.resourcesSkipped++
          continue
        }
        await atomicWriteFile({
          filePath: this.#metaSidecarPath({ collectionDir, resourceId }),
          data: metadataBytes
        })
        stats.resourcesCreated++
      }

      // Restore chunk files of chunked Resources (the `chunked-streams` feature)
      // into their per-Resource chunk directories. Skip-not-overwrite, per chunk
      // file: an existing chunk file is left untouched, so a re-import never
      // clobbers stored chunk bytes (or their version sidecar). An ORPHAN chunk
      // file -- one whose parent Resource is absent or a tombstone (no live
      // representation on the destination after the Resource apply loop above)
      // -- is skipped rather than resurrected, matching the live write path's
      // parent-exists rule (and the Postgres import).
      const parentIsLive = new Map<string, boolean>()
      for (const { resourceId, fileName, body } of chunkFiles) {
        let live = parentIsLive.get(resourceId)
        if (live === undefined) {
          live = Boolean(await this.#findFile({ collectionDir, resourceId }))
          parentIsLive.set(resourceId, live)
        }
        if (!live) {
          continue
        }
        const chunkDir = this.#chunkDir({ collectionDir, resourceId })
        const target = path.join(chunkDir, fileName)
        this.#assertContained(target)
        let present = false
        try {
          await fsStat(target)
          present = true
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err
          }
        }
        if (present) {
          continue
        }
        await mkdir(chunkDir, { recursive: true })
        await atomicWriteFile({ filePath: target, data: body })
      }
    }

    // Restore the archive's Space-scoped zcap revocations under this Space's
    // scope: a capability revoked before the export must stay revoked after
    // an import (a backup/restore round-trip must not resurrect revoked
    // access). Merge semantics match the rest of the import -- an
    // already-stored record is skipped -- and a record past its GC horizon is
    // dropped (the capability itself has expired; `isRevoked` would prune it).
    const now = Date.now()
    for (const record of revocations) {
      if (record.meta.expires && Date.parse(record.meta.expires) <= now) {
        continue
      }
      try {
        await this.insertRevocation({ scope: { spaceId }, record })
      } catch (err) {
        if (!(err instanceof DuplicateRevocationError)) {
          throw err
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
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Collection's `createdBy` on first write only
   * @param [options.ifMatch] {string}   an `If-Match` compare-and-swap on the
   *   current description version (the `key-epochs` feature); a stale validator
   *   throws `PreconditionFailedError` (412)
   * @returns {Promise<{ version: number }>}   the Collection's new description
   *   version (the `ETag` validator)
   */
  async writeCollection({
    spaceId,
    collectionId,
    collectionDescription,
    createdBy,
    ifMatch,
    assertTransition
  }: {
    spaceId: string
    collectionId: string
    collectionDescription: CollectionDescription
    createdBy?: IDID
    ifMatch?: string
    assertTransition?: (
      prior?: CollectionDescription & { descriptionVersion?: number }
    ) => void
  }): Promise<{ version: number }> {
    // Serialize the read-check-write under a per-Collection-description lock so
    // the `If-Match` compare-and-swap and the monotonic version bump are atomic
    // with the write (two concurrent recipient edits cannot clobber one
    // another). A distinct lock namespace from the per-Resource / unique-scan
    // locks: a description write and a Resource write touch different files.
    return this.#writeMutex.run(
      this.#collectionDescLockKey({ spaceId, collectionId }),
      async () => {
        // Prior description, read once and reused below: for the create-path
        // quota check, `createdBy` resolution, and the CAS version.
        const prior = await this.getCollectionDescription({
          spaceId,
          collectionId
        })

        // Compare-and-swap on the current description version (opt-in): a stale
        // `If-Match` throws 412. An unconditional write skips this.
        assertCollectionWritePrecondition({
          collectionId,
          currentVersion: prior?.descriptionVersion ?? 0,
          ifMatch
        })

        // The request layer's state-transition rails (e.g. epoch append-only),
        // re-evaluated here against the description just read under the lock.
        assertTransition?.(prior)

        // Count quota (create path only): a new Collection must not push its
        // Space past `maxCollectionsPerSpace`; overwriting an existing
        // Collection's description never trips it.
        if (this.maxCollectionsPerSpace !== undefined && !prior) {
          const collectionIds = await this.#collectionIds({ spaceId })
          if (collectionIds.length >= this.maxCollectionsPerSpace) {
            throw new CountQuotaExceededError({
              scope: 'Collections per Space',
              limit: this.maxCollectionsPerSpace
            })
          }
        }

        // `createdBy` names the Collection's creator, not its last writer: taken
        // from this write's invoker only when this write CREATES the
        // description, and preserved verbatim afterward -- including
        // preserved-as-absent. The client-supplied `collectionDescription` is
        // wire input and may carry its own `createdBy` (and the out-of-band
        // `descriptionVersion` when a caller spread a read result back in) --
        // discard both, since the server alone is authoritative for them.
        const {
          createdBy: _suppliedCreatedBy,
          descriptionVersion: _suppliedVersion,
          ...rest
        } = collectionDescription as CollectionDescription & {
          descriptionVersion?: number
        }
        const creator = prior ? prior.createdBy : createdBy
        const version = (prior?.descriptionVersion ?? 0) + 1

        await this.#persistCollection({
          spaceId,
          collectionId,
          collectionDescription: {
            ...rest,
            ...(creator !== undefined && { createdBy: creator })
          },
          descriptionVersion: version
        })
        return { version }
      }
    )
  }

  /**
   * Builds the per-Collection-description serialization key for `#writeMutex`
   * (`desc:<spaceId>/<collectionId>`), so a Collection Description compare-and-
   * swap serializes with itself while staying disjoint from the per-Resource and
   * unique-scan lock namespaces.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {string}
   */
  #collectionDescLockKey({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return `desc:${spaceId}/${collectionId}`
  }

  /**
   * Writes a Collection's description file (creating the Collection dir if
   * needed), with NO count-quota check. The count guard lives in the public
   * `writeCollection`; `importSpace` tracks the Space's Collection count itself
   * (measured once up front) and calls this directly, so it does not
   * re-enumerate the Space per created Collection.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDescription {CollectionDescription}
   * @param [options.descriptionVersion] {number}   the monotonic description
   *   version to persist (the `ETag` validator; the `key-epochs` feature). Kept
   *   OUT of the wire body -- stored under a reserved `_version` member that
   *   `getCollectionDescription` strips and re-surfaces as `descriptionVersion`.
   *   When omitted (the import path), a `_version` already on the incoming
   *   description is preserved, else it defaults to `1`.
   * @returns {Promise<void>}
   */
  async #persistCollection({
    spaceId,
    collectionId,
    collectionDescription,
    descriptionVersion
  }: {
    spaceId: string
    collectionId: string
    collectionDescription: CollectionDescription
    descriptionVersion?: number
  }): Promise<void> {
    const collectionDir = await this.#ensureCollectionDir({
      spaceId,
      collectionId
    })
    const filename = `.collection.${collectionId}.json`
    // Shared normalization (lib/collectionDescription.ts): strip the
    // version-bearing members from the incoming body and re-stamp -- an
    // explicit `descriptionVersion` wins, else a `_version` already on the
    // incoming (imported) description is kept, else the first write starts
    // at 1.
    const { body, version } = normalizeDescriptionWrite({
      collectionDescription,
      descriptionVersion
    })
    await atomicWriteFile({
      filePath: path.join(collectionDir, filename),
      data: JSON.stringify({ ...body, _version: version })
    })
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
  }): Promise<
    (CollectionDescription & { descriptionVersion?: number }) | undefined
  > {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const filename = `.collection.${collectionId}.json`
    const metaStore = new MetadataJsonStore<
      CollectionDescription & { _version?: number }
    >({
      file: path.join(collectionDir, filename)
    })
    const raw = await metaStore.read()
    if (!raw) {
      return undefined
    }
    // `_version` is the internal ETag validator, kept out of the wire body:
    // strip it and re-surface it out-of-band as `descriptionVersion` (the
    // handler sets the `ETag` header from it). Absent for a legacy Collection.
    const { _version, ...description } = raw
    return {
      ...description,
      ...(_version !== undefined && { descriptionVersion: _version })
    }
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
    // Freed bytes: drop the cached quota usage so the next write re-measures.
    this.#usageCache.delete(spaceId)
    // `force: true` keeps delete idempotent (spec / `StorageBackend` contract):
    // removing an absent (or already-deleted) Collection resolves rather than
    // rejecting with `ENOENT` (which the request layer would wrap as a 500).
    return await rm(this.#collectionDir({ spaceId, collectionId }), {
      recursive: true,
      force: true
    })
  }

  /**
   * Lists a Collection's Resources, OPTIONALLY cursor-paginated (spec
   * "Pagination"). Items are returned in a stable total order -- ascending by
   * `resourceId`, read straight from the `r.<resourceId>.<type>.<ext>` filename
   * (the keyset). A `cursor` resumes the scan at the first id strictly greater
   * than the cursor's anchor, so paging stays correct even if the anchor id was
   * deleted between pages; `limit` bounds the page (clamped to
   * `[1, MAX_PAGE_SIZE]`, default `DEFAULT_PAGE_SIZE`). `next` is built (and
   * present) only when a further page may follow.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.limit] {number}   requested page size
   * @param [options.cursor] {string}   opaque cursor from a prior page's `next`
   * @returns {Promise<CollectionResourcesList>}
   */
  async listCollectionItems({
    spaceId,
    collectionId,
    limit,
    cursor,
    collectionDescription: providedDescription
  }: {
    spaceId: string
    collectionId: string
    limit?: number
    cursor?: string
    collectionDescription?: CollectionDescription
  }): Promise<CollectionResourcesList> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    // Prefer the caller's control-plane description. When this backend serves a
    // Collection's data plane (an external backend), it does NOT hold the
    // description locally, so its own `getCollectionDescription` would resolve
    // `undefined` and reading `.name`/`.type` off it would 500.
    const collectionDescription =
      providedDescription ??
      (await this.getCollectionDescription({ spaceId, collectionId }))

    // Enumerate the Collection dir directly rather than globbing: glob v13 does
    // not sort, so its order is nondeterministic -- pagination needs a stable
    // keyset. Keep only resource representations (`r.<id>.<type>.<ext>`), which
    // drops the `.meta.` / `.collection.` / `.policy.` dot-files.
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(collectionDir, {
        withFileTypes: true
      })
    } catch (err) {
      this.logger.error({ err }, 'Error reading collection directory')
    }
    const resources = entries
      .filter(entry => entry.isFile() && isRepresentationFileName(entry.name))
      .map(entry => parseResourceFileName(entry.name))
      // Sort by `resourceId` ascending in code-unit order -- the SAME ordering
      // the cursor seek (`resourceId > after`) uses, so the keyset is consistent
      // (localeCompare could disagree with the `>` operator and break paging).
      .sort((left, right) =>
        compareCodeUnits(left.resourceId, right.resourceId)
      )

    // The full count is free here (we enumerated the whole dir), so keep
    // returning `totalItems` -- the count of the entire Collection, not the page.
    const totalItems = resources.length

    // Seek to the first entry strictly after the cursor's anchor id. Keyset
    // stability: a missing anchor (deleted between pages) does not break the
    // scan, since we resume at the first id greater than it.
    let startIndex = 0
    if (cursor !== undefined) {
      const { after } = decodeCursor(cursor)
      const found = resources.findIndex(({ resourceId }) => resourceId > after)
      startIndex = found === -1 ? resources.length : found
    }

    // Clamp `limit` to `[1, MAX_PAGE_SIZE]`, defaulting when absent.
    const pageSize =
      limit === undefined ? DEFAULT_PAGE_SIZE : clampPageSize(limit)

    // Take `pageSize + 1` from the seek point to detect a further page without a
    // second pass; the page is the first `pageSize`, and `hasMore` is whether we
    // got the extra one (so a page that exactly fills the Collection has no
    // spurious empty trailing page).
    const window = resources.slice(startIndex, startIndex + pageSize + 1)
    const hasMore = window.length > pageSize
    const pageEntries = hasMore ? window.slice(0, pageSize) : window

    // Read `.meta` sidecars ONLY for the items on this page (the previous
    // implementation read a sidecar for every resource on every list). Surface
    // the user-writable `custom.name` (spec: updating it updates the name shown
    // in Collection listings) -- but only for a plaintext Collection. On an
    // encrypted Collection `custom` is the opaque encryption envelope, so the
    // server cannot project a `name`; the listing omits it (spec "List
    // Collection", encrypted-Collection note). (A bare `custom?.name` on a JWE
    // envelope already yields `undefined`; the guard makes that explicit.)
    const encrypted = collectionDescription?.encryption !== undefined
    const items = await Promise.all(
      pageEntries.map(async ({ resourceId, contentType }) => {
        const sidecar = await this.readMetaSidecar({
          collectionDir,
          resourceId
        })
        const name = encrypted
          ? undefined
          : (sidecar?.custom as ResourceMetadataCustom | undefined)?.name
        return {
          id: resourceId,
          url: resourcePath({ spaceId, collectionId, resourceId }),
          contentType,
          ...(name !== undefined && { name }),
          // The client-declared key epoch (the `key-epochs` feature) rides each
          // listing item so a reader can pick the right epoch key without a
          // `/meta` fetch per Resource.
          ...(sidecar?.epoch !== undefined && { epoch: sidecar.epoch })
        }
      })
    )

    // `next` is present iff a further page may follow; its absence marks the last
    // page (the authoritative end-of-list signal). The cursor (the last id on
    // this page) and the page size are baked into the URL so the client follows
    // it verbatim without constructing query parameters.
    let next: string | undefined
    if (hasMore) {
      const lastId = pageEntries[pageEntries.length - 1]!.resourceId
      const base = collectionPath({
        spaceId,
        collectionId,
        trailingSlash: true
      })
      next = `${base}?limit=${pageSize}&cursor=${encodeCursor(lastId)}`
    }

    return {
      id: collectionId,
      url: collectionPath({ spaceId, collectionId }),
      name: collectionDescription?.name ?? collectionId,
      type: collectionDescription?.type || ['Collection'],
      totalItems,
      items,
      ...(next !== undefined && { next })
    }
  }

  // Resources

  /**
   * Writes a resource representation (JSON value or byte stream) to disk, under
   * the per-Resource write lock (the `conditional-writes` feature), and bumps
   * the Resource's monotonic `version`. The new version is returned so the
   * request layer can surface it as the response `ETag`.
   *
   * When a conditional-write precondition is supplied it is evaluated against
   * the Resource's current state atomically with the write (under the lock),
   * throwing `PreconditionFailedError` (412) on a mismatch:
   * - `ifNoneMatch` (a create-if-absent `If-None-Match: *`) fails if the
   *   Resource already exists.
   * - `ifMatch` (an update-if-unchanged `If-Match: "<etag>"`) fails if the
   *   Resource is absent or its current `ETag` does not equal `ifMatch`.
   * `ifNoneMatch` takes precedence when both are supplied (RFC9110).
   *
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.input {ResourceInput}
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Resource's `createdBy` on first write only
   * @param [options.ifMatch] {string}   `If-Match` precondition (a quoted ETag)
   * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *` (create-if-absent)
   * @returns {Promise<{ version: number }>}   the Resource's new version
   */
  async writeResource({
    spaceId,
    collectionId,
    resourceId,
    input,
    createdBy,
    epoch,
    uniqueIndexes,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    input: ResourceInput
    createdBy?: IDID
    epoch?: string
    uniqueIndexes?: NormalizedIndexDeclaration[]
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<{ version: number }> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const lockKey = this.#resourceLockKey({
      spaceId,
      collectionId,
      resourceId
    })
    const write = () =>
      this.#writeMutex.run(lockKey, () =>
        this.#writeResourceLocked({
          spaceId,
          collectionDir,
          resourceId,
          input,
          createdBy,
          epoch,
          ifMatch,
          ifNoneMatch
        })
      )

    // Two unique-attribute invariants can force a write to serialize on the
    // Collection lock before it takes its per-Resource lock: the EDV blinded
    // one (`unique: true` blinded attributes; the `blinded-index-query`
    // feature) and the plaintext equality one (a Collection's `unique`-declared
    // `indexes`; the `equality-query` feature). Only a JSON content write can
    // create either claim, so only such writes pay for it: they serialize per
    // Collection (the outer lock, so two racing claimants cannot both pass the
    // scan), evaluate the conflict against the Collection's other live
    // documents, then take the ordinary per-Resource lock nested inside.
    // Distinct-key nesting cannot deadlock: plain writes never hold a Resource
    // key while waiting on a Collection key. The two conditions are unified so a
    // write carrying both claims acquires the Collection lock exactly once.
    const blindedUnique =
      input.kind === 'json' &&
      collectUniqueBlindedTerms({ document: input.data }).length > 0
    const equalityUnique =
      input.kind === 'json' &&
      uniqueIndexes !== undefined &&
      uniqueIndexes.length > 0
    if (blindedUnique || equalityUnique) {
      return this.#writeMutex.run(
        this.#collectionLockKey({ spaceId, collectionId }),
        async () => {
          if (blindedUnique) {
            assertNoUniqueBlindedConflict({
              document: input.kind === 'json' ? input.data : undefined,
              candidates: await this.#readJsonCandidates({
                spaceId,
                collectionId,
                excludeResourceId: resourceId
              })
            })
          }
          if (equalityUnique) {
            // A content write does not change the Resource's `custom`, so the
            // custom side of the claim comes from the CURRENT stored sidecar.
            const priorSidecar = await this.readMetaSidecar({
              collectionDir,
              resourceId
            })
            assertNoUniqueEqualityConflict({
              indexes: uniqueIndexes!,
              content: input.kind === 'json' ? input.data : undefined,
              custom: priorSidecar?.custom,
              candidates: await this.#readEqualityCandidates({
                spaceId,
                collectionId,
                excludeResourceId: resourceId
              })
            })
          }
          return write()
        }
      )
    }
    return write()
  }

  /**
   * The critical section of `writeResource`, run under the per-Resource lock:
   * evaluates any precondition, writes the representation, prunes a stale
   * representation under a different content-type, and persists the bumped
   * `version` in the sidecar. See `writeResource` for the parameters.
   * @returns {Promise<{ version: number }>}
   */
  async #writeResourceLocked({
    spaceId,
    collectionDir,
    resourceId,
    input,
    createdBy,
    epoch,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionDir: string
    resourceId: string
    input: ResourceInput
    createdBy?: IDID
    epoch?: string
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<{ version: number }> {
    const filename = fileNameFor({ resourceId, contentType: input.contentType })
    const filePath = path.join(collectionDir, filename)
    this.#assertContained(filePath)

    // Evaluate any conditional-write precondition against the current state
    // before writing (still inside the lock, so the check and write are atomic).
    if (ifMatch !== undefined || ifNoneMatch) {
      await this.#assertWritePrecondition({
        collectionDir,
        resourceId,
        ifMatch,
        ifNoneMatch
      })
    }

    // Count quota (create path only): a new live Resource must not push its
    // Space past `maxResourcesPerSpace`. A write over an existing live
    // representation is an update (never trips it); a write over a tombstone
    // (no `r.` file) is a create and does count. Soft under concurrency.
    if (this.maxResourcesPerSpace !== undefined) {
      const isLive =
        (await this.#findFile({ collectionDir, resourceId })) !== undefined
      if (!isLive) {
        const liveCount = await this.#countLiveResources({ spaceId })
        if (liveCount >= this.maxResourcesPerSpace) {
          throw new CountQuotaExceededError({
            scope: 'Resources per Space',
            limit: this.maxResourcesPerSpace
          })
        }
      }
    }

    await this.#writeRepresentationBytes({ spaceId, filePath, input })

    // A Resource has a single current representation: remove any prior one
    // stored under a different content-type (write-new-then-prune).
    await this.#pruneStaleRepresentations({
      collectionDir,
      resourceId,
      keepPath: filePath
    })

    // Maintain the server-managed timestamps and the monotonic `version`: a
    // content write sets `createdAt` on first write, bumps `updatedAt`, and
    // increments `version` (the ETag validator) from its prior value, preserving
    // any user-writable `custom` and the independent `metaVersion` already stored
    // in the sidecar (a content write does not touch the metadata sub-resource).
    //
    // `createdBy` pairs with `createdAt`: taken from this write's invoker only
    // when this write creates the sidecar, so it names the creator rather than
    // the last writer, and is preserved verbatim afterward -- including
    // preserved-as-absent, so a Resource created with no invoker never has a
    // later writer backfilled into it. A tombstone keeps both, so re-creating a
    // deleted id under a different invoker preserves the original creator, as
    // it does the original `createdAt`.
    return this.#bumpSidecarVersion({
      collectionDir,
      resourceId,
      build: ({ prior, version, now }) => {
        const creator = prior ? prior.createdBy : createdBy
        return {
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
          ...(creator !== undefined && { createdBy: creator }),
          version,
          ...(prior?.metaVersion !== undefined && {
            metaVersion: prior.metaVersion
          }),
          ...(prior?.custom && { custom: prior.custom }),
          // The key-epoch stamp is set from this write's declaration and CLEARED
          // when absent (the new ciphertext's epoch is unknown -- a stale stamp
          // is worse than none), so it is NOT preserved from `prior` like
          // `custom`.
          ...(epoch !== undefined && { epoch })
        }
      }
    })
  }

  /**
   * Writes a representation body (JSON value or byte stream) to `filePath`,
   * applying the same size guards every write path shares: the per-upload cap
   * (413 `PayloadTooLargeError`) and, when a byte quota is configured, the
   * Space headroom (507). A JSON body is fully in memory, so its size is checked
   * up front and written atomically; a binary body is streamed through the cap /
   * quota guards into a temp file and durably committed (fsync + rename + dir
   * fsync), removing the partial file on any failure. Shared by the Resource
   * write path (`#writeResourceLocked`) and the chunk write path
   * (`#writeChunkLocked`); the caller has already resolved `filePath` and ensured
   * its parent directory exists for the streamed case.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.filePath {string}   absolute path of the representation file
   * @param options.input {ResourceInput}
   * @returns {Promise<void>}
   */
  async #writeRepresentationBytes({
    spaceId,
    filePath,
    input
  }: {
    spaceId: string
    filePath: string
    input: ResourceInput
  }): Promise<void> {
    const { capacityBytes, maxUploadBytes } = this

    if (input.kind === 'json') {
      // JSON bodies are fully in memory, so their serialized size is known up
      // front and the pre-flight checks alone suffice (no streaming guard). The
      // per-upload cap (413) is checked before the cumulative quota (507).
      // Serialize once and reuse for both the size pre-flight and the write.
      const serialized = JSON.stringify(input.data)
      const incomingBytes = Buffer.byteLength(serialized)
      if (maxUploadBytes !== undefined && incomingBytes > maxUploadBytes) {
        throw new PayloadTooLargeError({
          maxUploadBytes,
          backendId: this.describe().id,
          uploadBytes: incomingBytes
        })
      }
      if (capacityBytes !== undefined) {
        await this.#assertSpaceHeadroom({
          spaceId,
          capacityBytes,
          incomingBytes
        })
      }
      // Write the serialized JSON directly rather than through fs-json-store,
      // whose `write` verifies the result via `readExisting` and treats a falsy
      // round-tripped value (`null`, `false`, `0`, `""`) as "file does not
      // exist" -- which would 500 a legitimate top-level primitive Resource. The
      // read path (`getResource`) streams the bytes back verbatim, so any
      // top-level JSON value -- object, array, or bare primitive -- round-trips.
      // Ensure the Collection dir exists first (fs-json-store used to create it
      // on the fly; a data-plane backend may not have seen this Collection yet).
      this.logger.info('Creating JSON resource')
      await mkdir(path.dirname(filePath), { recursive: true })
      // Durable, atomic replacement (write-temp + fsync + rename + dir fsync):
      // the final path never observes a torn write, even across a crash.
      await atomicWriteFile({ filePath, data: serialized })
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
        guards.push(this.#uploadCapGuard({ maxUploadBytes }))
      }
      if (capacityBytes !== undefined) {
        const headroomBytes = await this.#assertSpaceHeadroom({
          spaceId,
          capacityBytes,
          incomingBytes: input.declaredBytes ?? 0
        })
        guards.push(this.#quotaGuard({ spaceId, capacityBytes, headroomBytes }))
      }
      // Stream into a temp file in the same directory, then durably commit it
      // (fsync + rename + dir fsync) once the whole body has been written and
      // verified. Streaming to the final path directly would expose a truncated
      // representation under the resource's name if the process crashed
      // mid-stream; staging + rename makes the resource appear only whole.
      const tempPath = tempPathFor(filePath)
      try {
        await pipeline([
          input.stream,
          ...guards,
          fs.createWriteStream(tempPath)
        ])
        await commitTempFile({ tempPath, filePath })
      } catch (err) {
        // Remove the partial file on ANY failure: a guard rejection (413/507),
        // an aborted upload, or a streamed `Digest` mismatch (the request layer
        // verifies the body's digest as it flows). A failed write must not leave
        // a truncated or unverified representation behind. Only the temp path is
        // ever staged into, so a failed write never touches the final path.
        await rm(tempPath, { force: true })
        throw err
      }
    }
  }

  /**
   * Removes any prior representation of a Resource (or chunk) stored under a
   * different content-type than the one just written: its filename differs, so
   * `#resourceFilesFor` still lists it. Write-new-then-prune (the caller writes
   * the new representation first) so the item is never momentarily absent.
   * Shared by the Resource write path (`#writeResourceLocked`) and the chunk
   * write path (`#writeChunkLocked`).
   * @param options {object}
   * @param options.collectionDir {string}   the dir the representation lives in
   *   (a Collection dir, or a chunk dir for a chunk)
   * @param options.resourceId {string}   the representation id (a resourceId, or
   *   the stringified chunk index)
   * @param options.keepPath {string}   full path of the just-written
   *   representation to keep
   * @returns {Promise<void>}
   */
  async #pruneStaleRepresentations({
    collectionDir,
    resourceId,
    keepPath
  }: {
    collectionDir: string
    resourceId: string
    keepPath: string
  }): Promise<void> {
    const existing = await this.#resourceFilesFor({ collectionDir, resourceId })
    await Promise.all(
      existing
        .filter(name => path.resolve(name) !== path.resolve(keepPath))
        .map(name => rm(name))
    )
  }

  /**
   * The read-bump-write sidecar tail shared by `#writeResourceLocked` and
   * `#writeChunkLocked`: reads the item's current metadata sidecar, computes the
   * next monotonic `version` (bumped from the prior value, so a first write
   * lands at 1), builds the new sidecar via `build`, writes it, and returns the
   * new version. The two write paths fill in different fields -- a chunk carries
   * no user Metadata / `createdBy` / epoch stamp -- so `build` supplies the
   * sidecar body from the shared `{ prior, version, now }` inputs.
   * @param options {object}
   * @param options.collectionDir {string}   the dir the sidecar lives in (a
   *   Collection dir, or a chunk dir for a chunk)
   * @param options.resourceId {string}   the sidecar id (a resourceId, or the
   *   stringified chunk index)
   * @param options.build {(context: { prior?: MetaSidecar, version: number,
   *   now: string }) => MetaSidecar}   builds the sidecar to persist from the
   *   prior sidecar, the bumped `version`, and the write timestamp
   * @returns {Promise<{ version: number }>}
   */
  async #bumpSidecarVersion({
    collectionDir,
    resourceId,
    build
  }: {
    collectionDir: string
    resourceId: string
    build: (context: {
      prior?: MetaSidecar
      version: number
      now: string
    }) => MetaSidecar
  }): Promise<{ version: number }> {
    const now = new Date().toISOString()
    const prior = await this.readMetaSidecar({ collectionDir, resourceId })
    const version = (prior?.version ?? 0) + 1
    await this.#writeMetaSidecar({
      collectionDir,
      resourceId,
      sidecar: build({ prior, version, now })
    })
    return { version }
  }

  /**
   * Builds the per-Resource serialization key for `#writeMutex`
   * (`<spaceId>/<collectionId>/<resourceId>`), so conditional writes to distinct
   * Resources run concurrently while writes to the same Resource are ordered.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {string}
   */
  #resourceLockKey({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): string {
    return `${spaceId}/${collectionId}/${resourceId}`
  }

  /**
   * The Collection-level mutex key, held by unique-blinded-attribute writes to
   * serialize their conflict scans. Namespaced (`unique:` prefix) so it can
   * never collide with a per-Resource key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {string}
   */
  #collectionLockKey({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return `unique:${spaceId}/${collectionId}`
  }

  /**
   * Evaluates a conditional-write precondition against a Resource's current
   * on-disk state. MUST be called inside the per-Resource write lock so the
   * check is atomic with the write that follows. Throws
   * `PreconditionFailedError` (412) when the precondition is not met.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
   * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *` (create-if-absent)
   * @returns {Promise<void>}
   */
  async #assertWritePrecondition({
    collectionDir,
    resourceId,
    ifMatch,
    ifNoneMatch
  }: {
    collectionDir: string
    resourceId: string
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<void> {
    const exists =
      (await this.#findFile({ collectionDir, resourceId })) !== undefined
    const prior = exists
      ? await this.readMetaSidecar({ collectionDir, resourceId })
      : undefined
    assertWritePrecondition({
      resourceId,
      exists,
      currentVersion: prior?.version ?? 0,
      ifMatch,
      ifNoneMatch
    })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.contentType] {string}
   * @returns {Promise<ResourceResult>}   includes the Resource's current
   *   `version` (the ETag validator) when one is recorded in its sidecar.
   */
  async getResource({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    /**
     * `contentType` is advisory and ignored for lookup: a Resource has a
     * single current representation, resolved by `resourceId` alone.
     */
    contentType?: string
  }): Promise<ResourceResult> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    return this.#readRepresentation({
      collectionDir,
      resourceId,
      requestName: 'Get Resource'
    })
  }

  /**
   * Resolves a stored representation's read stream, content-type, and version
   * (a `ResourceResult`), shared by `getResource` and `getChunk` -- a chunk is a
   * Resource keyed by its index inside its chunk dir. The content-type is
   * derived from the filename segment (the exact type it was written under), and
   * the `version` ETag validator from the sidecar (absent only for a legacy item
   * written before versioning). Throws `ResourceNotFoundError` (404) when no
   * representation file is present. Unlike the metadata getters it does NOT
   * re-`stat` the file: the read stream's own `open` surfaces a concurrent
   * removal, so a stat existence recheck would be redundant.
   * @param options {object}
   * @param options.collectionDir {string}   the dir the representation lives in
   *   (a Collection dir, or a chunk dir for a chunk)
   * @param options.resourceId {string}   the representation id (a resourceId, or
   *   the stringified chunk index)
   * @param options.requestName {string}   used in the 404 error title
   * @returns {Promise<ResourceResult>}
   */
  async #readRepresentation({
    collectionDir,
    resourceId,
    requestName
  }: {
    collectionDir: string
    resourceId: string
    requestName: string
  }): Promise<ResourceResult> {
    const filePath = await this.#findFile({ collectionDir, resourceId })
    if (!filePath) {
      throw new ResourceNotFoundError({ requestName })
    }

    const { contentType: storedResourceType } = parseResourceFileName(
      path.basename(filePath)
    )
    const sidecar = await this.readMetaSidecar({ collectionDir, resourceId })

    return {
      resourceStream: await openFileStream(filePath, this.logger),
      storedResourceType,
      ...(sidecar?.version !== undefined && { version: sidecar.version })
    }
  }

  /**
   * Resolves a stored representation's `stat`, filename content-type, and
   * sidecar together -- the shared core of the two metadata getters
   * (`getResourceMetadata` and `getChunkMetadata`). Resolves `undefined` when no
   * representation file is present (including a delete race on `stat`). Unlike
   * `#readRepresentation`, the `stat` result is USED (the reported `size`, and
   * the timestamp fallbacks in `getResourceMetadata`), so it is not dropped.
   * @param options {object}
   * @param options.collectionDir {string}   the dir the representation lives in
   * @param options.resourceId {string}   the representation id (a resourceId, or
   *   the stringified chunk index)
   * @returns {Promise<{ stats: import('node:fs').Stats, contentType: string,
   *   sidecar?: MetaSidecar } | undefined>}
   */
  async #statRepresentation({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): Promise<
    { stats: fs.Stats; contentType: string; sidecar?: MetaSidecar } | undefined
  > {
    const filePath = await this.#findFile({ collectionDir, resourceId })
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
    const sidecar = await this.readMetaSidecar({ collectionDir, resourceId })
    return { stats, contentType, sidecar }
  }

  /**
   * Builds the on-disk path for a Resource's metadata sidecar
   * (`.meta.<resourceId>.json`) in its Collection dir.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {string}
   */
  #metaSidecarPath({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): string {
    const filePath = path.join(collectionDir, metaSidecarFileName(resourceId))
    this.#assertContained(filePath)
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
  async readMetaSidecar({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): Promise<MetaSidecar | undefined> {
    const metaStore = new MetadataJsonStore<MetaSidecar>({
      file: this.#metaSidecarPath({ collectionDir, resourceId })
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
  async #writeMetaSidecar({
    collectionDir,
    resourceId,
    sidecar
  }: {
    collectionDir: string
    resourceId: string
    sidecar: MetaSidecar
  }): Promise<void> {
    await atomicWriteFile({
      filePath: this.#metaSidecarPath({ collectionDir, resourceId }),
      data: JSON.stringify(sidecar)
    })
  }

  /**
   * Reads the metadata of a Resource's current representation: the REQUIRED
   * server-managed fields (`contentType`, `size`, both derived from the stored
   * file), plus the OPTIONAL `createdAt` / `updatedAt` timestamps and the
   * user-writable `custom` object read from the sidecar. For a Resource written
   * before sidecars existed, the timestamps fall back to the file's birth/modify
   * times and `custom` is omitted. Resolves `undefined` when the Resource is
   * absent (including a delete race on `stat`).
   *
   * Also surfaces the Resource's content `version` and its `metaVersion` (the
   * two ETag validators) when recorded in the sidecar, so the request layer can
   * set the `ETag` header: HEAD / the resource itself use the content `version`,
   * while `GET /meta` uses `metaVersion`. Both are out-of-band fields the request
   * layer reads for the header; neither is part of the Resource Metadata wire
   * body.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<(ResourceMetadata & { version?: number; metaVersion?:
   *   number }) | undefined>}
   */
  async getResourceMetadata({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<
    (ResourceMetadata & { version?: number; metaVersion?: number }) | undefined
  > {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const stated = await this.#statRepresentation({ collectionDir, resourceId })
    if (!stated) {
      return undefined
    }
    const { stats, contentType, sidecar } = stated

    const createdAt = sidecar?.createdAt ?? stats.birthtime.toISOString()
    const updatedAt = sidecar?.updatedAt ?? stats.mtime.toISOString()
    const hasCustom = sidecar?.custom && Object.keys(sidecar.custom).length > 0

    return {
      contentType,
      size: stats.size,
      createdAt,
      updatedAt,
      // Absent for a Resource created before `createdBy` was recorded; there is
      // no stat-based fallback for it, as there is for the timestamps.
      ...(sidecar?.createdBy !== undefined && { createdBy: sidecar.createdBy }),
      // `custom` is returned verbatim -- `{ name, tags }` on a plaintext
      // Collection, the opaque encryption envelope on an encrypted one.
      ...(hasCustom && { custom: sidecar!.custom as ResourceMetadataCustom }),
      // The client-declared key epoch (the `key-epochs` feature), when stamped.
      ...(sidecar?.epoch !== undefined && { epoch: sidecar.epoch }),
      ...(sidecar?.version !== undefined && { version: sidecar.version }),
      ...(sidecar?.metaVersion !== undefined && {
        metaVersion: sidecar.metaVersion
      })
    }
  }

  /**
   * Replaces the user-writable `custom` object of a Resource's metadata sidecar
   * (full replacement; `{}` clears it), bumping `updatedAt` and the independent
   * `metaVersion` (the `/meta` ETag). Does not create a Resource: resolves
   * `undefined` when the Resource is absent so the handler can 404. The content
   * `version` and the two REQUIRED server-managed fields are untouched (a
   * metadata write does not change the stored representation, preserving the
   * content ETag contract). On an encrypted Collection `custom` is the opaque
   * encryption envelope, stored verbatim.
   *
   * Runs under the per-Resource write lock -- the same lock content writes take
   * -- so an `If-Match` / `If-None-Match` precondition (evaluated on
   * `metaVersion`) is atomic with the write and serializes with concurrent
   * content/metadata writes to the same Resource. A precondition mismatch throws
   * `PreconditionFailedError` (412).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.custom {ResourceMetadataCustom | Record<string, unknown>}
   * @param [options.ifMatch] {string}   `If-Match` on the current `metaVersion`
   * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *` -- write only if
   *   no metadata has been written yet (`metaVersion` unset)
   * @returns {Promise<{ metaVersion: number } | undefined>}   the new
   *   `metaVersion`, or `undefined` when the Resource does not exist
   */
  async writeResourceMetadata({
    spaceId,
    collectionId,
    resourceId,
    custom,
    epoch,
    uniqueIndexes,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    custom: ResourceMetadataCustom | Record<string, unknown>
    epoch?: string
    uniqueIndexes?: NormalizedIndexDeclaration[]
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<{ metaVersion: number } | undefined> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const writeMeta = async (): Promise<
      { metaVersion: number } | undefined
    > => {
      const filePath = await this.#findFile({ collectionDir, resourceId })
      if (!filePath) {
        return undefined
      }
      const prior = await this.readMetaSidecar({ collectionDir, resourceId })
      // Evaluate the `/meta` precondition against the current `metaVersion`
      // atomically under the lock, before writing. `If-None-Match: *` means
      // "only if no metadata has been written yet"; `If-Match` pins the current
      // `metaVersion` ETag.
      assertMetaWritePrecondition({
        resourceId,
        metaVersion: prior?.metaVersion,
        ifMatch,
        ifNoneMatch
      })

      const now = new Date().toISOString()
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
      const metaVersion = (prior?.metaVersion ?? 0) + 1
      const hasCustom = Object.keys(custom).length > 0
      // The key-epoch stamp describes the CONTENT write, not this metadata
      // write, so a supplied `epoch` replaces it but an omitted one PRESERVES
      // the stored value (unlike `custom`, which is full-replace).
      const resolvedEpoch = epoch ?? prior?.epoch
      await this.#writeMetaSidecar({
        collectionDir,
        resourceId,
        sidecar: {
          createdAt,
          updatedAt: now,
          // Preserve the server-managed creator: a metadata write replaces only
          // `custom`, and `createdBy` is not user-writable.
          ...(prior?.createdBy !== undefined && {
            createdBy: prior.createdBy
          }),
          // Preserve the content `version` (ETag) -- a metadata write does not
          // change the stored representation.
          ...(prior?.version !== undefined && { version: prior.version }),
          metaVersion,
          ...(hasCustom && { custom }),
          ...(resolvedEpoch !== undefined && { epoch: resolvedEpoch })
        }
      })
      return { metaVersion }
    }
    // A metadata write can create a plaintext equality unique claim for a
    // `custom`-sourced attribute (the `equality-query` feature). When the
    // Collection declares any unique index, serialize on the Collection lock and
    // scan for a conflict -- content is the Resource's stored JSON content
    // (unchanged by a metadata write), custom is the incoming value this write
    // sets -- before taking the per-Resource lock nested inside. Distinct-key
    // nesting cannot deadlock (plain writes never hold a Resource key while
    // waiting on a Collection key).
    if (uniqueIndexes !== undefined && uniqueIndexes.length > 0) {
      return this.#writeMutex.run(
        this.#collectionLockKey({ spaceId, collectionId }),
        async () => {
          assertNoUniqueEqualityConflict({
            indexes: uniqueIndexes,
            content: await this.#readResourceJsonContent({
              collectionDir,
              resourceId
            }),
            custom,
            candidates: await this.#readEqualityCandidates({
              spaceId,
              collectionId,
              excludeResourceId: resourceId
            })
          })
          return this.#writeMutex.run(
            this.#resourceLockKey({ spaceId, collectionId, resourceId }),
            writeMeta
          )
        }
      )
    }
    return this.#writeMutex.run(
      this.#resourceLockKey({ spaceId, collectionId, resourceId }),
      writeMeta
    )
  }

  /**
   * Soft-deletes a Resource: drops its content representation but keeps the
   * sidecar as a **tombstone** (`deleted: true`, a bumped `version` and
   * `updatedAt`, the last-known `contentType` retained) so the change feed
   * (replication) still surfaces it until clients catch up (GC of tombstones is
   * future work). With no content file left, the tombstone is invisible to
   * every normal read path
   * (`getResource` / `getResourceMetadata` / `listCollectionItems` all gate on
   * the content file via `#findFile`, so they 404 / skip it), making soft delete
   * transparent to the existing API.
   *
   * When `ifMatch` is supplied (the `conditional-writes` feature), the delete
   * proceeds only if the Resource exists and its current `ETag` matches, else
   * `PreconditionFailedError` (412). The whole read-modify-write runs under the
   * per-Resource write lock so it serializes with concurrent writes. The delete
   * is idempotent: an already-absent Resource (never created, or an existing
   * tombstone) is a no-op, leaving any tombstone's change-feed entry stable.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.ifMatch] {string}   `If-Match` precondition (a quoted ETag)
   * @returns {Promise<void>}
   */
  async deleteResource({
    spaceId,
    collectionId,
    resourceId,
    ifMatch
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    ifMatch?: string
  }): Promise<void> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    // Freed bytes: drop the cached quota usage so the next write re-measures.
    this.#usageCache.delete(spaceId)
    const softDelete = async (): Promise<void> => {
      if (ifMatch !== undefined) {
        await this.#assertWritePrecondition({
          collectionDir,
          resourceId,
          ifMatch
        })
      }
      // A Resource has a single current representation, so this normally matches
      // one file. The segment-anchored match in `#resourceFilesFor` keeps a
      // prefix id (e.g. `note` vs `notebook`) from being swept up too.
      const filesForResource = await this.#resourceFilesFor({
        collectionDir,
        resourceId
      })
      if (filesForResource.length === 0) {
        // Already absent (never existed, or already a tombstone): idempotent
        // no-op. Leaving an existing tombstone untouched keeps its change-feed
        // entry (its `updatedAt` / `version`) stable.
        return
      }
      // Capture the representation's last-known content-type from its filename
      // before removing it: once the content file is gone the tombstone sidecar
      // is the only record of it, and the change feed reports it.
      const { contentType } = parseResourceFileName(
        path.basename(filesForResource[0]!)
      )
      // Drop the content representation(s) but KEEP the sidecar as the tombstone.
      await Promise.all(filesForResource.map(filename => rm(filename)))
      // Cascade-delete the Resource's chunks (the `chunked-streams` feature): a
      // chunk must never outlive its parent Resource, so its whole chunk
      // directory goes with the content. Runs under the same per-Resource lock a
      // `writeChunk` takes, so a chunk write racing this delete cannot re-create
      // an orphan directory. `force` makes an absent chunk directory a no-op.
      await rm(this.#chunkDir({ collectionDir, resourceId }), {
        recursive: true,
        force: true
      })
      // Bump `version` / `updatedAt` so the tombstone sorts after the Resource's
      // prior state in the change feed, and continues the monotonic version (a
      // later re-create reads this sidecar and keeps counting up). `custom` is
      // dropped: the user Metadata goes with the deleted Resource. `createdAt` /
      // `createdBy` are kept: they are the server's record of the Resource's
      // origin, which a re-create under the same id continues.
      const now = new Date().toISOString()
      const prior = await this.readMetaSidecar({ collectionDir, resourceId })
      await this.#writeMetaSidecar({
        collectionDir,
        resourceId,
        sidecar: {
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
          ...(prior?.createdBy !== undefined && {
            createdBy: prior.createdBy
          }),
          version: (prior?.version ?? 0) + 1,
          deleted: true,
          contentType
        }
      })
    }
    // The soft delete is a read-modify-write on the sidecar, so it always
    // serializes with concurrent writes under the per-Resource lock (not only
    // for a conditional delete, as the old unconditional removal did).
    return this.#writeMutex.run(
      this.#resourceLockKey({ spaceId, collectionId, resourceId }),
      softDelete
    )
  }

  // Chunks (the `chunked-streams` feature)

  /**
   * Builds the on-disk path for a Resource's chunk directory
   * (`.chunks.<encodedResourceId>/`) inside its Collection dir. A hidden
   * subdirectory (leading `.`, so it is invisible to the `r.`-prefixed Collection
   * listing and the live-Resource count) that holds the Resource's chunk
   * representations; inside it a chunk is stored exactly like a Resource keyed by
   * its index (`r.<index>.<encodedContentType>.<ext>` plus a `.meta.<index>.json`
   * version sidecar), so the Resource file / sidecar helpers are reused verbatim
   * with the chunk directory as the `collectionDir`.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {string}
   */
  #chunkDir({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): string {
    const chunkDir = path.join(collectionDir, chunkDirName(resourceId))
    this.#assertContained(chunkDir)
    return chunkDir
  }

  /**
   * Writes one chunk of a chunked Resource, keyed by
   * `(spaceId, collectionId, resourceId, chunkIndex)`. The parent Resource MUST
   * already exist (else `ResourceNotFoundError`, 404), checked under the same
   * per-Resource lock a `deleteResource` cascade takes so a chunk can never be
   * orphaned by a racing delete. The body is stored opaquely (bytes +
   * content-type) through the shared upload-cap / quota guards, and the chunk's
   * own monotonic `version` (its ETag validator, independent of the parent's) is
   * bumped; any `If-Match` / `If-None-Match` precondition is evaluated on that
   * version atomically with the write (`PreconditionFailedError`, 412).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}   non-negative integer chunk position
   * @param options.input {ResourceInput}
   * @param [options.ifMatch] {string}   `If-Match` precondition (a quoted ETag)
   * @param [options.ifNoneMatch] {boolean}   `If-None-Match: *` (create-if-absent)
   * @returns {Promise<{ version: number }>}   the chunk's new version
   */
  async writeChunk({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex,
    input,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
    input: ResourceInput
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<{ version: number }> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    // Serialize on the parent Resource's lock key -- the same key
    // `deleteResource` takes -- so the parent-exists check, the write, and the
    // cascade delete cannot interleave (no orphan chunk).
    return this.#writeMutex.run(
      this.#resourceLockKey({ spaceId, collectionId, resourceId }),
      () =>
        this.#writeChunkLocked({
          spaceId,
          collectionDir,
          resourceId,
          chunkIndex,
          input,
          ifMatch,
          ifNoneMatch
        })
    )
  }

  /**
   * The critical section of `writeChunk`, run under the per-Resource lock. See
   * `writeChunk` for the parameters.
   * @returns {Promise<{ version: number }>}
   */
  async #writeChunkLocked({
    spaceId,
    collectionDir,
    resourceId,
    chunkIndex,
    input,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionDir: string
    resourceId: string
    chunkIndex: number
    input: ResourceInput
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<{ version: number }> {
    // The parent Resource must exist: writing a chunk of an absent Resource
    // rejects, so orphan chunks cannot accumulate.
    const parentExists =
      (await this.#findFile({ collectionDir, resourceId })) !== undefined
    if (!parentExists) {
      throw new ResourceNotFoundError({ requestName: 'Write Chunk' })
    }

    // Inside the chunk directory a chunk is a Resource keyed by its index, so the
    // Resource file / sidecar helpers apply with `chunkDir` as the collectionDir
    // and the stringified index as the resourceId.
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    const chunkId = String(chunkIndex)
    const filename = fileNameFor({
      resourceId: chunkId,
      contentType: input.contentType
    })
    const filePath = path.join(chunkDir, filename)
    this.#assertContained(filePath)

    // Evaluate any precondition against the chunk's current version before
    // writing (still inside the lock, so check and write are atomic).
    if (ifMatch !== undefined || ifNoneMatch) {
      await this.#assertWritePrecondition({
        collectionDir: chunkDir,
        resourceId: chunkId,
        ifMatch,
        ifNoneMatch
      })
    }

    // The chunk directory is created lazily on first write (a binary body is
    // streamed into a temp file in it, so it must exist first).
    await mkdir(chunkDir, { recursive: true })
    await this.#writeRepresentationBytes({ spaceId, filePath, input })

    // A chunk has a single current representation: remove any prior one stored
    // under a different content-type (write-new-then-prune).
    await this.#pruneStaleRepresentations({
      collectionDir: chunkDir,
      resourceId: chunkId,
      keepPath: filePath
    })

    // Bump the chunk's monotonic `version` (its ETag validator), preserving its
    // `createdAt`. A chunk carries no user Metadata / `createdBy` / epoch stamp.
    return this.#bumpSidecarVersion({
      collectionDir: chunkDir,
      resourceId: chunkId,
      build: ({ prior, version, now }) => ({
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
        version
      })
    })
  }

  /**
   * Reads a chunk's bytes, resolving a `ResourceResult` (stream + resolved
   * content-type + the chunk's `version`). Throws `ResourceNotFoundError` (404)
   * when the chunk is absent.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @returns {Promise<ResourceResult>}
   */
  async getChunk({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<ResourceResult> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    // A chunk is a Resource keyed by its index inside its chunk dir, so the
    // shared representation reader applies with `chunkDir` as the collectionDir.
    return this.#readRepresentation({
      collectionDir: chunkDir,
      resourceId: String(chunkIndex),
      requestName: 'Get Chunk'
    })
  }

  /**
   * Reads a chunk's stored content-type / size / version (the HEAD payload
   * headers). Resolves `undefined` when the chunk is absent.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @returns {Promise<ChunkMetadata|undefined>}
   */
  async getChunkMetadata({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<ChunkMetadata | undefined> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    // A chunk is a Resource keyed by its index inside its chunk dir, so the
    // shared stat/sidecar reader applies with `chunkDir` as the collectionDir.
    const stated = await this.#statRepresentation({
      collectionDir: chunkDir,
      resourceId: String(chunkIndex)
    })
    if (!stated) {
      return undefined
    }
    const { stats, contentType, sidecar } = stated
    return {
      contentType,
      size: stats.size,
      ...(sidecar?.version !== undefined && { version: sidecar.version })
    }
  }

  /**
   * Deletes one chunk (a hard delete: its bytes and version sidecar both go, and
   * -- unlike a Resource -- it leaves no tombstone, since chunks are not part of
   * the change feed). Resolves `true` when a chunk was removed and `false` when
   * none was stored at that index. When `ifMatch` is supplied it is evaluated on
   * the chunk's current version atomically with the removal (under the same
   * per-Resource lock), throwing `PreconditionFailedError` (412) on a mismatch.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @param [options.ifMatch] {string}   `If-Match` precondition (a quoted ETag)
   * @returns {Promise<boolean>}
   */
  async deleteChunk({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex,
    ifMatch
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
    ifMatch?: string
  }): Promise<boolean> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    const chunkId = String(chunkIndex)
    return this.#writeMutex.run(
      this.#resourceLockKey({ spaceId, collectionId, resourceId }),
      async () => {
        const files = await this.#resourceFilesFor({
          collectionDir: chunkDir,
          resourceId: chunkId
        })
        if (files.length === 0) {
          // Absent: the handler 404s on `false` (chunk deletes are not silently
          // idempotent, mirroring the EDV chunk contract).
          return false
        }
        if (ifMatch !== undefined) {
          await this.#assertWritePrecondition({
            collectionDir: chunkDir,
            resourceId: chunkId,
            ifMatch
          })
        }
        await Promise.all(files.map(name => rm(name)))
        // Remove the version sidecar too: a chunk keeps no tombstone.
        await rm(
          this.#metaSidecarPath({
            collectionDir: chunkDir,
            resourceId: chunkId
          }),
          { force: true }
        )
        // When that was the last chunk, remove the now-empty chunk directory
        // itself: a lingering empty `.chunks.<encId>/` would otherwise appear
        // in the export walk (diverging from a Postgres export of the same
        // logical state) and count its allocated block toward the du-based
        // quota measurement. Safe under the per-Resource lock (`writeChunk`
        // serializes on the same key, so nothing lands in the directory
        // between the check and the rmdir).
        const remaining = await fs.promises.readdir(chunkDir)
        if (remaining.length === 0) {
          await fs.promises.rmdir(chunkDir)
        }
        // Freed bytes: drop the cached quota usage so the next write re-measures.
        this.#usageCache.delete(spaceId)
        return true
      }
    )
  }

  /**
   * Lists a Resource's stored chunks in ascending `index` order -- the
   * discovery/reassembly listing (the server never reassembles). Resolves an
   * empty listing when the Resource has no chunk directory (including when the
   * Resource itself is absent -- existence is the parent routes' concern).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<ChunkListing>}
   */
  async listChunks({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<ChunkListing> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(chunkDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { count: 0, chunks: [] }
      }
      throw err
    }

    // Keep only chunk representations (`r.<index>.<type>.<ext>`), dropping the
    // `.meta.<index>.json` version sidecars.
    const chunkEntries = entries.filter(
      entry => entry.isFile() && isRepresentationFileName(entry.name)
    )
    const chunks = await Promise.all(
      chunkEntries.map(async entry => {
        const { resourceId: indexStr, contentType } = parseResourceFileName(
          entry.name
        )
        const filePath = path.join(chunkDir, entry.name)
        const stats = await fsStat(filePath)
        const sidecar = await this.readMetaSidecar({
          collectionDir: chunkDir,
          resourceId: indexStr
        })
        return {
          index: Number(indexStr),
          size: stats.size,
          contentType,
          ...(sidecar?.version !== undefined && { version: sidecar.version })
        }
      })
    )
    chunks.sort((left, right) => left.index - right.index)
    return { count: chunks.length, chunks }
  }

  /**
   * Replication change feed (the `changes` query profile; see the
   * `StorageBackend.changesSince` contract.
   * Enumerates the Collection once, builds a lightweight descriptor for every
   * JSON-document Resource (live) and JSON tombstone, orders them by
   * `(updatedAt, resourceId)`, seeks strictly past `checkpoint`, takes a page of
   * `limit`, and reads JSON bodies ONLY for that page. O(n) over the Collection
   * per call (it must read every sidecar to order by `updatedAt`) -- acceptable
   * for this teaching backend; an indexed backend would answer it from an
   * `updatedAt` index.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.checkpoint] {{ id: string, updatedAt: string }}   resume position
   * @param options.limit {number}   page cap (clamped to the backend maximum)
   * @returns {Promise<{ documents: Array<object>, checkpoint: object | null }>}
   */
  async changesSince({
    spaceId,
    collectionId,
    checkpoint,
    limit
  }: {
    spaceId: string
    collectionId: string
    checkpoint?: { id: string; updatedAt: string }
    limit: number
  }): Promise<{
    documents: Array<{
      resourceId: string
      version: number
      metaVersion?: number
      createdBy?: IDID
      updatedAt: string
      deleted: boolean
      data?: unknown
      custom?: ResourceMetadataCustom | Record<string, unknown>
      epoch?: string
    }>
    checkpoint: { id: string; updatedAt: string } | null
  }> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })

    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(collectionDir, {
        withFileTypes: true
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    // Index the dir: live content files by id, and the set of ids that have a
    // `.meta.` sidecar (a sidecar with no live file is a tombstone candidate).
    const liveFileById = new Map<
      string,
      { fileName: string; contentType: string }
    >()
    const sidecarIds = new Set<string>()
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue
      }
      if (isRepresentationFileName(entry.name)) {
        const { resourceId, contentType } = parseResourceFileName(entry.name)
        liveFileById.set(resourceId, { fileName: entry.name, contentType })
      } else {
        const sidecarId = metaSidecarFileId(entry.name)
        if (sidecarId !== undefined) {
          sidecarIds.add(sidecarId)
        }
      }
    }

    // Build descriptors (no body reads yet): one per JSON-document Resource
    // (live) or JSON tombstone. Binary Resources and anomalous orphan sidecars
    // (sidecar present but not a tombstone) are excluded. Each sidecar read is
    // an independent file read, so the whole pass runs in parallel. A live
    // descriptor carries the `fileName` to read its body from; a tombstone has
    // none -- the discriminated union ties that to `deleted`.
    type Descriptor =
      | {
          resourceId: string
          version: number
          metaVersion?: number
          createdBy?: IDID
          updatedAt: string
          deleted: false
          fileName: string
          custom?: ResourceMetadataCustom | Record<string, unknown>
          epoch?: string
        }
      | {
          resourceId: string
          version: number
          metaVersion?: number
          createdBy?: IDID
          updatedAt: string
          deleted: true
        }
    const liveDescriptors = [...liveFileById].map(
      async ([resourceId, live]): Promise<Descriptor | undefined> => {
        if (!isJson({ contentType: live.contentType })) {
          return undefined
        }
        const sidecar = await this.readMetaSidecar({
          collectionDir,
          resourceId
        })
        // `updatedAt` / `version` come from the sidecar; fall back to the file's
        // mtime for a legacy Resource written before sidecars existed.
        let updatedAt = sidecar?.updatedAt
        if (!updatedAt) {
          try {
            updatedAt = (
              await fsStat(path.join(collectionDir, live.fileName))
            ).mtime.toISOString()
          } catch {
            return undefined
          }
        }
        return {
          resourceId,
          version: sidecar?.version ?? 0,
          ...(sidecar?.metaVersion !== undefined && {
            metaVersion: sidecar.metaVersion
          }),
          // The creator's DID rides the feed so provenance replicates with the
          // document, rather than needing a `/meta` fetch per Resource.
          ...(sidecar?.createdBy !== undefined && {
            createdBy: sidecar.createdBy
          }),
          updatedAt,
          deleted: false,
          fileName: live.fileName,
          // The user-writable `custom` (the opaque encryption envelope on an
          // encrypted Collection) rides the feed so metadata replicates
          // alongside content; read from the sidecar already loaded here.
          ...(sidecar?.custom !== undefined && { custom: sidecar.custom }),
          // The client-declared key epoch (the `key-epochs` feature) rides the
          // feed so a replicating reader picks the right epoch key.
          ...(sidecar?.epoch !== undefined && { epoch: sidecar.epoch })
        }
      }
    )
    // A sidecar with no live file is a tombstone candidate; keep only the ones
    // that are actually tombstones (`deleted: true`) and JSON.
    const tombstoneDescriptors = [...sidecarIds]
      .filter(resourceId => !liveFileById.has(resourceId))
      .map(async (resourceId): Promise<Descriptor | undefined> => {
        const sidecar = await this.readMetaSidecar({
          collectionDir,
          resourceId
        })
        if (
          sidecar?.deleted !== true ||
          !isJson({ contentType: sidecar.contentType })
        ) {
          return undefined
        }
        return {
          resourceId,
          version: sidecar.version ?? 0,
          ...(sidecar.metaVersion !== undefined && {
            metaVersion: sidecar.metaVersion
          }),
          // A tombstone keeps its creator, as it keeps its `createdAt`.
          ...(sidecar.createdBy !== undefined && {
            createdBy: sidecar.createdBy
          }),
          updatedAt: sidecar.updatedAt,
          deleted: true
        }
      })
    const descriptors = (
      await Promise.all([...liveDescriptors, ...tombstoneDescriptors])
    ).filter((desc): desc is Descriptor => desc !== undefined)

    // Order by `(updatedAt, resourceId)` ascending -- the SAME total order the
    // checkpoint seek uses (ISO-8601 `updatedAt` sorts chronologically as a
    // string; `resourceId` breaks same-instant ties), so the keyset is stable.
    descriptors.sort(
      (left, right) =>
        compareCodeUnits(left.updatedAt, right.updatedAt) ||
        compareCodeUnits(left.resourceId, right.resourceId)
    )

    // Seek to the first descriptor strictly after the checkpoint's position.
    let startIndex = 0
    if (checkpoint !== undefined) {
      const found = descriptors.findIndex(
        desc =>
          desc.updatedAt > checkpoint.updatedAt ||
          (desc.updatedAt === checkpoint.updatedAt &&
            desc.resourceId > checkpoint.id)
      )
      startIndex = found === -1 ? descriptors.length : found
    }

    const pageSize = clampPageSize(limit)
    const pageDescriptors = descriptors.slice(startIndex, startIndex + pageSize)

    // Read JSON bodies only for this page. A tombstone carries no `data` (the
    // delete replicates on `deleted: true` alone).
    const documents = await Promise.all(
      pageDescriptors.map(async desc => {
        if (desc.deleted) {
          return {
            resourceId: desc.resourceId,
            version: desc.version,
            ...(desc.metaVersion !== undefined && {
              metaVersion: desc.metaVersion
            }),
            ...(desc.createdBy !== undefined && { createdBy: desc.createdBy }),
            updatedAt: desc.updatedAt,
            deleted: true
          }
        }
        let data: unknown
        try {
          data = JSON.parse(
            await fs.promises.readFile(
              path.join(collectionDir, desc.fileName),
              'utf8'
            )
          )
        } catch {
          data = undefined
        }
        return {
          resourceId: desc.resourceId,
          version: desc.version,
          ...(desc.metaVersion !== undefined && {
            metaVersion: desc.metaVersion
          }),
          ...(desc.createdBy !== undefined && { createdBy: desc.createdBy }),
          updatedAt: desc.updatedAt,
          deleted: false,
          data,
          // Surface the user-writable `custom` (opaque envelope on an encrypted
          // Collection) so a metadata-only edit replicates.
          ...(desc.custom !== undefined && { custom: desc.custom }),
          // Surface the client-declared key epoch (the `key-epochs` feature).
          ...(desc.epoch !== undefined && { epoch: desc.epoch })
        }
      })
    )

    const last = documents[documents.length - 1]
    return {
      documents,
      checkpoint: last
        ? { id: last.resourceId, updatedAt: last.updatedAt }
        : null
    }
  }

  /**
   * Blinded-index query (the `blinded-index` query profile; see the
   * `StorageBackend.queryByBlindedIndex` contract). Enumerates the Collection
   * dir, reads and parses every live JSON Resource, and hands the candidates
   * to the shared evaluator (`lib/blindedIndex.ts`) for matching, ordering,
   * and cursor pagination. O(n) over the Collection per call, with every JSON
   * body read -- acceptable for this teaching backend; an indexed backend
   * would answer from flattened attribute tokens. Tombstones are excluded
   * naturally (no live content file); binary Resources and unparsable JSON
   * are skipped.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.query {BlindedIndexQuery}
   * @param [options.count] {boolean}   return only the match count
   * @param [options.limit] {number}   requested page size
   * @param [options.cursor] {string}   opaque cursor from a prior page
   * @returns {Promise<{ count: number } | BlindedIndexQueryPage>}
   */
  async queryByBlindedIndex({
    spaceId,
    collectionId,
    query,
    count,
    limit,
    cursor
  }: {
    spaceId: string
    collectionId: string
    query: BlindedIndexQuery
    count?: boolean
    limit?: number
    cursor?: string
  }): Promise<{ count: number } | BlindedIndexQueryPage> {
    const candidates = await this.#readJsonCandidates({
      spaceId,
      collectionId
    })
    return runBlindedIndexQuery({ candidates, query, count, limit, cursor })
  }

  /**
   * Reads and parses every live JSON Resource of a Collection -- the candidate
   * set for both the blinded-index query and the unique-attribute conflict
   * scan. Tombstones are excluded naturally (no live content file); binary
   * Resources, unparsable JSON, and (optionally) one excluded Resource are
   * skipped. An absent Collection dir resolves empty.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.excludeResourceId] {string}   omit this Resource (the
   *   conflict scan excludes the document being written)
   * @returns {Promise<Array<{ resourceId: string, document: unknown }>>}
   */
  async #readJsonCandidates({
    spaceId,
    collectionId,
    excludeResourceId
  }: {
    spaceId: string
    collectionId: string
    excludeResourceId?: string
  }): Promise<Array<{ resourceId: string; document: unknown }>> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })

    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(collectionDir, {
        withFileTypes: true
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    return (
      await Promise.all(
        entries
          .filter(
            entry => entry.isFile() && isRepresentationFileName(entry.name)
          )
          .map(entry => ({
            fileName: entry.name,
            ...parseResourceFileName(entry.name)
          }))
          .filter(
            ({ resourceId, contentType }) =>
              resourceId !== excludeResourceId && isJson({ contentType })
          )
          .map(async ({ resourceId, fileName }) => {
            try {
              return {
                resourceId,
                document: JSON.parse(
                  await fs.promises.readFile(
                    path.join(collectionDir, fileName),
                    'utf8'
                  )
                ) as unknown
              }
            } catch {
              return undefined
            }
          })
      )
    ).filter(candidate => candidate !== undefined)
  }

  /**
   * Plaintext equality query (the `equality` query profile; see the
   * `StorageBackend.queryByEquality` contract). Reads every live Resource of
   * the Collection -- JSON Resources carrying parsed `content`, blobs carrying
   * only their sidecar `custom` -- and hands the candidates to the shared
   * evaluator (`lib/equalityIndex.ts`) for extraction, matching, ordering, and
   * cursor pagination. O(n) over the Collection per call, with every JSON body
   * read -- deliberate for this teaching backend; a materialized backend would
   * answer from an attribute index. Tombstones are excluded naturally (no live
   * content file).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.query {EqualityQuery}
   * @param options.indexes {NormalizedIndexDeclaration[]}   the normalized
   *   declared indexes (the request layer resolves them from the description)
   * @param [options.count] {boolean}   return only the match count
   * @param [options.limit] {number}   requested page size
   * @param [options.cursor] {string}   opaque cursor from a prior page
   * @returns {Promise<{ count: number } | EqualityQueryPage>}
   */
  async queryByEquality({
    spaceId,
    collectionId,
    query,
    indexes,
    count,
    limit,
    cursor
  }: {
    spaceId: string
    collectionId: string
    query: EqualityQuery
    indexes: NormalizedIndexDeclaration[]
    count?: boolean
    limit?: number
    cursor?: string
  }): Promise<{ count: number } | EqualityQueryPage> {
    const candidates = await this.#readEqualityCandidates({
      spaceId,
      collectionId
    })
    return runEqualityQuery({
      candidates,
      query,
      indexes,
      count,
      limit,
      cursor
    })
  }

  /**
   * Declare-time uniqueness scan for the `equality` profile (see the
   * `StorageBackend.findEqualityUniqueViolation` contract): reads the
   * Collection's live Resources and delegates to the shared scan, which reports
   * the first `(name, value)` claimed by two different Resources under the given
   * `unique` declarations (or `undefined` when none is).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.indexes {NormalizedIndexDeclaration[]}
   * @returns {Promise<{ name: string, value: EqualityValue } | undefined>}
   */
  async findEqualityUniqueViolation({
    spaceId,
    collectionId,
    indexes
  }: {
    spaceId: string
    collectionId: string
    indexes: NormalizedIndexDeclaration[]
  }): Promise<{ name: string; value: EqualityValue } | undefined> {
    const candidates = await this.#readEqualityCandidates({
      spaceId,
      collectionId
    })
    return findEqualityUniqueViolation({ indexes, candidates })
  }

  /**
   * Reads every live Resource of a Collection as an equality candidate -- the
   * candidate set for the equality query and the plaintext unique-attribute
   * conflict scans. Unlike `#readJsonCandidates` this INCLUDES blob Resources
   * (a blob is queryable through its `custom`-sourced attributes): each entry
   * resolves `{ resourceId, content?, custom? }`, where `content` is the parsed
   * JSON of a JSON-typed representation (the blob content read is skipped, and
   * unparsable JSON is dropped, as in `#readJsonCandidates`) and `custom` is the
   * `.meta.` sidecar's `custom` when present. Tombstones are excluded naturally
   * (no live `r.` content file); an optional excluded Resource is skipped. An
   * absent Collection dir resolves empty.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.excludeResourceId] {string}   omit this Resource (a conflict
   *   scan excludes the Resource being written)
   * @returns {Promise<EqualityCandidate[]>}
   */
  async #readEqualityCandidates({
    spaceId,
    collectionId,
    excludeResourceId
  }: {
    spaceId: string
    collectionId: string
    excludeResourceId?: string
  }): Promise<EqualityCandidate[]> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })

    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(collectionDir, {
        withFileTypes: true
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    return await Promise.all(
      entries
        .filter(entry => entry.isFile() && isRepresentationFileName(entry.name))
        .map(entry => ({
          fileName: entry.name,
          ...parseResourceFileName(entry.name)
        }))
        .filter(({ resourceId }) => resourceId !== excludeResourceId)
        .map(async ({ resourceId, fileName, contentType }) => {
          // Parse the content only for a JSON representation; a blob contributes
          // no content-sourced attributes (its `custom` still makes it
          // queryable). Unparsable JSON is treated as no content.
          let content: unknown
          if (isJson({ contentType })) {
            try {
              content = JSON.parse(
                await fs.promises.readFile(
                  path.join(collectionDir, fileName),
                  'utf8'
                )
              ) as unknown
            } catch {
              content = undefined
            }
          }
          const sidecar = await this.readMetaSidecar({
            collectionDir,
            resourceId
          })
          return {
            resourceId,
            ...(content !== undefined && { content }),
            ...(sidecar?.custom !== undefined && { custom: sidecar.custom })
          }
        })
    )
  }

  /**
   * Reads and parses a single Resource's stored JSON content, or resolves
   * `undefined` when the Resource is absent, a blob, or unparsable JSON -- the
   * content side of a custom-sourced unique-attribute claim on a metadata write.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {Promise<unknown>}
   */
  async #readResourceJsonContent({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): Promise<unknown> {
    const filePath = await this.#findFile({ collectionDir, resourceId })
    if (!filePath) {
      return undefined
    }
    const { contentType } = parseResourceFileName(path.basename(filePath))
    if (!isJson({ contentType })) {
      return undefined
    }
    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown
    } catch {
      return undefined
    }
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
  #policyFile({
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
        ? this.#collectionDir({ spaceId, collectionId })
        : this.#spaceDir(spaceId)
    const filename = `.policy.${resourceId ?? collectionId ?? spaceId}.json`
    const filePath = path.join(dir, filename)
    this.#assertContained(filePath)
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
      file: this.#policyFile({ spaceId, collectionId, resourceId })
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
      await this.#ensureCollectionDir({ spaceId, collectionId })
    } else {
      await this.#ensureSpaceDir({ spaceId })
    }
    await atomicWriteFile({
      filePath: this.#policyFile({ spaceId, collectionId, resourceId }),
      data: JSON.stringify(policy)
    })
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
    await rm(this.#policyFile({ spaceId, collectionId, resourceId }), {
      force: true
    })
  }

  // Registered external backends (spec "Backends")

  /**
   * Builds the on-disk path for a registered backend record: a
   * `.backend.<backendId>.json` dot-file in the Space dir (the same per-file
   * convention as `.policy.` / `.space.`). One file per backend id.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @returns {string}
   */
  #backendFile({
    spaceId,
    backendId
  }: {
    spaceId: string
    backendId: string
  }): string {
    const filePath = path.join(
      this.#spaceDir(spaceId),
      `.backend.${backendId}.json`
    )
    this.#assertContained(filePath)
    return filePath
  }

  /**
   * Persists a full (secret-bearing) backend-registration record. Upsert.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @param options.record {StoredBackendRecord}
   * @returns {Promise<void>}
   */
  async writeBackend({
    spaceId,
    backendId,
    record
  }: {
    spaceId: string
    backendId: string
    record: StoredBackendRecord
  }): Promise<void> {
    await this.#ensureSpaceDir({ spaceId })
    await atomicWriteFile({
      filePath: this.#backendFile({ spaceId, backendId }),
      data: JSON.stringify(record)
    })
  }

  /**
   * Reads the full (secret-bearing) record for one backend, for internal use
   * (existence checks, the future provider adapter). Resolves `undefined` when
   * absent. The only method that exposes secret connection material.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @returns {Promise<StoredBackendRecord|undefined>}
   */
  async getBackend({
    spaceId,
    backendId
  }: {
    spaceId: string
    backendId: string
  }): Promise<StoredBackendRecord | undefined> {
    const metaStore = new MetadataJsonStore<StoredBackendRecord>({
      file: this.#backendFile({ spaceId, backendId })
    })
    return await metaStore.read()
  }

  /**
   * Enumerates the Space's registered backends and returns them **sanitized**
   * (each mapped through `sanitizeBackendRecord`, so the secret connection
   * material never reaches the listing), sorted by id. An absent Space dir
   * reports no registered backends rather than throwing.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<BackendDescriptor[]>}
   */
  async listBackends({
    spaceId
  }: {
    spaceId: string
  }): Promise<BackendDescriptor[]> {
    const spaceDir = this.#spaceDir(spaceId)
    let entries
    try {
      entries = await fs.promises.readdir(spaceDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
    const backendFile = /^\.backend\.(.+)\.json$/
    const reads = entries
      .filter(entry => entry.isFile() && backendFile.test(entry.name))
      .map(entry =>
        new MetadataJsonStore<StoredBackendRecord>({
          file: path.join(spaceDir, entry.name)
        }).read()
      )
    const records = (await Promise.all(reads)).filter(
      (record): record is StoredBackendRecord => Boolean(record)
    )
    records.sort((a, b) => a.id.localeCompare(b.id))
    return records.map(sanitizeBackendRecord)
  }

  /**
   * Removes a registered backend record. Idempotent (no error if absent).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @returns {Promise<void>}
   */
  async deleteBackend({
    spaceId,
    backendId
  }: {
    spaceId: string
    backendId: string
  }): Promise<void> {
    await rm(this.#backendFile({ spaceId, backendId }), { force: true })
  }

  /**
   * WebKMS keystores (the `/kms` facet). A sibling tree to Spaces:
   * `keystores/<localId>/` holds a keystore's `config.json` now, and its key
   * records / revocations in later tracks -- hence a directory per keystore
   * rather than a flat file.
   *
   * The directory holding one keystore's records, contained in `keystoresDir`.
   * @param keystoreId {string}   the keystore's server-generated local id
   * @returns {string}
   */
  #keystoreDir(keystoreId: string): string {
    const keystoreDir = path.join(this.keystoresDir, keystoreId)
    this.#assertContained(keystoreDir, this.keystoresDir)
    return keystoreDir
  }

  #keystoreConfigFile(keystoreId: string): string {
    return path.join(this.#keystoreDir(keystoreId), 'config.json')
  }

  /**
   * Persists a keystore config unconditionally (the create path -- local ids
   * are server-generated random values, so create never collides). The
   * sequence-gated update path is `updateKeystore`.
   * @param options {object}
   * @param options.keystoreId {string}   the keystore's local id
   * @param options.config {KeystoreConfig}
   * @returns {Promise<void>}
   */
  async writeKeystore({
    keystoreId,
    config
  }: {
    keystoreId: string
    config: KeystoreConfig
  }): Promise<void> {
    await mkdir(this.#keystoreDir(keystoreId), { recursive: true })
    await atomicWriteFile({
      filePath: this.#keystoreConfigFile(keystoreId),
      data: JSON.stringify(config)
    })
  }

  /**
   * @param options {object}
   * @param options.keystoreId {string}   the keystore's local id
   * @returns {Promise<KeystoreConfig|undefined>}
   *   Resolves falsy when the keystore does not exist (must not throw).
   */
  async getKeystore({
    keystoreId
  }: {
    keystoreId: string
  }): Promise<KeystoreConfig | undefined> {
    const metaStore = new MetadataJsonStore<KeystoreConfig>({
      file: this.#keystoreConfigFile(keystoreId)
    })
    return await metaStore.read()
  }

  /**
   * Replaces a keystore config, gated atomically (under the per-keystore write
   * mutex) on: the keystore existing, `config.sequence` being exactly the
   * stored sequence + 1, and `config.kmsModule` matching the stored one (the
   * module is immutable). Any other state rejects with the protocol's single
   * merged 409 conflict.
   * @param options {object}
   * @param options.keystoreId {string}   the keystore's local id
   * @param options.config {KeystoreConfig}
   * @returns {Promise<void>}
   */
  async updateKeystore({
    keystoreId,
    config
  }: {
    keystoreId: string
    config: KeystoreConfig
  }): Promise<void> {
    await this.#writeMutex.run(`keystore:${keystoreId}`, async () => {
      const existing = await this.getKeystore({ keystoreId })
      if (
        !existing ||
        config.sequence !== existing.sequence + 1 ||
        config.kmsModule !== existing.kmsModule
      ) {
        throw new KeystoreStateConflictError()
      }
      await atomicWriteFile({
        filePath: this.#keystoreConfigFile(keystoreId),
        data: JSON.stringify(config)
      })
    })
  }

  /**
   * Every stored keystore config whose `controller` matches, sorted by local
   * id (the request layer caps the wire result). An absent keystores root
   * (nothing stored yet) resolves an empty list; a directory without a
   * readable config file is skipped.
   * @param options {object}
   * @param options.controller {IDID}
   * @returns {Promise<KeystoreConfig[]>}
   */
  async listKeystoresByController({
    controller
  }: {
    controller: IDID
  }): Promise<KeystoreConfig[]> {
    let rootEntries: fs.Dirent[]
    try {
      rootEntries = await fs.promises.readdir(this.keystoresDir, {
        withFileTypes: true
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw new StorageError({ cause: err as Error })
    }
    const keystoreEntries = rootEntries
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    const configs: KeystoreConfig[] = []
    for (const entry of keystoreEntries) {
      const config = await this.getKeystore({ keystoreId: entry.name })
      if (config && config.controller === controller) {
        configs.push(config)
      }
    }
    return configs
  }

  /**
   * The file holding one key record, contained in its keystore's `keys/`
   * subdirectory. The record is a plain JSON file (not a metadata store):
   * records are immutable once inserted, so there is no read-modify-write to
   * protect.
   * @param options {object}
   * @param options.keystoreId {string}   the owning keystore's local id
   * @param options.localId {string}   the key's local id
   * @returns {string}
   */
  #keyFile({
    keystoreId,
    localId
  }: {
    keystoreId: string
    localId: string
  }): string {
    const keysDir = path.join(this.#keystoreDir(keystoreId), 'keys')
    const keyFile = path.join(keysDir, `${localId}.json`)
    this.#assertContained(keyFile, keysDir)
    return keyFile
  }

  /**
   * Inserts a key record, create-only: the exclusive-create write (`wx`)
   * enforces the `(keystoreId, localId)` uniqueness atomically, rejecting a
   * duplicate with the protocol's 409 (`KeyIdConflictError`).
   * @param options {object}
   * @param options.keystoreId {string}   the owning keystore's local id
   * @param options.localId {string}   the key's local id
   * @param options.record {KmsKeyRecord}   the full (secret-bearing) record
   * @returns {Promise<void>}
   */
  async insertKey({
    keystoreId,
    localId,
    record
  }: {
    keystoreId: string
    localId: string
    record: KmsKeyRecord
  }): Promise<void> {
    const keyFile = this.#keyFile({ keystoreId, localId })
    await mkdir(path.dirname(keyFile), { recursive: true })
    try {
      // Durable, atomic create-only write: `atomicCreateFile` preserves the
      // `wx` uniqueness (an existing key file rejects with EEXIST) while also
      // fsyncing the record and its directory.
      await atomicCreateFile({
        filePath: keyFile,
        data: JSON.stringify(record, null, 2)
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new KeyIdConflictError()
      }
      throw new StorageError({ cause: err as Error })
    }
  }

  /**
   * @param options {object}
   * @param options.keystoreId {string}   the owning keystore's local id
   * @param options.localId {string}   the key's local id
   * @returns {Promise<KmsKeyRecord|undefined>}
   *   Resolves falsy when the key does not exist (must not throw).
   */
  async getKey({
    keystoreId,
    localId
  }: {
    keystoreId: string
    localId: string
  }): Promise<KmsKeyRecord | undefined> {
    try {
      const raw = await fs.promises.readFile(
        this.#keyFile({ keystoreId, localId }),
        'utf8'
      )
      return JSON.parse(raw) as KmsKeyRecord
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined
      }
      throw new StorageError({ cause: err as Error })
    }
  }

  /**
   * Every stored key record under the keystore (`keys/*.json`), sorted by local
   * id (the file name's stem). An absent keystore or `keys/` directory (no keys
   * yet) resolves an empty list; a non-`.json` entry is skipped. The record is
   * returned verbatim -- the at-rest cipher applies above the backend.
   * @param options {object}
   * @param options.keystoreId {string}   the owning keystore's local id
   * @returns {Promise<Array<{ localId: string, record: KmsKeyRecord }>>}
   */
  async listKeys({
    keystoreId
  }: {
    keystoreId: string
  }): Promise<Array<{ localId: string; record: KmsKeyRecord }>> {
    const keysDir = path.join(this.#keystoreDir(keystoreId), 'keys')
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(keysDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw new StorageError({ cause: err as Error })
    }
    const localIds = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -'.json'.length))
      .sort((a, b) => a.localeCompare(b))
    const keys: Array<{ localId: string; record: KmsKeyRecord }> = []
    for (const localId of localIds) {
      const record = await this.getKey({ keystoreId, localId })
      // A record readable at readdir time but gone by getKey (a concurrent
      // prune) is simply skipped; the listing is a snapshot, not a lock.
      if (record) {
        keys.push({ localId, record })
      }
    }
    return keys
  }

  /**
   * The file holding one zcap revocation record. For a keystore scope it lives
   * in that keystore's `revocations/` subdirectory; for a Space scope it lives
   * under the sibling `spaceRevocationsDir` root (NOT inside the Space dir --
   * see the `spaceRevocationsDir` property doc). The file name folds the
   * `(delegator, capabilityId)` unique key into a SHA-256 digest (the shared
   * `revocationFileName` codec).
   * @param options {object}
   * @param options.scope {RevocationScope}   the owning keystore or Space
   * @param options.delegator {string}   the revoked capability's delegator
   * @param options.capabilityId {string}   the revoked capability's id
   * @returns {string}
   */
  #revocationFile({
    scope,
    delegator,
    capabilityId
  }: {
    scope: RevocationScope
    delegator: string
    capabilityId: string
  }): string {
    const fileName = revocationFileName({ delegator, capabilityId })
    if ('keystoreId' in scope) {
      return path.join(
        this.#keystoreDir(scope.keystoreId),
        'revocations',
        fileName
      )
    }
    return path.join(this.#spaceRevocationDir(scope.spaceId), fileName)
  }

  /**
   * Inserts a revocation record, create-only: the exclusive-create write
   * (`wx`) enforces the `(delegator, capability.id)` uniqueness atomically,
   * rejecting a duplicate with the protocol's 409
   * (`DuplicateRevocationError`).
   * @param options {object}
   * @param options.scope {RevocationScope}   the owning keystore or Space
   * @param options.record {RevocationRecord}   the revocation to store
   * @returns {Promise<void>}
   */
  async insertRevocation({
    scope,
    record
  }: {
    scope: RevocationScope
    record: RevocationRecord
  }): Promise<void> {
    // The scope must already exist -- the postgres backend enforces this via
    // its foreign keys, so an absent-parent insert rejects identically on
    // both backends instead of mkdir-ing an orphan record dir here. (The HTTP
    // route 404-masks unknown scopes before reaching the store; this guards
    // direct backend use.)
    const scopeExists =
      'keystoreId' in scope
        ? Boolean(await this.getKeystore({ keystoreId: scope.keystoreId }))
        : Boolean(await this.getSpaceDescription({ spaceId: scope.spaceId }))
    if (!scopeExists) {
      throw new StorageError({
        cause: new Error(
          'Cannot insert a revocation under an absent keystore or Space.'
        )
      })
    }
    const revocationFile = this.#revocationFile({
      scope,
      delegator: record.meta.delegator,
      capabilityId: record.capability.id
    })
    await mkdir(path.dirname(revocationFile), { recursive: true })
    try {
      // Durable, atomic create-only write: `atomicCreateFile` preserves the
      // `wx` uniqueness (an existing revocation rejects with EEXIST) while also
      // fsyncing the record and its directory.
      await atomicCreateFile({
        filePath: revocationFile,
        data: JSON.stringify(record, null, 2)
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DuplicateRevocationError()
      }
      throw new StorageError({ cause: err as Error })
    }
  }

  /**
   * True when any of the given capabilities has a stored, unexpired
   * revocation under the scope (keystore or Space). A record past its
   * `meta.expires` GC horizon is pruned on the way through and counts as not
   * revoked -- the capability itself has expired, so verification already
   * rejects it on expiry (this is the filesystem analogue of a TTL index).
   * @param options {object}
   * @param options.scope {RevocationScope}   the owning keystore or Space
   * @param options.capabilities {CapabilitySummary[]}   the
   *   `(capabilityId, delegator)` pairs to check
   * @returns {Promise<boolean>}
   */
  async isRevoked({
    scope,
    capabilities
  }: {
    scope: RevocationScope
    capabilities: CapabilitySummary[]
  }): Promise<boolean> {
    const now = Date.now()
    for (const { capabilityId, delegator } of capabilities) {
      const revocationFile = this.#revocationFile({
        scope,
        delegator,
        capabilityId
      })
      let raw: string
      try {
        raw = await fs.promises.readFile(revocationFile, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        throw new StorageError({ cause: err as Error })
      }
      const record = JSON.parse(raw) as RevocationRecord
      if (record.meta.expires && Date.parse(record.meta.expires) <= now) {
        await rm(revocationFile, { force: true })
        continue
      }
      return true
    }
    return false
  }
}
