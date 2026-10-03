/**
 * Storage layout versioning for the `FileSystemBackend`: an ordered list of
 * migration functions plus the runner that applies them on backend `open()`,
 * mirroring `MIGRATIONS` in `postgresSchema.ts`. The data root's `store.json`
 * records the layout version the directory is at, the store's origin id (see
 * `lib/originId.ts`), and the high-water mark of the store's hybrid logical
 * clock (`clockHighWater`, epoch milliseconds; see `lib/hlc.ts`). It sits
 * beside `spaces/`, `keystores/` and `space-revocations/`, so no Space or
 * Collection id can collide with it.
 *
 * The runner runs inside the server process at startup. It must not run from a
 * Fly `release_command`, since Fly runs that command in a temporary machine
 * that does not mount the app's volume.
 */
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
  utimes
} from 'node:fs/promises'
import type { FastifyBaseLogger } from 'fastify'
import {
  TEMP_FILE_PREFIX,
  atomicCreateFile,
  atomicWriteFile
} from '../lib/atomicFile.js'
import { KeyedMutex } from '../lib/keyedMutex.js'
import { isValidOriginId, settleOriginId } from '../lib/originId.js'
import {
  StoreLockTimeoutError,
  StoreOriginIdError,
  StoreVersionError
} from '../errors.js'

/**
 * One layout migration. It must be idempotent: a run interrupted before its
 * version stamp is written is repeated in full on the next boot.
 */
export type StoreMigration = (options: {
  dataDir: string
  logger: FastifyBaseLogger
}) => Promise<void>

/**
 * Ordered layout migrations. Version `n` is `STORE_MIGRATIONS[n - 1]`. New
 * entries are appended. An applied entry is not edited.
 */
export const STORE_MIGRATIONS: StoreMigration[] = [
  // v1: the baseline layout, the one every data dir written before `store.json`
  // existed is already in. An unstamped dir that holds data starts at version
  // 0, so this step is what stamps it; it has nothing to convert.
  async () => {},
  // v2: every versioned record carries a write stamp in place of a version
  // counter. A record written at an earlier layout carries none, and there is
  // no stamping step: a store holding any Space is refused, every boot, until
  // it is wiped or restored from an archive (whose records an import
  // re-stamps). An empty store passes and is stamped at this version.
  refuseUnstampedSpaces
]

/**
 * The file at the data root that records the layout version and the origin id.
 */
export const STORE_FILE_NAME = 'store.json'

/**
 * The parsed contents of `store.json`. `originId` is absent from a file
 * written before the store carried one, and `clockHighWater` from a store
 * whose clock has minted nothing yet. Members this code does not know are
 * kept on every rewrite.
 */
type StoreRecord = {
  version: number
  originId?: string
  clockHighWater?: number
  [member: string]: unknown
}

/**
 * The layout step that refuses a store written before records carried write
 * stamps: any entry under `spaces/` is a Space whose records carry none.
 * Staging temp files left there by a killed process are not Spaces.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<void>}
 */
