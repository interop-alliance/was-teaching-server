/**
 * Tests for the hybrid logical clock behind every write stamp
 * (`src/lib/hlc.ts`): the send and receive rules under a frozen physical
 * clock, the clock bound, the mint over a held stamp, and the high-water mark
 * a filesystem store persists in `store.json` and seeds the clock from at
 * boot.
 */
import { describe, it, afterEach } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isWriteStamp } from '@interop/storage-core'
import {
  HybridLogicalClock,
  compareStamps,
  isoOfMs,
  readingOfStamp,
  stampOf
} from '../src/lib/hlc.js'
import type { HlcTimestamp } from '../src/lib/hlc.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { STORE_FILE_NAME } from '../src/backends/filesystemStore.js'
import type { WriteStamp } from '../src/types.js'
import { frozenClock } from './helpers.js'

const ORIGIN = 'zTestOrigin'

/**
 * A clock over a frozen physical clock.
 * @param [options] {object}
 * @param [options.highWater] {number}
 * @param [options.persistHighWater] {(ms: number) => Promise<void>}
 * @returns {{ clock: HybridLogicalClock, physical: { now: number, read: () => number } }}
 */
function frozenHlc({
  highWater,
  persistHighWater
}: {
  highWater?: number
  persistHighWater?: (ms: number) => Promise<void>
} = {}): {
  clock: HybridLogicalClock
  physical: { now: number; read: () => number }
} {
  const physical = frozenClock()
  const clock = new HybridLogicalClock({
    originId: ORIGIN,
    physicalClock: physical.read,
    ...(highWater !== undefined && { highWater }),
    ...(persistHighWater !== undefined && { persistHighWater })
  })
  return { clock, physical }
}

/**
 * Reads `store.json`'s `clockHighWater` member.
 * @param dataDir {string}
 * @returns {Promise<number | undefined>}
 */
async function storedHighWater(dataDir: string): Promise<number | undefined> {
  const record = JSON.parse(
    await readFile(path.join(dataDir, STORE_FILE_NAME), 'utf8')
  )
  return record.clockHighWater
}

