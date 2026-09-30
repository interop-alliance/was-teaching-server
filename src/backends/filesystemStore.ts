/**
 * Storage layout versioning for the `FileSystemBackend`: an ordered list of
 * migration functions plus the runner that applies them on backend `init()`,
 * mirroring `MIGRATIONS` in `postgresSchema.ts`. The data root's `store.json`
 * records the layout version the directory is at. It sits beside `spaces/`,
 * `keystores/` and `space-revocations/`, so no Space or Collection id can
 * collide with it.
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
import { StoreLockTimeoutError, StoreVersionError } from '../errors.js'

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
  // v1: the baseline layout. A data dir is stamped at the current version when
  // it is first used, so this step has nothing to convert.
  async () => {}
]

/**
 * The file at the data root that records the layout version.
 */
export const STORE_FILE_NAME = 'store.json'

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
 * rewrites `store.json` after each step. Refuses to start (`StoreVersionError`)
 * when `store.json` names a version newer than `migrations` knows, or when it
 * is absent over a data dir that already holds data. Holds a lock file for the
 * whole run, so two processes sharing the data dir cannot both migrate it.
 * @param options {object}
 * @param options.dataDir {string}   the backend's data root
 * @param options.logger {FastifyBaseLogger}
 * @param [options.migrations] {StoreMigration[]}   defaults to STORE_MIGRATIONS
 * @param [options.lockTimeoutMs] {number}   how long to wait on a held lock
 * @returns {Promise<number>}   the version the data dir is at afterwards
 */
export async function applyStoreMigrations({
  dataDir,
  logger,
  migrations = STORE_MIGRATIONS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS
}: {
  dataDir: string
  logger: FastifyBaseLogger
  migrations?: StoreMigration[]
  lockTimeoutMs?: number
}): Promise<number> {
  await mkdir(dataDir, { recursive: true })
  return runnerMutex.run(await realpath(dataDir), () =>
    migrateUnderLock({ dataDir, logger, migrations, lockTimeoutMs })
  )
}

/**
 * The body of `applyStoreMigrations`, run once the in-process mutex is held.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.logger {FastifyBaseLogger}
 * @param options.migrations {StoreMigration[]}
 * @param options.lockTimeoutMs {number}
 * @returns {Promise<number>}
 */
async function migrateUnderLock({
  dataDir,
  logger,
  migrations,
  lockTimeoutMs
}: {
  dataDir: string
  logger: FastifyBaseLogger
  migrations: StoreMigration[]
  lockTimeoutMs: number
}): Promise<number> {
  const currentVersion = migrations.length
  const lock = await acquireLock({ dataDir, lockTimeoutMs, logger })
  try {
    const stampedVersion = await readStoreVersion({ dataDir })
    if (stampedVersion === undefined) {
      if (!(await isEmptyDataDir({ dataDir }))) {
        throw new StoreVersionError({
          detail:
            `The data directory ${dataDir} holds data but no ` +
            `${STORE_FILE_NAME}; this server expects version ${currentVersion}.`
        })
      }
      await writeStoreVersion({ dataDir, version: currentVersion })
      return currentVersion
    }
    if (stampedVersion > currentVersion) {
      throw new StoreVersionError({
        detail:
          `${path.join(dataDir, STORE_FILE_NAME)} names version ${stampedVersion}; ` +
          `this server knows up to version ${currentVersion}.`
      })
    }
    for (
      let version = stampedVersion + 1;
      version <= currentVersion;
      version++
    ) {
      logger.info(
        { from: version - 1, to: version },
        'Migrating filesystem store'
      )
      await migrations[version - 1]!({ dataDir, logger })
      await writeStoreVersion({ dataDir, version })
    }
    return currentVersion
  } finally {
    await lock.release()
  }
}

/**
 * Reads the version `store.json` records, or `undefined` when there is none.
 * A `store.json` that is not a JSON object with a non-negative integer
 * `version` is refused rather than treated as absent.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<number | undefined>}
 */
async function readStoreVersion({
  dataDir
}: {
  dataDir: string
}): Promise<number | undefined> {
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
  let version: unknown
  try {
    version = JSON.parse(text)?.version
  } catch {
    // Reported below with the other malformed shapes.
  }
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new StoreVersionError({
      detail: `${storePath} does not name an integer version.`
    })
  }
  return version as number
}

/**
 * Rewrites `store.json` with `version` (temp file plus rename).
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.version {number}
 * @returns {Promise<void>}
 */
async function writeStoreVersion({
  dataDir,
  version
}: {
  dataDir: string
  version: number
}): Promise<void> {
  await atomicWriteFile({
    filePath: path.join(dataDir, STORE_FILE_NAME),
    data: JSON.stringify({ version }) + '\n'
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
