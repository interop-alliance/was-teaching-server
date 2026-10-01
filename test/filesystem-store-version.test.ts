/**
 * Tests for the filesystem backend's storage layout version (`store.json`) and
 * the startup migration runner.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import pino from 'pino'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import {
  STORE_FILE_NAME,
  STORE_MIGRATIONS,
  applyStoreMigrations,
  type StoreMigration
} from '../src/backends/filesystemStore.js'
import { TEMP_FILE_ORPHAN_AGE_MS } from '../src/lib/atomicFile.js'
import { StoreLockTimeoutError, StoreVersionError } from '../src/errors.js'

const logger = pino({ level: 'silent' })

/**
 * A migration that does nothing.
 */
const noop: StoreMigration = async () => {}

/**
 * A migration that counts how often it runs.
 */
function countingMigration(): {
  migration: StoreMigration
  runs: () => number
} {
  let ran = 0
  return {
    migration: async () => {
      ran++
    },
    runs: () => ran
  }
}

/**
 * Writes a lock file held by a process on another host, with a fresh mtime.
 */
async function writeOtherHostLock(dataDir: string): Promise<string> {
  const lockPath = path.join(dataDir, 'store.lock.other-host')
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, hostname: 'another-machine' })
  )
  return lockPath
}

/**
 * The version `store.json` in `dataDir` records.
 */
async function storedVersion(dataDir: string): Promise<number> {
  const text = await readFile(path.join(dataDir, STORE_FILE_NAME), 'utf8')
  return JSON.parse(text).version
}

/**
 * Writes a `store.json` recording `version` into `dataDir`.
 */
async function stamp(dataDir: string, version: number): Promise<void> {
  await writeFile(
    path.join(dataDir, STORE_FILE_NAME),
    JSON.stringify({ version })
  )
}

