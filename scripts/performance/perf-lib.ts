/**
 * Pure and injectable-dependency logic shared by `pnpm perf:fs` and
 * `pnpm perf:pg` (`perf-fs.ts`, `perf-pg.ts`) and their seed scripts: CLI
 * argument parsing, the run-length estimate, the Markdown table formatting,
 * and the three load-aggregation harnesses. Kept
 * free of side effects at import time so it can be unit tested without
 * spawning a server, k6, or any network request.
 */

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
 * One pivoted cell as it reads in the table: the skip string as-is, `--` for
 * a gap, or `<rate> req/s (<avg> ms)`.
 * @param cell {Measurement | string | undefined}
 * @returns {string}
 */
function formatCell(cell: Measurement | string | undefined): string {
  if (cell === undefined) {
    return '--'
  }
  if (typeof cell === 'string') {
    return cell
  }
  const avg = cell.avgMs === undefined ? 'n/a' : formatNumber(cell.avgMs, 2)
  return `${formatNumber(cell.rate, 1)} req/s (${avg} ms)`
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
    ({ test, cells }) => `| ${test} | ${cells.map(formatCell).join(' | ')} |`
  )
  return [header, divider, ...body].join('\n')
}

/** How close a largest/smallest rate ratio has to be to 1 to read as flat. */
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
  filling
}: {
  sizes: number[]
  edgeSizes: number[]
  durationSeconds: number
  serialWrites: number
  warmUpWrites: number
  pauseMs: number
  withK6: boolean
  filling: boolean
}): number {
  const writesPerSecond = 25
  const sum = (values: number[]) =>
    values.reduce((total, value) => total + value, 0)
  const filled = filling ? 2 * sum(sizes) + 3 * sum(edgeSizes) : 0
  const loadTests =
    (withK6 ? 2 * sizes.length : 0) + sizes.length + 2 * edgeSizes.length
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
    pauseSeconds
  return Math.ceil(seconds / 60)
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
  let completed = 0
  let failed = 0
  let totalMs = 0
  const started = performance.now()
  const deadline = started + durationSeconds * 1000
  await Promise.all(
    Array.from({ length: clients }, async (_unused, worker) => {
      for (let count = 0; performance.now() < deadline; count++) {
        const sent = performance.now()
        try {
          await op(worker, count)
          completed++
          totalMs += performance.now() - sent
        } catch {
          failed++
        }
      }
    })
  )
  const elapsedSeconds = (performance.now() - started) / 1000
  return {
    rate: completed / elapsedSeconds,
    avgMs: completed ? totalMs / completed : undefined,
    failed
  }
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
  const workers = Array.from({ length: clients }, (_unused, worker) => worker)
  let completed = 0
  let failed = 0
  let totalMs = 0
  let timedMs = 0
  while (timedMs < durationSeconds * 1000) {
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
          const sent = performance.now()
          try {
            await was.request({ path: `${path}/${id}`, method: 'DELETE' })
            completed++
            totalMs += performance.now() - sent
          } catch {
            failed++
          }
        }
      })
    )
    timedMs += performance.now() - started
  }
  return {
    rate: completed / (timedMs / 1000),
    avgMs: completed ? totalMs / completed : undefined,
    failed
  }
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
  let completed = 0
  let failed = 0
  let totalMs = 0
  const started = performance.now()
  for (let index = 0; index < serialWrites; index++) {
    const requestStarted = performance.now()
    try {
      await was.request({
        path: `${path}/s-${index}`,
        method: 'PUT',
        json: { index }
      })
      completed++
      totalMs += performance.now() - requestStarted
    } catch {
      failed++
    }
  }
  const elapsedMs = performance.now() - started
  return {
    rate: completed / (elapsedMs / 1000),
    avgMs: completed ? totalMs / completed : undefined,
    failed
  }
}
