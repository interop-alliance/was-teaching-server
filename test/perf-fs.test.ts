/**
 * Tests for the pure/injectable-dependency logic behind `pnpm perf:fs`
 * (`scripts/performance/perf-lib.ts`): CLI argument parsing, the run-length estimate,
 * the Markdown table formatting, and the three load-aggregation harnesses.
 * The subprocess/k6/WasClient wiring itself is verified by running
 * `pnpm perf:fs` once end to end, not by unit tests.
 */
import { describe, it } from 'vitest'
import assert from 'node:assert'
import {
  deleteLoad,
  estimateMinutes,
  formatMachine,
  formatPivotedTable,
  formatProgressLine,
  formatScalingSummary,
  load,
  parseSizes,
  pivotRows,
  positiveInteger,
  serialWriteLoad
} from '../scripts/performance/perf-lib.js'

describe('positiveInteger', () => {
  it('parses a valid positive integer string', () => {
    assert.equal(positiveInteger('5'), 5)
  })

  it('rejects a non-numeric value', () => {
    assert.throws(() => positiveInteger('abc'), /positive integer/)
  })

  it('rejects zero', () => {
    assert.throws(() => positiveInteger('0'), /positive integer/)
  })

  it('rejects a non-integer value', () => {
    assert.throws(() => positiveInteger('1.5'), /positive integer/)
  })
})

describe('parseSizes', () => {
  it('dedups and sorts, with edgeSizes as the smallest and largest', () => {
    assert.deepEqual(parseSizes('500,1,500,2000'), {
      sizes: [1, 500, 2000],
      edgeSizes: [1, 2000]
    })
  })

  it('treats a single size as its own only edge', () => {
    assert.deepEqual(parseSizes('500'), {
      sizes: [500],
      edgeSizes: [500]
    })
  })

  it('treats two sizes as both edges, with no middle', () => {
    assert.deepEqual(parseSizes('500,1'), {
      sizes: [1, 500],
      edgeSizes: [1, 500]
    })
  })
})

describe('formatProgressLine', () => {
  it('formats a completed measurement with thousands separators and fixed decimals', () => {
    assert.equal(
      formatProgressLine({
        test: 'Signed read',
        size: 2000,
        result: { rate: 812.34, avgMs: 6.149, failed: 0 }
      }),
      'Signed read (size 2,000): 812.3 req/s, 6.15 ms avg, 0 failed'
    )
  })

  it('formats a skipped line (no k6) with just the skip reason', () => {
    assert.equal(
      formatProgressLine({
        test: 'Public read',
        size: 1,
        result: 'skipped (no k6)'
      }),
      'Public read (size 1): skipped (no k6)'
    )
  })

  it('shows n/a for average latency when every call failed', () => {
    assert.equal(
      formatProgressLine({
        test: 'Signed write',
        size: 1,
        result: { rate: 0, avgMs: undefined, failed: 5 }
      }),
      'Signed write (size 1): 0.0 req/s, n/a ms avg, 5 failed'
    )
  })
})

describe('load', () => {
  it('reports a positive rate and zero failures when every call succeeds', async () => {
    const result = await load({
      clients: 2,
      durationSeconds: 0.05,
      op: async () => {}
    })
    assert.ok(result.rate > 0, `expected a positive rate, got ${result.rate}`)
    assert.equal(result.failed, 0)
    assert.ok(result.avgMs !== undefined && result.avgMs >= 0)
  })

  it('counts every call as a failure and reports no average latency when all fail', async () => {
    const result = await load({
      clients: 1,
      durationSeconds: 0.02,
      op: async () => {
        throw new Error('simulated failure')
      }
    })
    assert.ok(
      result.failed > 0,
      `expected at least one failure, got ${result.failed}`
    )
    assert.equal(result.rate, 0)
    assert.equal(result.avgMs, undefined)
  })
})