async function refuseUnstampedSpaces({
  dataDir
}: {
  dataDir: string
}): Promise<void> {
  const spacesDir = path.join(dataDir, 'spaces')
  let entries: string[]
  try {
    entries = await readdir(spacesDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw err
  }
  const spaces = entries.filter(name => !name.startsWith(TEMP_FILE_PREFIX))
  if (spaces.length > 0) {
    throw new StoreVersionError({
      detail:
        `${spacesDir} holds ${spaces.length} Space(s) written before records ` +
        'carried write stamps, and there is no stamping migration. Wipe the ' +
        'data directory, or restore each Space from an export archive into ' +
        'an empty store.'
    })
  }
}

/**
 * The name prefix of the lock files a runner creates while it reads and
 * advances the version. Each runner creates its own `store.lock.<nonce>`.
 */
const LOCK_FILE_PREFIX = 'store.lock.'

/**
 * Entries that do not make a data dir non-empty, beside the lock and staging
 * temp files `isEmptyDataDir` matches by prefix: `store.json` itself, and the
 * `lost+found` directory an ext4 volume carries at its root (a fresh Fly
 * volume has one).
 */
const IGNORED_ROOT_ENTRIES = new Set([STORE_FILE_NAME, 'lost+found'])

/**
 * How often a runner waiting on the lock checks it again.
 */
const LOCK_POLL_MS = 100

/**
 * How long a runner waits on a lock another live process holds.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * How often a holder refreshes its lock file's mtime.
 */
const LOCK_HEARTBEAT_MS = 5 * 1000

/**
 * How long a lock file may go without a heartbeat before it counts as left by
 * a process that is gone, whatever host or process id it names.
 */
const LOCK_STALE_MS = 60 * 1000

/**
 * Serializes the runners in this process per data dir. A lock file naming this
 * process is then never a live one, since no other runner here holds one.
 */
const runnerMutex = new KeyedMutex()

/**
 * Brings the data dir at `dataDir` to the newest layout version: stamps an
 * empty dir at that version, applies each pending migration in order, and
 * rewrites `store.json` after each step. A dir that holds data but no
 * `store.json` predates the stamp and is at the baseline layout, so it starts
 * at version 0 and every step runs over it. Refuses to start
 * (`StoreVersionError`) when `store.json` names a version newer than
 * `migrations` knows. Holds a lock file for the whole run, so two processes
 * sharing the data dir cannot both migrate it.
 *
 * Also settles the store's origin id on every boot, under the same lock. A
 * stored id is kept, and a configured one that differs is refused, as is a
 * malformed stored id (`StoreOriginIdError`). A store with no id takes the
 * configured one, or a minted one, and writes it before any migration step
 * runs, so a run killed after that write keeps the id for the next boot.
 * @param options {object}
 * @param options.dataDir {string}   the backend's data root
 * @param options.logger {FastifyBaseLogger}
 * @param [options.originId] {string}   the configured origin id
 *   (`WAS_ORIGIN_ID`)
 * @param [options.migrations] {StoreMigration[]}   defaults to STORE_MIGRATIONS
 * @param [options.lockTimeoutMs] {number}   how long to wait on a held lock
 * @returns {Promise<{ version: number, originId: string, clockHighWater?: number }>}
 *   the version the data dir is at afterwards, its origin id, and the clock's
 *   persisted high-water mark, when the store has one
 */
export async function applyStoreMigrations({
  dataDir,
  logger,
  originId,
  migrations = STORE_MIGRATIONS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS
}: {
  dataDir: string
  logger: FastifyBaseLogger
  originId?: string
  migrations?: StoreMigration[]
  lockTimeoutMs?: number
}): Promise<{ version: number; originId: string; clockHighWater?: number }> {
  await mkdir(dataDir, { recursive: true })
  return runnerMutex.run(await realpath(dataDir), () =>
    migrateUnderLock({
      dataDir,
      logger,
      configuredOriginId: originId,
      migrations,
      lockTimeoutMs
    })
  )
}

/**
 * The body of `applyStoreMigrations`, run once the in-process mutex is held.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.logger {FastifyBaseLogger}
 * @param [options.configuredOriginId] {string}
 * @param options.migrations {StoreMigration[]}
 * @param options.lockTimeoutMs {number}
 * @returns {Promise<{ version: number, originId: string, clockHighWater?: number }>}
 */
async function migrateUnderLock({
  dataDir,
  logger,
  configuredOriginId,
  migrations,
  lockTimeoutMs
}: {
  dataDir: string
  logger: FastifyBaseLogger
  configuredOriginId?: string
  migrations: StoreMigration[]
  lockTimeoutMs: number
}): Promise<{ version: number; originId: string; clockHighWater?: number }> {
  const currentVersion = migrations.length
  const lock = await acquireLock({ dataDir, lockTimeoutMs, logger })
  try {
    let record = await readStoreRecord({ dataDir })
    if (record === undefined) {
      // An empty data dir starts at the current version; one that holds data
      // predates the stamp and is at the baseline layout.
      const empty = await isEmptyDataDir({ dataDir })
      if (!empty) {
        logger.info(
          { dataDir },
          `Data directory holds data but no ${STORE_FILE_NAME}; migrating from the baseline layout`
        )
      }
      record = { version: empty ? currentVersion : 0 }
    }
    if (record.version > currentVersion) {
      throw new StoreVersionError({
        detail:
          `${path.join(dataDir, STORE_FILE_NAME)} names version ${record.version}; ` +
          `this server knows up to version ${currentVersion}.`
      })
    }
    // A malformed configured id is refused here, before anything is written:
    // in `store.json` it would refuse every later boot.
    const originId = settleOriginId({
      stored: record.originId,
      configured: configuredOriginId
    })
    if (record.originId === undefined) {
      // Written before any step runs, so a run killed mid-migration keeps it.
      record = { ...record, originId }
      await writeStoreRecord({ dataDir, record })
    }
    for (
      let version = record.version + 1;
      version <= currentVersion;
      version++
    ) {
      logger.info(
        { from: version - 1, to: version },
        'Migrating filesystem store'
      )
      await migrations[version - 1]!({ dataDir, logger })
      record = { ...record, version }
      await writeStoreRecord({ dataDir, record })
    }
    const { clockHighWater } = record
    return {
      version: currentVersion,
      originId,
      ...(clockHighWater !== undefined && { clockHighWater })
    }
  } finally {
    await lock.release()
  }
}

/**
 * Reads `store.json` as a whole record, or `undefined` when there is none. A
 * `store.json` that is not a JSON object with a non-negative integer
 * `version` is refused rather than treated as absent, and so is one whose
 * `originId` is present but not a well-formed origin id, or whose
 * `clockHighWater` is present but not a non-negative integer.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<StoreRecord | undefined>}
 */
async function readStoreRecord({
  dataDir
}: {
  dataDir: string
}): Promise<StoreRecord | undefined> {
  const storePath = path.join(dataDir, STORE_FILE_NAME)
  let text: string
  try {
    text = await readFile(storePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Reported below with the other malformed shapes.
  }
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  const { version, originId, clockHighWater } = record
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new StoreVersionError({
      detail: `${storePath} does not name an integer version.`
    })
  }
  if (
    clockHighWater !== undefined &&
    (!Number.isSafeInteger(clockHighWater) || (clockHighWater as number) < 0)
  ) {
    throw new StoreVersionError({
      detail: `${storePath} names a clockHighWater that is not a non-negative integer.`
    })
  }
  if (originId !== undefined && !isValidOriginId(originId)) {
    throw StoreOriginIdError.malformed({
      id: String(originId),
      where: storePath
    })
  }
  return record as StoreRecord
}

/**
 * Persists a new high-water mark of the store's hybrid logical clock as
 * `store.json`'s `clockHighWater` member, keeping every other member. Run by
 * the backend's clock at runtime, on a cadence (see `lib/hlc.ts`), so it is
 * serialized with the boot runner and with itself through the in-process
 * runner mutex. A mark is only ever raised: a lower `clockHighWater` than the
 * stored one leaves the file as it is.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.clockHighWater {number}   epoch milliseconds
 * @returns {Promise<void>}
 */
export async function writeClockHighWater({
  dataDir,
  clockHighWater
}: {
  dataDir: string
  clockHighWater: number
}): Promise<void> {
  await runnerMutex.run(await realpath(dataDir), async () => {
    const record = await readStoreRecord({ dataDir })
    if (record === undefined) {
      throw new StoreVersionError({
        detail: `${path.join(dataDir, STORE_FILE_NAME)} is missing.`
      })
    }
    if ((record.clockHighWater ?? -1) >= clockHighWater) {
      return
    }
    await writeStoreRecord({ dataDir, record: { ...record, clockHighWater } })
  })
}

/**
 * Rewrites `store.json` with the whole `record` (temp file plus rename). The
 * caller passes the record it read with its own members changed, so the
 * members it does not own, the origin id and the clock's high-water mark
 * among them, are kept.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.record {StoreRecord}
 * @returns {Promise<void>}
 */
async function writeStoreRecord({
  dataDir,
  record
}: {
  dataDir: string
  record: StoreRecord
}): Promise<void> {
  await atomicWriteFile({
    filePath: path.join(dataDir, STORE_FILE_NAME),
    data: JSON.stringify(record) + '\n'
  })
}

/**
 * Whether the data dir holds nothing but entries that carry no data.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<boolean>}
 */
async function isEmptyDataDir({
  dataDir
}: {
  dataDir: string
}): Promise<boolean> {
  const entries = await readdir(dataDir)
  return entries.every(
    name =>
      IGNORED_ROOT_ENTRIES.has(name) ||
      name.startsWith(LOCK_FILE_PREFIX) ||
      name.startsWith(TEMP_FILE_PREFIX)
  )
}

/**
 * The contents of a lock file: the process that created it.
 */
type LockHolder = { pid: number; hostname: string }

/**
 * Takes the store lock for `dataDir`. The runner creates its own uniquely
 * named lock file, then lists the others. If another live lock file exists, it
 * removes its own and waits, so of two runners racing, the one that lists last
 * always sees the other's file. Both may back off at once, so the wait is
 * jittered. A stale lock file is ignored and removed. Its name is never reused,
 * so removing it cannot touch a live hold.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.lockTimeoutMs {number}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<{ release: () => Promise<void> }>}
 */
async function acquireLock({
  dataDir,
  lockTimeoutMs,
  logger
}: {
  dataDir: string
  lockTimeoutMs: number
  logger: FastifyBaseLogger
}): Promise<{ release: () => Promise<void> }> {
  const lockPath = path.join(dataDir, LOCK_FILE_PREFIX + randomUUID())
  const holder: LockHolder = { pid: process.pid, hostname: os.hostname() }
  const deadline = Date.now() + lockTimeoutMs
  let waitLogged = false
  for (;;) {
    let rivals = await liveLockFiles({ dataDir, logger })
    if (rivals.length === 0) {
      // Staged and linked into place, so a reader never sees a partial lock.
      await atomicCreateFile({
        filePath: lockPath,
        data: JSON.stringify(holder)
      })
      rivals = (await liveLockFiles({ dataDir, logger })).filter(
        rival => rival !== lockPath
      )
      if (rivals.length === 0) {
        return holdLock({ lockPath })
      }
      await unlink(lockPath).catch(() => {})
    }
    if (Date.now() > deadline) {
      throw new StoreLockTimeoutError({ lockPath: rivals[0]! })
    }
    if (!waitLogged) {
      logger.info({ lockPath: rivals[0] }, 'Waiting for the store lock')
      waitLogged = true
    }
    await new Promise(resolve =>
      setTimeout(resolve, LOCK_POLL_MS + Math.random() * LOCK_POLL_MS)
    )
  }
}

/**
 * Starts the heartbeat on a lock file just taken, and returns its release.
 * @param options {object}
 * @param options.lockPath {string}
 * @returns {{ release: () => Promise<void> }}
 */
function holdLock({ lockPath }: { lockPath: string }): {
  release: () => Promise<void>
} {
  const heartbeat = setInterval(() => {
    const now = new Date()
    utimes(lockPath, now, now).catch(() => {})
  }, LOCK_HEARTBEAT_MS)
  heartbeat.unref()
  return {
    async release() {
      clearInterval(heartbeat)
      await unlink(lockPath).catch(() => {})
    }
  }
}

/**
 * Lists the paths of the live lock files in `dataDir`, removing the stale
 * ones it finds (best-effort).
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<string[]>}
 */
async function liveLockFiles({
  dataDir,
  logger
}: {
  dataDir: string
  logger: FastifyBaseLogger
}): Promise<string[]> {
  const live: string[] = []
  for (const name of await readdir(dataDir)) {
    if (!name.startsWith(LOCK_FILE_PREFIX)) {
      continue
    }
    const lockPath = path.join(dataDir, name)
    const judgment = await judgeLockFile({ lockPath })
    if (judgment === 'live') {
      live.push(lockPath)
    } else if (judgment !== 'gone') {
      logger.warn(
        { lockPath, holder: judgment.staleHolder },
        'Removing a stale store lock'
      )
      await unlink(lockPath).catch(() => {})
    }
  }
  return live
}

/**
 * Reads one lock file and judges it. A lock file is stale when its heartbeat
 * stopped, or when it names this host and a process id that is not running or
 * is this process (whose runners the in-process mutex serializes, so none of
 * them holds a lock here). A lock file that does not parse is stale too.
 * @param options {object}
 * @param options.lockPath {string}
 * @returns {Promise<'live' | 'gone' | { staleHolder: LockHolder | string }>}
 *   `'gone'` when the file no longer exists; a stale file carries its holder,
 *   or its text when it does not parse
 */
async function judgeLockFile({
  lockPath
}: {
  lockPath: string
}): Promise<'live' | 'gone' | { staleHolder: LockHolder | string }> {
  let text: string
  let mtimeMs: number
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs
    text = await readFile(lockPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'gone'
    }
    throw err
  }
  let holder: LockHolder
  try {
    holder = JSON.parse(text)
  } catch {
    return { staleHolder: text }
  }
  if (!Number.isInteger(holder?.pid) || typeof holder.hostname !== 'string') {
    return { staleHolder: text }
  }
  if (Date.now() - mtimeMs > LOCK_STALE_MS || isGoneOnThisHost(holder)) {
    return { staleHolder: holder }
  }
  return 'live'
}

/**
 * Whether a lock's holder names this host and a process that is known to be
 * gone: no running process has its id, or its id is this process's.
 * @param holder {LockHolder}
 * @returns {boolean}
 */
function isGoneOnThisHost(holder: LockHolder): boolean {
  if (holder.hostname !== os.hostname()) {
    return false
  }
  if (holder.pid === process.pid || holder.pid <= 0) {
    return true
  }
  try {
    process.kill(holder.pid, 0)
    return false
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
