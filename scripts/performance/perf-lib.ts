/**
 * Pure and injectable-dependency logic shared by `pnpm perf:fs` and
 * `pnpm perf:pg` (`perf-fs.ts`, `perf-pg.ts`) and their seed scripts: CLI
 * argument parsing, the run-length estimate, the Markdown table formatting,
 * the load-aggregation harnesses, and the Collection-size seeding over an
 * injected backend. Kept free of side effects at import time so it can be
 * unit tested without spawning a server, k6, or any network request.
 */
import type { StorageBackend } from '../../src/types.js'

/**
 * Parses a command-line value as a positive integer.
 * @param value {string}
 * @returns {number}
 */
export function positiveInteger(value: string): number {
  const number = Number(value.trim())
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Expected a positive integer, got "${value}".`)
  }
  return number
}

/**
 * Parses a `--sizes` value (comma-separated Collection sizes) into the
 * deduped, sorted list and the edge sizes (smallest and largest) that the
 * signed write/delete/serial-write tests run at.
 * @param value {string}
 * @returns {{ sizes: number[], edgeSizes: number[] }}
 */
export function parseSizes(value: string): {
  sizes: number[]
  edgeSizes: number[]
} {
  const sizes = [...new Set(value.split(',').map(positiveInteger))].sort(
    (left, right) => left - right
  )
  const edgeSizes = sizes.filter(
    (_size, index) => index === 0 || index === sizes.length - 1
  )
  return { sizes, edgeSizes }
}

/**
 * The settings every load test reads, from the shared CLI options
 * (`--clients`, `--duration`, `--writes`).
 */
export interface LoadSettings {
  clients: number
  durationSeconds: number
  serialWrites: number
}

/**
 * Parses the shared load-test CLI values into `LoadSettings`.
 * @param options {object}
 * @param options.clients {string}
 * @param options.duration {string}
 * @param options.writes {string}
 * @returns {LoadSettings}
 */
export function parseLoadSettings({
  clients,
  duration,
  writes
}: {
  clients: string
  duration: string
  writes: string
}): LoadSettings {
  return {
    clients: positiveInteger(clients),
    durationSeconds: positiveInteger(duration),
    serialWrites: positiveInteger(writes)
  }
}

export interface Measurement {
  rate: number
  avgMs?: number
  failed: number
}

export interface Row {
  test: string
  size: number
  result: Measurement | string
}

/**
 * Formats a number with thousands separators and fixed decimals.
 * @param value {number}
 * @param digits {number}
 * @returns {string}
 */
function formatNumber(value: number, digits: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

/**
 * One completed test as a plain progress line, printed as each test finishes
 * so a multi-minute run isn't silent. The final report (`formatPivotedTable`
 * / `formatScalingSummary`) is the polished table; this is just "something
 * happened."
 * @param row {Row}
 * @returns {string}
 */
export function formatProgressLine({ test, size, result }: Row): string {
  const sizeLabel = formatNumber(size, 0)
  if (typeof result === 'string') {
    return `${test} (size ${sizeLabel}): ${result}`
  }
  const avg = result.avgMs === undefined ? 'n/a' : formatNumber(result.avgMs, 2)
  return `${test} (size ${sizeLabel}): ${formatNumber(result.rate, 1)} req/s, ${avg} ms avg, ${result.failed} failed`
}

/**
 * One test's result at every size the run covers, aligned with `sizes`: a
 * `Measurement` where that (test, size) pair ran, the skip string where k6
 * was skipped, or `undefined` where that test was not run at that size (the
 * signed write/delete/serial-write tests only run at the edge sizes).
 */
export interface PivotedRow {
  test: string
  cells: Array<Measurement | string | undefined>
}

/**
 * Groups the run's flat `Row[]` by test, in first-seen order, into one
 * `PivotedRow` per test with one cell per size.
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.rows {Row[]}
 * @returns {PivotedRow[]}
 */
export function pivotRows({
  sizes,
  rows
}: {
  sizes: number[]
  rows: Row[]
}): PivotedRow[] {
  const order: string[] = []
  const cellsByTest = new Map<string, Array<Measurement | string | undefined>>()
  for (const row of rows) {
    if (!cellsByTest.has(row.test)) {
      order.push(row.test)
      cellsByTest.set(row.test, new Array(sizes.length).fill(undefined))
    }
    const index = sizes.indexOf(row.size)
    cellsByTest.get(row.test)![index] = row.result
  }
  return order.map(test => ({
    test,
    cells: cellsByTest.get(test) as Array<Measurement | string | undefined>
  }))
}

/**
 * One table cell as it reads: the skip string as-is, `--` for a gap, or
 * `<rate> <unit> (<avg> ms)`.
 * @param cell {Measurement | string | undefined}
 * @param [unit] {string}   `req/s` by default; the matrix counts `files/s`
 * @returns {string}
 */
function formatCell(
  cell: Measurement | string | undefined,
  unit = 'req/s'
): string {
  if (cell === undefined) {
    return '--'
  }
  if (typeof cell === 'string') {
    return cell
  }
  const avg = cell.avgMs === undefined ? 'n/a' : formatNumber(cell.avgMs, 2)
  return `${formatNumber(cell.rate, 1)} ${unit} (${avg} ms)`
}

/**
 * The pivoted results as a Markdown table: one row per test, one column per
 * size.
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.pivoted {PivotedRow[]}
 * @returns {string}
 */
export function formatPivotedTable({
  sizes,
  pivoted
}: {
  sizes: number[]
  pivoted: PivotedRow[]
}): string {
  const header = `| Test | ${sizes.map(size => `size ${size}`).join(' | ')} |`
  const divider = `|---|${sizes.map(() => '---:').join('|')}|`
  const body = pivoted.map(
    ({ test, cells }) =>
      `| ${test} | ${cells.map(cell => formatCell(cell)).join(' | ')} |`
  )
  return [header, divider, ...body].join('\n')
}

/**
 * One payload-matrix result: a Collection category and a payload, with its
 * read and write measurement (or the skip string, for a public read without
 * k6). Each counts whole files, however many requests one file takes.
 */
export interface MatrixRow {
  category: MatrixCategory
  payload: MatrixPayload
  read: Measurement | string
  write: Measurement | string
}

const matrixCategoryLabels: Record<MatrixCategory, string> = {
  public: 'Public',
  plaintext: 'Plaintext',
  encrypted: 'Encrypted'
}

const matrixPayloadLabels: Record<MatrixPayload, string> = {
  json: 'JSON',
  small: '100 KiB file',
  large: '10 MiB file'
}

/**
 * How a matrix cell is named in progress lines and failure lists, e.g.
 * `Encrypted, 10 MiB file`.
 * @param options {object}
 * @param options.category {MatrixCategory}
 * @param options.payload {MatrixPayload}
 * @returns {string}
 */
export function matrixLabel({
  category,
  payload
}: {
  category: MatrixCategory
  payload: MatrixPayload
}): string {
  return `${matrixCategoryLabels[category]}, ${matrixPayloadLabels[payload]}`
}

/**
 * One completed matrix test as a progress line, e.g.
 * `Encrypted, 10 MiB file, write: 12.3 files/s (80.10 ms), 0 failed`.
 * @param options {object}
 * @param options.category {MatrixCategory}
 * @param options.payload {MatrixPayload}
 * @param options.operation {string}   `read` or `write`
 * @param options.result {Measurement | string}
 * @returns {string}
 */
export function formatMatrixProgressLine({
  category,
  payload,
  operation,
  result
}: {
  category: MatrixCategory
  payload: MatrixPayload
  operation: string
  result: Measurement | string
}): string {
  const label = `${matrixLabel({ category, payload })}, ${operation}`
  if (typeof result === 'string') {
    return `${label}: ${result}`
  }
  return `${label}: ${formatCell(result, 'files/s')}, ${result.failed} failed`
}

/**
 * The payload matrix as a Markdown table, one row per category and payload,
 * followed by a failures line.
 * @param rows {MatrixRow[]}
 * @returns {string}
 */
export function formatMatrixTable(rows: MatrixRow[]): string {
  const failures: string[] = []
  const body = rows.map(({ category, payload, read, write }) => {
    for (const [operation, result] of [
      ['read', read],
      ['write', write]
    ] as const) {
      if (typeof result !== 'string' && result.failed > 0) {
        failures.push(
          `${matrixLabel({ category, payload })} ${operation}: ${result.failed} failed`
        )
      }
    }
    return (
      `| ${matrixCategoryLabels[category]} | ${matrixPayloadLabels[payload]} | ` +
      `${formatCell(read, 'files/s')} | ${formatCell(write, 'files/s')} |`
    )
  })
  return [
    '| Collection | Payload | Read | Write |',
    '|---|---|---:|---:|',
    ...body,
    '',
    failures.length > 0 ? `Failures: ${failures.join('; ')}` : 'Failures: none'
  ].join('\n')
}

/**
 * How close a largest/smallest rate ratio has to be to 1 to read as flat.
 */
const flatRatioBand = 0.15

/**
 * Compares each test's rate at the smallest size against the largest, and
 * reports which tests slow down with Collection size, which stayed flat, and
 * any failures anywhere in the run. A test with a skipped (no k6) cell at
 * either endpoint is left out of the comparison -- there is no rate to
 * compare.
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.pivoted {PivotedRow[]}
 * @returns {string[]} one line per entry, ready to join with `\n`
 */
export function formatScalingSummary({
  sizes,
  pivoted
}: {
  sizes: number[]
  pivoted: PivotedRow[]
}): string[] {
  const smallest = sizes[0]
  const largest = sizes.at(-1) as number
  const changed: Array<{ test: string; factor: number; line: string }> = []
  const flat: string[] = []
  const failures: string[] = []

  for (const { test, cells } of pivoted) {
    cells.forEach((cell, index) => {
      if (cell !== undefined && typeof cell !== 'string' && cell.failed > 0) {
        failures.push(`${test} size ${sizes[index]}: ${cell.failed} failed`)
      }
    })
    const smallCell = cells[0]
    const largeCell = cells.at(-1)
    if (
      smallCell === undefined ||
      largeCell === undefined ||
      typeof smallCell === 'string' ||
      typeof largeCell === 'string'
    ) {
      continue
    }
    const factor = largeCell.rate / smallCell.rate
    if (factor >= 1 - flatRatioBand && factor <= 1 + flatRatioBand) {
      flat.push(test)
      continue
    }
    const direction = factor < 1 ? 'slower' : 'faster'
    const spoken = factor < 1 ? 1 / factor : factor
    changed.push({
      test,
      factor,
      line:
        `${test}: ${formatNumber(smallCell.rate, 1)} -> ` +
        `${formatNumber(largeCell.rate, 1)} req/s, ` +
        `${formatNumber(spoken, 1)}x ${direction}`
    })
  }
  changed.sort((left, right) => left.factor - right.factor)

  const lines = [`Smallest size (${smallest}) to largest (${largest}):`]
  for (const { line } of changed) {
    lines.push(`- ${line}`)
  }
  if (flat.length > 0) {
    lines.push(`- ${flat.join(', ')}: roughly flat`)
  }
  lines.push('')
  lines.push(
    failures.length > 0 ? `Failures: ${failures.join('; ')}` : 'Failures: none'
  )
  return lines
}

/**
 * Formats the run's CPU model, core count, and total RAM for the printed
 * header, so two compared runs can be checked for a matching environment at a
 * glance.
 * @param options {object}
 * @param options.cpuModel {string}
 * @param options.cores {number}
 * @param options.totalMemoryBytes {number}
 * @returns {string}
 */
export function formatMachine({
  cpuModel,
  cores,
  totalMemoryBytes
}: {
  cpuModel: string
  cores: number
  totalMemoryBytes: number
}): string {
  const gib = totalMemoryBytes / 1024 ** 3
  return `${cpuModel}, ${cores} cores, ${gib.toFixed(1)} GB RAM`
}

/**
 * Estimates how long a run takes with the given settings. Filling Collections
 * and the delete tests' untimed refills are the parts that vary most, so they
 * are priced at a representative signed-write rate (25 writes/s, from a prior
 * default-settings run).
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @param options.durationSeconds {number}
 * @param options.serialWrites {number}
 * @param options.withK6 {boolean}
 * @param [options.matrix] {boolean}   whether the payload matrix runs too: 9
 *   reads (3 of them through k6) and 9 writes, the 6 binary writes with an
 *   untimed delete after each round, priced at half the test's length
 * @returns {number} minutes, rounded up
 */
export function estimateMinutes({
  sizes,
  edgeSizes,
  durationSeconds,
  serialWrites,
  warmUpWrites,
  pauseMs,
  withK6,
  filling,
  matrix = false
}: {
  sizes: number[]
  edgeSizes: number[]
  durationSeconds: number
  serialWrites: number
  warmUpWrites: number
  pauseMs: number
  withK6: boolean
  filling: boolean
  matrix?: boolean
}): number {
  const writesPerSecond = 25
  const sum = (values: number[]) =>
    values.reduce((total, value) => total + value, 0)
  const filled = filling ? 2 * sum(sizes) + 3 * sum(edgeSizes) : 0
  const matrixTests = matrix ? (withK6 ? 9 : 6) + 9 : 0
  const matrixCleanupSeconds = matrix ? 6 * durationSeconds * 0.5 : 0
  const loadTests =
    (withK6 ? 2 * sizes.length : 0) +
    sizes.length +
    2 * edgeSizes.length +
    matrixTests
  // a delete round refills its Resources at the write rate, about twice as slow
  // as it deletes them
  const refillSeconds = edgeSizes.length * durationSeconds * 1.8
  const serialSeconds =
    (edgeSizes.length * (warmUpWrites + serialWrites)) / writesPerSecond
  const pauseSeconds = ((loadTests + edgeSizes.length + 1) * pauseMs) / 1000
  const seconds =
    filled / writesPerSecond +
    loadTests * durationSeconds +
    refillSeconds +
    serialSeconds +
    matrixCleanupSeconds +
    pauseSeconds
  return Math.ceil(seconds / 60)
}

/**
 * The payload matrix's fixed Space ids: one Space holding the read targets,
 * one taking the timed writes, and one holding `--binary-total-mib` of extra
 * binary data that nothing reads.
 */
export const matrixSpaceIds = {
  read: 'perf-matrix-read',
  write: 'perf-matrix-write',
  ballast: 'perf-ballast'
} as const

/**
 * The matrix categories, each one a Collection of that id in both the read
 * and the write Space.
 */
export const matrixCategories = ['public', 'plaintext', 'encrypted'] as const

export type MatrixCategory = (typeof matrixCategories)[number]

/**
 * The matrix payloads. In the public and plaintext Collections each read
 * target's Resource id is the payload name; the encrypted Collection's ids
 * are EDV ids minted at seed time.
 */
export const matrixPayloads = ['json', 'small', 'large'] as const

export type MatrixPayload = (typeof matrixPayloads)[number]

/**
 * Whether a value read back from a `seed-meta.json` is the encrypted read
 * targets' EDV ids: a string per matrix payload.
 * @param value {unknown}
 * @returns {boolean}
 */
export function isEncryptedIds(
  value: unknown
): value is Record<MatrixPayload, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    matrixPayloads.every(
      payload => typeof (value as Record<string, unknown>)[payload] === 'string'
    )
  )
}

/**
 * The small binary payload: under was-client's 512 KiB threshold, so in an
 * encrypted Collection it is one EDV document.
 */
export const smallFileBytes = 100 * 1024

/**
 * The large binary payload: over the 512 KiB threshold, so in an encrypted
 * Collection it is one EDV document plus ten 1 MiB chunks.
 */
export const largeFileBytes = 10 * 1024 * 1024

/**
 * How many writes a seed runs at once, over signed HTTP or through a backend.
 */
export const seedConcurrency = 10

/**
 * The three Spaces each edge size gets, as `<label>-<size>`, by the test that
 * uses it: the signed write test, the signed delete test, and the serial
 * writes.
 */
export const edgeSpaceLabels = {
  write: 'perf-write',
  remove: 'perf-delete',
  serial: 'perf-serial'
} as const

/**
 * What a seed script is about to write, printed before it starts: where, then
 * the Collection sizes, the payload matrix and the ballast, each with the flag
 * that changes it.
 * @param options {object}
 * @param options.target {string}   where the seed goes, with its flags
 * @param options.sizes {number[]}
 * @param options.ballast {string}   the ballast line
 * @returns {string}
 */
export function formatSeedPlan({
  target,
  sizes,
  ballast
}: {
  target: string
  sizes: number[]
  ballast: string
}): string {
  return [
    `Seeding ${target}, replacing what it holds:`,
    `- Collection sizes: ${sizes.join(', ')} Resources (--sizes)`,
    '- Payload matrix: a JSON credential, a 100 KiB file and a 10 MiB file, ' +
      'in public, plaintext and encrypted Collections',
    `- Binary ballast: ${ballast}`,
    ''
  ].join('\n')
}

/**
 * The ids `vc-1` to `vc-<count>`.
 * @param count {number}
 * @returns {string[]}
 */
export function itemIds(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `vc-${index + 1}`)
}

/**
 * The body every seeded Resource carries, whether seeded over signed HTTP
 * (`pnpm perf:fs`) or written directly through the backend
 * (`pnpm perf:fs:seed`, `pnpm perf:pg:seed`).
 * @param id {string}
 * @returns {object}
 */
export function credential(id: string): object {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential'],
    issuer: 'did:key:z6MkExampleIssuer',
    validFrom: '2026-01-01T00:00:00Z',
    credentialSubject: { id: 'did:key:z6MkExampleSubject', name: id }
  }
}

/**
 * Writes one id at a time per worker, `concurrency` workers sharing one
 * iterator so each id is written exactly once. `pnpm perf:fs` and the seed
 * scripts share this shape but differ in how a single id gets written
 * (a signed HTTP `Collection.put` versus a direct backend `writeResource`),
 * so `write` is the seam between them.
 * @param options {object}
 * @param options.ids {string[]}
 * @param options.concurrency {number}
 * @param options.write {(id: string) => Promise<unknown>}
 * @returns {Promise<void>}
 */
export async function fillConcurrently({
  ids,
  concurrency,
  write
}: {
  ids: string[]
  concurrency: number
  write: (id: string) => Promise<unknown>
}): Promise<void> {
  const pending = ids.values()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (const id of pending) {
        await write(id)
      }
    })
  )
}

/**
 * The running count behind every load harness: completed and failed
 * requests, and the summed latency of the completed ones.
 */
class Tally {
  #completed = 0
  #failed = 0
  #totalMs = 0

  /**
   * Runs `op`, counting it as completed (with its latency) or failed.
   * @param op {() => Promise<unknown>}
   * @returns {Promise<boolean>} whether it completed
   */
  async time(op: () => Promise<unknown>): Promise<boolean> {
    const sent = performance.now()
    try {
      await op()
      this.#completed++
      this.#totalMs += performance.now() - sent
      return true
    } catch {
      this.#failed++
      return false
    }
  }

  /**
   * The tally as a measurement over `elapsedMs` of timed work.
   * @param elapsedMs {number}
   * @returns {Measurement}
   */
  measurement(elapsedMs: number): Measurement {
    return {
      rate: this.#completed / (elapsedMs / 1000),
      avgMs: this.#completed ? this.#totalMs / this.#completed : undefined,
      failed: this.#failed
    }
  }
}

/**
 * The worker indexes `0` to `clients - 1`.
 * @param clients {number}
 * @returns {number[]}
 */
function workerIndexes(clients: number): number[] {
  return Array.from({ length: clients }, (_unused, worker) => worker)
}

/**
 * Runs `op` from `clients` concurrent clients until `durationSeconds` have
 * elapsed, reporting requests per second, average latency, and failures. Each
 * client sends one request at a time, moving to the next as soon as the
 * previous one settles.
 * @param options {object}
 * @param options.clients {number}
 * @param options.durationSeconds {number}
 * @param options.op {(worker: number, count: number) => Promise<unknown>}
 * @returns {Promise<Measurement>}
 */
export async function load({
  clients,
  durationSeconds,
  op
}: {
  clients: number
  durationSeconds: number
  op: (worker: number, count: number) => Promise<unknown>
}): Promise<Measurement> {
  const tally = new Tally()
  const started = performance.now()
  const deadline = started + durationSeconds * 1000
  await Promise.all(
    workerIndexes(clients).map(async worker => {
      for (let count = 0; performance.now() < deadline; count++) {
        await tally.time(() => op(worker, count))
      }
    })
  )
  return tally.measurement(performance.now() - started)
}

/**
 * A minimal `WasClient`-shaped dependency: just the signed-request escape
 * hatch `deleteLoad` and `serialWriteLoad` need.
 */
export interface RequestingClient {
  request(options: {
    path: string
    method: string
    json?: object
  }): Promise<unknown>
}

/**
 * Timed work from `clients` concurrent clients, in rounds: each round runs
 * `round` once, which returns how long its timed part took. Rounds repeat
 * until the timed parts add up to `durationSeconds`.
 * @param options {object}
 * @param options.durationSeconds {number}
 * @param options.round {(round: number) => Promise<number>}
 * @returns {Promise<number>} the summed timed milliseconds
 */
async function timedRounds({
  durationSeconds,
  round
}: {
  durationSeconds: number
  round: (round: number) => Promise<number>
}): Promise<number> {
  let timedMs = 0
  for (let index = 0; timedMs < durationSeconds * 1000; index++) {
    timedMs += await round(index)
  }
  return timedMs
}

/**
 * Signed deletes from `clients` concurrent clients, in rounds: each round
 * re-creates every client's `deleteRoundSize` Resources (untimed), then each
 * client deletes its own (timed). Rounds repeat until the timed part reaches
 * `durationSeconds`. The ids repeat every round, so the Collection stays
 * within `clients * deleteRoundSize` Resources of its starting size.
 * @param options {object}
 * @param options.clients {number}
 * @param options.durationSeconds {number}
 * @param options.deleteRoundSize {number}
 * @param options.was {RequestingClient}
 * @param options.path {string}
 * @param options.collection {object} a minimal `Collection`-shaped dependency:
 *   just the write this needs to refill the Resources it is about to delete
 * @returns {Promise<Measurement>}
 */
export async function deleteLoad({
  clients,
  durationSeconds,
  deleteRoundSize,
  was,
  path,
  collection
}: {
  clients: number
  durationSeconds: number
  deleteRoundSize: number
  was: RequestingClient
  path: string
  collection: { put(resourceId: string, data: unknown): Promise<unknown> }
}): Promise<Measurement> {
  const idsOf = (worker: number) =>
    Array.from(
      { length: deleteRoundSize },
      (_unused, index) => `del-${worker}-${index}`
    )
  const workers = workerIndexes(clients)
  const tally = new Tally()
  const timedMs = await timedRounds({
    durationSeconds,
    round: async () => {
      await Promise.all(
        workers.map(worker =>
          Promise.all(
            idsOf(worker).map(id => collection.put(id, { resourceId: id }))
          )
        )
      )
      const started = performance.now()
      await Promise.all(
        workers.map(async worker => {
          for (const id of idsOf(worker)) {
            await tally.time(() =>
              was.request({ path: `${path}/${id}`, method: 'DELETE' })
            )
          }
        })
      )
      return performance.now() - started
    }
  })
  return tally.measurement(timedMs)
}

/**
 * Timed creates with an untimed cleanup, from `clients` concurrent clients,
 * in rounds: each round every client runs `create` once (timed, together),
 * then `remove` for what it created (untimed). Rounds repeat until the timed
 * part reaches `durationSeconds`, so the stored data never grows past one
 * round's worth, however large each create is. A failed create counts as a
 * failure and is not removed.
 * @param options {object}
 * @param options.clients {number}
 * @param options.durationSeconds {number}
 * @param options.create {(worker: number, round: number) => Promise<unknown>}
 * @param options.remove {(worker: number, round: number) => Promise<unknown>}
 * @returns {Promise<Measurement>}
 */
export async function createDeleteLoad({
  clients,
  durationSeconds,
  create,
  remove
}: {
  clients: number
  durationSeconds: number
  create: (worker: number, round: number) => Promise<unknown>
  remove: (worker: number, round: number) => Promise<unknown>
}): Promise<Measurement> {
  const workers = workerIndexes(clients)
  const tally = new Tally()
  const timedMs = await timedRounds({
    durationSeconds,
    round: async round => {
      const created: number[] = []
      const started = performance.now()
      await Promise.all(
        workers.map(async worker => {
          if (await tally.time(() => create(worker, round))) {
            created.push(worker)
          }
        })
      )
      const elapsedMs = performance.now() - started
      await Promise.all(
        created.map(worker => remove(worker, round).catch(() => undefined))
      )
      return elapsedMs
    }
  })
  return tally.measurement(timedMs)
}

/**
 * One client writing `serialWrites` new Resources in a row, after
 * `warmUpWrites` untimed warm-up writes.
 * @param options {object}
 * @param options.was {RequestingClient}
 * @param options.path {string}
 * @param options.warmUpWrites {number}
 * @param options.serialWrites {number}
 * @returns {Promise<Measurement>}
 */
export async function serialWriteLoad({
  was,
  path,
  warmUpWrites,
  serialWrites
}: {
  was: RequestingClient
  path: string
  warmUpWrites: number
  serialWrites: number
}): Promise<Measurement> {
  for (let index = 0; index < warmUpWrites; index++) {
    await was.request({
      path: `${path}/warm-${index}`,
      method: 'PUT',
      json: { index }
    })
  }
  const tally = new Tally()
  const started = performance.now()
  for (let index = 0; index < serialWrites; index++) {
    await tally.time(() =>
      was.request({
        path: `${path}/s-${index}`,
        method: 'PUT',
        json: { index }
      })
    )
  }
  return tally.measurement(performance.now() - started)
}

/**
 * Writes one Resource per id directly through the backend, several at a
 * time, under `createdBy`.
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.ids {string[]}
 * @param options.createdBy {`did:${string}`}
 * @returns {Promise<void>}
 */
async function fillThroughBackend({
  backend,
  spaceId,
  collectionId,
  ids,
  createdBy
}: {
  backend: StorageBackend
  spaceId: string
  collectionId: string
  ids: string[]
  createdBy: `did:${string}`
}): Promise<void> {
  await fillConcurrently({
    ids,
    concurrency: seedConcurrency,
    write: id =>
      backend.writeResource({
        spaceId,
        collectionId,
        resourceId: id,
        input: {
          kind: 'json',
          contentType: 'application/json',
          data: credential(id)
        },
        createdBy
      })
  })
}

/**
 * Creates one Space with one Collection, filled to `size`, directly through
 * the backend.
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.size {number}
 * @param options.controller {`did:${string}`}
 * @param options.makePublic {boolean}
 * @returns {Promise<void>}
 */
async function seedSpaceThroughBackend({
  backend,
  spaceId,
  collectionId,
  size,
  controller,
  makePublic
}: {
  backend: StorageBackend
  spaceId: string
  collectionId: string
  size: number
  controller: `did:${string}`
  makePublic: boolean
}): Promise<void> {
  await backend.writeSpace({
    spaceId,
    spaceMetadata: { id: spaceId, type: ['Space'], controller },
    createdBy: controller
  })
  await backend.writeCollection({
    spaceId,
    collectionId,
    collectionMetadata: { id: collectionId, type: ['Collection'] },
    createdBy: controller
  })
  await fillThroughBackend({
    backend,
    spaceId,
    collectionId,
    ids: itemIds(size),
    createdBy: controller
  })
  if (makePublic) {
    await backend.writePolicy({
      spaceId,
      collectionId,
      policy: { type: 'PublicCanRead' }
    })
  }
}

/**
 * Seeds, directly through `backend`, every Collection-size Space the runners
 * test, under the fixed ids `seededTargets` (in `perf-runner.ts`) reads back:
 * a `perf-public` Space (one public Collection per size), a `perf-private`
 * Space (one private Collection per size), and three Spaces per edge size
 * (`perf-write-<size>`, `perf-delete-<size>`, `perf-serial-<size>`), each
 * with a single `items` Collection. Every record is written under
 * `controller`, which is what a real signed write over HTTP would have
 * produced: `createdBy` and `controller` match what the request handlers set
 * from `invokerDid(request)`.
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @param options.controller {`did:${string}`}
 * @returns {Promise<void>}
 */
export async function seedSizeSpaces({
  backend,
  sizes,
  edgeSizes,
  controller
}: {
  backend: StorageBackend
  sizes: number[]
  edgeSizes: number[]
  controller: `did:${string}`
}): Promise<void> {
  for (const size of sizes) {
    for (const [spaceId, makePublic] of [
      ['perf-public', true],
      ['perf-private', false]
    ] as const) {
      await seedSpaceThroughBackend({
        backend,
        spaceId,
        collectionId: `c-${size}`,
        size,
        controller,
        makePublic
      })
    }
  }
  for (const size of edgeSizes) {
    for (const label of Object.values(edgeSpaceLabels)) {
      await seedSpaceThroughBackend({
        backend,
        spaceId: `${label}-${size}`,
        collectionId: 'items',
        size,
        controller,
        makePublic: false
      })
    }
  }
}