describe('estimateMinutes', () => {
  const base = {
    sizes: [1, 500],
    edgeSizes: [1, 500],
    durationSeconds: 10,
    serialWrites: 100,
    warmUpWrites: 20,
    pauseMs: 2_000,
    filling: true
  }

  it('returns a positive integer number of minutes', () => {
    const minutes = estimateMinutes({ ...base, withK6: true })
    assert.ok(Number.isInteger(minutes), `expected an integer, got ${minutes}`)
    assert.ok(minutes > 0, `expected a positive estimate, got ${minutes}`)
  })

  it('increases when the load tests run longer', () => {
    const shorter = estimateMinutes({
      ...base,
      durationSeconds: 10,
      withK6: true
    })
    const longer = estimateMinutes({
      ...base,
      durationSeconds: 100,
      withK6: true
    })
    assert.ok(
      longer > shorter,
      `expected a longer duration to raise the estimate, got ${shorter} then ${longer}`
    )
  })

  it('leaves out the fill time when a seed dir supplies the Collections', () => {
    const seeded = estimateMinutes({ ...base, withK6: true, filling: false })
    const filled = estimateMinutes({ ...base, withK6: true, filling: true })
    assert.ok(
      seeded <= filled,
      `expected a seeded run to estimate no longer, got ${seeded} vs ${filled}`
    )
    const large = { ...base, sizes: [1, 20000], edgeSizes: [1, 20000] }
    assert.ok(
      estimateMinutes({ ...large, withK6: true, filling: false }) <
        estimateMinutes({ ...large, withK6: true, filling: true }),
      'expected the fill of large Collections to raise the unseeded estimate'
    )
  })

  it('increases when there are more/larger Collection sizes to fill', () => {
    const fewer = estimateMinutes({
      ...base,
      sizes: [1],
      edgeSizes: [1],
      withK6: true
    })
    const more = estimateMinutes({
      ...base,
      sizes: [1, 500, 20000],
      edgeSizes: [1, 20000],
      withK6: true
    })
    assert.ok(
      more > fewer,
      `expected more/larger sizes to raise the estimate, got ${fewer} then ${more}`
    )
  })

  it('counts the extra k6 load tests when k6 is available', () => {
    const withoutK6 = estimateMinutes({ ...base, withK6: false })
    const withK6 = estimateMinutes({ ...base, withK6: true })
    assert.ok(
      withK6 >= withoutK6,
      `expected k6 to not lower the estimate, got ${withoutK6} then ${withK6}`
    )
  })
})

describe('deleteLoad', () => {
  it('refills before deleting each round, and reports zero failures when every call succeeds', async () => {
    const calls: string[] = []
    const result = await deleteLoad({
      clients: 1,
      durationSeconds: 0.02,
      deleteRoundSize: 2,
      path: '/space/s/c',
      collection: {
        put: async () => {
          calls.push('put')
        }
      },
      was: {
        request: async () => {
          calls.push('request')
        }
      }
    })
    assert.ok(result.rate > 0, `expected a positive rate, got ${result.rate}`)
    assert.equal(result.failed, 0)
    assert.ok(result.avgMs !== undefined && result.avgMs >= 0)
    assert.ok(
      calls.length >= 4,
      `expected at least one full round, got ${calls.length} calls`
    )
    assert.deepEqual(
      calls.slice(0, 4),
      ['put', 'put', 'request', 'request'],
      'expected both refill puts before either timed delete'
    )
  })

  it('counts a failed delete without failing the refill', async () => {
    const result = await deleteLoad({
      clients: 1,
      durationSeconds: 0.02,
      deleteRoundSize: 1,
      path: '/space/s/c',
      collection: { put: async () => {} },
      was: {
        request: async () => {
          throw new Error('simulated failure')
        }
      }
    })
    assert.ok(
      result.failed > 0,
      `expected at least one failure, got ${result.failed}`
    )
    assert.equal(result.rate, 0)
    assert.equal(result.avgMs, undefined)
  })
})

