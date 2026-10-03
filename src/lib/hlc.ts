/**
 * The hybrid logical clock behind every write stamp (Kulkarni et al., "Logical
 * Physical Clocks"). Each storage backend holds one clock for its store and
 * mints a stamp with it inside the critical section of every versioned write.
 * A stamp is the clock reading `{ ms, counter }` plus the store's origin id,
 * carried on the wire as `updatedAt` (the ISO string of `ms`),
 * `updatedAtCounter` and `originId` (storage-core's `WriteStamp`). Stamps are
 * ordered by `(ms, counter, originId)`: the first two numerically, the last by
 * plain string comparison.
 *
 * The clock reading `l` never runs below the largest physical time or stamp it
 * has seen, so a stamp minted here never sorts below one minted here before,
 * even when the physical clock steps backwards. A write over a stored record
 * also raises the clock to that record's stamp first, so the new stamp sorts
 * above the one it overwrites even after a restart, when the clock starts
 * again from its persisted high-water mark.
 *
 * One process mints for one store. Two processes over one store would share
 * the origin id and could mint the same stamp twice.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { WriteStamp } from '@interop/storage-core'
import { REPLICATION_CLOCK_BOUND_MS } from '../config.default.js'

/**
 * A clock reading: the physical part `ms` (epoch milliseconds) and the
 * logical `counter` that orders readings within one millisecond.
 */
export interface HlcTimestamp {
  ms: number
  counter: number
}

/**
 * How far the physical part must move past the last persisted high-water mark
 * before a mint persists a new one, in milliseconds.
 */
const HIGH_WATER_CADENCE_MS = 1000

/**
 * The ISO string a stamp's `updatedAt` carries for a clock reading's `ms`.
 * @param ms {number}   epoch milliseconds
 * @returns {string}
 */
