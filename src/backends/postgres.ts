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
import { AsyncLocalStorage } from 'node:async_hooks'
import { Readable } from 'node:stream'
import pg from 'pg'
import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
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
  assertImportBodiesFit
} from '../lib/importTar.js'
import type { ImportPlanCollection } from '../lib/importTar.js'
import { collectionPath, collectionsPath } from '../lib/paths.js'
import {
  fileNameFor,
  parseResourceFileName,
  chunkDirName,
  spaceDescriptionFileName,
  collectionDescriptionFileName,
  COLLECTION_POLICY_FILE_NAME,
  resourcePolicyFileName,
  SPACE_POLICY_FILE_NAME,
  metaSidecarFileName,
  collectionMetaFileName,
  collectionLogFileName
} from '../lib/resourceFileName.js'
import type { MetaSidecar, CollectionMetaSidecar } from '../lib/metaSidecar.js'
import {
  sanitizeBackendRecord,
  serverBackendDescriptor
} from '../lib/backends.js'
import { backendUsageFieldsFor } from '../lib/backendUsage.js'
import {
  collectionListingItem,
  collectionResourcesList,
  suppressesItemNames
} from '../lib/collectionListing.js'
import { decodeCursor } from '../lib/cursor.js'
import { policyGrants } from '../policy.js'
import { packSpaceArchive } from '../lib/exportTar.js'
import type { ArchiveEntry, ArchiveFile } from '../lib/exportTar.js'
import { revocationFileName } from '../lib/revocations.js'
import { isJson } from '../lib/isJson.js'
import { normalizeDescriptionWrite } from '../lib/descriptionWrite.js'
import {
  type EtagValidator,
  type HeldValidators,
  descriptionEtagOf,
  embedDescriptionValidator,
  etagOf,
  resolveGeneration,
  stripDescriptionValidator
} from '../lib/etag.js'
import {
  clampPageSize,
  nextPageUrl,
  resolvePageSize
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
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_SPACES_PER_CONTROLLER,
  DEFAULT_MAX_COLLECTIONS_PER_SPACE,
  DEFAULT_MAX_RESOURCES_PER_SPACE,
  normalizeCountLimit,
  normalizeCapacityBytes
} from '../config.default.js'
import {
  assertWritePrecondition,
  assertMetaWritePrecondition,
  assertCollectionWritePrecondition,
  assertSpaceWritePrecondition,
  assertCollectionMetaWritePrecondition,
  assertCollectionLogWritePrecondition
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
  StoredCollectionDescription,
  DescriptionValidatorParts,
  StoredSpaceDescription,
  StoredCollectionMetadata,
  StoredCollectionLog,
  VersionedMetadata,
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
const CONNECTION_TIMEOUT_MS = 30_000
// The per-Space advisory lock `writeSpace` and `deleteSpace` serialize on
// (a Space Description precondition check and version bump, or a delete, are
// atomic against each other; disjoint from the `spaces` row lock the
// Collection and Resource writes hold as the usage counter).
const SPACE_DESC_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('space-desc:' || $1))`

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
  generation: string
  version: number
  meta_generation: string | null
  meta_version: number | null
  custom: ResourceMetadataCustom | Record<string, unknown> | null
  deleted: boolean
  created_at: string
  updated_at: string
  created_by: IDID | null
  epoch: string | null
}

/**
 * Buffers a byte stream fully into memory, aborting with
 * `PayloadTooLargeError` (413) the moment the cumulative size exceeds
 * `maxUploadBytes` -- the buffered-`bytea` analogue of the filesystem
 * backend's streaming `#byteLimitGuard`.
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
 * The stored form of a Space or Collection Description row: the jsonb body
 * with the row's validator columns re-surfaced as the out-of-band
 * `descriptionGeneration` / `descriptionVersion` parts. A NULL generation
 * column (a legacy row) contributes no generation, so `etagOf` reports no
 * validator for it. Resolves `undefined` for a missing row and for a
 * placeholder (NULL-description) row, both "no described record yet".
 * @param row {object}   the row, if any
 * @param [row.description] {T | null}
 * @param row.description_generation {string | null}
 * @param row.description_version {number}
 * @returns {(T & DescriptionValidatorParts) | undefined}
 */
function storedDescriptionFromRow<T extends object>(
  row:
    | {
        description: T | null
        description_generation: string | null
        description_version: number
      }
    | undefined
): (T & DescriptionValidatorParts) | undefined {
  if (row?.description == null) {
    return undefined
  }
  return {
    ...row.description,
    ...(row.description_generation !== null && {
      descriptionGeneration: row.description_generation
    }),
    descriptionVersion: row.description_version
  }
}

/**
 * Parses an archived `.meta.<resourceId>.json` sidecar's bytes into the
 * shared sidecar shape; unparseable (or absent) bytes yield `undefined`, and
 * the import falls back to fresh-write defaults.
 * @param bytes {Buffer|undefined}
 * @returns {MetaSidecar|undefined}
 */