describe('serialWriteLoad', () => {
  it('runs warm-up writes before the timed writes, untimed', async () => {
    const paths: string[] = []
    const result = await serialWriteLoad({
      path: '/space/s/c',
      warmUpWrites: 2,
      serialWrites: 3,
      was: {
        request: async ({ path }) => {
          paths.push(path)
        }
      }
    })
    assert.equal(result.failed, 0)
    assert.ok(result.rate > 0, `expected a positive rate, got ${result.rate}`)
    assert.deepEqual(paths, [
      '/space/s/c/warm-0',
      '/space/s/c/warm-1',
      '/space/s/c/s-0',
      '/space/s/c/s-1',
      '/space/s/c/s-2'
    ])
  })

  it('counts a failed write and keeps writing the remaining ones', async () => {
    let timedCalls = 0
    const result = await serialWriteLoad({
      path: '/space/s/c',
      warmUpWrites: 0,
      serialWrites: 3,
      was: {
        request: async () => {
          timedCalls++
          if (timedCalls === 2) {
            throw new Error('simulated failure')
          }
        }
      }
    })
    assert.equal(timedCalls, 3, 'expected all 3 writes to be attempted')
    assert.equal(result.failed, 1)
  })
})

describe('formatMachine', () => {
  it('formats the CPU model, core count, and RAM in GB', () => {
    assert.equal(
      formatMachine({
        cpuModel: 'Apple M3 Pro',
        cores: 12,
        totalMemoryBytes: 12.34 * 1024 ** 3
      }),
      'Apple M3 Pro, 12 cores, 12.3 GB RAM'
    )
  })

  it('formats an exact whole number of GB with one decimal place', () => {
    assert.equal(
      formatMachine({
        cpuModel: 'Intel(R) Core(TM) i7',
        cores: 8,
        totalMemoryBytes: 16 * 1024 ** 3
      }),
      'Intel(R) Core(TM) i7, 8 cores, 16.0 GB RAM'
    )
  })
})

describe('pivotRows', () => {
  it('groups rows by test, in first-seen order, one cell per size', () => {
    const rows = [
      {
        test: 'Public read',
        size: 1,
        result: { rate: 1034.3, avgMs: 4.81, failed: 0 }
      },
      {
        test: 'Signed write',
        size: 1,
        result: { rate: 33.8, avgMs: 147.15, failed: 0 }
      },
      {
        test: 'Public read',
        size: 500,
        result: { rate: 1038.1, avgMs: 4.79, failed: 0 }
      },
      {
        test: 'Signed write',
        size: 500,
        result: { rate: 35.0, avgMs: 142.22, failed: 0 }
      }
    ]
    const pivoted = pivotRows({ sizes: [1, 500], rows })
    assert.equal(pivoted.length, 2)
    assert.equal(pivoted[0]!.test, 'Public read')
    assert.deepEqual(pivoted[0]!.cells, [rows[0]!.result, rows[2]!.result])
    assert.equal(pivoted[1]!.test, 'Signed write')
    assert.deepEqual(pivoted[1]!.cells, [rows[1]!.result, rows[3]!.result])
  })

  it('leaves a gap (undefined) for a size a test was not run at', () => {
    const rows = [
      {
        test: 'Signed delete',
        size: 1,
        result: { rate: 46.9, avgMs: 104.44, failed: 0 }
      },
      {
        test: 'Signed delete',
        size: 2000,
        result: { rate: 40.1, avgMs: 120.0, failed: 0 }
      }
    ]
    const pivoted = pivotRows({ sizes: [1, 500, 2000], rows })
    assert.deepEqual(pivoted[0]!.cells, [
      rows[0]!.result,
      undefined,
      rows[1]!.result
    ])
  })
})