export function isoOfMs(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * The clock reading a write stamp carries, or `undefined` when the stamp is
 * partial or its `updatedAt` does not parse as a date.
 * @param stamp {Partial<WriteStamp> | undefined}
 * @returns {HlcTimestamp | undefined}
 */
export function readingOfStamp(
  stamp: Partial<WriteStamp> | undefined
): HlcTimestamp | undefined {
  if (
    stamp?.updatedAt === undefined ||
    !Number.isSafeInteger(stamp.updatedAtCounter)
  ) {
    return undefined
  }
  const ms = Date.parse(stamp.updatedAt)
  return Number.isNaN(ms)
    ? undefined
    : { ms, counter: stamp.updatedAtCounter as number }
}

/**
 * The write stamp members of a stored record, each left out when absent.
 * @param record {Partial<WriteStamp> | undefined}
 * @returns {Partial<WriteStamp>}
 */
export function stampOf(
  record: Partial<WriteStamp> | undefined
): Partial<WriteStamp> {
  return {
    ...(record?.updatedAt !== undefined && { updatedAt: record.updatedAt }),
    ...(record?.updatedAtCounter !== undefined && {
      updatedAtCounter: record.updatedAtCounter
    }),
    ...(record?.originId !== undefined && { originId: record.originId })
  }
}

/**
 * A record without its write stamp members (`updatedAt`, `updatedAtCounter`,
 * `originId`). A Space or Collection Metadata body takes this form in the
 * Postgres `metadata` jsonb, whose stamp lives in its own columns, and an
 * incoming or archived record takes it before the backend's clock stamps it.
 * @param record {T}
 * @returns {Omit<T, keyof WriteStamp>}
 */
export function withoutStampMembers<T extends object>(
  record: T
): Omit<T, keyof WriteStamp> {
  const {
    updatedAt: _updatedAt,
    updatedAtCounter: _updatedAtCounter,
    originId: _originId,
    ...rest
  } = record as T & Partial<WriteStamp>
  return rest
}

/**
 * Orders two write stamps by `(ms, counter, originId)`: negative when `left`
 * sorts first, positive when `right` does, zero when they are the same stamp.
 * The first two compare numerically, `originId` by plain code-unit
 * comparison, so the order is the same on every server.
 * @param left {WriteStamp}
 * @param right {WriteStamp}
 * @returns {number}
 */
export function compareStamps(left: WriteStamp, right: WriteStamp): number {
  const leftMs = Date.parse(left.updatedAt)
  const rightMs = Date.parse(right.updatedAt)
  if (leftMs !== rightMs) {
    return leftMs - rightMs
  }
  if (left.updatedAtCounter !== right.updatedAtCounter) {
    return left.updatedAtCounter - right.updatedAtCounter
  }
  if (left.originId === right.originId) {
    return 0
  }
  return left.originId < right.originId ? -1 : 1
}

/**
 * Whether a value is a usable clock reading part: a safe non-negative
 * integer.
 * @param value {unknown}
 * @returns {boolean}
 */
function isReadingPart(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Whether reading `left` sorts after reading `right`.
 * @param left {HlcTimestamp}
 * @param right {HlcTimestamp}
 * @returns {boolean}
 */
function isAfter(left: HlcTimestamp, right: HlcTimestamp): boolean {
  return (
    left.ms > right.ms || (left.ms === right.ms && left.counter > right.counter)
  )
}

/**
 * One store's hybrid logical clock. `now()` advances it by the send rule,
 * `observe()` by the receive rule under the clock bound, and `mint()` stamps a
 * write over a held record.
 */
export class HybridLogicalClock {
  /**
   * The physical part of the last reading handed out or taken in.
   */
  #ms: number
  /**
   * The logical part of that reading. `-1` only right after a seeded boot,
   * so the first reading at the seeded millisecond carries counter 0.
   */
  #counter: number
  /**
   * The store's origin id, stamped on every minted write.
   */
  readonly originId: string
  /**
   * How far ahead of physical time, in milliseconds, `observe()` accepts a
   * reading.
   */
  readonly bound: number
  #physicalClock: () => number
  #persistHighWater?: (ms: number) => Promise<void>
  /**
   * Returns the logger a failed high-water write is reported through. A
   * function rather than a logger, since a backend's logger can be replaced
   * after its clock is built.
   */
  #getLogger?: () => FastifyBaseLogger
  /**
   * The last high-water mark persisted, or requested.
   */
  #persistedMark: number | undefined
  /**
   * Whether the clock has handed out or taken in a reading since boot. A
   * clock that has not is still at its seed, which needs no persisting.
   */
  #advanced = false
  /**
   * Serializes the high-water writes, so a later mark is never overwritten
   * by an earlier one finishing late.
   */
  #persisting: Promise<void> = Promise.resolve()

  /**
   * @param options {object}
   * @param options.originId {string}   the store's origin id
   * @param [options.physicalClock] {() => number}   the physical clock, epoch
   *   milliseconds; defaults to `Date.now`
   * @param [options.bound] {number}   the clock bound for `observe()`, in
   *   milliseconds; defaults to `REPLICATION_CLOCK_BOUND_MS`
   * @param [options.highWater] {number}   the high-water mark persisted
   *   before this boot. The clock starts at `highWater + 1` ms, counter 0.
   *   The mark is written on a cadence, so it can trail the last stamp
   *   minted before a crash by up to a second; the held-stamp rule in
   *   `mint()` is what keeps an overwrite above the stamp it replaces.
   * @param [options.persistHighWater] {(ms: number) => Promise<void>}
   *   persists a new high-water mark. Called by `mint()` whenever the
   *   physical part has moved more than a second past the last mark, and by
   *   `persistCurrentMark()` at shutdown.
   * @param [options.getLogger] {() => FastifyBaseLogger}   returns the
   *   backend's current logger, which a failed high-water write is reported
   *   through at `warn`
   */
  constructor({
    originId,
    physicalClock = Date.now,
    bound = REPLICATION_CLOCK_BOUND_MS,
    highWater,
    persistHighWater,
    getLogger
  }: {
    originId: string
    physicalClock?: () => number
    bound?: number
    highWater?: number
    persistHighWater?: (ms: number) => Promise<void>
    getLogger?: () => FastifyBaseLogger
  }) {
    this.originId = originId
    this.bound = bound
    this.#physicalClock = physicalClock
    this.#persistHighWater = persistHighWater
    this.#getLogger = getLogger
    this.#persistedMark = highWater
    // Seeded one millisecond past the mark with the counter one below 0, so
    // the first reading the send rule hands out at that millisecond is
    // `(highWater + 1, 0)`.
    this.#ms = highWater === undefined ? 0 : highWater + 1
    this.#counter = highWater === undefined ? 0 : -1
  }

  /**
   * The next reading, by the send rule: `l = max(l, physical time)`; the
   * counter ticks when `l` stood still and restarts at 0 when it advanced.
   * @returns {HlcTimestamp}
   */
  now(): HlcTimestamp {
    const physical = this.#readPhysical()
    this.#advanced = true
    if (physical > this.#ms) {
      this.#ms = physical
      this.#counter = 0
    } else {
      this.#counter += 1
    }
    return { ms: this.#ms, counter: this.#counter }
  }

  /**
   * Takes in a reading received from a peer, by the receive rule:
   * `l = max(l, received.ms, physical time)`, with the counter one past the
   * largest counter carried at that millisecond. A reading dated more than
   * `bound` ms ahead of physical time is refused and leaves the clock as it
   * was, and so is one whose `ms` or `counter` is not a safe non-negative
   * integer.
   * @param received {HlcTimestamp}
   * @returns {boolean}   `true` when taken in, `false` when refused
   */
  observe(received: HlcTimestamp): boolean {
    if (!isReadingPart(received.ms) || !isReadingPart(received.counter)) {
      return false
    }
    const physical = this.#readPhysical()
    if (received.ms - physical > this.bound) {
      return false
    }
    this.#advanced = true
    const ms = Math.max(this.#ms, received.ms, physical)
    if (ms === this.#ms && ms === received.ms) {
      this.#counter = Math.max(this.#counter, received.counter) + 1
    } else if (ms === this.#ms) {
      this.#counter += 1
    } else if (ms === received.ms) {
      this.#counter = received.counter + 1
    } else {
      this.#counter = 0
    }
    this.#ms = ms
    return true
  }

  /**
   * Mints the stamp of a write over a record this store holds. The clock is
   * first raised to the held stamp, without the clock bound, since the stamp
   * is the store's own. The send rule then yields
   * `max(now(), held + one counter tick)`, so the new stamp sorts above the
   * one it overwrites even when the clock restarted below it or physical
   * time stepped back. Persists a new high-water mark when this reading's
   * physical part is more than a second past the last one.
   * @param [options] {object}
   * @param [options.held] {Partial<WriteStamp>}   the stamp of the record the
   *   write replaces; absent on a create
   * @returns {Promise<WriteStamp>}
   */
  async mint({
    held
  }: { held?: Partial<WriteStamp> } = {}): Promise<WriteStamp> {
    const heldReading = readingOfStamp(held)
    if (
      heldReading !== undefined &&
      isAfter(heldReading, { ms: this.#ms, counter: this.#counter })
    ) {
      this.#ms = heldReading.ms
      this.#counter = heldReading.counter
    }
    const { ms, counter } = this.now()
    await this.#persistIfDue(ms)
    return {
      updatedAt: isoOfMs(ms),
      updatedAtCounter: counter,
      originId: this.originId
    }
  }

  /**
   * Persists the clock's current physical part as the high-water mark when
   * it stands above the last one persisted, so a clock seeded from it after
   * a clean restart starts above every stamp minted before. Run by a
   * backend's `close()`. Waits for any high-water write already in flight
   * first. A failed write is logged at `warn` and not thrown.
   * @returns {Promise<void>}
   */
  async persistCurrentMark(): Promise<void> {
    const persist = this.#persistHighWater
    const ms = this.#ms
    if (
      persist === undefined ||
      !this.#advanced ||
      (this.#persistedMark !== undefined && ms <= this.#persistedMark)
    ) {
      await this.#persisting
      return
    }
    await this.#persist({ persist, ms })
  }

  /**
   * Reads the physical clock, truncated to a whole millisecond, so the
   * clock's `ms` and the `updatedAt` serialized from it always agree.
   * @returns {number}
   */
  #readPhysical(): number {
    return Math.trunc(this.#physicalClock())
  }

  /**
   * Persists `ms` as the new high-water mark when it is more than a second
   * past the last one.
   * @param ms {number}
   * @returns {Promise<void>}
   */
  async #persistIfDue(ms: number): Promise<void> {
    const persist = this.#persistHighWater
    if (
      persist === undefined ||
      (this.#persistedMark !== undefined &&
        ms - this.#persistedMark <= HIGH_WATER_CADENCE_MS)
    ) {
      return
    }
    await this.#persist({ persist, ms })
  }

  /**
   * Writes `ms` as the high-water mark, chained after any write in flight so
   * the writes land in order. The mark is an optimization: the held-stamp
   * rule in `mint()` is what keeps an overwrite above the stamp it replaces.
   * Throwing a failed write would fail a client's write whose bytes may
   * already be stored, so it is logged at `warn` instead. The previous mark
   * is restored, unless a later mark was requested meanwhile, so the next
   * mint tries again.
   * @param options {object}
   * @param options.persist {(ms: number) => Promise<void>}
   * @param options.ms {number}
   * @returns {Promise<void>}
   */
  async #persist({
    persist,
    ms
  }: {
    persist: (ms: number) => Promise<void>
    ms: number
  }): Promise<void> {
    const previousMark = this.#persistedMark
    this.#persistedMark = ms
    const write = this.#persisting.then(() => persist(ms))
    // A failed write does not block the next one in the chain.
    this.#persisting = write.catch(() => {})
    try {
      await write
    } catch (err) {
      if (this.#persistedMark === ms) {
        this.#persistedMark = previousMark
      }
      this.#getLogger?.().warn(
        { err, highWater: ms },
        'Failed to persist the clock high-water mark'
      )
    }
  }
}
