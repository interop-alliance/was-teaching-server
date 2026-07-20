/**
 * PostgreSQL persistence backend: stores Spaces, Collections, and Resources as
 * rows (schema in postgresSchema.ts), and WebKMS keystores in a sibling table
 * tree, implementing the same StorageBackend contract as the filesystem
 * backend (types.ts). Selected by configuration (`DATABASE_URL`) and injected
 * the same way (`createApp({ backend })`).
 *
 * Design departures from the filesystem backend (deliberate):
 * - Quota accounting is transactional (`spaces.usage_bytes`, maintained in the
 *   same transaction as every write/delete), making the per-Space capacity a
 *   HARD limit under concurrency. "Usage" is exactly the stored content bytes;
 *   descriptions, policies, and metadata are not counted (a divergence from
 *   the filesystem's `du`, which counts every file).
 * - Conditional writes use row locks (`SELECT ... FOR UPDATE`) and
 *   transactions instead of the single-process `KeyedMutex`, so two server
 *   processes sharing one database get correct conditional writes.
 * - Blobs are buffered single-`bytea` writes bounded by `maxUploadBytes`; an
 *   unset cap defaults to `DEFAULT_MAX_UPLOAD_BYTES` rather than "unbounded"
 *   (unbounded buffering into a `bytea` is a footgun). Chunked-row streaming
 *   is a planned follow-up increment.
 * - `exportSpace` / `importSpace` speak the same tar dialect as the
 *   filesystem backend (same file-name codecs, same manifest), so archives
 *   migrate between the two backends in either direction; the Postgres import
 *   apply loop additionally runs in a single transaction (atomic rollback).
 */