function parseSidecar(bytes: Buffer | undefined): MetaSidecar | undefined {
  if (!bytes) {
    return undefined
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as MetaSidecar
  } catch {
    return undefined
  }
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

  #pool: pg.Pool
  #schema?: string
  /**
   * The `PoolClient` of the transaction running on the current async context,
   * when one is. `#withTransaction` installs it for the span of its callback
   * and `#reader()` hands it to any read that runs inside -- so a read invoked
   * re-entrantly from within a transaction (a `StorageBackend` method called
   * back from an `assertTransition` callback, say) joins that transaction
   * instead of checking out a SECOND pooled connection. Without this a
   * transaction that awaits a nested read holds one connection while waiting
   * for another, and `POOL_MAX` such transactions exhaust the pool and wait on
   * each other forever. Joining the transaction is also the semantics such a
   * read wants: it sees the state the transaction has written so far.
   */
  #transactionClient = new AsyncLocalStorage<pg.PoolClient>()

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
    this.#schema = schema
    this.logger = logger ?? silentLogger
    this.capacityBytes = normalizeCapacityBytes(capacityBytes)
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
    this.#pool = new pg.Pool({
      connectionString,
      max: POOL_MAX,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      // Defence in depth behind `#transactionClient`: if a future read ever
      // does check out a second connection from inside a transaction, the
      // pool starves loudly (an error the request layer turns into a 500)
      // rather than hanging every request forever.
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      // `search_path` is a connection-startup parameter, so every pooled
      // connection lands in the right schema with no per-checkout SET race.
      ...(schema !== undefined && { options: `-csearch_path=${schema}` })
    })
    this.#pool.on('error', err => {
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
    const client = await this.#pool.connect()
    try {
      if (this.#schema !== undefined) {
        // Identifier-quoted; the constructor validated the name's charset.
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.#schema}"`)
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
    await this.#pool.end()
  }

  /**
   * The `Queryable` a read should run on: the current transaction's client
   * when this call is running inside `#withTransaction`, else the pool. Every
   * read in this backend goes through it -- see `#transactionClient` for why.
   * @returns {Queryable}
   */
  #reader(): Queryable {
    return this.#transactionClient.getStore() ?? this.#pool
  }

  /**
   * Runs `fn` inside one transaction on a dedicated client, committing on
   * success and rolling back on any throw.
   * @param fn {(client: pg.PoolClient) => Promise<T>}
   * @returns {Promise<T>}
   */
  async #withTransaction<T>(
    fn: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      // Run the body with this transaction's client installed as the ambient
      // reader (see `#transactionClient`), so a nested read joins the
      // transaction rather than checking out a second connection.
      const result = await this.#transactionClient.run(client, () => fn(client))
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
   * affordances as the filesystem backend -- the shared server-backend feature
   * set (`SERVER_BACKEND_FEATURES` in `lib/backends.ts`), realized here by
   * row-locked preconditions with ETag validators and opaque per-chunk raw-bytes
   * storage in the `chunks` table.
   * @returns {Required<Omit<BackendDescriptor, 'provider' | 'connection'>>}
   */
  describe(): Required<Omit<BackendDescriptor, 'provider' | 'connection'>> {
    return serverBackendDescriptor({ name: 'Server PostgreSQL' })
  }

  /**
   * Ensures the `spaces` row for `spaceId` exists (a placeholder with a NULL
   * description when the Space was never described -- the analogue of the
   * filesystem creating a Space directory on a sub-Space write), and leaves
   * the row locked for the rest of the transaction.
   *
   * Provisioning and locking are one statement on purpose. `ON CONFLICT DO
   * NOTHING` takes no lock on the row it found, so a concurrent `deleteSpace`
   * could commit between this statement and a following `#lockSpaceRow`,
   * whose `FOR UPDATE` would then match no row and lock nothing; the caller's
   * next `INSERT` into a cascade-dependent table would raise a foreign-key
   * violation, which is no `ProblemError` and so renders a 500. `DO UPDATE`
   * locks the conflicting row instead, so the write and the deletion order
   * deterministically. The no-op update costs nothing extra: every content
   * write updates this row again through `#applyUsageDelta`.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async #ensureSpaceRow({
    client,
    spaceId
  }: {
    client: pg.PoolClient
    spaceId: string
  }): Promise<void> {
    await client.query(
      `INSERT INTO spaces (space_id) VALUES ($1)
       ON CONFLICT (space_id) DO UPDATE SET space_id = spaces.space_id`,
      [spaceId]
    )
  }

  /**
   * Ensures the `collections` row (and its parent `spaces` row) exists,
   * placeholder-description like `#ensureSpaceRow`.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<void>}
   */
  async #ensureCollectionRow({
    client,
    spaceId,
    collectionId
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
  }): Promise<void> {
    await this.#ensureSpaceRow({ client, spaceId })
    await client.query(
      `INSERT INTO collections (space_id, collection_id) VALUES ($1, $2)
       ON CONFLICT (space_id, collection_id) DO NOTHING`,
      [spaceId, collectionId]
    )
  }

  /**
   * Takes the Space's `spaces` row lock -- the ONE lock every mutating
   * transaction in this backend acquires first.
   *
   * Lock order, obeyed by every transaction that mutates stored bytes:
   * `spaces` row, then the `collections` row, then the `resources` / `chunks`
   * row. Every such transaction ends up holding the `spaces` row anyway,
   * because `#applyUsageDelta`'s `UPDATE spaces` locks it until commit; taking
   * it up front only widens that window by the transaction's own pre-read.
   * What it buys is the absence of an inversion: before this, a Collection
   * write locked `spaces` then `collections` while a Collection delete locked
   * `collections` then `spaces`, so a concurrent `PUT` and `DELETE` of one
   * non-empty Collection deadlocked, and Postgres aborted one with SQLSTATE
   * `40P01` -- not a `ProblemError`, so the request layer rendered a 500. The
   * same inversion stood between `importSpace` (which holds this row for its
   * whole apply loop) and the Resource and chunk write paths.
   *
   * The per-Space advisory locks are ordered against this the same way
   * throughout: `SPACE_DESC_LOCK_SQL` is taken BEFORE this row lock (the
   * Space Description paths take no other), and `#lockSameKeyCreate` /
   * `#lockCollectionUniqueness` are taken AFTER it.
   *
   * A path that provisions the Space takes this same lock through
   * `#ensureSpaceRow`, which creates-or-locks in one statement; calling this
   * afterwards is then a no-op on a row the transaction already holds, kept
   * where the call site's own reason for the lock is worth stating. This
   * variant never creates the row, so a delete path that finds it gone locks
   * nothing and its own statements report the absence.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async #lockSpaceRow({
    client,
    spaceId
  }: {
    client: pg.PoolClient
    spaceId: string
  }): Promise<void> {
    await client.query('SELECT 1 FROM spaces WHERE space_id = $1 FOR UPDATE', [
      spaceId
    ])
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
  async #applyUsageDelta({
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
   * "no prior row" and each evaluate its `If-None-Match: *` / `If-Match`
   * precondition against that phantom absence. The caller takes this lock when
   * its lock-nothing SELECT found no row, then RE-reads the row: the second
   * creator blocks here until the first commits, and its re-read sees the
   * committed row, so its precondition and its reported validator are computed
   * from accurate state. The usage delta does NOT depend on this lock -- it is
   * derived from the writing statement's own snapshot
   * (`#insertOrUpsertVersioned`), which is what keeps the counter exact
   * against a creator that never takes this lock at all. Held to commit
   * (advisory xact lock). The `create:`
   * prefix keeps this key domain distinct from the unique-blinded-term
   * advisory lock, which hashes the bare `(spaceId, collectionId)`.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.rowKey {string}   the row's identity within the Space
   * @returns {Promise<void>}
   */
  async #lockSameKeyCreate({
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

  /**
   * Locks a create-or-update target row and returns its prior state (or
   * `undefined` when absent), running `lockingSelect` -- a `SELECT ... FOR
   * UPDATE` on the row -- once, and, when it finds no row, taking the same-key
   * create lock (`#lockSameKeyCreate`, whose doc comment states why the re-read
   * is required) and re-running it. Shared by the Resource (`writeResource`) and
   * chunk (`writeChunk`) write paths, which pass their own table-specific select
   * and row-identity key.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.rowKey {string}   the row's identity within the Space (the
   *   `#lockSameKeyCreate` key domain)
   * @param options.lockingSelect {() => Promise<T | undefined>}   runs the
   *   `SELECT ... FOR UPDATE` and resolves the prior row (or `undefined`)
   * @returns {Promise<T | undefined>}   the prior row, re-read under the create
   *   lock when the first select found none
   */
  async #lockRowForWrite<T>({
    client,
    spaceId,
    rowKey,
    lockingSelect
  }: {
    client: pg.PoolClient
    spaceId: string
    rowKey: string
    lockingSelect: () => Promise<T | undefined>
  }): Promise<T | undefined> {
    let prior = await lockingSelect()
    if (prior === undefined) {
      // The lock-nothing case -- see `#lockSameKeyCreate`.
      await this.#lockSameKeyCreate({ client, spaceId, rowKey })
      prior = await lockingSelect()
    }
    return prior
  }

  /**
   * Serializes concurrent claimants of a per-Collection uniqueness invariant --
   * the EDV unique-blinded attributes and the plaintext `unique`-declared
   * equality indexes -- on a transaction-scoped advisory lock keyed by the
   * `(spaceId, collectionId)` pair. Held to commit, so a loser's conflict scan
   * sees the winner's committed row, and taken without entering the row-lock
   * ordering of plain writes. The bare `(spaceId, collectionId)` key domain is
   * deliberately distinct from the `create:`-prefixed same-key create lock
   * (`#lockSameKeyCreate`).
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<void>}
   */
  async #lockCollectionUniqueness({
    client,
    spaceId,
    collectionId
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
  }): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [spaceId, collectionId]
    )
  }

  /**
   * Buffers a write's body fully into memory as one `Buffer`, applying the
   * per-upload cap (413 `PayloadTooLargeError`): a JSON body is serialized and
   * size-checked; a binary body pre-flights its declared size, then buffers
   * through the counting guard that hard-caps a body whose size is omitted or
   * understated. Buffering happens BEFORE the write transaction so a slow upload
   * holds no row lock. Shared by `writeResource` and `writeChunk`.
   * @param input {ResourceInput}
   * @returns {Promise<Buffer>}
   */
  async #bufferInputCapped(input: ResourceInput): Promise<Buffer> {
    const { maxUploadBytes } = this
    const backendId = this.describe().id
    if (input.kind === 'json') {
      const content = Buffer.from(JSON.stringify(input.data))
      if (content.length > maxUploadBytes) {
        throw new PayloadTooLargeError({
          maxUploadBytes,
          backendId,
          uploadBytes: content.length
        })
      }
      return content
    }
    if (
      input.declaredBytes !== undefined &&
      input.declaredBytes > maxUploadBytes
    ) {
      throw new PayloadTooLargeError({
        maxUploadBytes,
        backendId,
        uploadBytes: input.declaredBytes
      })
    }
    return bufferStreamCapped({
      stream: input.stream,
      maxUploadBytes,
      backendId
    })
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
    const totalQuery = this.#reader().query<{ usage_bytes: string }>(
      'SELECT usage_bytes FROM spaces WHERE space_id = $1',
      [spaceId]
    )
    // The Space total and the per-Collection breakdown are independent reads:
    // issue both on the pool at once rather than paying the two round trips
    // serially. Per-Collection usage sums both Resource content bytes and
    // chunk bytes (the `chunked-streams` feature) so the breakdown agrees with
    // the Space total in the transactional counter.
    const [{ rows }, collectionRows] = await Promise.all([
      totalQuery,
      includeCollections
        ? this.#reader()
            .query<{ collection_id: string; usage: string }>(
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
            .then(result => result.rows)
        : undefined
    ])
    const usageBytes = rows[0] ? Number(rows[0].usage_bytes) : 0
    const usageByCollection: CollectionUsage[] | undefined =
      collectionRows?.map(row => ({
        id: row.collection_id,
        usageBytes: Number(row.usage)
      }))

    return {
      ...backendUsageFieldsFor({
        backend: this,
        usageBytes,
        spaceTotalBytes: usageBytes
      }),
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
    const { rows } = await this.#reader().query<{
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
      ...backendUsageFieldsFor({ backend: this, usageBytes, spaceTotalBytes }),
      measuredAt
    }
  }

  // Spaces

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.spaceDescription {SpaceDescription}
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Space's `createdBy` on first write only
   * @param [options.ifMatch] {string}   an `If-Match` compare-and-swap on the
   *   current description `ETag`; a stale validator throws
   *   `PreconditionFailedError` (412)
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *`, the guarded
   *   create; an existing Description throws `PreconditionFailedError` (412)
   * @returns {Promise<EtagValidator>}   the Space's new description validator
   *   (its `generation` and bumped `version`, the `ETag`)
   */
  async writeSpace({
    spaceId,
    spaceDescription,
    createdBy,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    spaceDescription: SpaceDescription
    createdBy?: IDID
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator> {
    const { controller } = spaceDescription
    return this.#withTransaction(async client => {
      // Serialize concurrent Description writes (and Delete Space) for the
      // same Space id on an advisory lock: a `FOR UPDATE` on the row locks
      // nothing while the row does not exist yet, and two racing guarded
      // creates must not both observe "absent". The advisory lock is the
      // whole serialization; the row itself is read plainly below, so a
      // Description write does not block, and is not blocked by, the
      // Collection and Resource writes that lock the same row as the Space's
      // usage counter. Holding the lock across the quota COUNT below also
      // serializes creates for the same controller.
      await client.query(SPACE_DESC_LOCK_SQL, [spaceId])
      if (this.maxSpacesPerController !== undefined) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext('controller-count:' || $1))`,
          [controller]
        )
      }
      // Read the current row (if any) and its validator, so the precondition,
      // the create detection, `createdBy` resolution, and the monotonic
      // version bump are all atomic with the write. A missing row and a
      // placeholder (NULL-description) row are both "no described Space yet":
      // version 0 and no generation, so the first real description write mints
      // a generation at version 1 (a placeholder's `description_version`
      // column holds the schema DEFAULT and must not count).
      const { rows } = await client.query<{
        description: SpaceDescription | null
        description_generation: string | null
        description_version: number
      }>(
        `SELECT description, description_generation, description_version
           FROM spaces WHERE space_id = $1`,
        [spaceId]
      )
      const prior = storedDescriptionFromRow(rows[0])

      assertSpaceWritePrecondition({
        spaceId,
        exists: prior !== undefined,
        currentEtag: descriptionEtagOf(prior),
        ifMatch,
        ifNoneMatch
      })

      // Count quota (create path only), enforced as a HARD limit under the
      // controller-scoped advisory lock taken above: COUNT this controller's
      // Spaces and reject at the limit.
      if (this.maxSpacesPerController !== undefined && prior === undefined) {
        const { rows: countRows } = await client.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM spaces WHERE controller = $1',
          [controller]
        )
        if (countRows[0]!.count >= this.maxSpacesPerController) {
          throw new CountQuotaExceededError({
            scope: 'Spaces per controller',
            limit: this.maxSpacesPerController
          })
        }
      }

      // `createdBy` names the Space's creator, not its last writer: taken from
      // this write's invoker only when this write CREATES the description, and
      // preserved verbatim afterward -- including preserved-as-absent, so a
      // Space created with no invoker (a token-provisioned create) never has a
      // later writer backfilled into it as its creator. The client-supplied
      // `spaceDescription` is wire input and may carry its own `createdBy` --
      // discard it, since the server alone is authoritative for it. The
      // validator-bearing members it may carry are stripped by the shared
      // normalization (lib/descriptionWrite.ts), the same rule the filesystem
      // backend applies, so a client-supplied `_generation` / `_version` never
      // lands in the jsonb body.
      const creator = prior ? prior.createdBy : createdBy
      // The description keeps its generation for the Space's whole life; a
      // Space deleted and re-created under the same id mints a new one, so the
      // two lives' validators can never coincide.
      const validator = {
        generation: resolveGeneration(prior?.descriptionGeneration),
        version: (prior?.descriptionVersion ?? 0) + 1
      }
      const { body } = normalizeDescriptionWrite({
        description: spaceDescription,
        validator
      })
      const { createdBy: _suppliedCreatedBy, ...rest } = body
      // The upsert maintains the denormalized `controller` column on both
      // insert and update -- the description's controller can change on
      // update, and the Spaces count quota reads this column (spec "Quotas").
      // The validator lives in its own columns and stays out of the jsonb body.
      await client.query(
        `INSERT INTO spaces (space_id, description, controller,
                             description_generation, description_version)
         VALUES ($1, $2::jsonb, $3, $4, $5)
         ON CONFLICT (space_id) DO UPDATE SET
           description = EXCLUDED.description,
           controller = EXCLUDED.controller,
           description_generation = EXCLUDED.description_generation,
           description_version = EXCLUDED.description_version`,
        [
          spaceId,
          JSON.stringify({
            ...rest,
            ...(creator !== undefined && { createdBy: creator })
          }),
          controller,
          validator.generation,
          validator.version
        ]
      )
      return validator
    })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<StoredSpaceDescription|undefined>}   falsy when the
   *   Space does not exist or is a placeholder row without a description;
   *   `descriptionGeneration` / `descriptionVersion` are the out-of-band
   *   `ETag` validator
   */
  async getSpaceDescription({
    spaceId
  }: {
    spaceId: string
  }): Promise<StoredSpaceDescription | undefined> {
    const { rows } = await this.#reader().query<{
      description: SpaceDescription | null
      description_generation: string | null
      description_version: number
    }>(
      `SELECT description, description_generation, description_version
         FROM spaces WHERE space_id = $1`,
      [spaceId]
    )
    return storedDescriptionFromRow(rows[0])
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
    await this.#withTransaction(async client => {
      // The same advisory lock `writeSpace` serializes on, so the delete
      // cannot land between that write's prior read and its upsert: the
      // upsert would recreate the row carrying the deleted life's generation,
      // where a re-create must mint a fresh one.
      await client.query(SPACE_DESC_LOCK_SQL, [spaceId])
      await client.query('DELETE FROM spaces WHERE space_id = $1', [spaceId])
    })
  }

  /**
   * Every described Space, sorted by id (byte order via `COLLATE "C"`).
   * Placeholder rows without a description are skipped, like a Space dir
   * without a readable description file.
   * @returns {Promise<SpaceDescription[]>}
   */
  async listSpaces(): Promise<SpaceDescription[]> {
    const { rows } = await this.#reader().query<{
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
   *   current description `ETag` (the `key-epochs` feature); a stale validator
   *   throws `PreconditionFailedError` (412)
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *`, the guarded
   *   create; an existing Description throws `PreconditionFailedError` (412)
   * @returns {Promise<EtagValidator>}   the Collection's new description
   *   validator (its `generation` and bumped `version`, the `ETag`)
   */
  async writeCollection({
    spaceId,
    collectionId,
    collectionDescription,
    createdBy,
    ifMatch,
    ifNoneMatch,
    assertTransition
  }: {
    spaceId: string
    collectionId: string
    collectionDescription: CollectionDescription
    createdBy?: IDID
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    assertTransition?: (
      prior?: StoredCollectionDescription
    ) => void | Promise<void>
  }): Promise<EtagValidator> {
    return this.#withTransaction(async client => {
      await this.#ensureSpaceRow({ client, spaceId })
      // Serialize all Collection writes within the Space on its space row: the
      // collection-row `FOR UPDATE` below locks nothing when the row does not
      // exist yet, so without this two concurrent creates of *different* new
      // ids could each pass the create-path quota COUNT (overshooting
      // `maxCollectionsPerSpace`), and two creates of the *same* id could each
      // compute the same first version. It is also the first lock of the
      // backend-wide order (`#lockSpaceRow`).
      await this.#lockSpaceRow({ client, spaceId })
      // Lock the Collection row (if any) and read its current description and
      // validator, so the `If-Match` compare-and-swap, the transition rails,
      // the create detection, and the monotonic version bump are all atomic
      // with the write (two concurrent recipient edits cannot clobber one
      // another).
      const { rows } = await client.query<{
        description: CollectionDescription | null
        description_generation: string | null
        description_version: number
      }>(
        `SELECT description, description_generation, description_version
           FROM collections
          WHERE space_id = $1 AND collection_id = $2 FOR UPDATE`,
        [spaceId, collectionId]
      )
      // A missing row and a placeholder (NULL-description) row are both "no
      // described Collection yet": version 0 and no generation, so the first
      // real description write mints a generation at version 1 (a
      // placeholder's `description_version` column holds the schema DEFAULT
      // and must not count).
      const prior = storedDescriptionFromRow(rows[0])
      // Guarded create (`If-None-Match: *`) or compare-and-swap (`If-Match`),
      // both opt-in: a present Description or a stale validator throws 412. An
      // unconditional write skips this.
      assertCollectionWritePrecondition({
        collectionId,
        exists: prior !== undefined,
        currentEtag: descriptionEtagOf(prior),
        ifMatch,
        ifNoneMatch
      })
      // The request layer's state-transition rails (e.g. epoch append-only),
      // re-evaluated here against the row just read under the lock.
      await assertTransition?.(prior)
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
      // The description keeps its generation for the Collection's whole life;
      // a Collection deleted and re-created under the same id mints a new one,
      // so the two lives' validators can never coincide.
      const validator = {
        generation: resolveGeneration(prior?.descriptionGeneration),
        version: (prior?.descriptionVersion ?? 0) + 1
      }
      await this.#upsertCollection({
        queryable: client,
        spaceId,
        collectionId,
        collectionDescription,
        createdBy,
        validator
      })
      return validator
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
   * @param [options.validator] {EtagValidator}   the description validator to
   *   stamp (the `ETag`; the `key-epochs` feature), kept OUT of the
   *   `description` jsonb -- it lives in the `description_generation` /
   *   `description_version` columns and travels only as the `ETag` header.
   *   When omitted (the import path), a `_generation` / `_version` pair on the
   *   incoming archived description is used, else a fresh generation at
   *   version 1.
   * @returns {Promise<void>}
   */
  async #upsertCollection({
    queryable,
    spaceId,
    collectionId,
    collectionDescription,
    createdBy,
    validator
  }: {
    queryable: Queryable
    spaceId: string
    collectionId: string
    collectionDescription: CollectionDescription
    createdBy?: IDID
    validator?: EtagValidator
  }): Promise<void> {
    // Shared normalization (lib/collectionDescription.ts): strip the
    // validator-bearing members from the incoming (possibly imported)
    // description so none of them lands in the stored jsonb body -- the
    // resolved validator becomes the `description_generation` /
    // `description_version` columns instead. `createdBy` is additionally
    // stripped here because this statement re-resolves it in SQL.
    const { body, validator: stamped } = normalizeDescriptionWrite({
      description: collectionDescription,
      validator
    })
    const { createdBy: _suppliedCreatedBy, ...rest } = body
    await queryable.query(
      `INSERT INTO collections (space_id, collection_id, description,
                                description_generation, description_version)
       VALUES (
         $1, $2,
         CASE WHEN $4::text IS NULL THEN $3::jsonb
              ELSE ($3::jsonb) || jsonb_build_object('createdBy', $4::text) END,
         $5, $6
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
         description_generation = $5,
         description_version = $6`,
      [
        spaceId,
        collectionId,
        JSON.stringify(rest),
        createdBy ?? null,
        stamped.generation,
        stamped.version
      ]
    )
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<StoredCollectionDescription | undefined>}
   *   `descriptionGeneration` / `descriptionVersion` are the out-of-band
   *   `ETag` validator.
   */
  async getCollectionDescription({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<StoredCollectionDescription | undefined> {
    const { rows } = await this.#reader().query<{
      description: CollectionDescription | null
      description_generation: string | null
      description_version: number
    }>(
      `SELECT description, description_generation, description_version
         FROM collections
        WHERE space_id = $1 AND collection_id = $2`,
      [spaceId, collectionId]
    )
    // Surface the validator out-of-band as `descriptionGeneration` /
    // `descriptionVersion` (the handler sets the `ETag` header from them); both
    // are stored in their own columns and stay out of the wire body.
    return storedDescriptionFromRow(rows[0])
  }

  /**
   * Reads a Collection's Metadata object from its `meta_*` columns, merging in
   * `createdBy` from the stored description (where the creator lives; it is
   * never duplicated onto the metadata columns). Resolves `undefined` when the
   * Collection does not exist -- a placeholder (NULL-description) row counts as
   * absent, exactly as `getCollectionDescription` treats it. `generation` /
   * `metaVersion` are spread only when non-NULL, so a Collection with no
   * metadata written yet yields no ETag.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<StoredCollectionMetadata | undefined>}
   */
  async getCollectionMetadata({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<StoredCollectionMetadata | undefined> {
    const { rows } = await this.#reader().query<{
      description: CollectionDescription | null
      meta_generation: string | null
      meta_version: number | null
      meta_custom: Record<string, unknown> | null
      meta_epoch: string | null
      meta_created_at: string | null
      meta_updated_at: string | null
    }>(
      `SELECT description, meta_generation, meta_version, meta_custom,
              meta_epoch, meta_created_at, meta_updated_at
         FROM collections
        WHERE space_id = $1 AND collection_id = $2`,
      [spaceId, collectionId]
    )
    const row = rows[0]
    if (!row?.description) {
      return undefined
    }
    const hasCustom =
      row.meta_custom !== null && Object.keys(row.meta_custom).length > 0
    return {
      ...(row.meta_created_at !== null && { createdAt: row.meta_created_at }),
      ...(row.meta_updated_at !== null && { updatedAt: row.meta_updated_at }),
      // Absent for a Collection created before `createdBy` was recorded.
      ...(row.description.createdBy !== undefined && {
        createdBy: row.description.createdBy
      }),
      ...(hasCustom && { custom: row.meta_custom as ResourceMetadataCustom }),
      ...(row.meta_epoch !== null && { epoch: row.meta_epoch }),
      // The `/meta` ETag validator: the metadata object's own generation with
      // its monotonic `metaVersion`, both minted by the first metadata write.
      ...(row.meta_generation !== null && { generation: row.meta_generation }),
      ...(row.meta_version !== null && { metaVersion: row.meta_version })
    }
  }

  /**
   * Replaces the user-writable `custom` object of a Collection's Metadata (full
   * replacement; `{}` clears), bumping `updatedAt` and the monotonic
   * `metaVersion` -- one row-locked transaction, preconditions evaluated on the
   * current metadata `ETag` via the shared helper. Resolves `undefined` (no
   * create) for an absent Collection or a placeholder (NULL-description) row.
   * The metadata object keeps its own `meta_generation`, minted by the first
   * metadata write. The `description_generation` / `description_version`
   * columns are untouched, so the two ETags stay independent.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.custom {ResourceMetadataCustom | Record<string, unknown>}
   * @param [options.epoch] {string}   the key-epoch stamp; omitted clears it
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<EtagValidator | undefined>}   the `/meta` object's new
   *   validator (its `generation` with the bumped `metaVersion`)
   */
  async writeCollectionMetadata({
    spaceId,
    collectionId,
    custom,
    epoch,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    custom: ResourceMetadataCustom | Record<string, unknown>
    epoch?: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator | undefined> {
    return this.#withTransaction(async client => {
      const { rows } = await client.query<{
        description: CollectionDescription | null
        meta_generation: string | null
        meta_version: number | null
        meta_created_at: string | null
      }>(
        `SELECT description, meta_generation, meta_version, meta_created_at
           FROM collections
          WHERE space_id = $1 AND collection_id = $2
          FOR UPDATE`,
        [spaceId, collectionId]
      )
      const prior = rows[0]
      // A missing row and a placeholder (NULL-description) row are both "no
      // Collection here", so neither gets metadata written to it.
      if (!prior?.description) {
        return undefined
      }
      assertCollectionMetaWritePrecondition({
        collectionId,
        currentEtag: etagOf({
          generation: prior.meta_generation ?? undefined,
          version: prior.meta_version ?? undefined
        }),
        ifMatch,
        ifNoneMatch
      })
      // The metadata object's generation is minted by this write when it is
      // the first, and preserved by every later one; the sidecar only ever
      // goes away with its Collection.
      const generation = resolveGeneration(prior.meta_generation)
      const metaVersion = (prior.meta_version ?? 0) + 1
      const hasCustom = Object.keys(custom).length > 0
      const now = new Date().toISOString()
      // `meta_epoch = $6` assigns the parameter DIRECTLY -- deliberately not
      // the `COALESCE($n, epoch)` preserve pattern the resource path uses -- so
      // an omitted stamp clears it. The stamp describes the `custom` envelope
      // this write replaces wholesale; preserving it would label the new
      // envelope with the old one's epoch.
      await client.query(
        `UPDATE collections SET
           meta_generation = $7,
           meta_version    = $3,
           meta_custom     = $4::jsonb,
           meta_epoch      = $6,
           meta_created_at = COALESCE(meta_created_at, $5),
           meta_updated_at = $5
         WHERE space_id = $1 AND collection_id = $2`,
        [
          spaceId,
          collectionId,
          metaVersion,
          hasCustom ? JSON.stringify(custom) : null,
          now,
          epoch ?? null,
          generation
        ]
      )
      return { generation, version: metaVersion }
    })
  }

  /**
   * Reads a Collection's governing history log (the `governed-history-logs`
   * feature): the JSON Lines body verbatim with its own validator. Resolves
   * `undefined` when the Collection has no log or does not exist.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<StoredCollectionLog | undefined>}
   */
  async getCollectionLog({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<StoredCollectionLog | undefined> {
    const { rows } = await this.#reader().query<{
      log_body: string | null
      log_generation: string | null
      log_version: number | null
    }>(
      `SELECT log_body, log_generation, log_version
         FROM collections
        WHERE space_id = $1 AND collection_id = $2`,
      [spaceId, collectionId]
    )
    const row = rows[0]
    if (!row || row.log_body === null || row.log_version === null) {
      return undefined
    }
    return {
      body: row.log_body,
      generation: resolveGeneration(row.log_generation),
      version: row.log_version
    }
  }

  /**
   * Replaces a Collection's governing history log (guarded create or
   * compare-and-swap append) in one row-locked transaction: the precondition
   * is evaluated on the log's current `ETag`, the request layer's
   * `assertTransition` runs against the row just read, and the description
   * validator is bumped in the same statement, since the served description's
   * `encryption` member is derived from this log's head. Resolves `undefined`
   * (no create) for an absent Collection or a placeholder row.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.body {string}   the new JSON Lines body
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @param [options.assertTransition] {Function}
   * @returns {Promise<EtagValidator | undefined>}   the log's new validator
   */
  async writeCollectionLog({
    spaceId,
    collectionId,
    body,
    ifMatch,
    ifNoneMatch,
    assertTransition
  }: {
    spaceId: string
    collectionId: string
    body: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    assertTransition?: (context: {
      prior?: StoredCollectionLog
      collectionDescription: StoredCollectionDescription
    }) => void | Promise<void>
  }): Promise<EtagValidator | undefined> {
    return this.#withTransaction(async client => {
      const { rows } = await client.query<{
        description: CollectionDescription | null
        description_generation: string | null
        description_version: number
        log_body: string | null
        log_generation: string | null
        log_version: number | null
      }>(
        `SELECT description, description_generation, description_version,
                log_body, log_generation, log_version
           FROM collections
          WHERE space_id = $1 AND collection_id = $2
          FOR UPDATE`,
        [spaceId, collectionId]
      )
      const row = rows[0]
      if (!row?.description) {
        return undefined
      }
      const prior: StoredCollectionLog | undefined =
        row.log_body !== null && row.log_version !== null
          ? {
              body: row.log_body,
              generation: resolveGeneration(row.log_generation),
              version: row.log_version
            }
          : undefined
      assertCollectionLogWritePrecondition({
        collectionId,
        currentEtag: etagOf({
          generation: prior?.generation,
          version: prior?.version
        }),
        ifMatch,
        ifNoneMatch
      })
      await assertTransition?.({
        prior,
        collectionDescription: {
          ...row.description,
          ...(row.description_generation !== null && {
            descriptionGeneration: row.description_generation
          }),
          descriptionVersion: row.description_version
        }
      })
      const validator = {
        generation: resolveGeneration(prior?.generation),
        version: (prior?.version ?? 0) + 1
      }
      await client.query(
        `UPDATE collections SET
           log_body            = $3,
           log_generation      = $4,
           log_version         = $5,
           description_version = description_version + 1
         WHERE space_id = $1 AND collection_id = $2`,
        [spaceId, collectionId, body, validator.generation, validator.version]
      )
      return validator
    })
  }

  /**
   * Deletes the Collection's chunks and Resources (each by a `DELETE ...
   * RETURNING` that totals the bytes it frees), then the Collection row and
   * its policies, and subtracts the freed bytes from the Space usage counter
   * -- all in one transaction. Idempotent.
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
    await this.#withTransaction(async client => {
      // Lock order (see `#applyUsageDelta`): the Space's counter row first,
      // then the Collection's rows.
      await this.#lockSpaceRow({ client, spaceId })
      // The Collection's freed bytes are its Resource content plus its chunk
      // bytes (the `chunked-streams` feature). Both are removed HERE, by
      // `DELETE ... RETURNING` statements that total exactly the rows they
      // remove, rather than letting the Collection row's cascade remove them
      // behind a prior `SUM`: a `SUM` taken before the delete misses anything
      // committed in between, which the cascade would then remove without
      // ever returning its bytes to the counter -- inflating `usage_bytes`
      // permanently, with no recompute path. `chunks` cascades from
      // `resources`, so the chunks go first or their rows would be gone
      // (and unmeasured) by the time we asked.
      const { rows: deletedChunkRows } = await client.query<{ size: string }>(
        `DELETE FROM chunks WHERE space_id = $1 AND collection_id = $2
          RETURNING size`,
        [spaceId, collectionId]
      )
      const { rows: deletedResourceRows } = await client.query<{
        size_bytes: string
      }>(
        `DELETE FROM resources WHERE space_id = $1 AND collection_id = $2
          RETURNING size_bytes`,
        [spaceId, collectionId]
      )
      const freedBytes =
        deletedChunkRows.reduce((total, row) => total + Number(row.size), 0) +
        deletedResourceRows.reduce(
          (total, row) => total + Number(row.size_bytes),
          0
        )
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
        await this.#applyUsageDelta({ client, spaceId, delta: -freedBytes })
      }
    })
  }

  /**
   * Lists a Space's Collections, OPTIONALLY cursor-paginated (spec
   * "Pagination"), with the same keyset (ascending `collection_id`, byte order
   * via the column's `COLLATE "C"`), cursor codec, clamps, and `next`
   * construction as `listCollectionItems`. `totalItems` is the full Collection
   * count (a `COUNT`). A row without a description (created by a sub-Collection
   * write) falls back to the id for its `name`, like a description-less
   * directory on the filesystem. Each summary's `public` flag is the
   * Collection's `PublicCanRead` policy state, resolved for the page in a
   * single batch query over the page's ids (not a per-row lookup).
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
    const after = cursor !== undefined ? decodeCursor(cursor).after : undefined
    const pageSize = resolvePageSize(limit)

    // The total count and the page itself are independent reads: issue both on
    // the pool at once rather than paying the two round trips serially.
    const [{ rows: countRows }, { rows }] = await Promise.all([
      this.#reader().query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM collections WHERE space_id = $1`,
        [spaceId]
      ),
      // Take `pageSize + 1` from the seek point to detect a further page without
      // a second query; `hasMore` is whether the extra row arrived. The
      // `collection_id > $2` seek relies on the column's byte collation, the same
      // ordering the cursor codec's code-unit comparison assumes.
      this.#reader().query<{
        collection_id: string
        description: CollectionDescription | null
      }>(
        `SELECT collection_id, description FROM collections
        WHERE space_id = $1
          AND ($2::text IS NULL OR collection_id > $2)
        ORDER BY collection_id
        LIMIT $3`,
        [spaceId, after ?? null, pageSize + 1]
      )
    ])
    const totalItems = Number(countRows[0]?.total ?? 0)
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows

    // Probe the page's collection-level policies inline so a client need not
    // issue one policy request per listed Collection (an N+1). A single batch
    // query over the page's ids keeps this off the per-row path. A
    // collection-level policy is keyed by `resource_id = ''` (the sentinel
    // convention in `#policyKey`); `public` is true iff a `PublicCanRead` policy
    // is attached (via the shared `policyGrants` recognizer, which fail-closes
    // any other/unrecognized policy type to false).
    const pageIds = pageRows.map(row => row.collection_id)
    const publicCollectionIds = new Set<string>()
    if (pageIds.length > 0) {
      const { rows: policyRows } = await this.#reader().query<{
        collection_id: string
        policy: PolicyDocument
      }>(
        `SELECT collection_id, policy FROM policies
          WHERE space_id = $1 AND collection_id = ANY($2) AND resource_id = ''`,
        [spaceId, pageIds]
      )
      for (const policyRow of policyRows) {
        if (
          policyGrants({
            policy: policyRow.policy,
            action: 'read',
            logger: this.logger
          })
        ) {
          publicCollectionIds.add(policyRow.collection_id)
        }
      }
    }

    const items: CollectionSummary[] = pageRows.map(row => ({
      id: row.collection_id,
      url: collectionPath({ spaceId, collectionId: row.collection_id }),
      name: row.description?.name ?? row.collection_id,
      public: publicCollectionIds.has(row.collection_id)
    }))

    let next: string | undefined
    if (hasMore) {
      next = nextPageUrl({
        path: collectionsPath({ spaceId }),
        limit: pageSize,
        after: pageRows[pageRows.length - 1]!.collection_id
      })
    }

    return {
      url: collectionsPath({ spaceId }),
      totalItems,
      items,
      ...(next !== undefined && { next })
    }
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
    const pageSize = resolvePageSize(limit)

    // The total count and the page itself are independent reads: issue both on
    // the pool at once rather than paying the two round trips serially.
    const [{ rows: countRows }, { rows }] = await Promise.all([
      this.#reader().query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND NOT deleted`,
        [spaceId, collectionId]
      ),
      // Take `pageSize + 1` from the seek point to detect a further page without
      // a second query; `hasMore` is whether the extra row arrived.
      this.#reader().query<{
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
    ])
    const totalItems = Number(countRows[0]?.total ?? 0)
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows

    // The shared item builder projects each row onto the wire shape (including
    // the encrypted-Collection name suppression).
    const encrypted = suppressesItemNames({ collectionDescription })
    const items = pageRows.map(row =>
      collectionListingItem({
        spaceId,
        collectionId,
        resourceId: row.resource_id,
        contentType: row.content_type,
        custom: row.custom ?? undefined,
        epoch: row.epoch ?? undefined,
        encrypted
      })
    )

    return collectionResourcesList({
      spaceId,
      collectionId,
      collectionDescription,
      totalItems,
      items,
      hasMore,
      pageSize
    })
  }

  // Resources

  /**
   * Writes a Resource representation as one transaction: row lock, shared
   * precondition evaluation (exact filesystem semantics -- a tombstone counts
   * as "not exists", `ifNoneMatch` precedence per RFC9110), monotonic
   * `version` bump continuing through delete/recreate under the row's
   * preserved `generation`, and the transactional quota delta. JSON is stored
   * as its serialized UTF-8 bytes; blobs buffer through the capped
   * accumulator.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.input {ResourceInput}
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Resource's `createdBy` on first write only
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<EtagValidator>}   the Resource's new content validator
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
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator> {
    const content = await this.#bufferInputCapped(input)

    return this.#withTransaction(async client => {
      await this.#ensureCollectionRow({ client, spaceId, collectionId })
      // First lock of the backend-wide order (`#lockSpaceRow`), before the
      // advisory and row locks below.
      await this.#lockSpaceRow({ client, spaceId })

      // Two unique-attribute invariants can force a JSON content write to
      // serialize before it upserts its row: the EDV blinded one (`unique: true`
      // blinded attributes; the `blinded-index-query` feature) and the plaintext
      // equality one (a Collection's `unique`-declared `plaintext.indexes`; the
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
        await this.#lockCollectionUniqueness({ client, spaceId, collectionId })
      }
      if (blindedUnique) {
        assertNoUniqueBlindedConflict({
          document: input.kind === 'json' ? input.data : undefined,
          candidates: await this.#readBlindedCandidates(client, {
            spaceId,
            collectionId,
            excludeResourceId: resourceId
          })
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
          candidates: await this.#readEqualityCandidates(client, {
            spaceId,
            collectionId,
            excludeResourceId: resourceId
          })
        })
      }

      // Lock the row (re-reading under the create lock when it does not exist
      // yet, so `exists` / `priorSize` below reflect a concurrent creator's
      // committed row). Narrow projection: the lock needs the row, not its
      // (possibly multi-MB) `content` bytea, which this path never reads.
      const selectPrior = async (): Promise<
        | Pick<
            ResourceRow,
            | 'generation'
            | 'version'
            | 'size_bytes'
            | 'deleted'
            | 'created_at'
            | 'created_by'
          >
        | undefined
      > => {
        const { rows } = await client.query<
          Pick<
            ResourceRow,
            | 'generation'
            | 'version'
            | 'size_bytes'
            | 'deleted'
            | 'created_at'
            | 'created_by'
          >
        >(
          `SELECT generation, version, size_bytes, deleted, created_at,
                  created_by
             FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            FOR UPDATE`,
          [spaceId, collectionId, resourceId]
        )
        return rows[0]
      }
      const prior = await this.#lockRowForWrite({
        client,
        spaceId,
        rowKey: `${collectionId}/${resourceId}`,
        lockingSelect: selectPrior
      })
      const exists = prior !== undefined && !prior.deleted
      if (ifMatch !== undefined || ifNoneMatch !== undefined) {
        assertWritePrecondition({
          resourceId,
          exists,
          // A tombstone has no live representation to validate, so it offers
          // no `ETag` for `If-Match` to match.
          currentEtag:
            prior && !prior.deleted
              ? etagOf({
                  generation: prior.generation,
                  version: prior.version
                })
              : undefined,
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
      // The row keeps its generation for its whole life -- a soft delete keeps
      // it and this write continues it across a re-create, exactly as the
      // `version` counter continues. Only a row that does not exist at all
      // mints one, so a hard-deleted Resource's successor can never present a
      // validator the previous one already handed out.
      const validator = {
        generation: resolveGeneration(prior?.generation),
        version: (prior?.version ?? 0) + 1
      }
      // A content write preserves the independent `meta_generation` /
      // `meta_version` and the user-writable `custom` of a LIVE Resource; a
      // tombstoned row already dropped all three (the metadata went with the
      // deleted Resource).
      //
      // Create-if-absent atomicity: when `If-None-Match: *` found NO prior row
      // (a tombstone is a real row and stays lock-serialized), concurrent
      // creators through this method are already serialized by
      // `#lockSameKeyCreate` above -- but a writer that does not take that
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
        validator.generation,
        validator.version,
        // `created_at` is preserved from the prior row (including across a
        // tombstone, as the filesystem sidecar does) and minted on a true
        // create; `updated_at` is ALWAYS this write's clock, on both the
        // insert and the conflict arm. They are separate parameters because
        // binding one to both rewinds an overwrite's `updated_at` to the
        // row's creation time, which would also hide the write from the
        // `(updated_at, resource_id)` change feed.
        prior?.created_at ?? now,
        now,
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
          is_json, size_bytes, generation, version, meta_version, custom,
          deleted, created_at, updated_at, created_by, epoch
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, false, $10, $11, $12, $13)`
      /**
       * `created_at` / `meta_generation` / `meta_version` / `custom` are
       * deliberately NOT in the conflict update: an overwrite keeps the
       * original creation time (also
       * across a tombstone, as the filesystem sidecar does) and the metadata
       * counters as they stand on the row. `created_by` is likewise NOT
       * backfilled from `EXCLUDED`: the conflict path always means a prior
       * row already existed (including the race where a concurrent creator's
       * INSERT landed between our lock-nothing SELECT and this statement), so
       * `resources.created_by` -- the prior row's own value, absent or not --
       * is authoritative and this write's `createdBy` is ignored entirely.
       * `generation` is preserved from the row for the same reason: the
       * conflict path always means a prior row (live or tombstoned) already
       * had one, and a generation is minted only where none exists.
       */
      const written = await this.#insertOrUpsertVersioned({
        client,
        insertSql,
        // The size this write replaces, read on the writing statement's own
        // snapshot. A tombstone already stores 0, so it contributes nothing.
        priorSizeSql: `SELECT size_bytes AS prior_size FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
        conflictSql: `
           ON CONFLICT (space_id, collection_id, resource_id) DO UPDATE SET
             content_type = EXCLUDED.content_type,
             content = EXCLUDED.content,
             is_json = EXCLUDED.is_json,
             size_bytes = EXCLUDED.size_bytes,
             generation = resources.generation,
             version = resources.version + 1,
             deleted = false,
             updated_at = EXCLUDED.updated_at,
             created_by = resources.created_by,
             epoch = EXCLUDED.epoch`,
        values,
        createOnly: ifNoneMatch === '*' && prior === undefined,
        validator,
        conflictDetail: `Resource '${resourceId}' already exists (If-None-Match: *).`
      })
      // Usage delta AFTER the write, from the size the write actually
      // replaced: a `QuotaExceededError` here still rolls the whole
      // transaction back, so the row never outlives the refusal.
      const delta = content.length - written.priorSizeBytes
      if (delta !== 0) {
        await this.#applyUsageDelta({ client, spaceId, delta })
      }
      return { generation: written.generation, version: written.version }
    })
  }

  /**
   * Lands a versioned row write on `client`, the shared tail of `writeResource`
   * and `writeChunk`. Under `createOnly` (an `If-None-Match: *` write whose
   * pre-read found NO prior row) it runs the bare INSERT, so the primary key
   * stays the arbiter against a creator that does not take the same-key lock
   * (`importSpace`'s plain INSERTs): the loser's unique violation (SQLSTATE
   * 23505) maps to the 412 the precondition would have thrown. Otherwise it
   * appends `conflictSql` and RETURNING to the INSERT as an upsert.
   *
   * The conflict update derives `version` from the row (`<table>.version +
   * 1`) and keeps the row's own `generation`, neither from the pre-read: if a
   * concurrent creator slipped in after our lock-nothing SELECT, the counter
   * still advances monotonically under that creator's generation instead of
   * two writers both claiming version 1 (an ETag anomaly). RETURNING reports
   * the validator that actually landed.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.insertSql {string}   the INSERT (no ON CONFLICT clause)
   * @param options.conflictSql {string}   the `ON CONFLICT ... DO UPDATE SET`
   *   clause appended on the upsert path; must set `version` from the row and
   *   preserve its `generation`
   * @param options.values {unknown[]}   the INSERT's bind values
   * @param options.createOnly {boolean}   run the bare INSERT (see above)
   * @param options.validator {EtagValidator}   the pre-read-derived validator,
   *   reported when the bare INSERT lands
   * @param options.priorSizeSql {string}   a `SELECT <size column> AS
   *   prior_size FROM <table> WHERE <primary key>` over the row about to be
   *   written, using the same bind values; run as a CTE of the writing
   *   statement so `priorSizeBytes` is the size this statement REPLACES
   * @param options.conflictDetail {string}   `detail` of the 412 a unique
   *   violation on the bare INSERT maps to
   * @returns {Promise<EtagValidator & { priorSizeBytes: number }>}   the
   *   validator that landed, plus the stored size the write replaced (0 when
   *   there was no row), for the caller's usage delta
   */
  async #insertOrUpsertVersioned({
    client,
    insertSql,
    conflictSql,
    values,
    createOnly,
    validator,
    priorSizeSql,
    conflictDetail
  }: {
    client: pg.PoolClient
    insertSql: string
    conflictSql: string
    values: unknown[]
    createOnly: boolean
    validator: EtagValidator
    priorSizeSql: string
    conflictDetail: string
  }): Promise<EtagValidator & { priorSizeBytes: number }> {
    if (createOnly) {
      try {
        await client.query(insertSql, values)
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new PreconditionFailedError({ detail: conflictDetail })
        }
        throw err
      }
      // The bare INSERT landed, so no row existed: nothing was replaced.
      return { ...validator, priorSizeBytes: 0 }
    }
    // `prior` is a plain SELECT CTE of this same statement, so it is evaluated
    // on the statement's snapshot -- the state BEFORE the upsert, including
    // any row a concurrent writer committed after this transaction's own
    // pre-read. Deriving the usage delta from it (rather than from that
    // pre-read) is what keeps `usage_bytes` exact when a writer that does not
    // take the same-key create lock -- `importSpace`'s plain INSERTs -- landed
    // a row in between: the upsert replaces that row, and its bytes leave the
    // counter with it.
    const { rows: written } = await client.query<
      EtagValidator & { prior_size: string }
    >(
      `WITH prior AS (${priorSizeSql})
       ${insertSql}${conflictSql}
           RETURNING generation, version,
             COALESCE((SELECT prior_size FROM prior), 0) AS prior_size`,
      values
    )
    return {
      generation: written[0]!.generation,
      version: written[0]!.version,
      priorSizeBytes: Number(written[0]!.prior_size)
    }
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
    const { rows } = await this.#reader().query<ResourceRow>(
      `SELECT content_type, content, generation, version, deleted
         FROM resources
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
      generation: row.generation,
      version: row.version
    }
  }

  /**
   * Soft-deletes a Resource into a tombstone row: content dropped, `deleted`
   * set, `version` bumped (so the change feed surfaces it) under the row's
   * unchanged `generation`, last-known `content_type` retained, the metadata
   * object dropped whole (`custom` with its `meta_generation` /
   * `meta_version` validator, so a re-create's first metadata write mints a
   * new generation and a pre-delete `/meta` ETag cannot pass `If-Match`
   * against it), and the freed bytes subtracted from the quota counter -- one
   * transaction. Idempotent on an absent Resource or an existing tombstone.
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
    await this.#withTransaction(async client => {
      // First lock of the backend-wide order (`#lockSpaceRow`).
      await this.#lockSpaceRow({ client, spaceId })
      // Narrow projection: the lock needs the row, not the `content` bytea
      // that is about to be dropped anyway.
      const { rows } = await client.query<
        Pick<ResourceRow, 'generation' | 'version' | 'size_bytes' | 'deleted'>
      >(
        `SELECT generation, version, size_bytes, deleted FROM resources
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
          currentEtag:
            prior && !prior.deleted
              ? etagOf({
                  generation: prior.generation,
                  version: prior.version
                })
              : undefined,
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
      // counter alongside the Resource's content bytes. `DELETE ... RETURNING
      // size` removes and totals in one query (the freed bytes summed in JS).
      const { rows: deletedChunkRows } = await client.query<{ size: string }>(
        `DELETE FROM chunks
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          RETURNING size`,
        [spaceId, collectionId, resourceId]
      )
      const freedChunkBytes = deletedChunkRows.reduce(
        (total, row) => total + Number(row.size),
        0
      )
      const freedBytes = Number(prior.size_bytes) + freedChunkBytes
      if (freedBytes > 0) {
        await this.#applyUsageDelta({ client, spaceId, delta: -freedBytes })
      }
      const now = new Date().toISOString()
      // `generation` is deliberately NOT touched: a tombstone keeps the row's
      // marker, so a later re-create continues both parts of the content
      // validator. `meta_generation` goes with `meta_version`: the `/meta`
      // validator dies with the metadata object.
      await client.query(
        `UPDATE resources SET
           content = NULL,
           size_bytes = 0,
           version = version + 1,
           meta_generation = NULL,
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
   * @returns {Promise<(ResourceMetadata & VersionedMetadata) | undefined>}
   */
  async getResourceMetadata({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<(ResourceMetadata & VersionedMetadata) | undefined> {
    const { rows } = await this.#reader().query<ResourceRow>(
      `SELECT content_type, size_bytes, generation, version, meta_generation,
              meta_version, custom, epoch, deleted, created_at, updated_at,
              created_by
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
      // The row's generation pairs with `version` for the content `ETag`; the
      // metadata object's own `metaGeneration` pairs with `metaVersion` for
      // the `/meta` one.
      generation: row.generation,
      version: row.version,
      ...(row.meta_generation !== null && {
        metaGeneration: row.meta_generation
      }),
      ...(row.meta_version !== null && { metaVersion: row.meta_version })
    }
  }

  /**
   * Replaces the user-writable `custom` object (full replacement; `{}`
   * clears), bumping `updatedAt` and the independent `metaVersion` -- one
   * row-locked transaction, preconditions evaluated on the current metadata
   * `ETag` via the shared helper. The metadata object keeps its own
   * `meta_generation`, minted by the first metadata write (afresh after a
   * tombstone dropped it); the row's content `generation` is untouched.
   * Resolves `undefined` (no create) for an absent or tombstoned Resource.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.custom {ResourceMetadataCustom | Record<string, unknown>}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<EtagValidator | undefined>}   the `/meta` object's new
   *   validator (its `meta_generation` with the bumped `metaVersion`)
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
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator | undefined> {
    return this.#withTransaction(async client => {
      // A metadata write can create a plaintext equality unique claim for a
      // `custom`-sourced attribute (the `equality-query` feature). When the
      // Collection declares any unique index, take the per-Collection advisory
      // lock first (held to commit, serializing concurrent claimants) so the
      // conflict scan below is atomic with the write.
      const equalityUnique =
        uniqueIndexes !== undefined && uniqueIndexes.length > 0
      if (equalityUnique) {
        await this.#lockCollectionUniqueness({ client, spaceId, collectionId })
      }
      const { rows } = await client.query<ResourceRow>(
        `SELECT meta_generation, meta_version, deleted FROM resources
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
        currentEtag: etagOf({
          generation: prior.meta_generation ?? undefined,
          version: prior.meta_version ?? undefined
        }),
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
          candidates: await this.#readEqualityCandidates(client, {
            spaceId,
            collectionId,
            excludeResourceId: resourceId
          })
        })
      }
      const metaGeneration = resolveGeneration(prior.meta_generation)
      const metaVersion = (prior.meta_version ?? 0) + 1
      const hasCustom = Object.keys(custom).length > 0
      const now = new Date().toISOString()
      // The key-epoch stamp describes the CONTENT write, so a supplied `epoch`
      // replaces it but an OMITTED one PRESERVES the stored value (unlike
      // `custom`, full-replace): `COALESCE($8, epoch)` keeps the current value
      // when the parameter is NULL.
      await client.query(
        `UPDATE resources SET
           meta_generation = $4,
           meta_version = $5,
           custom = $6::jsonb,
           updated_at = $7,
           epoch = COALESCE($8, epoch)
         WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
        [
          spaceId,
          collectionId,
          resourceId,
          metaGeneration,
          metaVersion,
          hasCustom ? JSON.stringify(custom) : null,
          now,
          epoch ?? null
        ]
      )
      return { generation: metaGeneration, version: metaVersion }
    })
  }

  // Chunks (the `chunked-streams` feature)

  /**
   * Writes one chunk of a chunked Resource as one transaction: the parent
   * Resource must exist (checked atomically -- a `FOR SHARE` lock on it also
   * blocks a concurrent delete of the parent for the duration of the write, so
   * a chunk can never be orphaned by a racing `deleteResource`), the chunk row
   * is locked, its precondition evaluated, its validator bumped, and
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
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<EtagValidator>}   the chunk's new validator
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
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator> {
    const bytes = await this.#bufferInputCapped(input)

    return this.#withTransaction(async client => {
      // First lock of the backend-wide order (`#lockSpaceRow`).
      await this.#lockSpaceRow({ client, spaceId })
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

      // Lock the chunk row (if any, re-reading under the create lock when it
      // does not exist yet) and read its current validator/size, so the
      // precondition, the monotonic bump, and the usage delta are all atomic
      // with the write.
      const chunkLabel = `${resourceId}/chunks/${chunkIndex}`
      const selectPrior = async (): Promise<
        { generation: string; version: number; size: string } | undefined
      > => {
        const { rows } = await client.query<{
          generation: string
          version: number
          size: string
        }>(
          `SELECT generation, version, size FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND chunk_index = $4
            FOR UPDATE`,
          [spaceId, collectionId, resourceId, chunkIndex]
        )
        return rows[0]
      }
      const prior = await this.#lockRowForWrite({
        client,
        spaceId,
        rowKey: `${collectionId}/${chunkLabel}`,
        lockingSelect: selectPrior
      })
      const exists = prior !== undefined
      if (ifMatch !== undefined || ifNoneMatch !== undefined) {
        assertWritePrecondition({
          resourceId: chunkLabel,
          exists,
          currentEtag: prior
            ? etagOf({ generation: prior.generation, version: prior.version })
            : undefined,
          ifMatch,
          ifNoneMatch
        })
      }

      // A chunk delete removes its row outright, so there is no tombstone to
      // continue: an overwrite keeps the row's generation, while a write at a
      // freed index mints a new one and cannot reuse the old validators.
      const validator = {
        generation: resolveGeneration(prior?.generation),
        version: (prior?.version ?? 0) + 1
      }
      const values = [
        spaceId,
        collectionId,
        resourceId,
        chunkIndex,
        input.contentType,
        bytes,
        bytes.length,
        validator.generation,
        validator.version
      ]
      const insertSql = `
        INSERT INTO chunks (
          space_id, collection_id, resource_id, chunk_index,
          content_type, bytes, size, generation, version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
      // Create-if-absent atomicity mirrors `writeResource`: concurrent
      // creators through this method are serialized by `#lockSameKeyCreate`
      // above; the race against a writer that does not take that lock is
      // settled inside `#insertOrUpsertVersioned`.
      const written = await this.#insertOrUpsertVersioned({
        client,
        insertSql,
        // The size this write replaces, read on the writing statement's own
        // snapshot (see `writeResource`).
        priorSizeSql: `SELECT size AS prior_size FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND chunk_index = $4`,
        conflictSql: `
         ON CONFLICT (space_id, collection_id, resource_id, chunk_index)
         DO UPDATE SET
           content_type = EXCLUDED.content_type,
           bytes = EXCLUDED.bytes,
           size = EXCLUDED.size,
           generation = chunks.generation,
           version = chunks.version + 1`,
        values,
        createOnly: ifNoneMatch === '*' && prior === undefined,
        validator,
        conflictDetail: `Chunk '${chunkLabel}' already exists (If-None-Match: *).`
      })
      // Usage delta AFTER the write, from the size the write actually
      // replaced (see `writeResource`).
      const delta = bytes.length - written.priorSizeBytes
      if (delta !== 0) {
        await this.#applyUsageDelta({ client, spaceId, delta })
      }
      return { generation: written.generation, version: written.version }
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
    const { rows } = await this.#reader().query<{
      content_type: string
      bytes: Buffer
      generation: string
      version: number
    }>(
      `SELECT content_type, bytes, generation, version FROM chunks
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
      generation: row.generation,
      version: row.version
    }
  }

  /**
   * Reads a chunk's stored content-type / size / validator (the HEAD payload
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
    const { rows } = await this.#reader().query<{
      content_type: string
      size: string
      generation: string
      version: number
    }>(
      `SELECT content_type, size, generation, version FROM chunks
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
      generation: row.generation,
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
    return this.#withTransaction(async client => {
      // First lock of the backend-wide order (`#lockSpaceRow`).
      await this.#lockSpaceRow({ client, spaceId })
      const { rows } = await client.query<{
        generation: string
        version: number
        size: string
      }>(
        `SELECT generation, version, size FROM chunks
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
          currentEtag: etagOf({
            generation: prior.generation,
            version: prior.version
          }),
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
        await this.#applyUsageDelta({ client, spaceId, delta: -freedBytes })
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
    const { rows } = await this.#reader().query<{
      chunk_index: number
      size: string
      content_type: string
      generation: string
      version: number
    }>(
      `SELECT chunk_index, size, content_type, generation, version FROM chunks
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
        generation: row.generation,
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
      generation?: string
      metaGeneration?: string
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
    const { rows } = await this.#reader().query<
      ResourceRow & { resource_id: string }
    >(
      `SELECT resource_id, content, version, meta_generation, meta_version,
              generation, custom, epoch, deleted, updated_at, created_by
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
          generation: row.generation,
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
        // The row's generation pairs with `version` and `metaGeneration` with
        // `metaVersion` so the request layer can derive the wire `etag` /
        // `metaEtag` without a fetch per Resource.
        generation: row.generation,
        ...(row.meta_generation !== null && {
          metaGeneration: row.meta_generation
        }),
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
    const candidates = await this.#readBlindedCandidates(this.#reader(), {
      spaceId,
      collectionId
    })
    return runBlindedIndexQuery({ candidates, query, count, limit, cursor })
  }

  /**
   * Reads every live JSON Resource of a Collection as a blinded-index
   * candidate -- the candidate set for the blinded-index query and the
   * unique-blinded-attribute conflict scan. Each row resolves
   * `{ resourceId, document }`, where `document` is the parsed JSON body; blob
   * rows are excluded in SQL (`is_json`) and an unparsable body is skipped.
   * Tombstones are excluded (`NOT deleted`); an optional excluded Resource is
   * skipped. Runs on the given executor -- the pool for a read-only query, or
   * the write transaction's client for a uniqueness scan (so the scan shares
   * the advisory lock and sees a consistent snapshot).
   * @param executor {pg.Pool | pg.PoolClient}
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.excludeResourceId] {string}
   * @returns {Promise<Array<{ resourceId: string, document: unknown }>>}
   */
  async #readBlindedCandidates(
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
  ): Promise<Array<{ resourceId: string; document: unknown }>> {
    const { rows } = await executor.query<{
      resource_id: string
      content: Buffer | null
    }>(
      `SELECT resource_id, content FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND is_json AND NOT deleted
          AND ($3::text IS NULL OR resource_id <> $3)
        ORDER BY resource_id`,
      [spaceId, collectionId, excludeResourceId ?? null]
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
    return candidates
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
    const candidates = await this.#readEqualityCandidates(this.#reader(), {
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
    const candidates = await this.#readEqualityCandidates(this.#reader(), {
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
  async #readEqualityCandidates(
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
  #policyKey({
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
    const { collectionKey, resourceKey } = this.#policyKey({
      collectionId,
      resourceId
    })
    const { rows } = await this.#reader().query<{ policy: PolicyDocument }>(
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
    await this.#withTransaction(async client => {
      // Ensure the containing rows exist (Space, and the Collection when the
      // policy is below Space level), like the filesystem's dir provisioning.
      if (collectionId !== undefined) {
        await this.#ensureCollectionRow({ client, spaceId, collectionId })
      } else {
        await this.#ensureSpaceRow({ client, spaceId })
      }
      await this.#upsertPolicy({
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
   * apply loop; keys through `#policyKey` so the sentinel convention lives in
   * one place.
   * @param options {object}
   * @param options.queryable {Queryable}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.policy {PolicyDocument}
   * @returns {Promise<void>}
   */
  async #upsertPolicy({
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
    const { collectionKey, resourceKey } = this.#policyKey({
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
    const { collectionKey, resourceKey } = this.#policyKey({
      collectionId,
      resourceId
    })
    await this.#reader().query(
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
    await this.#withTransaction(async client => {
      await this.#ensureSpaceRow({ client, spaceId })
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
    const { rows } = await this.#reader().query<{
      record: StoredBackendRecord
    }>(
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
    const { rows } = await this.#reader().query<{
      record: StoredBackendRecord
    }>(
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
    await this.#reader().query(
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
    await this.#reader().query(
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
    const { rows } = await this.#reader().query<{ config: KeystoreConfig }>(
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
    const result = await this.#reader().query(
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
    const { rows } = await this.#reader().query<{ config: KeystoreConfig }>(
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
      await this.#reader().query(
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
    const { rows } = await this.#reader().query<{ record: KmsKeyRecord }>(
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
    const { rows } = await this.#reader().query<{
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
  #revocationTable(scope: RevocationScope): {
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
    const { table, column, id } = this.#revocationTable(scope)
    try {
      // Prune rows past their GC horizon while on this (rare) write path, so
      // the hot read path (`isRevoked`, consulted on every delegated-chain
      // verification) stays a single read-only SELECT -- the SQL analogue of
      // a TTL index. Table-wide on purpose: expired rows are dead weight
      // whichever scope they belong to.
      await this.#reader().query(
        `DELETE FROM ${table}
          WHERE expires IS NOT NULL AND expires <= $1`,
        [new Date().toISOString()]
      )
      await this.#reader().query(
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
    const { table, column, id } = this.#revocationTable(scope)
    const delegators = capabilities.map(entry => entry.delegator)
    const capabilityIds = capabilities.map(entry => entry.capabilityId)
    const { rows } = await this.#reader().query(
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
   * @returns {MetaSidecar}
   */
  #sidecarFor(row: Omit<ResourceRow, 'content'>): MetaSidecar {
    if (row.deleted) {
      return {
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.created_by !== null && { createdBy: row.created_by }),
        generation: row.generation,
        version: row.version,
        deleted: true,
        contentType: row.content_type
      }
    }
    return {
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.created_by !== null && { createdBy: row.created_by }),
      generation: row.generation,
      version: row.version,
      ...(row.meta_generation !== null && {
        metaGeneration: row.meta_generation
      }),
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
      this.#reader().query<{
        collection_id: string
        resource_id: string
        policy: PolicyDocument
      }>(
        `SELECT collection_id, resource_id, policy FROM policies
            WHERE space_id = $1`,
        [spaceId]
      ),
      this.#reader().query<{
        collection_id: string
        description: CollectionDescription | null
        description_generation: string | null
        description_version: number
        meta_generation: string | null
        meta_version: number | null
        meta_custom: Record<string, unknown> | null
        meta_epoch: string | null
        meta_created_at: string | null
        meta_updated_at: string | null
        log_body: string | null
        log_generation: string | null
        log_version: number | null
      }>(
        `SELECT collection_id, description, description_generation,
                description_version, meta_generation, meta_version,
                meta_custom, meta_epoch, meta_created_at, meta_updated_at,
                log_body, log_generation, log_version
           FROM collections WHERE space_id = $1`,
        [spaceId]
      ),
      // Metadata only -- content bytes are fetched one resource at a time
      // while packing, so an export never holds the whole Space in memory.
      this.#reader().query<
        Omit<ResourceRow, 'content'> & {
          collection_id: string
          resource_id: string
        }
      >(
        `SELECT collection_id, resource_id, content_type, is_json,
                size_bytes, generation, version, meta_generation,
                meta_version, custom, epoch, deleted, created_at, updated_at,
                created_by
           FROM resources WHERE space_id = $1`,
        [spaceId]
      ),
      this.#reader().query<{
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
      this.#reader().query<{
        collection_id: string
        resource_id: string
        chunk_index: number
        content_type: string
        generation: string
        version: number
      }>(
        `SELECT collection_id, resource_id, chunk_index, content_type,
                generation, version
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

    // The shared archive entry shapes (`lib/exportTar.ts`): a file entry carries
    // its bytes inline (the small JSON dot-files) or a lazy `read()` resolved at
    // pack time (a resource representation, and a chunk of a chunked Resource --
    // the `chunked-streams` feature), and a chunk directory is a nested
    // directory entry whose files follow the same rule. `name` is the entry's
    // sort key within its dir; a chunk directory sorts by its `.chunks.<encId>`
    // dir name.
    // Space-level dot-files are always small JSON, carried inline.
    // The Space file follows the same `_generation` / `_version` embedding as
    // the `.collection.` file below (the filesystem backend's on-disk
    // convention), so archives stay interchangeable between the two backends.
    const spaceFiles: ArchiveFile[] = [
      {
        name: spaceDescriptionFileName(spaceId),
        bytes: Buffer.from(
          JSON.stringify(
            embedDescriptionValidator({
              body: stripDescriptionValidator(spaceDescription),
              generation: spaceDescription.descriptionGeneration,
              version: spaceDescription.descriptionVersion
            })
          )
        )
      }
    ]
    if (spacePolicy) {
      spaceFiles.push({
        name: SPACE_POLICY_FILE_NAME,
        bytes: Buffer.from(JSON.stringify(spacePolicy))
      })
    }

    const collectionsById = new Map<string, ArchiveEntry[]>()
    const filesFor = (collectionId: string): ArchiveEntry[] => {
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
        // Embed the description validator as `_generation` / `_version` in the
        // archived `.collection.` file (the filesystem backend's on-disk
        // convention) so the ETag validator survives an export/import round
        // trip and archives stay interchangeable between the two backends.
        files.push({
          name: collectionDescriptionFileName(row.collection_id),
          bytes: Buffer.from(
            JSON.stringify(
              embedDescriptionValidator({
                body: row.description,
                generation: row.description_generation ?? undefined,
                version: row.description_version
              })
            )
          )
        })
      }
      // The Collection's metadata sidecar, synthesized from the `meta_*`
      // columns in the filesystem backend's on-disk shape (only once metadata
      // has actually been written, which `meta_version` marks). `createdBy` is
      // NOT carried here: it lives on the archived description, which is where
      // both backends read it back from.
      if (row.meta_version !== null) {
        files.push({
          name: collectionMetaFileName(row.collection_id),
          bytes: Buffer.from(
            JSON.stringify({
              createdAt: row.meta_created_at ?? '',
              updatedAt: row.meta_updated_at ?? '',
              // Minted alongside `meta_version` by the first metadata write,
              // so a row with a `meta_version` always has one.
              generation: resolveGeneration(row.meta_generation),
              metaVersion: row.meta_version,
              ...(row.meta_custom !== null && { custom: row.meta_custom }),
              ...(row.meta_epoch !== null && { epoch: row.meta_epoch })
            } satisfies CollectionMetaSidecar)
          )
        })
      }
      // The governing history log, in the filesystem backend's on-disk shape.
      if (row.log_body !== null && row.log_version !== null) {
        files.push({
          name: collectionLogFileName(row.collection_id),
          bytes: Buffer.from(
            JSON.stringify({
              generation: resolveGeneration(row.log_generation),
              version: row.log_version,
              body: row.log_body
            } satisfies StoredCollectionLog)
          )
        })
      }
    }
    for (const row of policyRows) {
      if (row.collection_id === '') {
        continue
      }
      // The Collection's own policy has a fixed name; a Resource policy is
      // keyed by the resource id under its own prefix.
      filesFor(row.collection_id).push({
        name:
          row.resource_id === ''
            ? COLLECTION_POLICY_FILE_NAME
            : resourcePolicyFileName(row.resource_id),
        bytes: Buffer.from(JSON.stringify(row.policy))
      })
    }
    for (const row of resourceRows) {
      const files = filesFor(row.collection_id)
      files.push({
        name: metaSidecarFileName(row.resource_id),
        bytes: Buffer.from(JSON.stringify(this.#sidecarFor(row)))
      })
      if (!row.deleted) {
        const resource = {
          collectionId: row.collection_id,
          resourceId: row.resource_id
        }
        files.push({
          name: fileNameFor({
            resourceId: row.resource_id,
            contentType: row.content_type
          }),
          read: () => this.#resourceContent({ spaceId, ...resource })
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
    const chunkDirsByResource = new Map<string, ArchiveFile[]>()
    for (const row of chunkRows) {
      const dirKey = `${row.collection_id}/${row.resource_id}`
      let chunkFiles = chunkDirsByResource.get(dirKey)
      if (!chunkFiles) {
        chunkFiles = []
        chunkDirsByResource.set(dirKey, chunkFiles)
        filesFor(row.collection_id).push({
          name: chunkDirName(row.resource_id),
          files: chunkFiles
        })
      }
      const chunkId = String(row.chunk_index)
      const chunk = {
        collectionId: row.collection_id,
        resourceId: row.resource_id,
        chunkIndex: row.chunk_index
      }
      chunkFiles.push({
        name: fileNameFor({
          resourceId: chunkId,
          contentType: row.content_type
        }),
        read: () => this.#chunkContent({ spaceId, ...chunk })
      })
      // The chunk-metadata sidecar (`.chunks.<encId>/.meta.<index>.json`) the
      // filesystem backend writes per chunk. Only the ETag validator
      // (`generation` / `version`) is carried across export/import; the
      // filesystem writes `createdAt` / `updatedAt` too, but this backend's
      // `chunks` table holds no chunk timestamps, so it emits (and on import
      // reads) only the validator.
      chunkFiles.push({
        name: metaSidecarFileName(chunkId),
        bytes: Buffer.from(
          JSON.stringify({
            generation: row.generation,
            version: row.version
          } satisfies { generation?: string; version?: number })
        )
      })
    }
    for (const chunkFiles of chunkDirsByResource.values()) {
      chunkFiles.sort((left, right) => left.name.localeCompare(right.name))
    }

    // Top-level order: space-level files and collection dirs interleaved,
    // sorted by name -- the same order the filesystem's readdir+sort yields.
    const topLevel: ArchiveEntry[] = [
      ...spaceFiles,
      ...[...collectionsById].map(([collectionId, files]) => ({
        name: collectionId,
        files: files.sort((a, b) => a.name.localeCompare(b.name))
      }))
    ].sort((a, b) => a.name.localeCompare(b.name))

    // Space-scoped zcap revocations travel with the export, packed under a
    // top-level `revocations/` dir and named by the shared file-name codec so
    // both backends produce the same archive entries. Pretty-printed to match
    // the filesystem's stored records.
    const revocations: ArchiveFile[] = revocationRows
      .map(row => ({
        name: revocationFileName({
          delegator: row.delegator,
          capabilityId: row.capability_id
        }),
        bytes: Buffer.from(JSON.stringify(row.record, null, 2))
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return packSpaceArchive({ spaceId, entries: topLevel, revocations })
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
  async #resourceContent({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<Buffer> {
    const { rows } = await this.#reader().query<{ content: Buffer | null }>(
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
   * `#resourceContent`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @returns {Promise<Buffer>}
   */
  async #chunkContent({
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
    const { rows } = await this.#reader().query<{ bytes: Buffer | null }>(
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
    // Chunk entries (the `chunked-streams` feature): the plan carries each
    // chunk file (representation + optional version sidecar) with its decoded
    // fields; the `chunks` table stores a chunk as one row, so merge the two
    // files of each chunk into a single row here.
    const chunkEntries = this.#mergeChunkEntries(collections)
    const {
      capacityBytes,
      maxUploadBytes,
      maxCollectionsPerSpace,
      maxResourcesPerSpace
    } = this

    return this.#withTransaction(async client => {
      await this.#ensureSpaceRow({ client, spaceId })
      // Serialize with concurrent writers on this Space for the duration of
      // the import: the usage counter row is the natural lock, and it is the
      // first lock of the backend-wide order (`#lockSpaceRow`), so an import
      // and an ordinary write queue behind one another instead of deadlocking.
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

      // Shared pre-flight over every staged body (`assertImportBodiesFit`):
      // the per-body 413 cap and the fail-closed encryption check, before
      // anything is written. Skips (existing ids) are counted conservatively
      // for the quota estimate, as on the filesystem. Chunks (the
      // `chunked-streams` feature) are opaque bytes -- no encryption-conformance
      // check applies -- but they count the same per-body 413 and the
      // (conservative) capacity pre-flight as Resource bodies, tallied after
      // every Collection because this backend merges each chunk's files into
      // one row up front.
      const incomingBytes = await assertImportBodiesFit({
        collections,
        existingCollection: collectionId =>
          descriptionsById.get(collectionId) ?? undefined,
        assertUploadSize: uploadBytes => {
          if (uploadBytes > maxUploadBytes) {
            throw new PayloadTooLargeError({
              maxUploadBytes,
              backendId: this.describe().id,
              uploadBytes
            })
          }
        },
        trailingChunkBodies: chunkEntries
      })
      // The cumulative quota (507) stays here: the headroom check is this
      // backend's own, against the transactional usage counter read above.
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
          await this.#upsertPolicy({
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
        collectionMetadata,
        collectionLog,
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
          // (already discarded and reapplied by `#upsertCollection`, same as
          // any other write): this is only ever a create here (the branch
          // above skips existing Collections), so there is no prior row for
          // COALESCE to prefer over it.
          await this.#upsertCollection({
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
          // The Collection's own metadata sidecar travels with a newly-created
          // Collection, restored into the `meta_*` columns; for an existing
          // (skipped) Collection its metadata is left untouched, exactly as its
          // description and policy are.
          if (collectionMetadata) {
            await this.#applyImportedCollectionMetadata({
              client,
              spaceId,
              collectionId,
              metadataBytes: collectionMetadata
            })
          }
          // Its governing history log travels on the same terms.
          if (collectionLog) {
            await this.#applyImportedCollectionLog({
              client,
              spaceId,
              collectionId,
              logBytes: collectionLog
            })
          }
          stats.collectionsCreated++
        }

        // A collection-level policy travels with a newly-created collection;
        // for an existing (skipped) collection, leave its policy untouched.
        if (collectionPolicy) {
          if (collectionExisted) {
            stats.policiesSkipped++
          } else {
            await this.#upsertPolicy({
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
          await this.#insertImportedResource({
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
            await this.#upsertPolicy({
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
          await this.#insertImportedResource({
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
      // A chunk's parent-liveness is a property of its Resource, not its index:
      // cache it per (collectionId, resourceId) so a Resource with many chunks
      // is probed once rather than once per chunk. The Resource apply loop above
      // has fully settled, so a parent's row is stable for this pass.
      const parentLive = new Map<string, boolean>()
      for (const chunk of chunkEntries) {
        const parentKey = `${chunk.collectionId}/${chunk.resourceId}`
        let live = parentLive.get(parentKey)
        if (live === undefined) {
          const { rows: parentRows } = await client.query<{ deleted: boolean }>(
            `SELECT deleted FROM resources
              WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
            [spaceId, chunk.collectionId, chunk.resourceId]
          )
          const parent = parentRows[0]
          live = parent !== undefined && !parent.deleted
          parentLive.set(parentKey, live)
        }
        if (!live) {
          continue
        }
        // The chunk's validator comes from its archived `.meta.<index>.json`
        // sidecar, carried verbatim so a round trip keeps the exported ETag;
        // an archive without one (or one written before generations) mints a
        // fresh generation at version 1, the same fresh-write default as a
        // Resource restored without a sidecar. `ON CONFLICT DO NOTHING
        // RETURNING size`
        // folds the skip-not-overwrite check and the insert into one query: a
        // row comes back only when this INSERT actually created the chunk, so an
        // existing chunk adds nothing to the usage delta.
        const { rows: insertedRows } = await client.query<{ size: string }>(
          `INSERT INTO chunks (
             space_id, collection_id, resource_id, chunk_index,
             content_type, bytes, size, generation, version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT DO NOTHING
           RETURNING size`,
          [
            spaceId,
            chunk.collectionId,
            chunk.resourceId,
            chunk.chunkIndex,
            chunk.contentType,
            chunk.body,
            chunk.body.length,
            resolveGeneration(chunk.generation),
            chunk.version ?? 1
          ]
        )
        if (insertedRows.length > 0) {
          createdChunkBytes += Number(insertedRows[0]!.size)
        }
      }

      const createdTotalBytes = createdBytes + createdChunkBytes
      if (createdTotalBytes > 0) {
        // The pre-flight was conservative (it counted skips too), so the
        // actual created total always fits; apply it unguarded.
        await this.#applyUsageDelta({
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
   * Restores an archived Collection metadata sidecar into the Collection row's
   * `meta_*` columns, for the import apply loop. A sidecar that is not parseable
   * JSON is skipped rather than failing the import, matching how the filesystem
   * backend tolerates a malformed archived sidecar. The Collection row was just
   * created by the caller, so this is always an update of NULL columns.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.metadataBytes {Buffer}   the raw sidecar bytes
   * @returns {Promise<void>}
   */
  async #applyImportedCollectionMetadata({
    client,
    spaceId,
    collectionId,
    metadataBytes
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    metadataBytes: Buffer
  }): Promise<void> {
    let sidecar: CollectionMetaSidecar | undefined
    try {
      sidecar = JSON.parse(metadataBytes.toString('utf8'))
    } catch {
      return
    }
    if (!sidecar?.metaVersion) {
      return
    }
    const now = new Date().toISOString()
    await client.query(
      `UPDATE collections SET
         meta_generation = $8,
         meta_version    = $3,
         meta_custom     = $4::jsonb,
         meta_epoch      = $5,
         meta_created_at = $6,
         meta_updated_at = $7
       WHERE space_id = $1 AND collection_id = $2`,
      [
        spaceId,
        collectionId,
        sidecar.metaVersion,
        sidecar.custom !== undefined ? JSON.stringify(sidecar.custom) : null,
        sidecar.epoch ?? null,
        sidecar.createdAt || now,
        sidecar.updatedAt || now,
        // An archive written before generations carries no `generation`; the
        // restored metadata object starts a fresh one rather than none, so it
        // still has an ETag.
        resolveGeneration(sidecar.generation)
      ]
    )
  }

  /**
   * Restores an archived Collection history log (the filesystem backend's
   * `.collectionlog.<id>.json` shape) into the `log_*` columns. An archive
   * entry that does not parse to that shape is dropped.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.logBytes {Buffer}
   * @returns {Promise<void>}
   */
  async #applyImportedCollectionLog({
    client,
    spaceId,
    collectionId,
    logBytes
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    logBytes: Buffer
  }): Promise<void> {
    let stored: StoredCollectionLog | undefined
    try {
      stored = JSON.parse(logBytes.toString('utf8'))
    } catch {
      return
    }
    if (typeof stored?.body !== 'string' || !stored.version) {
      return
    }
    await client.query(
      `UPDATE collections SET
         log_body       = $3,
         log_generation = $4,
         log_version    = $5
       WHERE space_id = $1 AND collection_id = $2`,
      [
        spaceId,
        collectionId,
        stored.body,
        resolveGeneration(stored.generation),
        stored.version
      ]
    )
  }

  /**
   * Inserts one archived resource (or orphan tombstone) row for the import
   * apply loop. Timestamps, the ETag validator, `createdBy`, and `custom` come
   * from the archive's sidecar when present; an archive resource without a
   * sidecar (or one written before generations) is treated as a fresh first
   * write on this backend (a new generation at version 1, no `createdBy`).
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.contentType {string}
   * @param options.body {Buffer|null}   `null` re-creates a tombstone
   * @param [options.sidecar] {MetaSidecar}
   * @returns {Promise<void>}
   */
  async #insertImportedResource({
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
    sidecar: MetaSidecar | undefined
  }): Promise<void> {
    const now = new Date().toISOString()
    const deleted = body === null
    await client.query(
      `INSERT INTO resources (
         space_id, collection_id, resource_id, content_type, content,
         is_json, size_bytes, generation, version, meta_generation,
         meta_version, custom, deleted, created_at, updated_at, created_by,
         epoch
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
                 $13, $14, $15, $16, $17)`,
      [
        spaceId,
        collectionId,
        resourceId,
        contentType,
        body,
        isJson({ contentType }),
        body?.length ?? 0,
        resolveGeneration(sidecar?.generation),
        sidecar?.version ?? 1,
        // The `/meta` validator is restored verbatim from the archived sidecar,
        // as the filesystem backend restores the sidecar bytes themselves.
        sidecar?.metaGeneration ?? null,
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
   * Reduces the import plan's per-Collection chunk files (the `chunked-streams`
   * feature) into one merged chunk row per (collectionId, resourceId,
   * chunkIndex): the `chunks` table stores a chunk as a single row, whereas the
   * plan (and the filesystem backend's on-disk layout) keeps each chunk as an
   * `r.<index>...` representation paired with an optional `.meta.<index>.json`
   * version sidecar. `buildImportPlan` already validated the ids and dropped any
   * non-canonical index, so this only merges the two files of each chunk; a
   * chunk that carries only a sidecar (no representation) is dropped (a chunk
   * keeps no tombstone). The filesystem backend writes the files verbatim, so
   * this reduction lives here.
   * @param collections {ImportPlanCollection[]}
   * @returns {Array<{ collectionId: string, resourceId: string, chunkIndex:
   *   number, contentType: string, body: Buffer, generation?: string,
   *   version?: number }>}
   */
  #mergeChunkEntries(collections: ImportPlanCollection[]): Array<{
    collectionId: string
    resourceId: string
    chunkIndex: number
    contentType: string
    body: Buffer
    generation?: string
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
        generation?: string
        version?: number
      }
    >()
    for (const { collectionId, chunkFiles } of collections) {
      for (const chunkFile of chunkFiles) {
        const { resourceId, chunkIndex } = chunkFile
        const key = `${collectionId}/${resourceId}/${chunkIndex}`
        const slot = staged.get(key) ?? { collectionId, resourceId, chunkIndex }
        // A representation file carries a `contentType` (and its bytes); a
        // version sidecar carries only the validator.
        if (chunkFile.contentType !== undefined) {
          slot.contentType = chunkFile.contentType
          slot.body = chunkFile.body
        } else {
          if (chunkFile.generation !== undefined) {
            slot.generation = chunkFile.generation
          }
          if (chunkFile.version !== undefined) {
            slot.version = chunkFile.version
          }
        }
        staged.set(key, slot)
      }
    }

    const merged: Array<{
      collectionId: string
      resourceId: string
      chunkIndex: number
      contentType: string
      body: Buffer
      generation?: string
      version?: number
    }> = []
    for (const slot of staged.values()) {
      if (slot.body === undefined) {
        // A sidecar with no paired representation is not a valid chunk.
        continue
      }
      merged.push({
        collectionId: slot.collectionId,
        resourceId: slot.resourceId,
        chunkIndex: slot.chunkIndex,
        contentType: slot.contentType ?? 'application/octet-stream',
        body: slot.body,
        generation: slot.generation,
        version: slot.version
      })
    }
    return merged
  }
}