describe('Hybrid logical clock', () => {
  it('two readings in one millisecond get counters 0 and 1, and the counter restarts when the millisecond advances', () => {
    const { clock, physical } = frozenHlc()
    assert.deepEqual(clock.now(), { ms: physical.now, counter: 0 })
    assert.deepEqual(clock.now(), { ms: physical.now, counter: 1 })
    physical.now += 1
    assert.deepEqual(clock.now(), { ms: physical.now, counter: 0 })
  })

  it('a physical clock stepped backwards does not lower the reading', () => {
    const { clock, physical } = frozenHlc()
    const first = clock.now()
    physical.now -= 5000
    const second = clock.now()
    assert.equal(second.ms, first.ms)
    assert.equal(second.counter, first.counter + 1)
  })

  it('observe() advances the clock by the receive rule', () => {
    const { clock, physical } = frozenHlc()
    clock.now()
    const received = { ms: physical.now + 5000, counter: 3 }
    assert.equal(clock.observe(received), true)
    assert.deepEqual(clock.now(), { ms: received.ms, counter: 5 })
  })

  it('observe() refuses a reading past the clock bound and leaves the clock as it was', () => {
    const { clock, physical } = frozenHlc()
    const before = clock.now()
    assert.equal(
      clock.observe({ ms: physical.now + clock.bound + 1, counter: 0 }),
      false
    )
    assert.deepEqual(clock.now(), {
      ms: before.ms,
      counter: before.counter + 1
    })
    // At the bound exactly, the reading is taken in.
    assert.equal(
      clock.observe({ ms: physical.now + clock.bound, counter: 0 }),
      true
    )
  })

  it('a restarted clock behind a stored stamp mints above the held stamp, without the bound', async () => {
    const { clock, physical } = frozenHlc()
    // Held far ahead of physical time, past the clock bound: the store's own
    // stamp is still honored.
    const heldMs = physical.now + clock.bound * 10
    const held = {
      updatedAt: isoOfMs(heldMs),
      updatedAtCounter: 3,
      originId: ORIGIN
    }
    const minted = await clock.mint({ held })
    assert.deepEqual(readingOfStamp(minted), { ms: heldMs, counter: 4 })
    assert.equal(minted.originId, ORIGIN)
    assert.ok(compareStamps(minted, held) > 0)
  })

  it('a mint over a held stamp below the clock takes the send rule', async () => {
    const { clock, physical } = frozenHlc()
    const held = {
      updatedAt: isoOfMs(physical.now - 1000),
      updatedAtCounter: 7,
      originId: ORIGIN
    }
    const minted = await clock.mint({ held })
    assert.deepEqual(readingOfStamp(minted), { ms: physical.now, counter: 0 })
  })

  it('a clock seeded from a high-water mark starts one millisecond past it at counter 0', async () => {
    const { clock, physical } = frozenHlc({ highWater: Date.UTC(2027, 0, 1) })
    assert.ok(physical.now < Date.UTC(2027, 0, 1))
    const minted = await clock.mint()
    assert.deepEqual(readingOfStamp(minted), {
      ms: Date.UTC(2027, 0, 1) + 1,
      counter: 0
    })
  })

  it('persists a high-water mark when a mint moves more than a second past the last one', async () => {
    const persisted: number[] = []
    const { clock, physical } = frozenHlc({
      persistHighWater: async ms => {
        persisted.push(ms)
      }
    })
    const start = physical.now
    await clock.mint()
    assert.deepEqual(persisted, [start], 'the first mint persists')
    physical.now += 1000
    await clock.mint()
    assert.deepEqual(persisted, [start], 'one second later is not past it')
    physical.now += 1
    await clock.mint()
    assert.deepEqual(persisted, [start, start + 1001])
  })

  it('a failed high-water write does not reject mint(), is logged, and is retried by the next mint', async () => {
    const attempts: number[] = []
    const warnings: Array<{ object: any; message: string }> = []
    let failNext = true
    const physical = frozenClock()
    const clock = new HybridLogicalClock({
      originId: ORIGIN,
      physicalClock: physical.read,
      persistHighWater: async ms => {
        attempts.push(ms)
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
      },
      getLogger: () =>
        ({
          warn: (object: any, message: string) =>
            warnings.push({ object, message })
        }) as any
    })
    const start = physical.now
    const minted = await clock.mint()
    assert.deepEqual(readingOfStamp(minted), { ms: start, counter: 0 })
    assert.deepEqual(attempts, [start])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]!.object.err.message, 'disk full')

    // Within the cadence of the failed mark, the next mint still persists,
    // since the failed mark was withdrawn.
    physical.now += 1
    await clock.mint()
    assert.deepEqual(attempts, [start, start + 1])
    assert.equal(warnings.length, 1)

    // Once a mark has landed, the cadence applies again.
    physical.now += 1
    await clock.mint()
    assert.deepEqual(attempts, [start, start + 1])
  })

  it('two mints while a high-water write is pending return distinct, ordered stamps', async () => {
    let release: () => void = () => {}
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const { clock } = frozenHlc({ persistHighWater: () => pending })
    const firstMint = clock.mint()
    const secondMint = clock.mint()
    release()
    const [first, second] = await Promise.all([firstMint, secondMint])
    assert.ok(compareStamps(first, second) < 0)
    assert.deepEqual(readingOfStamp(second), {
      ms: readingOfStamp(first)!.ms,
      counter: readingOfStamp(first)!.counter + 1
    })
  })

  it('observe() refuses a reading whose parts are not safe non-negative integers, leaving the clock as it was', () => {
    const { clock, physical } = frozenHlc()
    const before = clock.now()
    for (const received of [
      { ms: NaN, counter: 0 },
      { ms: physical.now, counter: NaN },
      { ms: -1, counter: 0 },
      { ms: physical.now, counter: -1 },
      { ms: physical.now + 0.5, counter: 0 },
      { ms: physical.now, counter: 1.5 },
      { ms: Infinity, counter: 0 },
      { ms: '1' as unknown as number, counter: 0 },
      { counter: 0 } as unknown as HlcTimestamp
    ]) {
      assert.equal(clock.observe(received), false, JSON.stringify(received))
    }
    assert.deepEqual(clock.now(), {
      ms: before.ms,
      counter: before.counter + 1
    })
  })

  it('truncates a fractional physical clock reading, so ms and updatedAt agree', async () => {
    let physical = Date.UTC(2026, 9, 1) + 0.75
    const clock = new HybridLogicalClock({
      originId: ORIGIN,
      physicalClock: () => physical
    })
    const first = await clock.mint()
    assert.deepEqual(readingOfStamp(first), {
      ms: Date.UTC(2026, 9, 1),
      counter: 0
    })
    // A later fraction of the same millisecond is the same millisecond.
    physical += 0.2
    const reading = clock.now()
    assert.deepEqual(reading, { ms: Date.UTC(2026, 9, 1), counter: 1 })
    assert.equal(Date.parse(isoOfMs(reading.ms)), reading.ms)
  })

  it('persistCurrentMark() persists the reading above the last mark, and nothing when the clock has not moved', async () => {
    const persisted: number[] = []
    const { clock, physical } = frozenHlc({
      highWater: Date.UTC(2026, 0, 1),
      persistHighWater: async ms => {
        persisted.push(ms)
      }
    })
    // Still at its seed: nothing to persist.
    await clock.persistCurrentMark()
    assert.deepEqual(persisted, [])

    await clock.mint()
    assert.deepEqual(persisted, [physical.now])
    // Within the cadence: mint leaves the mark, persistCurrentMark raises it.
    physical.now += 500
    await clock.mint()
    assert.deepEqual(persisted, [physical.now - 500])
    await clock.persistCurrentMark()
    assert.deepEqual(persisted, [physical.now - 500, physical.now])
    await clock.persistCurrentMark()
    assert.equal(persisted.length, 2, 'not again at the same reading')
  })

  it('persistCurrentMark() logs a failed write and does not throw', async () => {
    const warnings: unknown[] = []
    const clock = new HybridLogicalClock({
      originId: ORIGIN,
      physicalClock: frozenClock().read,
      highWater: Date.UTC(2026, 0, 1),
      persistHighWater: async () => {
        throw new Error('read-only file system')
      },
      getLogger: () =>
        ({ warn: (object: unknown) => warnings.push(object) }) as any
    })
    await clock.mint()
    assert.equal(warnings.length, 1)
    clock.now()
    await clock.persistCurrentMark()
    assert.equal(warnings.length, 2)
  })

  it('orders stamps by (ms, counter, originId)', () => {
    const at = (ms: number, counter: number, originId: string) => ({
      updatedAt: isoOfMs(ms),
      updatedAtCounter: counter,
      originId
    })
    assert.ok(compareStamps(at(1, 9, 'b'), at(2, 0, 'a')) < 0)
    assert.ok(compareStamps(at(2, 1, 'a'), at(2, 0, 'b')) > 0)
    assert.ok(compareStamps(at(2, 1, 'a'), at(2, 1, 'b')) < 0)
    assert.equal(compareStamps(at(2, 1, 'a'), at(2, 1, 'a')), 0)
  })
})