describe('Filesystem store version', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-store-version-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('stamps an empty data dir with the current version on backend init', async () => {
    const backend = new FileSystemBackend({ dataDir })
    await backend.init()
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
    // The lock is released.
    assert.deepEqual(await readdir(dataDir), [STORE_FILE_NAME])
  })

  it('stamps a data dir that does not exist yet', async () => {
    const nested = path.join(dataDir, 'not-yet')
    const version = await applyStoreMigrations({ dataDir: nested, logger })
    assert.equal(version, STORE_MIGRATIONS.length)
    assert.equal(await storedVersion(nested), STORE_MIGRATIONS.length)
  })

  it('treats a volume root holding only lost+found as empty', async () => {
    await mkdir(path.join(dataDir, 'lost+found'))
    const counting = countingMigration()
    const version = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: [noop, counting.migration]
    })
    assert.equal(version, 2)
    assert.equal(counting.runs(), 0, 'a fresh dir needs no migration')
    assert.equal(await storedVersion(dataDir), 2)
  })

  it('applies a pending step once and stamps after it', async () => {
    await stamp(dataDir, 1)
    await mkdir(path.join(dataDir, 'spaces'))
    const counting = countingMigration()
    const migrations = [noop, counting.migration]
    assert.equal(await applyStoreMigrations({ dataDir, logger, migrations }), 2)
    assert.equal(await storedVersion(dataDir), 2)
    assert.equal(await applyStoreMigrations({ dataDir, logger, migrations }), 2)
    assert.equal(counting.runs(), 1)
  })

  it('re-runs a step interrupted before its stamp write', async () => {
    await stamp(dataDir, 1)
    const marker = path.join(dataDir, 'marker')
    let fail = true
    // Idempotent: writes the same marker however often it runs.
    const interruptible: StoreMigration = async ({ dataDir: root }) => {
      await writeFile(path.join(root, 'marker'), 'migrated')
      if (fail) {
        throw new Error('interrupted')
      }
    }
    const migrations = [noop, interruptible]
    await assert.rejects(
      applyStoreMigrations({ dataDir, logger, migrations }),
      /interrupted/
    )
    assert.equal(await storedVersion(dataDir), 1)
    fail = false
    assert.equal(await applyStoreMigrations({ dataDir, logger, migrations }), 2)
    assert.equal(await readFile(marker, 'utf8'), 'migrated')
    assert.equal(await storedVersion(dataDir), 2)
  })

  it('lets only one of two concurrent runners migrate', async () => {
    await stamp(dataDir, 1)
    let ran = 0
    const slow: StoreMigration = async () => {
      ran++
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const migrations = [noop, slow]
    const versions = await Promise.all([
      applyStoreMigrations({ dataDir, logger, migrations }),
      applyStoreMigrations({ dataDir, logger, migrations })
    ])
    assert.deepEqual(versions, [2, 2])
    assert.equal(ran, 1)
  })

  it('takes over a lock left by a process that is gone', async () => {
    await stamp(dataDir, 1)
    // This process's id, but not a lock this process holds: what a restart
    // that reused the id finds.
    await writeFile(
      path.join(dataDir, 'store.lock.left-behind'),
      JSON.stringify({ pid: process.pid, hostname: os.hostname() })
    )
    const version = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: [noop, noop],
      lockTimeoutMs: 1000
    })
    assert.equal(version, 2)
    assert.deepEqual(await readdir(dataDir), [STORE_FILE_NAME])
  })

  it('takes over a lock from another host whose heartbeat stopped', async () => {
    await stamp(dataDir, 1)
    const lockPath = await writeOtherHostLock(dataDir)
    const stale = new Date(Date.now() - 5 * 60 * 1000)
    await utimes(lockPath, stale, stale)
    const version = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: [noop, noop],
      lockTimeoutMs: 1000
    })
    assert.equal(version, 2)
  })

  it('waits on a live lock from another host until it is released', async () => {
    await stamp(dataDir, 1)
    const lockPath = await writeOtherHostLock(dataDir)
    const counting = countingMigration()
    const running = applyStoreMigrations({
      dataDir,
      logger,
      migrations: [noop, counting.migration],
      lockTimeoutMs: 5000
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(
      counting.runs(),
      0,
      'no step runs while the other host holds the lock'
    )
    await unlink(lockPath)
    assert.equal(await running, 2)
    assert.equal(counting.runs(), 1)
  })

  it('times out on a live lock from another host', async () => {
    await stamp(dataDir, 1)
    await writeOtherHostLock(dataDir)
    await assert.rejects(
      applyStoreMigrations({
        dataDir,
        logger,
        migrations: [noop, noop],
        lockTimeoutMs: 300
      }),
      StoreLockTimeoutError
    )
    assert.equal(await storedVersion(dataDir), 1)
  })

  it('removes stale temp files at the data root on backend init', async () => {
    await stamp(dataDir, STORE_MIGRATIONS.length)
    const tempPath = path.join(dataDir, '.tmp-left-behind')
    await writeFile(tempPath, '{"version":')
    const stale = new Date(Date.now() - TEMP_FILE_ORPHAN_AGE_MS - 60_000)
    await utimes(tempPath, stale, stale)
    await new FileSystemBackend({ dataDir }).init()
    assert.deepEqual(await readdir(dataDir), [STORE_FILE_NAME])
  })

  it('refuses a version newer than the code knows, naming both', async () => {
    await stamp(dataDir, STORE_MIGRATIONS.length + 1)
    const backend = new FileSystemBackend({ dataDir })
    await assert.rejects(
      backend.init(),
      (err: Error) =>
        err instanceof StoreVersionError &&
        err.message.includes(`version ${STORE_MIGRATIONS.length + 1}`) &&
        err.message.includes(`version ${STORE_MIGRATIONS.length}`)
    )
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length + 1)
  })

  it('migrates an unstamped data dir that holds data from version 0', async () => {
    await mkdir(path.join(dataDir, 'spaces'))
    const counting = countingMigration()
    const migrations = [noop, counting.migration]
    assert.equal(await applyStoreMigrations({ dataDir, logger, migrations }), 2)
    assert.equal(counting.runs(), 1, 'every step runs over pre-stamp data')
    assert.equal(await storedVersion(dataDir), 2)
    assert.deepEqual((await readdir(dataDir)).sort(), [
      'spaces',
      STORE_FILE_NAME
    ])
  })

  it('stamps an unstamped data dir that holds data on backend init', async () => {
    await mkdir(path.join(dataDir, 'spaces'))
    const backend = new FileSystemBackend({ dataDir })
    await backend.init()
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
  })

  it('refuses a store.json with no integer version', async () => {
    await writeFile(path.join(dataDir, STORE_FILE_NAME), '{"version":"1"}')
    await assert.rejects(
      applyStoreMigrations({ dataDir, logger }),
      StoreVersionError
    )
  })
})