import { Readable } from 'node:stream'
import pg from 'pg'
import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import * as tar from 'tar-stream'
import YAML from 'yaml'
import {
  StorageError,
  ResourceNotFoundError,
  SpaceNotFoundError,
  QuotaExceededError,
  CountQuotaExceededError,
  PayloadTooLargeError,
  PreconditionFailedError,
  KeystoreStateConflictError,
  KeyIdConflictError,
  DuplicateRevocationError
} from '../errors.js'
import { applyMigrations } from './postgresSchema.js'
import {
  extractTarEntries,
  buildImportPlan,
  metaSidecarFileId
} from '../lib/importTar.js'
import type { TarEntry } from '../lib/importTar.js'
import { collectionPath, resourcePath } from '../lib/paths.js'
import {
  fileNameFor,
  parseResourceFileName,
  chunkDirName,
  parseChunkDirName,
  parseChunkIndexSegment
} from '../lib/resourceFileName.js'
import { assertValidId } from '../lib/validateId.js'
import { sanitizeBackendRecord } from '../lib/backends.js'
import { backendUsageFields } from '../lib/backendUsage.js'
import { assertEncryptedWriteConforms } from '../lib/encryption.js'
import { encodeCursor, decodeCursor } from '../lib/cursor.js'
import {
  buildExportManifest,
  EXPORT_ENTRY_MTIME
} from '../lib/exportManifest.js'
import { revocationFileName } from '../lib/revocations.js'
import { isJson } from '../lib/isJson.js'
import { normalizeDescriptionWrite } from '../lib/collectionDescription.js'
import { DEFAULT_PAGE_SIZE, clampPageSize } from '../lib/pagination.js'
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
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_SPACES_PER_CONTROLLER,
  DEFAULT_MAX_COLLECTIONS_PER_SPACE,
  DEFAULT_MAX_RESOURCES_PER_SPACE,
  normalizeCountLimit
} from '../config.default.js'
import {
  assertWritePrecondition,
  assertMetaWritePrecondition,
  assertCollectionWritePrecondition
} from '../lib/preconditions.js'
import type {
  SpaceDescription,
  CollectionDescription,
  CollectionSummary,
  CollectionResourcesList,
  ResourceResult,
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

/** Pool sizing and per-connection statement timeout (operational defaults). */
const POOL_MAX = 10
const STATEMENT_TIMEOUT_MS = 30_000

/**
 * Silent logger used when no logger is injected into the backend (`createApp`
 * wires `fastify.log` in; tests may leave it silent).
 */
const silentLogger: FastifyBaseLogger = pino({ level: 'silent' })

/**
 * Anything a query can run against: the pool (auto-checkout) or a checked-out
 * transaction client. Shared write helpers take this so the normal methods
 * and the import transaction reuse one statement.
 */
type Queryable = pg.Pool | pg.PoolClient

/**
 * One `resources` row, as read back from pg. `size_bytes` arrives as a string
 * (node-postgres returns `bigint` columns as strings).
 */
interface ResourceRow {
  content_type: string
  content: Buffer | null
  is_json: boolean
  size_bytes: string
  version: number
  meta_version: number | null
  custom: ResourceMetadataCustom | Record<string, unknown> | null
  deleted: boolean
  created_at: string
  updated_at: string
  created_by: IDID | null
  epoch: string | null
}

/**
 * The synthesized `.meta.<resourceId>.json` sidecar shape used by
 * export/import -- the same on-disk shape the filesystem backend persists
 * (`MetaSidecar` there), so archives stay interchangeable.
 */
interface SidecarShape {
  createdAt: string
  updatedAt: string
  createdBy?: IDID
  version?: number
  metaVersion?: number
  custom?: ResourceMetadataCustom | Record<string, unknown>
  epoch?: string
  deleted?: boolean
  contentType?: string
}

/**
 * Buffers a byte stream fully into memory, aborting with
 * `PayloadTooLargeError` (413) the moment the cumulative size exceeds
 * `maxUploadBytes` -- the buffered-`bytea` analogue of the filesystem
 * backend's streaming `_uploadCapGuard`.
 * @param options {object}
 * @param options.stream {Readable}
 * @param options.maxUploadBytes {number}
 * @param options.backendId {string}   for the 413 problem detail
 * @returns {Promise<Buffer>}
 */
async function bufferStreamCapped({
  stream,
  maxUploadBytes,
  backendId
}: {
  stream: Readable
  maxUploadBytes: number
  backendId: string
}): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxUploadBytes) {
      throw new PayloadTooLargeError({ maxUploadBytes, backendId })
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Parses an archived `.meta.<resourceId>.json` sidecar's bytes into the
 * shared sidecar shape; unparseable (or absent) bytes yield `undefined`, and
 * the import falls back to fresh-write defaults.
 * @param bytes {Buffer|undefined}
 * @returns {SidecarShape|undefined}
 */
function parseSidecar(bytes: Buffer | undefined): SidecarShape | undefined {
  if (!bytes) {
    return undefined
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as SidecarShape
  } catch {
    return undefined
  }
}

/**
 * The chunk-metadata sidecar shape (`.chunks.<encId>/.meta.<index>.json`) the
 * filesystem backend writes per chunk. Only the monotonic `version` (the
 * chunk's ETag validator) is carried across export/import; the filesystem
 * writes `createdAt` / `updatedAt` too, but this backend's `chunks` table holds
 * no chunk timestamps, so it emits and reads only `version`.
 */
interface ChunkSidecar {
  version?: number
}

export class PostgresBackend implements StorageBackend {
  logger: FastifyBaseLogger
  /**
   * Per-Space storage capacity, in bytes (spec "Quotas"). `undefined` means no
   * configured limit. Unlike the filesystem backend's `du`-sampled soft limit,
   * this is enforced transactionally on every content write -- a HARD limit
   * under concurrency.
   */
  capacityBytes?: number
  /**
   * Largest single upload accepted, in bytes (spec "Quotas",
   * `maxUploadBytes`). Always set on this backend: an unconfigured cap
   * defaults to `DEFAULT_MAX_UPLOAD_BYTES`, because every blob write buffers
   * through memory on the single-`bytea` path.
   */
  maxUploadBytes: number
  /**
   * Max Spaces a single controller may create (spec "Quotas", a default-on
   * count quota). `undefined` means no cap. Enforced transactionally on the
   * Space create path (`writeSpace`), serialized per controller by an advisory
   * lock -- a HARD limit under concurrency, like the byte quota. The
   * constructor normalizes an unset option to
   * {@link DEFAULT_MAX_SPACES_PER_CONTROLLER} and a non-finite option
   * (`Infinity`) to `undefined`.
   */
  maxSpacesPerController?: number
  /**
   * Max Collections a single Space may hold (spec "Quotas", a default-on count
   * quota). `undefined` means no cap. Enforced on the Collection create path,
   * serialized per Space by the space row lock. Normalized like
   * {@link maxSpacesPerController}.
   */
  maxCollectionsPerSpace?: number
  /**
   * Max live Resources a single Space may hold across all its Collections (spec
   * "Quotas", a default-on count quota). `undefined` means no cap. Enforced on
   * the Resource create path (a tombstone does not count). Normalized like
   * {@link maxSpacesPerController}.
   */
  maxResourcesPerSpace?: number

  private _pool: pg.Pool
  private _schema?: string

  /**
   * @param options {object}
   * @param options.connectionString {string}   a `postgres://` URL
   * @param [options.schema] {string}   Postgres schema to operate in (set as
   *   the connection `search_path`; created by `init()` if absent). Used for
   *   test isolation; production uses the default `public`.
   * @param [options.logger] {FastifyBaseLogger}
   * @param [options.capacityBytes] {number}   per-Space quota in bytes; a
   *   finite value is enforced, `undefined` or a non-finite value means no
   *   configured limit
   * @param [options.maxUploadBytes] {number}   per-upload cap in bytes;
   *   `undefined` applies the `DEFAULT_MAX_UPLOAD_BYTES` default. A non-finite
   *   value (`Infinity`, from `MAX_UPLOAD_BYTES=unlimited`) throws: this backend
   *   buffers each upload in memory as a single `bytea`, so an unbounded cap is
   *   not supported.
   * @param [options.maxSpacesPerController] {number}   max Spaces per
   *   controller (spec "Quotas"); `undefined` applies the default-on limit,
   *   `Infinity` means no cap
   * @param [options.maxCollectionsPerSpace] {number}   max Collections per
   *   Space; `undefined` applies the default-on limit, `Infinity` means no cap
   * @param [options.maxResourcesPerSpace] {number}   max live Resources per
   *   Space; `undefined` applies the default-on limit, `Infinity` means no cap
   */
  constructor({
    connectionString,
    schema,
    logger,
    capacityBytes,
    maxUploadBytes,
    maxSpacesPerController,
    maxCollectionsPerSpace,
    maxResourcesPerSpace
  }: {
    connectionString: string
    schema?: string
    logger?: FastifyBaseLogger
    capacityBytes?: number
    maxUploadBytes?: number
    maxSpacesPerController?: number
    maxCollectionsPerSpace?: number
    maxResourcesPerSpace?: number
  }) {
    if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/i.test(schema)) {
      throw new Error(`Invalid Postgres schema name: "${schema}".`)
    }
    this._schema = schema
    this.logger = logger ?? silentLogger
    // A non-finite `capacityBytes` (`Infinity` from an explicit `unlimited`)
    // behaves exactly like unset inside the backend: no configured limit.
    this.capacityBytes =
      capacityBytes !== undefined && Number.isFinite(capacityBytes)
        ? capacityBytes
        : undefined
    // This backend buffers each upload in memory as a single `bytea`, so an
    // unbounded per-upload cap is not supported -- fail fast at construction
    // rather than risk an OOM at write time.
    if (maxUploadBytes !== undefined && !Number.isFinite(maxUploadBytes)) {
      throw new Error(
        `PostgresBackend does not support an unlimited per-upload cap ` +
          `(MAX_UPLOAD_BYTES=unlimited): each upload is buffered in memory as ` +
          `a single bytea. Set MAX_UPLOAD_BYTES to a finite byte count.`
      )
    }
    this.maxUploadBytes = maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
    // Count quotas normalize like `maxUploadBytes` (unset applies the
    // default-on limit, a non-finite `Infinity` means no cap), so every guard
    // keeps its plain `!== undefined` test.
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
    this._pool = new pg.Pool({
      connectionString,
      max: POOL_MAX,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      // `search_path` is a connection-startup parameter, so every pooled
      // connection lands in the right schema with no per-checkout SET race.
      ...(schema !== undefined && { options: `-csearch_path=${schema}` })
    })
    this._pool.on('error', err => {
      this.logger.error({ err }, 'Postgres pool background error')
    })
  }

  /**
   * Connects and applies schema migrations (idempotent, advisory-locked; see
   * postgresSchema.ts). Called once by the `createApp` composition before the
   * server starts listening.
   * @returns {Promise<void>}
   */
  async init(): Promise<void> {
    const client = await this._pool.connect()
    try {
      if (this._schema !== undefined) {
        // Identifier-quoted; the constructor validated the name's charset.
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${this._schema}"`)
      }
      // Lift the pool's statement timeout for this session: a waiting
      // instance blocks on the migration advisory lock for as long as the
      // holder's migration takes, and a future slow migration must not be
      // capped at the request-path timeout either.
      await client.query('SET statement_timeout = 0')
      await applyMigrations({ client })
    } finally {
      // Destroy rather than pool-return the client, so the lifted timeout
      // never leaks into a request-path connection.
      client.release(true)
    }
  }

  /**
   * Drains the connection pool. Wired to the Fastify `onClose` hook by the
   * plugin composition.
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    await this._pool.end()
  }

  /**
   * Runs `fn` inside one transaction on a dedicated client, committing on
   * success and rolling back on any throw.
   * @param fn {(client: pg.PoolClient) => Promise<T>}
   * @returns {Promise<T>}
   */
  private async _withTransaction<T>(
    fn: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this._pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        this.logger.error({ err: rollbackErr }, 'Postgres rollback failed')
      }
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Self-description advertised at `GET /space/:spaceId/backends`. Same
   * affordances as the filesystem backend: conditional writes (ETag
   * validators, row-locked preconditions) and the `changes` and
   * `blinded-index` query profiles.
   * @returns {Required<Omit<BackendDescriptor, 'provider' | 'connection'>>}
   */
  describe(): Required<Omit<BackendDescriptor, 'provider' | 'connection'>> {
    return {
      id: 'default',
      name: 'Server PostgreSQL',
      managedBy: 'server',
      storageMode: ['document', 'blob'],
      persistence: 'durable',
      // `key-epochs`: multi-recipient encrypted Collections -- per-epoch wrapped
      // keys on the `encryption` marker, a client-declared `epoch` stamp on
      // Resources, and conditional (`If-Match`) Collection Description writes.
      // `chunked-streams`: chunk addressing at `/{resourceId}/chunks/{n}`, opaque
      // per-chunk raw-bytes storage in the `chunks` table.
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
   * Ensures the `spaces` row for `spaceId` exists (a placeholder with a NULL
   * description when the Space was never described -- the analogue of the
   * filesystem creating a Space directory on a sub-Space write).
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  private async _ensureSpaceRow({
    client,
    spaceId
  }: {
    client: pg.PoolClient
    spaceId: string
  }): Promise<void> {
    await client.query(
      `INSERT INTO spaces (space_id) VALUES ($1)
       ON CONFLICT (space_id) DO NOTHING`,
      [spaceId]
    )
  }

  /**
   * Ensures the `collections` row (and its parent `spaces` row) exists,
   * placeholder-description like `_ensureSpaceRow`.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<void>}
   */
  private async _ensureCollectionRow({
    client,
    spaceId,
    collectionId
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
  }): Promise<void> {
    await this._ensureSpaceRow({ client, spaceId })
    await client.query(
      `INSERT INTO collections (space_id, collection_id) VALUES ($1, $2)
       ON CONFLICT (space_id, collection_id) DO NOTHING`,
      [spaceId, collectionId]
    )
  }

  /**
   * Applies a usage delta to the Space's transactional quota counter,
   * enforcing the configured capacity in the same statement (the hard-limit
   * departure from the filesystem's `du`-sampled soft check). Zero rows
   * updated with the row present means the write would not fit:
   * `QuotaExceededError` (507), rolling back the enclosing transaction.
   * MUST run inside the same transaction as the content mutation.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.delta {number}   signed byte delta (new minus old size)
   * @returns {Promise<void>}
   */
  private async _applyUsageDelta({
    client,
    spaceId,
    delta
  }: {
    client: pg.PoolClient
    spaceId: string
    delta: number
  }): Promise<void> {
    // Only a growing write can exhaust the quota; shrinking writes and deletes
    // always apply (and clamp at zero so drift can never go negative).
    const cap = delta > 0 ? (this.capacityBytes ?? null) : null
    const result = await client.query(
      `UPDATE spaces
          SET usage_bytes = GREATEST(usage_bytes + $2, 0)
        WHERE space_id = $1
          AND ($3::bigint IS NULL OR usage_bytes + $2 <= $3::bigint)`,
      [spaceId, delta, cap]
    )
    if (result.rowCount === 0) {
      throw new QuotaExceededError({
        spaceId,
        capacityBytes: this.capacityBytes!
      })
    }
  }

  /**
   * Serializes concurrent CREATORS of one not-yet-existing row (a Resource or
   * a chunk) on a transaction-scoped advisory lock keyed by the row's
   * identity. Under READ COMMITTED a `SELECT ... FOR UPDATE` on an absent row
   * locks nothing (no gap locks), so two concurrent creators would both read
   * "no prior row" and both apply their full byte size as the usage delta --
   * and while the `ON CONFLICT` arm recomputes `version` from the conflicting
   * row, it cannot retroactively fix the loser's delta, leaving `usage_bytes`
   * inflated by one write's size. The caller takes this lock when its
   * lock-nothing SELECT found no row, then RE-reads the row: the second
   * creator blocks here until the first commits, and its re-read sees the
   * committed row, so its precondition, version, and usage delta are computed
   * from accurate state. Held to commit (advisory xact lock). The `create:`
   * prefix keeps this key domain distinct from the unique-blinded-term
   * advisory lock, which hashes the bare `(spaceId, collectionId)`.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.rowKey {string}   the row's identity within the Space
   * @returns {Promise<void>}
   */
  private async _lockSameKeyCreate({
    client,
    spaceId,
    rowKey
  }: {
    client: pg.PoolClient
    spaceId: string
    rowKey: string
  }): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [spaceId, `create:${rowKey}`]
    )
  }

  // Quotas

  /**
   * Reports the Space's usage from the transactional counter (no measurement
   * pass, no cache). The per-Collection breakdown is computed on demand with
   * one aggregate query.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.includeCollections] {boolean}
   * @returns {Promise<BackendUsage>}
   */
  async reportUsage({
    spaceId,
    includeCollections = false
  }: {
    spaceId: string
    includeCollections?: boolean
  }): Promise<BackendUsage> {
    const measuredAt = new Date().toISOString()
    const { rows } = await this._pool.query<{ usage_bytes: string }>(
      'SELECT usage_bytes FROM spaces WHERE space_id = $1',
      [spaceId]
    )
    const usageBytes = rows[0] ? Number(rows[0].usage_bytes) : 0

    let usageByCollection: CollectionUsage[] | undefined
    if (includeCollections) {
      // Per-Collection usage sums both Resource content bytes and chunk bytes
      // (the `chunked-streams` feature) so the breakdown agrees with the
      // Space total in the transactional counter.
      const { rows: collectionRows } = await this._pool.query<{
        collection_id: string
        usage: string
      }>(
        `SELECT collection_id, COALESCE(SUM(bytes), 0) AS usage FROM (
           SELECT collection_id, size_bytes AS bytes FROM resources
             WHERE space_id = $1
           UNION ALL
           SELECT collection_id, size AS bytes FROM chunks
             WHERE space_id = $1
         ) usage_rows
          GROUP BY collection_id
          ORDER BY collection_id`,
        [spaceId]
      )
      usageByCollection = collectionRows.map(row => ({
        id: row.collection_id,
        usageBytes: Number(row.usage)
      }))
    }

    return {
      ...this._backendUsageFields({ usageBytes, spaceTotalBytes: usageBytes }),
      measuredAt,
      ...(includeCollections && { usageByCollection })
    }
  }

  /**
   * Reports a single Collection's usage (its `SUM(size_bytes)` slice), with
   * `state` / `limit` derived from the Space total (the quota is a per-Space
   * limit).
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
    const measuredAt = new Date().toISOString()
    const { rows } = await this._pool.query<{
      space_total: string
      collection_total: string
    }>(
      `SELECT
         (SELECT COALESCE(usage_bytes, 0) FROM spaces WHERE space_id = $1)
           AS space_total,
         (SELECT COALESCE(SUM(size_bytes), 0) FROM resources
           WHERE space_id = $1 AND collection_id = $2)
         + (SELECT COALESCE(SUM(size), 0) FROM chunks
           WHERE space_id = $1 AND collection_id = $2) AS collection_total`,
      [spaceId, collectionId]
    )
    const spaceTotalBytes = Number(rows[0]?.space_total ?? 0)
    const usageBytes = Number(rows[0]?.collection_total ?? 0)
    return {
      ...this._backendUsageFields({ usageBytes, spaceTotalBytes }),
      measuredAt
    }
  }

  /**
   * Builds the shared quota-report condition fields (see
   * `lib/backendUsage.ts`).
   * @param options {object}
   * @param options.usageBytes {number}
   * @param options.spaceTotalBytes {number}
   * @returns {Omit<BackendUsage, 'measuredAt' | 'usageByCollection'>}
   */
  private _backendUsageFields({
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

  // Spaces

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.spaceDescription {SpaceDescription}
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Space's `createdBy` on first write only
   * @returns {Promise<void>}
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
    const { controller } = spaceDescription
    // `createdBy` names the Space's creator, not its last writer: taken from
    // this write's invoker only when there is no prior description, and
    // preserved verbatim afterward. The client-supplied `spaceDescription` is
    // wire input and may carry its own `createdBy` -- discard it, since the
    // server alone is authoritative for this field.
    const { createdBy: _suppliedCreatedBy, ...rest } = spaceDescription
    const descriptionJson = JSON.stringify(rest)
    // The upsert maintains the denormalized `controller` column on both insert
    // and update -- the description's controller can change on update, and the
    // Spaces count quota reads this column (spec "Quotas"). `createdBy` is
    // resolved within this same statement, in one transaction-free round trip
    // (no separate read-then-write race with a concurrent `writeSpace` for the
    // same id):
    // - `spaces.description IS NULL` means there is no prior description row
    //   (a placeholder row created by a sub-resource write before any Space
    //   Description was written) -- this write IS the create, so it behaves
    //   like the insert branch: attach this write's `createdBy` when present,
    //   otherwise omit the key entirely (never store it as JSON `null`).
    // - Otherwise a prior description exists, and its `createdBy` -- present
    //   or absent -- is preserved verbatim via the jsonb `?` key-existence
    //   operator; this write's `createdBy` is ignored entirely (never
    //   backfilled).
    const upsert = (queryable: Queryable): Promise<unknown> =>
      queryable.query(
        `INSERT INTO spaces (space_id, description, controller)
         VALUES (
           $1,
           CASE WHEN $4::text IS NULL THEN $2::jsonb
                ELSE ($2::jsonb) || jsonb_build_object('createdBy', $4::text) END,
           $3
         )
         ON CONFLICT (space_id) DO UPDATE SET
           description = CASE
             WHEN spaces.description IS NULL THEN
               CASE WHEN $4::text IS NULL THEN $2::jsonb
                    ELSE ($2::jsonb) || jsonb_build_object('createdBy', $4::text) END
             WHEN spaces.description ? 'createdBy' THEN
               ($2::jsonb) || jsonb_build_object(
                 'createdBy', spaces.description->>'createdBy'
               )
             ELSE $2::jsonb
           END,
           controller = EXCLUDED.controller`,
        [spaceId, descriptionJson, controller, createdBy ?? null]
      )

    if (this.maxSpacesPerController === undefined) {
      await upsert(this._pool)
      return
    }

    // Count quota (create path only), enforced as a HARD limit: take a
    // controller-scoped advisory lock so concurrent creates for the same
    // controller serialize (the byte quota's posture), detect a create (no
    // described row yet -- a NULL-description placeholder counts as a create),
    // COUNT this controller's Spaces, and reject at the limit.
    await this._withTransaction(async client => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('controller-count:' || $1))`,
        [controller]
      )
      const { rows } = await client.query<{ description: unknown }>(
        'SELECT description FROM spaces WHERE space_id = $1',
        [spaceId]
      )
      const isCreate = rows[0]?.description == null
      if (isCreate) {
        const { rows: countRows } = await client.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM spaces WHERE controller = $1',
          [controller]
        )
        if (countRows[0]!.count >= this.maxSpacesPerController!) {
          throw new CountQuotaExceededError({
            scope: 'Spaces per controller',
            limit: this.maxSpacesPerController!
          })
        }
      }
      await upsert(client)
    })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<SpaceDescription|undefined>}   falsy when the Space does
   *   not exist or is a placeholder row without a description
   */
  async getSpaceDescription({
    spaceId
  }: {
    spaceId: string
  }): Promise<SpaceDescription | undefined> {
    const { rows } = await this._pool.query<{
      description: SpaceDescription | null
    }>('SELECT description FROM spaces WHERE space_id = $1', [spaceId])
    return rows[0]?.description ?? undefined
  }

  /**
   * Deletes the Space row; collections, resources, policies, and backend
   * records go with it via `ON DELETE CASCADE` (keystores are a sibling tree
   * and are deliberately untouched). Idempotent.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async deleteSpace({ spaceId }: { spaceId: string }): Promise<void> {
    await this._pool.query('DELETE FROM spaces WHERE space_id = $1', [spaceId])
  }

  /**
   * Every described Space, sorted by id (byte order via `COLLATE "C"`).
   * Placeholder rows without a description are skipped, like a Space dir
   * without a readable description file.
   * @returns {Promise<SpaceDescription[]>}
   */
  async listSpaces(): Promise<SpaceDescription[]> {
    const { rows } = await this._pool.query<{
      description: SpaceDescription
    }>(
      `SELECT description FROM spaces
        WHERE description IS NOT NULL
        ORDER BY space_id`
    )
    return rows.map(row => row.description)
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
    return this._withTransaction(async client => {
      await this._ensureSpaceRow({ client, spaceId })
      // Serialize all Collection writes within the Space on its space row: the
      // collection-row `FOR UPDATE` below locks nothing when the row does not
      // exist yet, so without this two concurrent creates of *different* new
      // ids could each pass the create-path quota COUNT (overshooting
      // `maxCollectionsPerSpace`), and two creates of the *same* id could each
      // compute the same first version.
      await client.query(
        'SELECT 1 FROM spaces WHERE space_id = $1 FOR UPDATE',
        [spaceId]
      )
      // Lock the Collection row (if any) and read its current description and
      // version, so the `If-Match` compare-and-swap, the transition rails, the
      // create detection, and the monotonic version bump are all atomic with
      // the write (two concurrent recipient edits cannot clobber one another).
      const { rows } = await client.query<{
        description: CollectionDescription | null
        description_version: number
      }>(
        `SELECT description, description_version FROM collections
          WHERE space_id = $1 AND collection_id = $2 FOR UPDATE`,
        [spaceId, collectionId]
      )
      const priorRow = rows[0]
      // A missing row and a placeholder (NULL-description) row are both "no
      // described Collection yet": version 0, so the first real description
      // write returns 1 (a placeholder's `description_version` column holds
      // the schema DEFAULT and must not count).
      const prior =
        priorRow?.description == null
          ? undefined
          : {
              ...priorRow.description,
              descriptionVersion: priorRow.description_version
            }
      const currentVersion = prior?.descriptionVersion ?? 0
      // Compare-and-swap (opt-in): a stale `If-Match` throws 412. An
      // unconditional write skips this.
      assertCollectionWritePrecondition({
        collectionId,
        currentVersion,
        ifMatch
      })
      // The request layer's state-transition rails (e.g. epoch append-only),
      // re-evaluated here against the row just read under the lock.
      assertTransition?.(prior)
      // Count quota (create path only): a create is no row or a placeholder
      // (NULL-description) row; describing one must not push the Space past
      // `maxCollectionsPerSpace` (spec "Quotas").
      if (this.maxCollectionsPerSpace !== undefined && prior === undefined) {
        const { rows: countRows } = await client.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM collections WHERE space_id = $1',
          [spaceId]
        )
        if (countRows[0]!.count >= this.maxCollectionsPerSpace) {
          throw new CountQuotaExceededError({
            scope: 'Collections per Space',
            limit: this.maxCollectionsPerSpace
          })
        }
      }
      const version = currentVersion + 1
      await this._upsertCollection({
        queryable: client,
        spaceId,
        collectionId,
        collectionDescription,
        createdBy,
        descriptionVersion: version
      })
      return { version }
    })
  }

  /**
   * The one Collection-description upsert statement, shared by
   * `writeCollection` and the import apply loop. `createdBy` is resolved
   * within this same statement, in one round trip (no separate read-then-write
   * race with a concurrent write for the same id):
   * - `collections.description IS NULL` means there is no prior description
   *   row (a placeholder row created by a sub-Resource write before any
   *   Collection Description was written) -- this write IS the create, so it
   *   behaves like the insert branch: attach the `createdBy` parameter when
   *   present, otherwise omit the key entirely (never store it as JSON
   *   `null`).
   * - Otherwise a prior description exists, and its `createdBy` -- present or
   *   absent -- is preserved verbatim via the jsonb `?` key-existence
   *   operator; the `createdBy` parameter is ignored entirely (never
   *   backfilled).
   * Any `createdBy` embedded in `collectionDescription` itself is discarded
   * here: `writeCollection` passes the invoker DID via the `createdBy`
   * parameter instead, and the import apply loop passes the imported
   * document's own `createdBy` so a restored Collection keeps its original
   * creator (that import call is always a create -- the caller skips existing
   * Collections -- so there is no prior row to preserve instead).
   * @param options {object}
   * @param options.queryable {Queryable}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDescription {CollectionDescription}
   * @param [options.createdBy] {string}   resolved creator to fall back to
   *   when there is no prior row
   * @param [options.descriptionVersion] {number}   the monotonic description
   *   version to stamp (the `ETag` validator; the `key-epochs` feature), kept
   *   OUT of the `description` jsonb -- it lives in the `description_version`
   *   column and travels only as the `ETag` header. When omitted (the import
   *   path), a `_version` on the incoming archived description is used, else 1.
   * @returns {Promise<void>}
   */
  private async _upsertCollection({
    queryable,
    spaceId,
    collectionId,
    collectionDescription,
    createdBy,
    descriptionVersion
  }: {
    queryable: Queryable
    spaceId: string
    collectionId: string
    collectionDescription: CollectionDescription
    createdBy?: IDID
    descriptionVersion?: number
  }): Promise<void> {
    // Shared normalization (lib/collectionDescription.ts): strip the
    // version-bearing members from the incoming (possibly imported)
    // description so neither lands in the stored jsonb body -- the resolved
    // version becomes the `description_version` column instead. `createdBy` is
    // additionally stripped here because this statement re-resolves it in SQL.
    const { body, version } = normalizeDescriptionWrite({
      collectionDescription,
      descriptionVersion
    })
    const { createdBy: _suppliedCreatedBy, ...rest } = body
    await queryable.query(
      `INSERT INTO collections (space_id, collection_id, description,
                                description_version)
       VALUES (
         $1, $2,
         CASE WHEN $4::text IS NULL THEN $3::jsonb
              ELSE ($3::jsonb) || jsonb_build_object('createdBy', $4::text) END,
         $5
       )
       ON CONFLICT (space_id, collection_id) DO UPDATE SET
         description = CASE
           WHEN collections.description IS NULL THEN
             CASE WHEN $4::text IS NULL THEN $3::jsonb
                  ELSE ($3::jsonb) || jsonb_build_object('createdBy', $4::text) END
           WHEN collections.description ? 'createdBy' THEN
             ($3::jsonb) || jsonb_build_object(
               'createdBy', collections.description->>'createdBy'
             )
           ELSE $3::jsonb
         END,
         description_version = $5`,
      [spaceId, collectionId, JSON.stringify(rest), createdBy ?? null, version]
    )
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<(CollectionDescription & { descriptionVersion?: number })
   *   | undefined>}   `descriptionVersion` is the out-of-band `ETag` validator.
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
    const { rows } = await this._pool.query<{
      description: CollectionDescription | null
      description_version: number
    }>(
      `SELECT description, description_version FROM collections
        WHERE space_id = $1 AND collection_id = $2`,
      [spaceId, collectionId]
    )
    const row = rows[0]
    if (!row?.description) {
      return undefined
    }
    // Surface the version out-of-band as `descriptionVersion` (the handler sets
    // the `ETag` header from it); it is stored in its own column, never the
    // wire body.
    return { ...row.description, descriptionVersion: row.description_version }
  }

  /**
   * Deletes the Collection row (resources cascade), its policies, and
   * subtracts the Collection's stored bytes from the Space usage counter --
   * all in one transaction. Idempotent.
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
    await this._withTransaction(async client => {
      // The Collection's freed bytes are its Resource content plus its chunk
      // bytes (the `chunked-streams` feature); both cascade away with the
      // Collection row, so both leave the quota counter.
      const { rows } = await client.query<{ total: string }>(
        `SELECT
           (SELECT COALESCE(SUM(size_bytes), 0) FROM resources
             WHERE space_id = $1 AND collection_id = $2)
         + (SELECT COALESCE(SUM(size), 0) FROM chunks
             WHERE space_id = $1 AND collection_id = $2) AS total`,
        [spaceId, collectionId]
      )
      const freedBytes = Number(rows[0]?.total ?? 0)
      await client.query(
        `DELETE FROM collections WHERE space_id = $1 AND collection_id = $2`,
        [spaceId, collectionId]
      )
      // Collection- and Resource-level policies live under the Collection (the
      // filesystem removes them with the dir; here they key off collection_id).
      await client.query(
        `DELETE FROM policies WHERE space_id = $1 AND collection_id = $2`,
        [spaceId, collectionId]
      )
      if (freedBytes > 0) {
        await this._applyUsageDelta({ client, spaceId, delta: -freedBytes })
      }
    })
  }

  /**
   * Every Collection row in the Space, sorted by id. A row without a
   * description (created by a sub-Collection write) falls back to the id for
   * its `name`, like a description-less directory on the filesystem.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<CollectionSummary[]>}
   */
  async listCollections({
    spaceId
  }: {
    spaceId: string
  }): Promise<CollectionSummary[]> {
    const { rows } = await this._pool.query<{
      collection_id: string
      description: CollectionDescription | null
    }>(
      `SELECT collection_id, description FROM collections
        WHERE space_id = $1 ORDER BY collection_id`,
      [spaceId]
    )
    return rows.map(row => ({
      id: row.collection_id,
      url: collectionPath({ spaceId, collectionId: row.collection_id }),
      name: row.description?.name ?? row.collection_id
    }))
  }

  /**
   * Lists a Collection's Resources, cursor-paginated with the same keyset
   * (ascending `resourceId`, byte order), cursor codec, clamps, and `next`
   * construction as the filesystem backend. Tombstones are invisible.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.limit] {number}
   * @param [options.cursor] {string}
   * @param [options.collectionDescription] {CollectionDescription}
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
    const collectionDescription =
      providedDescription ??
      (await this.getCollectionDescription({ spaceId, collectionId }))

    const after = cursor !== undefined ? decodeCursor(cursor).after : undefined
    const pageSize =
      limit === undefined ? DEFAULT_PAGE_SIZE : clampPageSize(limit)

    const { rows: countRows } = await this._pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND NOT deleted`,
      [spaceId, collectionId]
    )
    const totalItems = Number(countRows[0]?.total ?? 0)

    // Take `pageSize + 1` from the seek point to detect a further page without
    // a second query; `hasMore` is whether the extra row arrived.
    const { rows } = await this._pool.query<{
      resource_id: string
      content_type: string
      custom: ResourceMetadataCustom | null
      epoch: string | null
    }>(
      `SELECT resource_id, content_type, custom, epoch FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND NOT deleted
          AND ($3::text IS NULL OR resource_id > $3)
        ORDER BY resource_id
        LIMIT $4`,
      [spaceId, collectionId, after ?? null, pageSize + 1]
    )
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows

    // Surface the user-writable `custom.name` only for a plaintext Collection;
    // on an encrypted one `custom` is the opaque envelope, so the listing
    // omits `name` (spec "List Collection", encrypted-Collection note).
    const encrypted = collectionDescription?.encryption !== undefined
    const items = pageRows.map(row => {
      const name = encrypted ? undefined : row.custom?.name
      return {
        id: row.resource_id,
        url: resourcePath({
          spaceId,
          collectionId,
          resourceId: row.resource_id
        }),
        contentType: row.content_type,
        ...(name !== undefined && { name }),
        // The client-declared key epoch (the `key-epochs` feature) rides each
        // listing item so a reader picks the right epoch key without a `/meta`
        // fetch per Resource.
        ...(row.epoch !== null && { epoch: row.epoch })
      }
    })

    let next: string | undefined
    if (hasMore) {
      const lastId = pageRows[pageRows.length - 1]!.resource_id
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
   * Writes a Resource representation as one transaction: row lock, shared
   * precondition evaluation (exact filesystem semantics -- a tombstone counts
   * as "not exists", `ifNoneMatch` precedence per RFC9110), monotonic
   * `version` bump continuing through delete/recreate, and the transactional
   * quota delta. JSON is stored as its serialized UTF-8 bytes; blobs buffer
   * through the capped accumulator.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.input {ResourceInput}
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Resource's `createdBy` on first write only
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
   * @returns {Promise<{ version: number }>}
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
    const { maxUploadBytes } = this
    let content: Buffer
    if (input.kind === 'json') {
      content = Buffer.from(JSON.stringify(input.data))
      if (content.length > maxUploadBytes) {
        throw new PayloadTooLargeError({
          maxUploadBytes,
          backendId: this.describe().id,
          uploadBytes: content.length
        })
      }
    } else {
      // Pre-flight a declared size, then buffer through the counting guard
      // that hard-caps a body whose size is omitted or understated. Buffering
      // happens BEFORE the transaction so a slow upload holds no row lock.
      if (
        input.declaredBytes !== undefined &&
        input.declaredBytes > maxUploadBytes
      ) {
        throw new PayloadTooLargeError({
          maxUploadBytes,
          backendId: this.describe().id,
          uploadBytes: input.declaredBytes
        })
      }
      content = await bufferStreamCapped({
        stream: input.stream,
        maxUploadBytes,
        backendId: this.describe().id
      })
    }

    return this._withTransaction(async client => {
      await this._ensureCollectionRow({ client, spaceId, collectionId })

      // Two unique-attribute invariants can force a JSON content write to
      // serialize before it upserts its row: the EDV blinded one (`unique: true`
      // blinded attributes; the `blinded-index-query` feature) and the plaintext
      // equality one (a Collection's `unique`-declared `indexes`; the
      // `equality-query` feature). Only a unique-carrying JSON write can create
      // either claim. A per-Collection transaction-scoped advisory lock
      // serializes the claimants (held to commit, so the loser's scan sees the
      // winner's committed row) without entering the row-lock ordering of plain
      // writes; it is taken once and shared by both checks.
      const blindedUnique =
        input.kind === 'json' &&
        collectUniqueBlindedTerms({ document: input.data }).length > 0
      const equalityUnique =
        input.kind === 'json' &&
        uniqueIndexes !== undefined &&
        uniqueIndexes.length > 0
      if (blindedUnique || equalityUnique) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [spaceId, collectionId]
        )
      }
      if (blindedUnique) {
        const { rows: candidateRows } = await client.query<{
          resource_id: string
          content: Buffer | null
        }>(
          `SELECT resource_id, content FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND is_json
              AND NOT deleted AND resource_id <> $3`,
          [spaceId, collectionId, resourceId]
        )
        const candidates: Array<{ resourceId: string; document: unknown }> = []
        for (const row of candidateRows) {
          if (!row.content) {
            continue
          }
          try {
            candidates.push({
              resourceId: row.resource_id,
              document: JSON.parse(row.content.toString('utf8')) as unknown
            })
          } catch {
            // skip an unparsable body
          }
        }
        assertNoUniqueBlindedConflict({
          document: input.kind === 'json' ? input.data : undefined,
          candidates
        })
      }
      if (equalityUnique) {
        // A content write does not change the Resource's `custom`, so the custom
        // side of the claim comes from the CURRENT stored row.
        const { rows: selfRows } = await client.query<{
          custom: ResourceMetadataCustom | Record<string, unknown> | null
        }>(
          `SELECT custom FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND NOT deleted`,
          [spaceId, collectionId, resourceId]
        )
        assertNoUniqueEqualityConflict({
          indexes: uniqueIndexes!,
          content: input.kind === 'json' ? input.data : undefined,
          custom: selfRows[0]?.custom ?? undefined,
          candidates: await this._readEqualityCandidates(client, {
            spaceId,
            collectionId,
            excludeResourceId: resourceId
          })
        })
      }

      // Narrow projection: the lock needs the row, not its (possibly multi-MB)
      // `content` bytea, which this path never reads.
      const { rows } = await client.query<
        Pick<
          ResourceRow,
          'version' | 'size_bytes' | 'deleted' | 'created_at' | 'created_by'
        >
      >(
        `SELECT version, size_bytes, deleted, created_at, created_by
           FROM resources
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          FOR UPDATE`,
        [spaceId, collectionId, resourceId]
      )
      let prior = rows[0]
      if (prior === undefined) {
        // The lock-nothing case: serialize with any concurrent creator of the
        // same id and re-read, so `exists` / `priorSize` below reflect the row
        // it committed (see `_lockSameKeyCreate` -- without this, both
        // creators would count their full byte size as the usage delta).
        await this._lockSameKeyCreate({
          client,
          spaceId,
          rowKey: `${collectionId}/${resourceId}`
        })
        const { rows: reread } = await client.query<
          Pick<
            ResourceRow,
            'version' | 'size_bytes' | 'deleted' | 'created_at' | 'created_by'
          >
        >(
          `SELECT version, size_bytes, deleted, created_at, created_by
             FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            FOR UPDATE`,
          [spaceId, collectionId, resourceId]
        )
        prior = reread[0]
      }
      const exists = prior !== undefined && !prior.deleted
      if (ifMatch !== undefined || ifNoneMatch) {
        assertWritePrecondition({
          resourceId,
          exists,
          currentVersion: prior?.version ?? 0,
          ifMatch,
          ifNoneMatch
        })
      }

      // Count quota (create path only): a new live Resource -- including one
      // written over a tombstone (`exists` is false) -- must not push the Space
      // past `maxResourcesPerSpace` (spec "Quotas"). An overwrite of a live
      // Resource never trips it. Counted inside the write transaction.
      if (this.maxResourcesPerSpace !== undefined && !exists) {
        const { rows: countRows } = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM resources
            WHERE space_id = $1 AND NOT deleted`,
          [spaceId]
        )
        if (countRows[0]!.count >= this.maxResourcesPerSpace) {
          throw new CountQuotaExceededError({
            scope: 'Resources per Space',
            limit: this.maxResourcesPerSpace
          })
        }
      }

      const now = new Date().toISOString()
      const version = (prior?.version ?? 0) + 1
      const priorSize = exists ? Number(prior?.size_bytes ?? 0) : 0
      const delta = content.length - priorSize
      if (delta !== 0) {
        await this._applyUsageDelta({ client, spaceId, delta })
      }

      // A content write preserves the independent `metaVersion` and the
      // user-writable `custom` of a LIVE Resource; a tombstoned row already
      // dropped both (the metadata went with the deleted Resource).
      //
      // Create-if-absent atomicity: when `If-None-Match: *` found NO prior row
      // (a tombstone is a real row and stays lock-serialized), concurrent
      // creators through this method are already serialized by
      // `_lockSameKeyCreate` above -- but a writer that does not take that
      // lock (`importSpace`'s plain INSERTs) can still race. A plain INSERT
      // (no ON CONFLICT) keeps the primary key as the arbiter: the loser's
      // unique violation maps to the 412 the precondition would have thrown.
      // `createdBy` names the Resource's creator, not its last writer: taken
      // from this write's invoker only when there is no prior row at all
      // (`prior === undefined`), then preserved EXACTLY as the prior row has
      // it -- including preserved-as-absent -- by every later write,
      // regardless of who invokes it. A tombstone IS a prior row, so a
      // re-create over one keeps the tombstone's `createdBy` (or its
      // absence), exactly as `created_at` is preserved across it.
      const creator =
        prior !== undefined ? prior.created_by : (createdBy ?? null)
      const values = [
        spaceId,
        collectionId,
        resourceId,
        input.contentType,
        content,
        isJson({ contentType: input.contentType }),
        content.length,
        version,
        prior?.created_at ?? now,
        creator,
        // The client-declared key epoch (the `key-epochs` feature): a content
        // write stores it and CLEARS it when absent (the new ciphertext's epoch
        // is unknown), so both the INSERT and the conflict update set it from
        // this write -- it is NOT preserved from the prior row like `created_by`.
        epoch ?? null
      ]
      const insertSql = `
        INSERT INTO resources (
          space_id, collection_id, resource_id, content_type, content,
          is_json, size_bytes, version, meta_version, custom, deleted,
          created_at, updated_at, created_by, epoch
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, false, $9, $9, $10, $11)`
      if (ifNoneMatch && prior === undefined) {
        try {
          await client.query(insertSql, values)
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw new PreconditionFailedError({
              detail: `Resource '${resourceId}' already exists (If-None-Match: *).`
            })
          }
          throw err
        }
      } else {
        // The conflict update derives `version` from the row (`resources.
        // version + 1`), not from the pre-read: if a concurrent creator
        // slipped in after our lock-nothing SELECT, the counter still
        // advances monotonically instead of two writers both claiming
        // version 1 (an ETag anomaly). RETURNING reports the version that
        // actually landed.
        const { rows: written } = await client.query<{ version: number }>(
          `${insertSql}
           ON CONFLICT (space_id, collection_id, resource_id) DO UPDATE SET
             content_type = EXCLUDED.content_type,
             content = EXCLUDED.content,
             is_json = EXCLUDED.is_json,
             size_bytes = EXCLUDED.size_bytes,
             version = resources.version + 1,
             deleted = false,
             updated_at = EXCLUDED.updated_at,
             created_by = resources.created_by,
             epoch = EXCLUDED.epoch
           RETURNING version`,
          values
        )
        return { version: written[0]!.version }
      }
      // `created_at` / `meta_version` / `custom` are deliberately NOT in the
      // conflict update: an overwrite keeps the original creation time (also
      // across a tombstone, as the filesystem sidecar does) and the metadata
      // counters as they stand on the row. `created_by` is likewise NOT
      // backfilled from `EXCLUDED`: the conflict path always means a prior
      // row already existed (including the race where a concurrent creator's
      // INSERT landed between our lock-nothing SELECT and this statement), so
      // `resources.created_by` -- the prior row's own value, absent or not --
      // is authoritative and this write's `createdBy` is ignored entirely.
      return { version }
    })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.contentType] {string}   advisory; ignored for lookup
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
    contentType?: string
  }): Promise<ResourceResult> {
    const { rows } = await this._pool.query<ResourceRow>(
      `SELECT content_type, content, version, deleted FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionId, resourceId]
    )
    const row = rows[0]
    if (!row || row.deleted || row.content === null) {
      throw new ResourceNotFoundError({ requestName: 'Get Resource' })
    }
    return {
      resourceStream: Readable.from(row.content),
      storedResourceType: row.content_type,
      version: row.version
    }
  }

  /**
   * Soft-deletes a Resource into a tombstone row: content dropped, `deleted`
   * set, `version` bumped (so the change feed surfaces it), last-known
   * `content_type` retained, `custom` / `meta_version` dropped, and the freed
   * bytes subtracted from the quota counter -- one transaction. Idempotent on
   * an absent Resource or an existing tombstone.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.ifMatch] {string}
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
    await this._withTransaction(async client => {
      // Narrow projection: the lock needs the row, not the `content` bytea
      // that is about to be dropped anyway.
      const { rows } = await client.query<
        Pick<ResourceRow, 'version' | 'size_bytes' | 'deleted'>
      >(
        `SELECT version, size_bytes, deleted FROM resources
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          FOR UPDATE`,
        [spaceId, collectionId, resourceId]
      )
      const prior = rows[0]
      const exists = prior !== undefined && !prior.deleted
      if (ifMatch !== undefined) {
        assertWritePrecondition({
          resourceId,
          exists,
          currentVersion: prior?.version ?? 0,
          ifMatch
        })
      }
      if (!exists) {
        // Already absent (never existed, or already a tombstone): idempotent
        // no-op, keeping an existing tombstone's change-feed entry stable.
        return
      }
      // A soft delete is an UPDATE, not a row removal, so the chunk foreign
      // key's ON DELETE CASCADE does not fire -- remove the Resource's chunks
      // (the `chunked-streams` feature) explicitly in this same transaction so
      // they never outlive their parent, and return their bytes to the quota
      // counter alongside the Resource's content bytes.
      const { rows: chunkRows } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(size), 0) AS total FROM chunks
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
        [spaceId, collectionId, resourceId]
      )
      const freedChunkBytes = Number(chunkRows[0]?.total ?? 0)
      if (freedChunkBytes > 0) {
        await client.query(
          `DELETE FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
          [spaceId, collectionId, resourceId]
        )
      }
      const freedBytes = Number(prior.size_bytes) + freedChunkBytes
      if (freedBytes > 0) {
        await this._applyUsageDelta({ client, spaceId, delta: -freedBytes })
      }
      const now = new Date().toISOString()
      await client.query(
        `UPDATE resources SET
           content = NULL,
           size_bytes = 0,
           version = version + 1,
           meta_version = NULL,
           custom = NULL,
           epoch = NULL,
           deleted = true,
           updated_at = $4
         WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
        [spaceId, collectionId, resourceId, now]
      )
    })
  }

  /**
   * Reads the metadata of a Resource's current representation. Tombstones and
   * absent Resources resolve `undefined`. `custom` is included only when
   * non-empty, verbatim (`{ name, tags }` or the opaque envelope).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<(ResourceMetadata & { createdBy?: IDID; version?:
   *   number; metaVersion?: number }) | undefined>}
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
    | (ResourceMetadata & {
        createdBy?: IDID
        version?: number
        metaVersion?: number
      })
    | undefined
  > {
    const { rows } = await this._pool.query<ResourceRow>(
      `SELECT content_type, size_bytes, version, meta_version, custom, epoch,
              deleted, created_at, updated_at, created_by
         FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionId, resourceId]
    )
    const row = rows[0]
    if (!row || row.deleted) {
      return undefined
    }
    const hasCustom = row.custom !== null && Object.keys(row.custom).length > 0
    return {
      contentType: row.content_type,
      size: Number(row.size_bytes),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Absent for a Resource created before `createdBy` was recorded.
      ...(row.created_by !== null && { createdBy: row.created_by }),
      ...(hasCustom && { custom: row.custom as ResourceMetadataCustom }),
      // The client-declared key epoch (the `key-epochs` feature), when stamped.
      ...(row.epoch !== null && { epoch: row.epoch }),
      version: row.version,
      ...(row.meta_version !== null && { metaVersion: row.meta_version })
    }
  }

  /**
   * Replaces the user-writable `custom` object (full replacement; `{}`
   * clears), bumping `updatedAt` and the independent `metaVersion` -- one
   * row-locked transaction, preconditions evaluated on the current
   * `metaVersion` via the shared helper. Resolves `undefined` (no create) for
   * an absent or tombstoned Resource.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.custom {ResourceMetadataCustom | Record<string, unknown>}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
   * @returns {Promise<{ metaVersion: number } | undefined>}
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
    return this._withTransaction(async client => {
      // A metadata write can create a plaintext equality unique claim for a
      // `custom`-sourced attribute (the `equality-query` feature). When the
      // Collection declares any unique index, take the per-Collection advisory
      // lock first (held to commit, serializing concurrent claimants) so the
      // conflict scan below is atomic with the write.
      const equalityUnique =
        uniqueIndexes !== undefined && uniqueIndexes.length > 0
      if (equalityUnique) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [spaceId, collectionId]
        )
      }
      const { rows } = await client.query<ResourceRow>(
        `SELECT meta_version, deleted FROM resources
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          FOR UPDATE`,
        [spaceId, collectionId, resourceId]
      )
      const prior = rows[0]
      if (!prior || prior.deleted) {
        return undefined
      }
      assertMetaWritePrecondition({
        resourceId,
        metaVersion: prior.meta_version ?? undefined,
        ifMatch,
        ifNoneMatch
      })
      if (equalityUnique) {
        // Content is the Resource's stored JSON content (unchanged by a
        // metadata write); custom is the incoming value this write sets. Fetch
        // the (possibly multi-MB) content only on this uniqueness path -- the
        // row is already `FOR UPDATE`-locked above.
        const { rows: selfRows } = await client.query<{
          content: Buffer | null
          is_json: boolean
        }>(
          `SELECT content, is_json FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
          [spaceId, collectionId, resourceId]
        )
        let content: unknown
        const selfRow = selfRows[0]
        if (selfRow?.is_json && selfRow.content) {
          try {
            content = JSON.parse(selfRow.content.toString('utf8')) as unknown
          } catch {
            content = undefined
          }
        }
        assertNoUniqueEqualityConflict({
          indexes: uniqueIndexes!,
          content,
          custom,
          candidates: await this._readEqualityCandidates(client, {
            spaceId,
            collectionId,
            excludeResourceId: resourceId
          })
        })
      }
      const metaVersion = (prior.meta_version ?? 0) + 1
      const hasCustom = Object.keys(custom).length > 0
      const now = new Date().toISOString()
      // The key-epoch stamp describes the CONTENT write, so a supplied `epoch`
      // replaces it but an OMITTED one PRESERVES the stored value (unlike
      // `custom`, full-replace): `COALESCE($7, epoch)` keeps the current value
      // when the parameter is NULL.
      await client.query(
        `UPDATE resources SET
           meta_version = $4,
           custom = $5::jsonb,
           updated_at = $6,
           epoch = COALESCE($7, epoch)
         WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
        [
          spaceId,
          collectionId,
          resourceId,
          metaVersion,
          hasCustom ? JSON.stringify(custom) : null,
          now,
          epoch ?? null
        ]
      )
      return { metaVersion }
    })
  }

  // Chunks (the `chunked-streams` feature)

  /**
   * Writes one chunk of a chunked Resource as one transaction: the parent
   * Resource must exist (checked atomically -- a `FOR SHARE` lock on it also
   * blocks a concurrent delete of the parent for the duration of the write, so
   * a chunk can never be orphaned by a racing `deleteResource`), the chunk row
   * is locked, its precondition evaluated, its monotonic `version` bumped, and
   * the transactional quota delta applied. The chunk body is stored opaquely as
   * a single `bytea`, the buffered-blob path (bounded by `maxUploadBytes`),
   * exactly like a binary Resource representation.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}   a non-negative safe integer
   * @param options.input {ResourceInput}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
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
    const { maxUploadBytes } = this
    let bytes: Buffer
    if (input.kind === 'json') {
      bytes = Buffer.from(JSON.stringify(input.data))
      if (bytes.length > maxUploadBytes) {
        throw new PayloadTooLargeError({
          maxUploadBytes,
          backendId: this.describe().id,
          uploadBytes: bytes.length
        })
      }
    } else {
      // Pre-flight a declared size, then buffer through the counting guard that
      // hard-caps a body whose size is omitted or understated. Buffering
      // happens BEFORE the transaction so a slow upload holds no row lock.
      if (
        input.declaredBytes !== undefined &&
        input.declaredBytes > maxUploadBytes
      ) {
        throw new PayloadTooLargeError({
          maxUploadBytes,
          backendId: this.describe().id,
          uploadBytes: input.declaredBytes
        })
      }
      bytes = await bufferStreamCapped({
        stream: input.stream,
        maxUploadBytes,
        backendId: this.describe().id
      })
    }

    return this._withTransaction(async client => {
      // Parent Resource must exist (and not be a tombstone). `FOR SHARE`
      // conflicts with the `FOR UPDATE` a concurrent `deleteResource` takes, so
      // the two serialize on the parent row -- the parent cannot be deleted
      // between this check and the chunk write.
      const { rows: parentRows } = await client.query<{ deleted: boolean }>(
        `SELECT deleted FROM resources
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          FOR SHARE`,
        [spaceId, collectionId, resourceId]
      )
      const parent = parentRows[0]
      if (!parent || parent.deleted) {
        throw new ResourceNotFoundError({ requestName: 'Write Chunk' })
      }

      // Lock the chunk row (if any) and read its current version/size, so the
      // precondition, the monotonic bump, and the usage delta are all atomic
      // with the write.
      const { rows } = await client.query<{ version: number; size: string }>(
        `SELECT version, size FROM chunks
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            AND chunk_index = $4
          FOR UPDATE`,
        [spaceId, collectionId, resourceId, chunkIndex]
      )
      let prior = rows[0]
      const chunkLabel = `${resourceId}/chunks/${chunkIndex}`
      if (prior === undefined) {
        // The lock-nothing case: serialize with any concurrent creator of the
        // same chunk and re-read, so the usage delta below reflects the row it
        // committed (see `_lockSameKeyCreate`).
        await this._lockSameKeyCreate({
          client,
          spaceId,
          rowKey: `${collectionId}/${chunkLabel}`
        })
        const { rows: reread } = await client.query<{
          version: number
          size: string
        }>(
          `SELECT version, size FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND chunk_index = $4
            FOR UPDATE`,
          [spaceId, collectionId, resourceId, chunkIndex]
        )
        prior = reread[0]
      }
      const exists = prior !== undefined
      if (ifMatch !== undefined || ifNoneMatch) {
        assertWritePrecondition({
          resourceId: chunkLabel,
          exists,
          currentVersion: prior?.version ?? 0,
          ifMatch,
          ifNoneMatch
        })
      }

      const version = (prior?.version ?? 0) + 1
      const priorSize = exists ? Number(prior?.size ?? 0) : 0
      const delta = bytes.length - priorSize
      if (delta !== 0) {
        await this._applyUsageDelta({ client, spaceId, delta })
      }

      const values = [
        spaceId,
        collectionId,
        resourceId,
        chunkIndex,
        input.contentType,
        bytes,
        bytes.length,
        version
      ]
      const insertSql = `
        INSERT INTO chunks (
          space_id, collection_id, resource_id, chunk_index,
          content_type, bytes, size, version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
      // Create-if-absent atomicity mirrors `writeResource`: concurrent
      // creators through this method are serialized by `_lockSameKeyCreate`
      // above, and against a writer that does not take that lock
      // (`importSpace`'s plain INSERTs) the plain INSERT keeps the primary key
      // as the arbiter -- a racing creator's unique violation maps to the 412
      // the precondition would have thrown.
      if (ifNoneMatch && prior === undefined) {
        try {
          await client.query(insertSql, values)
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw new PreconditionFailedError({
              detail: `Chunk '${chunkLabel}' already exists (If-None-Match: *).`
            })
          }
          throw err
        }
        return { version }
      }
      // The conflict update derives `version` from the row (`chunks.version +
      // 1`), not from the pre-read, so a concurrent creator that slipped in
      // after our lock-nothing SELECT still advances the counter monotonically.
      // RETURNING reports the version that actually landed.
      const { rows: written } = await client.query<{ version: number }>(
        `${insertSql}
         ON CONFLICT (space_id, collection_id, resource_id, chunk_index)
         DO UPDATE SET
           content_type = EXCLUDED.content_type,
           bytes = EXCLUDED.bytes,
           size = EXCLUDED.size,
           version = chunks.version + 1
         RETURNING version`,
        values
      )
      return { version: written[0]!.version }
    })
  }

  /**
   * Reads a chunk's bytes. Rejects with `ResourceNotFoundError` (404) when no
   * chunk is stored at that index.
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
    const { rows } = await this._pool.query<{
      content_type: string
      bytes: Buffer
      version: number
    }>(
      `SELECT content_type, bytes, version FROM chunks
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          AND chunk_index = $4`,
      [spaceId, collectionId, resourceId, chunkIndex]
    )
    const row = rows[0]
    if (!row) {
      throw new ResourceNotFoundError({ requestName: 'Get Chunk' })
    }
    return {
      resourceStream: Readable.from(row.bytes),
      storedResourceType: row.content_type,
      version: row.version
    }
  }

  /**
   * Reads a chunk's stored content-type / size / version (the HEAD payload
   * headers). Resolves `undefined` when the chunk is absent.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @returns {Promise<{ contentType: string, size: number, version?: number }
   *   | undefined>}
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
  }): Promise<
    { contentType: string; size: number; version?: number } | undefined
  > {
    const { rows } = await this._pool.query<{
      content_type: string
      size: string
      version: number
    }>(
      `SELECT content_type, size, version FROM chunks
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          AND chunk_index = $4`,
      [spaceId, collectionId, resourceId, chunkIndex]
    )
    const row = rows[0]
    if (!row) {
      return undefined
    }
    return {
      contentType: row.content_type,
      size: Number(row.size),
      version: row.version
    }
  }

  /**
   * Deletes one chunk as one transaction (the chunk row is locked, its
   * `ifMatch` precondition evaluated atomically, and its bytes returned to the
   * quota counter). Resolves `true` when a chunk was removed, `false` when none
   * was stored at that index (the handler 404s on `false` -- chunk deletes are
   * not silently idempotent, unlike `deleteResource`).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @param [options.ifMatch] {string}
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
    return this._withTransaction(async client => {
      const { rows } = await client.query<{ version: number; size: string }>(
        `SELECT version, size FROM chunks
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            AND chunk_index = $4
          FOR UPDATE`,
        [spaceId, collectionId, resourceId, chunkIndex]
      )
      const prior = rows[0]
      if (prior === undefined) {
        return false
      }
      if (ifMatch !== undefined) {
        assertWritePrecondition({
          resourceId: `${resourceId}/chunks/${chunkIndex}`,
          exists: true,
          currentVersion: prior.version,
          ifMatch
        })
      }
      await client.query(
        `DELETE FROM chunks
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            AND chunk_index = $4`,
        [spaceId, collectionId, resourceId, chunkIndex]
      )
      const freedBytes = Number(prior.size)
      if (freedBytes > 0) {
        await this._applyUsageDelta({ client, spaceId, delta: -freedBytes })
      }
      return true
    })
  }

  /**
   * Lists a Resource's stored chunks in ascending `chunk_index` order -- the
   * discovery/reassembly listing. The opaque `bytes` column is deliberately not
   * selected. An empty listing (Resource with no chunks, or an absent Resource)
   * resolves `{ count: 0, chunks: [] }`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<{ count: number, chunks: Array<{ index: number, size:
   *   number, contentType: string, version?: number }> }>}
   */
  async listChunks({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<{
    count: number
    chunks: Array<{
      index: number
      size: number
      contentType: string
      version?: number
    }>
  }> {
    const { rows } = await this._pool.query<{
      chunk_index: number
      size: string
      content_type: string
      version: number
    }>(
      `SELECT chunk_index, size, content_type, version FROM chunks
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
        ORDER BY chunk_index`,
      [spaceId, collectionId, resourceId]
    )
    return {
      count: rows.length,
      chunks: rows.map(row => ({
        index: row.chunk_index,
        size: Number(row.size),
        contentType: row.content_type,
        version: row.version
      }))
    }
  }

  /**
   * Replication change feed (the `changes` query profile): one indexed keyset
   * query over `(updatedAt, resourceId)`, tombstones included, JSON documents
   * only, bodies parsed for the returned page.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.checkpoint] {{ id: string, updatedAt: string }}
   * @param options.limit {number}
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
    const pageSize = clampPageSize(limit)
    const { rows } = await this._pool.query<
      ResourceRow & { resource_id: string }
    >(
      `SELECT resource_id, content, version, meta_version, custom, epoch,
              deleted, updated_at, created_by
         FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND is_json
          AND ($3::text IS NULL OR (updated_at, resource_id) > ($3, $4))
        ORDER BY updated_at, resource_id
        LIMIT $5`,
      [
        spaceId,
        collectionId,
        checkpoint?.updatedAt ?? null,
        checkpoint?.id ?? null,
        pageSize
      ]
    )

    const documents = rows.map(row => {
      if (row.deleted) {
        return {
          resourceId: row.resource_id,
          version: row.version,
          ...(row.meta_version !== null && { metaVersion: row.meta_version }),
          // A tombstone keeps its creator, as it keeps its `created_at`.
          ...(row.created_by !== null && { createdBy: row.created_by }),
          updatedAt: row.updated_at,
          deleted: true
        }
      }
      let data: unknown
      try {
        data = row.content
          ? JSON.parse(row.content.toString('utf8'))
          : undefined
      } catch {
        data = undefined
      }
      return {
        resourceId: row.resource_id,
        version: row.version,
        ...(row.meta_version !== null && { metaVersion: row.meta_version }),
        // The creator's DID rides the feed so provenance replicates with the
        // document, rather than needing a `/meta` fetch per Resource.
        ...(row.created_by !== null && { createdBy: row.created_by }),
        updatedAt: row.updated_at,
        deleted: false,
        data,
        ...(row.custom !== null && { custom: row.custom }),
        // The client-declared key epoch (the `key-epochs` feature) rides the
        // feed so a replicating reader picks the right epoch key.
        ...(row.epoch !== null && { epoch: row.epoch })
      }
    })

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
   * `StorageBackend.queryByBlindedIndex` contract). Selects the Collection's
   * live JSON rows, parses each body, and hands the candidates to the shared
   * evaluator (`lib/blindedIndex.ts`) for matching, ordering, and cursor
   * pagination -- identical semantics to the filesystem backend. A full scan
   * of the Collection per call, deliberate for this teaching backend; an
   * indexed variant would flatten the blinded attributes into an indexed
   * token side-table (the bedrock-edv-storage strategy). Unparsable JSON is
   * skipped.
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
    const { rows } = await this._pool.query<{
      resource_id: string
      content: Buffer | null
    }>(
      `SELECT resource_id, content FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND is_json AND NOT deleted
        ORDER BY resource_id`,
      [spaceId, collectionId]
    )

    const candidates: Array<{ resourceId: string; document: unknown }> = []
    for (const row of rows) {
      if (!row.content) {
        continue
      }
      try {
        candidates.push({
          resourceId: row.resource_id,
          document: JSON.parse(row.content.toString('utf8')) as unknown
        })
      } catch {
        // skip an unparsable body
      }
    }

    return runBlindedIndexQuery({ candidates, query, count, limit, cursor })
  }

  /**
   * Plaintext equality query (the `equality` query profile; see the
   * `StorageBackend.queryByEquality` contract). Reads the Collection's live
   * Resources -- JSON rows carrying parsed `content`, all rows carrying their
   * `custom` jsonb -- and hands the candidates to the shared evaluator
   * (`lib/equalityIndex.ts`) for extraction, matching, ordering, and cursor
   * pagination -- identical semantics to the filesystem backend. A full scan of
   * the Collection per call, deliberate for this teaching backend; a
   * materialized variant would answer from a JSONB expression index.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.query {EqualityQuery}
   * @param options.indexes {NormalizedIndexDeclaration[]}
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
    const candidates = await this._readEqualityCandidates(this._pool, {
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
    const candidates = await this._readEqualityCandidates(this._pool, {
      spaceId,
      collectionId
    })
    return findEqualityUniqueViolation({ indexes, candidates })
  }

  /**
   * Reads every live Resource of a Collection as an equality candidate -- the
   * candidate set for the equality query and the plaintext unique-attribute
   * conflict scans. Includes blob Resources (queryable through their
   * `custom`-sourced attributes): each row resolves `{ resourceId, content?,
   * custom? }`, where `content` is the parsed JSON of a JSON row (a blob and
   * unparsable JSON contribute none) and `custom` is the row's jsonb `custom`
   * when set. Tombstones are excluded (`NOT deleted`); an optional excluded
   * Resource is skipped. Runs on the given executor -- the pool for a read-only
   * query, or the write transaction's client for a uniqueness scan (so the scan
   * shares the advisory lock and sees a consistent snapshot).
   * @param executor {pg.Pool | pg.PoolClient}
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.excludeResourceId] {string}
   * @returns {Promise<EqualityCandidate[]>}
   */
  private async _readEqualityCandidates(
    executor: pg.Pool | pg.PoolClient,
    {
      spaceId,
      collectionId,
      excludeResourceId
    }: {
      spaceId: string
      collectionId: string
      excludeResourceId?: string
    }
  ): Promise<EqualityCandidate[]> {
    const { rows } = await executor.query<{
      resource_id: string
      content: Buffer | null
      is_json: boolean
      custom: ResourceMetadataCustom | Record<string, unknown> | null
    }>(
      `SELECT resource_id, content, is_json, custom FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND NOT deleted
          AND ($3::text IS NULL OR resource_id <> $3)
        ORDER BY resource_id`,
      [spaceId, collectionId, excludeResourceId ?? null]
    )
    const candidates: EqualityCandidate[] = []
    for (const row of rows) {
      let content: unknown
      if (row.is_json && row.content) {
        try {
          content = JSON.parse(row.content.toString('utf8')) as unknown
        } catch {
          // skip an unparsable body -- it contributes no content attributes
        }
      }
      candidates.push({
        resourceId: row.resource_id,
        ...(content !== undefined && { content }),
        ...(row.custom !== null && { custom: row.custom })
      })
    }
    return candidates
  }

  // Policies

  /**
   * Maps the optional-id policy addressing onto the sentinel-column primary
   * key: Space policy `('', '')`, Collection policy `(cid, '')`, Resource
   * policy `(cid, rid)`.
   * @param options {object}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {{ collectionKey: string, resourceKey: string }}
   */
  private _policyKey({
    collectionId,
    resourceId
  }: {
    collectionId?: string
    resourceId?: string
  }): { collectionKey: string; resourceKey: string } {
    return {
      collectionKey: collectionId ?? '',
      resourceKey: resourceId ?? ''
    }
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {Promise<PolicyDocument|undefined>}
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
    const { collectionKey, resourceKey } = this._policyKey({
      collectionId,
      resourceId
    })
    const { rows } = await this._pool.query<{ policy: PolicyDocument }>(
      `SELECT policy FROM policies
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionKey, resourceKey]
    )
    return rows[0]?.policy
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
    await this._withTransaction(async client => {
      // Ensure the containing rows exist (Space, and the Collection when the
      // policy is below Space level), like the filesystem's dir provisioning.
      if (collectionId !== undefined) {
        await this._ensureCollectionRow({ client, spaceId, collectionId })
      } else {
        await this._ensureSpaceRow({ client, spaceId })
      }
      await this._upsertPolicy({
        queryable: client,
        spaceId,
        collectionId,
        resourceId,
        policy
      })
    })
  }

  /**
   * The one policy upsert statement, shared by `writePolicy` and the import
   * apply loop; keys through `_policyKey` so the sentinel convention lives in
   * one place.
   * @param options {object}
   * @param options.queryable {Queryable}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.policy {PolicyDocument}
   * @returns {Promise<void>}
   */
  private async _upsertPolicy({
    queryable,
    spaceId,
    collectionId,
    resourceId,
    policy
  }: {
    queryable: Queryable
    spaceId: string
    collectionId?: string
    resourceId?: string
    policy: PolicyDocument
  }): Promise<void> {
    const { collectionKey, resourceKey } = this._policyKey({
      collectionId,
      resourceId
    })
    await queryable.query(
      `INSERT INTO policies (space_id, collection_id, resource_id, policy)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (space_id, collection_id, resource_id)
       DO UPDATE SET policy = EXCLUDED.policy`,
      [spaceId, collectionKey, resourceKey, JSON.stringify(policy)]
    )
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {Promise<void>}   idempotent
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
    const { collectionKey, resourceKey } = this._policyKey({
      collectionId,
      resourceId
    })
    await this._pool.query(
      `DELETE FROM policies
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionKey, resourceKey]
    )
  }

  // Registered external backends (spec "Backends")

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
    await this._withTransaction(async client => {
      await this._ensureSpaceRow({ client, spaceId })
      await client.query(
        `INSERT INTO backend_records (space_id, backend_id, record)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (space_id, backend_id)
         DO UPDATE SET record = EXCLUDED.record`,
        [spaceId, backendId, JSON.stringify(record)]
      )
    })
  }

  /**
   * The full (secret-bearing) record, or `undefined`. The only method that
   * exposes secret connection material -- internal use.
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
    const { rows } = await this._pool.query<{ record: StoredBackendRecord }>(
      `SELECT record FROM backend_records
        WHERE space_id = $1 AND backend_id = $2`,
      [spaceId, backendId]
    )
    return rows[0]?.record
  }

  /**
   * The Space's registered backends, **sanitized** (mapped through
   * `sanitizeBackendRecord` -- the secret boundary is unchanged), sorted by id.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<BackendDescriptor[]>}
   */
  async listBackends({
    spaceId
  }: {
    spaceId: string
  }): Promise<BackendDescriptor[]> {
    const { rows } = await this._pool.query<{ record: StoredBackendRecord }>(
      `SELECT record FROM backend_records
        WHERE space_id = $1 ORDER BY backend_id`,
      [spaceId]
    )
    return rows.map(row => sanitizeBackendRecord(row.record))
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @returns {Promise<void>}   idempotent
   */
  async deleteBackend({
    spaceId,
    backendId
  }: {
    spaceId: string
    backendId: string
  }): Promise<void> {
    await this._pool.query(
      `DELETE FROM backend_records WHERE space_id = $1 AND backend_id = $2`,
      [spaceId, backendId]
    )
  }

  // WebKMS keystores (the `/kms` facet)

  /**
   * Persists a keystore config unconditionally (the create path; local ids
   * are server-generated random values). The queryable/gated fields
   * (`controller`, `sequence`, `kmsModule`) are denormalized alongside the
   * verbatim config.
   * @param options {object}
   * @param options.keystoreId {string}
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
    await this._pool.query(
      `INSERT INTO keystores (keystore_id, controller, sequence, kms_module, config)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (keystore_id) DO UPDATE SET
         controller = EXCLUDED.controller,
         sequence = EXCLUDED.sequence,
         kms_module = EXCLUDED.kms_module,
         config = EXCLUDED.config`,
      [
        keystoreId,
        config.controller,
        config.sequence,
        config.kmsModule,
        JSON.stringify(config)
      ]
    )
  }

  /**
   * @param options {object}
   * @param options.keystoreId {string}
   * @returns {Promise<KeystoreConfig|undefined>}
   */
  async getKeystore({
    keystoreId
  }: {
    keystoreId: string
  }): Promise<KeystoreConfig | undefined> {
    const { rows } = await this._pool.query<{ config: KeystoreConfig }>(
      'SELECT config FROM keystores WHERE keystore_id = $1',
      [keystoreId]
    )
    return rows[0]?.config
  }

  /**
   * Replaces a keystore config, gated atomically in one conditional `UPDATE`:
   * the row must exist with `sequence` exactly one less than the incoming
   * config's and an unchanged `kmsModule`. Zero rows updated -- missing
   * keystore, stale sequence, or module change alike -- rejects with the
   * protocol's single merged 409 (`KeystoreStateConflictError`).
   * @param options {object}
   * @param options.keystoreId {string}
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
    const result = await this._pool.query(
      `UPDATE keystores SET
         controller = $2,
         sequence = $3,
         config = $4::jsonb
       WHERE keystore_id = $1 AND sequence = $3 - 1 AND kms_module = $5`,
      [
        keystoreId,
        config.controller,
        config.sequence,
        JSON.stringify(config),
        config.kmsModule
      ]
    )
    if (result.rowCount === 0) {
      throw new KeystoreStateConflictError()
    }
  }

  /**
   * Every stored keystore config whose `controller` matches, sorted by local
   * id (the request layer caps the wire result).
   * @param options {object}
   * @param options.controller {IDID}
   * @returns {Promise<KeystoreConfig[]>}
   */
  async listKeystoresByController({
    controller
  }: {
    controller: IDID
  }): Promise<KeystoreConfig[]> {
    const { rows } = await this._pool.query<{ config: KeystoreConfig }>(
      `SELECT config FROM keystores
        WHERE controller = $1 ORDER BY keystore_id`,
      [controller]
    )
    return rows.map(row => row.config)
  }

  /**
   * Inserts a key record, create-only: the primary key enforces the
   * `(keystoreId, localId)` uniqueness atomically; a duplicate rejects with
   * the protocol's 409 (`KeyIdConflictError`). The record is stored verbatim
   * (opaque to storage -- the at-rest cipher applies above the backend).
   * @param options {object}
   * @param options.keystoreId {string}
   * @param options.localId {string}
   * @param options.record {KmsKeyRecord}
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
    try {
      await this._pool.query(
        `INSERT INTO kms_keys (keystore_id, local_id, record)
         VALUES ($1, $2, $3::jsonb)`,
        [keystoreId, localId, JSON.stringify(record)]
      )
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new KeyIdConflictError()
      }
      throw new StorageError({ cause: err as Error })
    }
  }

  /**
   * @param options {object}
   * @param options.keystoreId {string}
   * @param options.localId {string}
   * @returns {Promise<KmsKeyRecord|undefined>}
   */
  async getKey({
    keystoreId,
    localId
  }: {
    keystoreId: string
    localId: string
  }): Promise<KmsKeyRecord | undefined> {
    const { rows } = await this._pool.query<{ record: KmsKeyRecord }>(
      `SELECT record FROM kms_keys
        WHERE keystore_id = $1 AND local_id = $2`,
      [keystoreId, localId]
    )
    return rows[0]?.record
  }

  /**
   * Every stored key record under the keystore, sorted by local id (the request
   * layer caps and paginates the wire result). An empty keystore resolves an
   * empty list. The record is returned verbatim -- the at-rest cipher applies
   * above the backend.
   * @param options {object}
   * @param options.keystoreId {string}
   * @returns {Promise<Array<{ localId: string, record: KmsKeyRecord }>>}
   */
  async listKeys({
    keystoreId
  }: {
    keystoreId: string
  }): Promise<Array<{ localId: string; record: KmsKeyRecord }>> {
    const { rows } = await this._pool.query<{
      local_id: string
      record: KmsKeyRecord
    }>(
      `SELECT local_id, record FROM kms_keys
        WHERE keystore_id = $1 ORDER BY local_id`,
      [keystoreId]
    )
    return rows.map(row => ({ localId: row.local_id, record: row.record }))
  }

  /**
   * Resolves a revocation scope to the table it lives in, the scope column
   * within that table, and the scope id value. The returned `table` and
   * `column` are server-chosen constants (never user input), so callers may
   * safely interpolate them into a SQL template; `id` remains a bound value.
   * @param scope {RevocationScope}
   * @returns {{ table: string, column: string, id: string }}
   */
  private _revocationTable(scope: RevocationScope): {
    table: string
    column: string
    id: string
  } {
    if ('keystoreId' in scope) {
      return {
        table: 'revocations',
        column: 'keystore_id',
        id: scope.keystoreId
      }
    }
    return { table: 'space_revocations', column: 'space_id', id: scope.spaceId }
  }

  /**
   * Inserts a revocation record, create-only on
   * `(scope id, delegator, capability.id)`; a duplicate rejects with the
   * protocol's 409 (`DuplicateRevocationError`).
   * @param options {object}
   * @param options.scope {RevocationScope}
   * @param options.record {RevocationRecord}
   * @returns {Promise<void>}
   */
  async insertRevocation({
    scope,
    record
  }: {
    scope: RevocationScope
    record: RevocationRecord
  }): Promise<void> {
    // `table` / `column` are internal constants, not user input; ids are bound.
    const { table, column, id } = this._revocationTable(scope)
    try {
      // Prune rows past their GC horizon while on this (rare) write path, so
      // the hot read path (`isRevoked`, consulted on every delegated-chain
      // verification) stays a single read-only SELECT -- the SQL analogue of
      // a TTL index. Table-wide on purpose: expired rows are dead weight
      // whichever scope they belong to.
      await this._pool.query(
        `DELETE FROM ${table}
          WHERE expires IS NOT NULL AND expires <= $1`,
        [new Date().toISOString()]
      )
      await this._pool.query(
        `INSERT INTO ${table}
           (${column}, delegator, capability_id, record, expires)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          id,
          record.meta.delegator,
          record.capability.id,
          JSON.stringify(record),
          record.meta.expires ?? null
        ]
      )
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new DuplicateRevocationError()
      }
      throw new StorageError({ cause: err as Error })
    }
  }

  /**
   * True when any of the given capabilities has a stored, unexpired
   * revocation under the scope. A single read-only SELECT: rows past their
   * `meta.expires` GC horizon are filtered out in the predicate rather than
   * pruned here -- this runs on every delegated-chain verification, so it
   * must not write; `insertRevocation` prunes on the (rare) write path
   * instead. ISO-8601 strings compare correctly under the column's byte-order
   * collation.
   * @param options {object}
   * @param options.scope {RevocationScope}
   * @param options.capabilities {CapabilitySummary[]}
   * @returns {Promise<boolean>}
   */
  async isRevoked({
    scope,
    capabilities
  }: {
    scope: RevocationScope
    capabilities: CapabilitySummary[]
  }): Promise<boolean> {
    if (capabilities.length === 0) {
      return false
    }
    // `table` / `column` are internal constants, not user input; ids are bound.
    const { table, column, id } = this._revocationTable(scope)
    const delegators = capabilities.map(entry => entry.delegator)
    const capabilityIds = capabilities.map(entry => entry.capabilityId)
    const { rows } = await this._pool.query(
      `SELECT 1 FROM ${table}
        WHERE ${column} = $1
          AND (delegator, capability_id) IN
              (SELECT * FROM unnest($2::text[], $3::text[]))
          AND (expires IS NULL OR expires > $4)
        LIMIT 1`,
      [id, delegators, capabilityIds, new Date().toISOString()]
    )
    return rows.length > 0
  }

  // Export / import (spec "Export Space" / "Import Space")

  /**
   * Builds the filesystem-dialect sidecar object for a resource row (the
   * `.meta.<id>.json` shape), field order matching the filesystem writer so
   * archives stay as close to byte-compatible as jsonb round-tripping allows.
   * @param row {Omit<ResourceRow, 'content'>}
   * @returns {SidecarShape}
   */
  private _sidecarFor(row: Omit<ResourceRow, 'content'>): SidecarShape {
    if (row.deleted) {
      return {
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.created_by !== null && { createdBy: row.created_by }),
        version: row.version,
        deleted: true,
        contentType: row.content_type
      }
    }
    return {
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.created_by !== null && { createdBy: row.created_by }),
      version: row.version,
      ...(row.meta_version !== null && { metaVersion: row.meta_version }),
      ...(row.custom !== null && { custom: row.custom }),
      // The client-declared key epoch (the `key-epochs` feature) rides the
      // `.meta.` sidecar so it survives an export/import round trip.
      ...(row.epoch !== null && { epoch: row.epoch })
    }
  }

  /**
   * Exports the Space as a tar stream in the exact filesystem on-disk layout
   * (same file-name codecs, same manifest), so the archive imports into
   * either backend. Backend registration records are excluded (secret
   * material), exactly as on the filesystem.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<Readable>}   tar-stream pack
   */
  async exportSpace({ spaceId }: { spaceId: string }): Promise<Readable> {
    const spaceDescription = await this.getSpaceDescription({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Export Space' })
    }

    const [
      { rows: policyRows },
      { rows: collectionRows },
      { rows: resourceRows },
      { rows: revocationRows },
      { rows: chunkRows }
    ] = await Promise.all([
      this._pool.query<{
        collection_id: string
        resource_id: string
        policy: PolicyDocument
      }>(
        `SELECT collection_id, resource_id, policy FROM policies
            WHERE space_id = $1`,
        [spaceId]
      ),
      this._pool.query<{
        collection_id: string
        description: CollectionDescription | null
        description_version: number
      }>(
        `SELECT collection_id, description, description_version FROM collections
            WHERE space_id = $1`,
        [spaceId]
      ),
      // Metadata only -- content bytes are fetched one resource at a time
      // while packing, so an export never holds the whole Space in memory.
      this._pool.query<
        Omit<ResourceRow, 'content'> & {
          collection_id: string
          resource_id: string
        }
      >(
        `SELECT collection_id, resource_id, content_type, is_json,
                size_bytes, version, meta_version, custom, epoch, deleted,
                created_at, updated_at, created_by
           FROM resources WHERE space_id = $1`,
        [spaceId]
      ),
      this._pool.query<{
        delegator: string
        capability_id: string
        record: RevocationRecord
      }>(
        `SELECT delegator, capability_id, record FROM space_revocations
            WHERE space_id = $1`,
        [spaceId]
      ),
      // Chunk metadata only -- bytes are fetched one chunk at a time while
      // packing, so an export never holds a chunked Resource whole in memory.
      this._pool.query<{
        collection_id: string
        resource_id: string
        chunk_index: number
        content_type: string
        version: number
      }>(
        `SELECT collection_id, resource_id, chunk_index, content_type, version
           FROM chunks WHERE space_id = $1
          ORDER BY collection_id, resource_id, chunk_index`,
        [spaceId]
      )
    ])

    // Assemble the per-entry file lists in the filesystem's shapes: files are
    // named by the shared codecs and sorted with localeCompare, matching the
    // filesystem's directory-listing sort.
    const spacePolicy = policyRows.find(
      row => row.collection_id === '' && row.resource_id === ''
    )?.policy

    // A file entry carries its bytes inline (the small JSON dot-files), a lazy
    // reference to a resource representation, or a chunk directory (the
    // `chunked-streams` feature) whose files are likewise inline (the per-chunk
    // `.meta.<index>.json` sidecar) or lazy (the chunk `r.<index>...`
    // representation, resolved at pack time). `name` is the entry's sort key
    // within its dir; a chunk directory sorts by its `.chunks.<encId>` dir name.
    type ChunkFile =
      | { name: string; bytes: Buffer }
      | {
          name: string
          chunk: {
            collectionId: string
            resourceId: string
            chunkIndex: number
          }
        }
    type FileEntry =
      | { name: string; bytes: Buffer }
      | { name: string; resource: { collectionId: string; resourceId: string } }
      | { name: string; chunkDir: ChunkFile[] }
    // Space-level dot-files are always small JSON, carried inline.
    const spaceFiles: Array<{ name: string; bytes: Buffer }> = [
      {
        name: `.space.${spaceId}.json`,
        bytes: Buffer.from(JSON.stringify(spaceDescription))
      }
    ]
    if (spacePolicy) {
      spaceFiles.push({
        name: `.policy.${spaceId}.json`,
        bytes: Buffer.from(JSON.stringify(spacePolicy))
      })
    }

    const collectionsById = new Map<string, FileEntry[]>()
    const filesFor = (collectionId: string): FileEntry[] => {
      let files = collectionsById.get(collectionId)
      if (!files) {
        files = []
        collectionsById.set(collectionId, files)
      }
      return files
    }
    for (const row of collectionRows) {
      const files = filesFor(row.collection_id)
      if (row.description !== null) {
        // Embed the description version as `_version` in the archived
        // `.collection.` file (the filesystem backend's on-disk convention) so
        // the ETag validator survives an export/import round trip and archives
        // stay interchangeable between the two backends.
        files.push({
          name: `.collection.${row.collection_id}.json`,
          bytes: Buffer.from(
            JSON.stringify({
              ...row.description,
              _version: row.description_version
            })
          )
        })
      }
    }
    for (const row of policyRows) {
      if (row.collection_id === '') {
        continue
      }
      // Collection policy keys by the collection id, resource policy by the
      // resource id -- same dot-file convention, distinct keying ids.
      const keyId = row.resource_id === '' ? row.collection_id : row.resource_id
      filesFor(row.collection_id).push({
        name: `.policy.${keyId}.json`,
        bytes: Buffer.from(JSON.stringify(row.policy))
      })
    }
    for (const row of resourceRows) {
      const files = filesFor(row.collection_id)
      files.push({
        name: `.meta.${row.resource_id}.json`,
        bytes: Buffer.from(JSON.stringify(this._sidecarFor(row)))
      })
      if (!row.deleted) {
        files.push({
          name: fileNameFor({
            resourceId: row.resource_id,
            contentType: row.content_type
          }),
          resource: {
            collectionId: row.collection_id,
            resourceId: row.resource_id
          }
        })
      }
    }
    // Chunks (the `chunked-streams` feature): each chunked Resource contributes
    // one `.chunks.<encResourceId>/` subdirectory in its Collection dir, in the
    // exact filesystem-backend layout so an archive imports into either backend.
    // A chunk is stored there as a Resource keyed by its stringified index: an
    // `r.<index>.<encContentType>.<ext>` representation file (`fileNameFor`)
    // plus a `.meta.<index>.json` version sidecar. Files within a chunk dir are
    // sorted by name (the filesystem's readdir sort). Rows arrive ordered by
    // `(collection, resource, index)`.
    const chunkDirsByResource = new Map<string, ChunkFile[]>()
    for (const row of chunkRows) {
      const dirKey = `${row.collection_id}/${row.resource_id}`
      let chunkFiles = chunkDirsByResource.get(dirKey)
      if (!chunkFiles) {
        chunkFiles = []
        chunkDirsByResource.set(dirKey, chunkFiles)
        filesFor(row.collection_id).push({
          name: chunkDirName(row.resource_id),
          chunkDir: chunkFiles
        })
      }
      const chunkId = String(row.chunk_index)
      chunkFiles.push({
        name: fileNameFor({
          resourceId: chunkId,
          contentType: row.content_type
        }),
        chunk: {
          collectionId: row.collection_id,
          resourceId: row.resource_id,
          chunkIndex: row.chunk_index
        }
      })
      chunkFiles.push({
        name: `.meta.${chunkId}.json`,
        bytes: Buffer.from(
          JSON.stringify({ version: row.version } satisfies ChunkSidecar)
        )
      })
    }
    for (const chunkFiles of chunkDirsByResource.values()) {
      chunkFiles.sort((left, right) => left.name.localeCompare(right.name))
    }

    // Top-level order: space-level files and collection dirs interleaved,
    // sorted by name -- the same order the filesystem's readdir+sort yields.
    const topLevel: Array<
      | { kind: 'file'; name: string; bytes: Buffer }
      | { kind: 'collection'; name: string; files: FileEntry[] }
    > = [
      ...spaceFiles.map(file => ({ kind: 'file' as const, ...file })),
      ...[...collectionsById].map(([collectionId, files]) => ({
        kind: 'collection' as const,
        name: collectionId,
        files: files.sort((a, b) => a.name.localeCompare(b.name))
      }))
    ].sort((a, b) => a.name.localeCompare(b.name))

    // Space-scoped zcap revocations travel with the export, packed under a
    // top-level `revocations/` dir and named by the shared file-name codec so
    // both backends produce the same archive entries. Pretty-printed to match
    // the filesystem's stored records.
    const revocationFiles = revocationRows
      .map(row => ({
        name: revocationFileName({
          delegator: row.delegator,
          capabilityId: row.capability_id
        }),
        bytes: Buffer.from(JSON.stringify(row.record, null, 2))
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const manifest = buildExportManifest({
      spaceId,
      entries: topLevel.map(entry =>
        entry.kind === 'collection'
          ? {
              name: entry.name,
              // A chunk directory expands to its `.chunks.<encId>/<file>`
              // relative paths (mirroring the pack order), so the manifest
              // matches the filesystem backend's for the same Space.
              files: entry.files.flatMap(file =>
                'chunkDir' in file
                  ? file.chunkDir.map(child => `${file.name}/${child.name}`)
                  : [file.name]
              )
            }
          : { name: entry.name }
      ),
      revocationFiles: revocationFiles.map(file => file.name)
    })

    // Fixed mtime on every entry so the archive is byte-reproducible (see
    // EXPORT_ENTRY_MTIME).
    const mtime = EXPORT_ENTRY_MTIME
    const pack = tar.pack()
    pack.entry({ name: 'manifest.yml', mtime }, YAML.stringify(manifest))
    pack.entry({ name: 'space/', type: 'directory', mtime })
    pack.entry({ name: `space/${spaceId}/`, type: 'directory', mtime })
    for (const entry of topLevel) {
      const entryTarget = `space/${spaceId}/${entry.name}`
      if (entry.kind === 'collection') {
        pack.entry({ name: `${entryTarget}/`, type: 'directory', mtime })
        for (const file of entry.files) {
          if ('chunkDir' in file) {
            // A chunked Resource's `.chunks.<encId>/` subdirectory: emit the
            // directory entry, then each file -- an inline `.meta.<index>.json`
            // sidecar, or a chunk representation whose bytes are fetched one at
            // a time.
            const dirTarget = `${entryTarget}/${file.name}`
            pack.entry({ name: `${dirTarget}/`, type: 'directory', mtime })
            for (const chunkFile of file.chunkDir) {
              const bytes =
                'bytes' in chunkFile
                  ? chunkFile.bytes
                  : await this._chunkContent({ spaceId, ...chunkFile.chunk })
              pack.entry(
                { name: `${dirTarget}/${chunkFile.name}`, mtime },
                bytes
              )
            }
            continue
          }
          const bytes =
            'bytes' in file
              ? file.bytes
              : await this._resourceContent({ spaceId, ...file.resource })
          pack.entry({ name: `${entryTarget}/${file.name}`, mtime }, bytes)
        }
      } else {
        pack.entry({ name: entryTarget, mtime }, entry.bytes)
      }
    }
    if (revocationFiles.length > 0) {
      pack.entry({ name: 'revocations/', type: 'directory', mtime })
      for (const file of revocationFiles) {
        pack.entry({ name: `revocations/${file.name}`, mtime }, file.bytes)
      }
    }
    pack.finalize()
    return pack
  }

  /**
   * Fetches one resource's content bytes for the export pack loop. A row
   * deleted or tombstoned between the metadata pass and this read (the export
   * is not one transaction, same as the filesystem's racy directory walk)
   * yields an empty body rather than failing the whole archive.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<Buffer>}
   */
  private async _resourceContent({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<Buffer> {
    const { rows } = await this._pool.query<{ content: Buffer | null }>(
      `SELECT content FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionId, resourceId]
    )
    return rows[0]?.content ?? Buffer.alloc(0)
  }

  /**
   * Fetches one chunk's bytes for the export pack loop (the `chunked-streams`
   * feature). A chunk removed between the metadata pass and this read yields an
   * empty body rather than failing the whole archive, matching
   * `_resourceContent`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @returns {Promise<Buffer>}
   */
  private async _chunkContent({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<Buffer> {
    const { rows } = await this._pool.query<{ bytes: Buffer | null }>(
      `SELECT bytes FROM chunks
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          AND chunk_index = $4`,
      [spaceId, collectionId, resourceId, chunkIndex]
    )
    return rows[0]?.bytes ?? Buffer.alloc(0)
  }

  /**
   * Merges a WAS space-export tarball into an existing Space with the same
   * three-invariant pre-flight (per-entry 413, fail-closed 422 encryption
   * conformance, cumulative 507) and skip-not-overwrite merge semantics as
   * the filesystem backend -- including tombstone carry-over and "a tombstone
   * blocks resurrection". One strict improvement: the entire apply loop runs
   * in a single transaction, so a mid-import failure leaves the Space
   * untouched atomically.
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
    // Chunk entries (the `chunked-streams` feature) live in per-Resource
    // `.chunks.<encId>/` subdirectories, which `buildImportPlan` skips (it
    // ignores nested files); parse them straight off the raw tar entries.
    const chunkEntries = this._chunkEntriesFromArchive(entries)
    const {
      capacityBytes,
      maxUploadBytes,
      maxCollectionsPerSpace,
      maxResourcesPerSpace
    } = this

    return this._withTransaction(async client => {
      await this._ensureSpaceRow({ client, spaceId })
      // Serialize with concurrent writers on this Space for the duration of
      // the import: the usage counter row is the natural lock.
      const { rows: spaceRows } = await client.query<{ usage_bytes: string }>(
        'SELECT usage_bytes FROM spaces WHERE space_id = $1 FOR UPDATE',
        [spaceId]
      )
      const currentUsage = Number(spaceRows[0]?.usage_bytes ?? 0)

      // One pass over the Space's Collections: description presence drives
      // both the pre-flight encryption resolution and the skip-or-create
      // decision in the apply loop (a NULL-description placeholder row counts
      // as "does not exist", like a description-less directory).
      const { rows: descriptionRows } = await client.query<{
        collection_id: string
        description: CollectionDescription | null
      }>(
        `SELECT collection_id, description FROM collections
          WHERE space_id = $1`,
        [spaceId]
      )
      const descriptionsById = new Map(
        descriptionRows.map(row => [row.collection_id, row.description])
      )

      // Count quotas: measure the Space's existing Collection rows / live
      // Resources ONCE here, then track running totals as the apply loop
      // creates items, so an import cannot push the Space past
      // `maxCollectionsPerSpace` / `maxResourcesPerSpace`. Only brand-new items
      // count -- a re-imported existing id is skipped and does not -- mirroring
      // the per-create write-path guards without a COUNT query per row. The
      // transaction rolls the whole import back if a cap is exceeded mid-apply.
      let collectionRowCount = descriptionsById.size
      let liveResourceCount = 0
      if (maxResourcesPerSpace !== undefined) {
        const { rows: liveRows } = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM resources
            WHERE space_id = $1 AND NOT deleted`,
          [spaceId]
        )
        liveResourceCount = liveRows[0]!.count
      }

      // Pre-flight pass over every staged resource, before writing anything.
      // Skips (existing ids) are counted conservatively for the quota
      // estimate, as on the filesystem.
      let incomingBytes = 0
      for (const {
        collectionId,
        collectionDescription,
        resources
      } of collections) {
        const existing = descriptionsById.get(collectionId) ?? undefined
        const effectiveEncryption = existing
          ? existing.encryption
          : collectionDescription.encryption
        for (const { fileName, body } of resources) {
          if (body.length > maxUploadBytes) {
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
      }
      // Chunks (the `chunked-streams` feature) are opaque bytes -- no
      // encryption-conformance check applies -- but they count the same per-body
      // 413 and the (conservative) capacity pre-flight as Resource bodies.
      for (const chunk of chunkEntries) {
        if (chunk.body.length > maxUploadBytes) {
          throw new PayloadTooLargeError({
            maxUploadBytes,
            backendId: this.describe().id,
            uploadBytes: chunk.body.length
          })
        }
        incomingBytes += chunk.body.length
      }
      if (
        capacityBytes !== undefined &&
        currentUsage + incomingBytes > capacityBytes
      ) {
        throw new QuotaExceededError({ spaceId, capacityBytes })
      }

      const stats: ImportStats = {
        collectionsCreated: 0,
        collectionsSkipped: 0,
        resourcesCreated: 0,
        resourcesSkipped: 0,
        policiesCreated: 0,
        policiesSkipped: 0
      }

      // Space-level policy: restore it when the destination has none.
      if (spacePolicy) {
        const { rows } = await client.query(
          `SELECT 1 FROM policies
            WHERE space_id = $1 AND collection_id = '' AND resource_id = ''`,
          [spaceId]
        )
        if (rows.length > 0) {
          stats.policiesSkipped++
        } else {
          await this._upsertPolicy({
            queryable: client,
            spaceId,
            policy: spacePolicy
          })
          stats.policiesCreated++
        }
      }

      let createdBytes = 0
      for (const {
        collectionId,
        collectionDescription,
        collectionPolicy,
        resources,
        resourcePolicies,
        resourceMetadata
      } of collections) {
        const collectionExisted = Boolean(descriptionsById.get(collectionId))
        if (collectionExisted) {
          stats.collectionsSkipped++
        } else {
          // A brand-new Collection row counts against the cap; upserting a
          // description onto an existing NULL-description placeholder row does
          // not add a row, so it never trips the limit.
          const isNewRow = !descriptionsById.has(collectionId)
          if (
            maxCollectionsPerSpace !== undefined &&
            isNewRow &&
            collectionRowCount >= maxCollectionsPerSpace
          ) {
            throw new CountQuotaExceededError({
              scope: 'Collections per Space',
              limit: maxCollectionsPerSpace
            })
          }
          // Import restores `createdBy` verbatim from the archived document
          // (already discarded and reapplied by `_upsertCollection`, same as
          // any other write): this is only ever a create here (the branch
          // above skips existing Collections), so there is no prior row for
          // COALESCE to prefer over it.
          await this._upsertCollection({
            queryable: client,
            spaceId,
            collectionId,
            collectionDescription,
            createdBy: collectionDescription.createdBy
          })
          if (isNewRow) {
            collectionRowCount++
          }
          descriptionsById.set(collectionId, collectionDescription)
          stats.collectionsCreated++
        }

        // A collection-level policy travels with a newly-created collection;
        // for an existing (skipped) collection, leave its policy untouched.
        if (collectionPolicy) {
          if (collectionExisted) {
            stats.policiesSkipped++
          } else {
            await this._upsertPolicy({
              queryable: client,
              spaceId,
              collectionId,
              policy: collectionPolicy
            })
            stats.policiesCreated++
          }
        }

        // All ids the destination already holds for this Collection -- live
        // or tombstone, either blocks the import for its id ("a tombstone
        // blocks resurrection") -- in one query instead of one per resource.
        // Created ids are added as we go, so a duplicate id later in the same
        // archive is skipped rather than tripping the primary key.
        const { rows: existingIdRows } = await client.query<{
          resource_id: string
        }>(
          `SELECT resource_id FROM resources
            WHERE space_id = $1 AND collection_id = $2`,
          [spaceId, collectionId]
        )
        const existingResourceIds = new Set(
          existingIdRows.map(row => row.resource_id)
        )

        for (const { fileName, resourceId, body } of resources) {
          if (existingResourceIds.has(resourceId)) {
            stats.resourcesSkipped++
            // A resource-level policy travels with a newly-created resource.
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
          const { contentType } = parseResourceFileName(fileName)
          await this._insertImportedResource({
            client,
            spaceId,
            collectionId,
            resourceId,
            contentType,
            body,
            sidecar: parseSidecar(resourceMetadata.get(resourceId))
          })
          existingResourceIds.add(resourceId)
          createdBytes += body.length
          stats.resourcesCreated++

          const resourcePolicy = resourcePolicies.get(resourceId)
          if (resourcePolicy) {
            await this._upsertPolicy({
              queryable: client,
              spaceId,
              collectionId,
              resourceId,
              policy: resourcePolicy
            })
            stats.policiesCreated++
          }
        }

        // Carry tombstones: an orphan `.meta.` sidecar that is a tombstone
        // (`deleted: true`) re-creates the tombstone row; a non-tombstone
        // orphan sidecar is anomalous and skipped. Merge semantics match
        // resources: anything the destination already has is left untouched.
        const importedResourceIds = new Set(
          resources.map(resource => resource.resourceId)
        )
        for (const resourceId of resourceMetadata.keys()) {
          if (importedResourceIds.has(resourceId)) {
            continue
          }
          const sidecar = parseSidecar(resourceMetadata.get(resourceId))
          if (sidecar?.deleted !== true) {
            continue
          }
          if (existingResourceIds.has(resourceId)) {
            stats.resourcesSkipped++
            continue
          }
          await this._insertImportedResource({
            client,
            spaceId,
            collectionId,
            resourceId,
            contentType: sidecar.contentType ?? 'application/octet-stream',
            body: null,
            sidecar
          })
          existingResourceIds.add(resourceId)
          stats.resourcesCreated++
        }
      }

      // Chunks (the `chunked-streams` feature): restore each archived chunk
      // skip-not-overwrite, after the Resource apply loop so a chunk's parent
      // Resource row already exists in this transaction (the foreign key
      // requires it). An orphan chunk -- one whose parent is absent or a
      // tombstone -- is skipped rather than resurrected. Existing chunk rows are
      // left untouched.
      let createdChunkBytes = 0
      for (const chunk of chunkEntries) {
        const { rows: parentRows } = await client.query<{ deleted: boolean }>(
          `SELECT deleted FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
          [spaceId, chunk.collectionId, chunk.resourceId]
        )
        const parent = parentRows[0]
        if (!parent || parent.deleted) {
          continue
        }
        const { rows: existingChunkRows } = await client.query(
          `SELECT 1 FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND chunk_index = $4`,
          [spaceId, chunk.collectionId, chunk.resourceId, chunk.chunkIndex]
        )
        if (existingChunkRows.length > 0) {
          continue
        }
        // The chunk's `version` comes from its archived `.meta.<index>.json`
        // sidecar; an archive without one (or a chunk written before sidecars)
        // starts at version 1, the same fresh-write default as a Resource
        // restored without a sidecar.
        await client.query(
          `INSERT INTO chunks (
             space_id, collection_id, resource_id, chunk_index,
             content_type, bytes, size, version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            spaceId,
            chunk.collectionId,
            chunk.resourceId,
            chunk.chunkIndex,
            chunk.contentType,
            chunk.body,
            chunk.body.length,
            chunk.version ?? 1
          ]
        )
        createdChunkBytes += chunk.body.length
      }

      const createdTotalBytes = createdBytes + createdChunkBytes
      if (createdTotalBytes > 0) {
        // The pre-flight was conservative (it counted skips too), so the
        // actual created total always fits; apply it unguarded.
        await this._applyUsageDelta({
          client,
          spaceId,
          delta: createdTotalBytes
        })
      }

      // Restore the archive's Space-scoped zcap revocations under this
      // Space's scope: a capability revoked before the export must stay
      // revoked after an import (a backup/restore round-trip must not
      // resurrect revoked access). `ON CONFLICT DO NOTHING` gives the
      // skip-not-overwrite merge per record; a record past its GC horizon is
      // dropped (the capability itself has expired; `isRevoked` would prune
      // it). Transactional like the rest of the apply loop.
      const now = Date.now()
      for (const record of revocations) {
        if (record.meta.expires && Date.parse(record.meta.expires) <= now) {
          continue
        }
        await client.query(
          `INSERT INTO space_revocations
             (space_id, delegator, capability_id, record, expires)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT DO NOTHING`,
          [
            spaceId,
            record.meta.delegator,
            record.capability.id,
            JSON.stringify(record),
            record.meta.expires ?? null
          ]
        )
      }

      return stats
    })
  }

  /**
   * Inserts one archived resource (or orphan tombstone) row for the import
   * apply loop. Timestamps, versions, `createdBy`, and `custom` come from the
   * archive's sidecar when present; an archive resource without a sidecar is
   * treated as a fresh first write on this backend (version 1, no
   * `createdBy`).
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.contentType {string}
   * @param options.body {Buffer|null}   `null` re-creates a tombstone
   * @param [options.sidecar] {SidecarShape}
   * @returns {Promise<void>}
   */
  private async _insertImportedResource({
    client,
    spaceId,
    collectionId,
    resourceId,
    contentType,
    body,
    sidecar
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    resourceId: string
    contentType: string
    body: Buffer | null
    sidecar: SidecarShape | undefined
  }): Promise<void> {
    const now = new Date().toISOString()
    const deleted = body === null
    await client.query(
      `INSERT INTO resources (
         space_id, collection_id, resource_id, content_type, content,
         is_json, size_bytes, version, meta_version, custom, deleted,
         created_at, updated_at, created_by, epoch
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
                 $12, $13, $14, $15)`,
      [
        spaceId,
        collectionId,
        resourceId,
        contentType,
        body,
        isJson({ contentType }),
        body?.length ?? 0,
        sidecar?.version ?? 1,
        sidecar?.metaVersion ?? null,
        sidecar?.custom !== undefined ? JSON.stringify(sidecar.custom) : null,
        deleted,
        sidecar?.createdAt ?? now,
        sidecar?.updatedAt ?? now,
        sidecar?.createdBy ?? null,
        // Restore the client-declared key epoch (the `key-epochs` feature) from
        // the archived sidecar; a tombstone or an unstamped Resource has none.
        sidecar?.epoch ?? null
      ]
    )
  }

  /**
   * Parses a Space-export archive's chunk entries (the `chunked-streams`
   * feature) out of the raw tar entry map, in the filesystem backend's on-disk
   * layout so archives round-trip between the two backends. Chunk files live at
   * `space/<sourceSpaceId>/<collectionId>/.chunks.<encResourceId>/<file>` --
   * where a chunk is a Resource keyed by its stringified index: an
   * `r.<index>.<encContentType>.<ext>` representation paired with an optional
   * `.meta.<index>.json` version sidecar. `buildImportPlan` skips these (it
   * ignores nested Collection-dir files), so they are parsed here. Ids parsed
   * from the archive are validated (the path-traversal guard); a file whose
   * raw index segment is not canonical (`parseChunkIndexSegment`) is ignored,
   * and a sidecar with no paired representation is dropped (a chunk keeps no
   * tombstone).
   * @param entries {Map<string, TarEntry>}
   * @returns {Array<{ collectionId: string, resourceId: string, chunkIndex:
   *   number, contentType: string, body: Buffer, version?: number }>}
   */
  private _chunkEntriesFromArchive(entries: Map<string, TarEntry>): Array<{
    collectionId: string
    resourceId: string
    chunkIndex: number
    contentType: string
    body: Buffer
    version?: number
  }> {
    // Accumulate the representation and the sidecar of each chunk under one
    // key, then emit only the chunks that carry a representation.
    const staged = new Map<
      string,
      {
        collectionId: string
        resourceId: string
        chunkIndex: number
        contentType?: string
        body?: Buffer
        version?: number
      }
    >()
    const pattern = /^space\/[^/]+\/([^/]+)\/(\.chunks\.[^/]+)\/([^/]+)$/
    for (const [entryName, entry] of entries) {
      if (entry.type !== 'file' || !entry.body) {
        continue
      }
      const match = entryName.match(pattern)
      if (!match) {
        continue
      }
      const collectionId = match[1]!
      const resourceId = parseChunkDirName(match[2]!)
      const fileName = match[3]!
      if (resourceId === undefined) {
        continue
      }
      // Reject a path-traversal / non-URL-safe id parsed from the archive
      // before it keys a destination row.
      assertValidId(collectionId, {
        kind: 'collection',
        requestName: 'Import Space'
      })
      assertValidId(resourceId, {
        kind: 'resource',
        requestName: 'Import Space'
      })

      // A chunk's index is the "resource id" of its file within the chunk dir:
      // `r.<index>.<encType>.<ext>` for the representation, `.meta.<index>.json`
      // for the version sidecar. The RAW index segment must pass the same
      // canonical predicate as the live route (`parseChunkIndexSegment`), so a
      // non-canonical spelling (`r.01.*`, `r.%31.*`) is dropped rather than
      // coerced onto -- and colliding with -- the canonical chunk's row.
      let chunkIdSegment: string | undefined
      let representation: { contentType: string; body: Buffer } | undefined
      let sidecarVersion: number | undefined
      const metaId = metaSidecarFileId(fileName)
      if (metaId !== undefined) {
        chunkIdSegment = metaId
        try {
          const sidecar = JSON.parse(
            entry.body.toString('utf8')
          ) as ChunkSidecar
          sidecarVersion = sidecar.version
        } catch {
          sidecarVersion = undefined
        }
      } else if (fileName.startsWith('r.')) {
        const { contentType } = parseResourceFileName(fileName)
        chunkIdSegment = fileName.split('.')[1]
        representation = { contentType, body: entry.body }
      } else {
        continue
      }

      const chunkIndex =
        chunkIdSegment === undefined
          ? undefined
          : parseChunkIndexSegment(chunkIdSegment)
      if (chunkIndex === undefined) {
        continue
      }

      const key = `${collectionId}/${resourceId}/${chunkIndex}`
      const slot = staged.get(key) ?? { collectionId, resourceId, chunkIndex }
      if (representation !== undefined) {
        slot.contentType = representation.contentType
        slot.body = representation.body
      }
      if (sidecarVersion !== undefined) {
        slot.version = sidecarVersion
      }
      staged.set(key, slot)
    }

    const parsed: Array<{
      collectionId: string
      resourceId: string
      chunkIndex: number
      contentType: string
      body: Buffer
      version?: number
    }> = []
    for (const slot of staged.values()) {
      if (slot.body === undefined) {
        // A sidecar with no paired representation is not a valid chunk.
        continue
      }
      parsed.push({
        collectionId: slot.collectionId,
        resourceId: slot.resourceId,
        chunkIndex: slot.chunkIndex,
        contentType: slot.contentType ?? 'application/octet-stream',
        body: slot.body,
        version: slot.version
      })
    }
    return parsed
  }
}