describe('Hybrid logical clock high-water mark (filesystem store)', () => {
  let dataDir: string | undefined

  afterEach(async () => {
    if (dataDir !== undefined) {
      await rm(dataDir, { recursive: true, force: true })
      dataDir = undefined
    }
  })

  it('is persisted in store.json on a cadence and seeds the clock at the next boot', async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-hlc-'))
    const physical = frozenClock()
    const start = physical.now
    const backend = await FileSystemBackend.open({
      dataDir,
      physicalClock: physical.read
    })
    assert.equal(await storedHighWater(dataDir), undefined)

    await backend.writeSpace({
      spaceId: 'space1',
      spaceMetadata: {
        id: 'space1',
        type: ['Space'],
        controller: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
      }
    })
    assert.equal(await storedHighWater(dataDir), start)

    // Within a second of the mark, a write leaves it.
    physical.now = start + 500
    await backend.writeCollection({
      spaceId: 'space1',
      collectionId: 'notes',
      collectionMetadata: { id: 'notes', type: ['Collection'] }
    })
    assert.equal(await storedHighWater(dataDir), start)

    // Past it, the next write persists the new reading.
    physical.now = start + 5000
    await backend.writeCollection({
      spaceId: 'space1',
      collectionId: 'notes',
      collectionMetadata: { id: 'notes', type: ['Collection'] }
    })
    assert.equal(await storedHighWater(dataDir), start + 5000)

    // A reboot whose physical clock stands behind the mark mints just past
    // it, above everything minted before the restart.
    const behind = frozenClock(start - 60_000)
    const rebooted = await FileSystemBackend.open({
      dataDir,
      physicalClock: behind.read
    })
    const minted = await rebooted.clock.mint()
    assert.deepEqual(readingOfStamp(minted), {
      ms: start + 5000 + 1,
      counter: 0
    })
    const stored = await rebooted.getCollectionMetadata({
      spaceId: 'space1',
      collectionId: 'notes'
    })
    assert.ok(stored && isWriteStamp(stampOf(stored)))
    assert.ok(compareStamps(minted, stampOf(stored) as WriteStamp) > 0)
  })

  it('is persisted by close(), so a clean restart mints above every stamp minted before it', async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-hlc-'))
    const physical = frozenClock()
    const start = physical.now
    const backend = await FileSystemBackend.open({
      dataDir,
      physicalClock: physical.read
    })
    await backend.writeSpace({
      spaceId: 'space1',
      spaceMetadata: {
        id: 'space1',
        type: ['Space'],
        controller: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
      }
    })
    // Within the cadence, so the write leaves the mark behind its stamp.
    physical.now = start + 500
    await backend.writeCollection({
      spaceId: 'space1',
      collectionId: 'notes',
      collectionMetadata: { id: 'notes', type: ['Collection'] }
    })
    assert.equal(await storedHighWater(dataDir), start)

    await backend.close()
    assert.equal(await storedHighWater(dataDir), start + 500)

    const behind = frozenClock(start - 60_000)
    const rebooted = await FileSystemBackend.open({
      dataDir,
      physicalClock: behind.read
    })
    const minted = await rebooted.clock.mint()
    const stored = await rebooted.getCollectionMetadata({
      spaceId: 'space1',
      collectionId: 'notes'
    })
    assert.ok(compareStamps(minted, stampOf(stored!) as WriteStamp) > 0)
    assert.deepEqual(readingOfStamp(minted), { ms: start + 501, counter: 0 })
  })

  it('close() logs a failed high-water write and resolves', async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-hlc-'))
    const warnings: unknown[] = []
    const physical = frozenClock()
    const backend = await FileSystemBackend.open({
      dataDir,
      physicalClock: physical.read
    })
    backend.logger = {
      ...backend.logger,
      warn: (object: unknown) => warnings.push(object)
    } as any
    await backend.clock.mint()
    physical.now += 1
    backend.clock.now()
    await rm(dataDir, { recursive: true, force: true })
    await backend.close()
    assert.equal(warnings.length, 1)
  })
})