describe('formatPivotedTable', () => {
  it('renders one column per size, with a req/s + avg ms cell', () => {
    const pivoted = [
      {
        test: 'Public read',
        cells: [
          { rate: 1034.3, avgMs: 4.81, failed: 0 },
          { rate: 1038.1, avgMs: 4.79, failed: 0 }
        ]
      }
    ]
    assert.equal(
      formatPivotedTable({ sizes: [1, 500], pivoted }),
      [
        '| Test | size 1 | size 500 |',
        '|---|---:|---:|',
        '| Public read | 1,034.3 req/s (4.81 ms) | 1,038.1 req/s (4.79 ms) |'
      ].join('\n')
    )
  })

  it('renders -- for a gap and the skip string for a skipped cell', () => {
    const pivoted = [
      {
        test: 'Signed delete',
        cells: [{ rate: 46.9, avgMs: 104.44, failed: 0 }, undefined]
      },
      { test: 'Public read', cells: ['skipped (no k6)', 'skipped (no k6)'] }
    ]
    assert.equal(
      formatPivotedTable({ sizes: [1, 500], pivoted }),
      [
        '| Test | size 1 | size 500 |',
        '|---|---:|---:|',
        '| Signed delete | 46.9 req/s (104.44 ms) | -- |',
        '| Public read | skipped (no k6) | skipped (no k6) |'
      ].join('\n')
    )
  })
})

describe('formatScalingSummary', () => {
  it('reports the steepest drop first, bundles flat tests, and reports no failures', () => {
    const pivoted = [
      {
        test: 'Public read',
        cells: [
          { rate: 1034.3, avgMs: 4.81, failed: 0 },
          { rate: 1038.1, avgMs: 4.79, failed: 0 }
        ]
      },
      {
        test: 'Public list',
        cells: [
          { rate: 1263.2, avgMs: 3.93, failed: 0 },
          { rate: 40.5, avgMs: 123.5, failed: 0 }
        ]
      },
      {
        test: 'Signed read',
        cells: [
          { rate: 826.2, avgMs: 6.05, failed: 0 },
          { rate: 816.2, avgMs: 6.13, failed: 0 }
        ]
      }
    ]
    const lines = formatScalingSummary({ sizes: [1, 500], pivoted })
    assert.equal(lines[0], 'Smallest size (1) to largest (500):')
    assert.ok(
      lines[1]!.startsWith('- Public list:'),
      `expected the steepest drop first, got: ${lines[1]}`
    )
    assert.ok(
      lines[1]!.includes('31.2x slower'),
      `expected a 31.2x factor, got: ${lines[1]}`
    )
    assert.ok(
      lines.some(
        line =>
          line.includes('Public read') &&
          line.includes('Signed read') &&
          line.includes('roughly flat')
      ),
      `expected flat tests bundled into one line, got: ${JSON.stringify(lines)}`
    )
    assert.equal(lines.at(-1), 'Failures: none')
  })

  it('reports a failure line naming the test and size when any cell failed', () => {
    const pivoted = [
      {
        test: 'Signed write',
        cells: [
          { rate: 33.8, avgMs: 147.15, failed: 0 },
          { rate: 35.0, avgMs: 142.22, failed: 2 }
        ]
      }
    ]
    const lines = formatScalingSummary({ sizes: [1, 500], pivoted })
    assert.ok(
      lines.at(-1)?.includes('Signed write') &&
        lines.at(-1)?.includes('size 500') &&
        lines.at(-1)?.includes('2 failed'),
      `expected a failure line naming the test, size, and count, got: ${lines.at(-1)}`
    )
  })

  it('skips a test from the scaling comparison when an endpoint was skipped (no k6)', () => {
    const pivoted = [
      { test: 'Public read', cells: ['skipped (no k6)', 'skipped (no k6)'] }
    ]
    const lines = formatScalingSummary({ sizes: [1, 500], pivoted })
    assert.ok(
      !lines.some(line => line.includes('Public read')),
      `expected the skipped test to be left out entirely, got: ${JSON.stringify(lines)}`
    )
  })
})
