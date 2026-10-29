/**
 * Tests for the pure/injectable-dependency logic behind `pnpm perf:fs`,
 * `pnpm perf:pg` and `pnpm perf:remote` (`scripts/performance/perf-lib.ts`):
 * CLI argument parsing, the backend split and its Collection pool, the
 * run-length estimate, the Markdown table formatting, the load-aggregation
 * harnesses, the network-fault retry and error description, and the parts of
 * a run record. The subprocess/k6/WasClient wiring itself is
 * verified by running `pnpm perf:fs` once end to end, not by unit tests.
 */
import { describe, it } from 'vitest'
import assert from 'node:assert'
import {
  backendCell,
  backendPool,
  collectionBackend,
  createDeleteLoad,
  deleteLoad,
  describeError,
  describePool,
  estimateMinutes,
  formatMachine,
  formatMatrixTable,
  formatPivotedTable,
  formatProgressLine,
  formatRetries,
  formatScalingSummary,
  healthBuild,
  k6Measurement,
  load,
  missingBackends,
  parseLoadSettings,
  parseRunner,
  parseSizes,
  parseSplit,
  pivotRows,
  positiveInteger,
  recordPath,
  retriedFaultCounts,
  retryOnNetworkFault,
  nonNegativeInteger,
  runResults,
  seedResourceCount,
  serialWriteLoad,
  sizeTestId
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

describe('nonNegativeInteger', () => {
  it('accepts zero', () => {
    assert.equal(nonNegativeInteger('0'), 0)
  })

  it('rejects a negative value', () => {
    assert.throws(() => nonNegativeInteger('-1'), /non-negative integer/)
  })

  it('rejects a blank value', () => {
    assert.throws(() => nonNegativeInteger(' '), /non-negative integer/)
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
      pool: [{}],
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
      pool: [{}],
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

  it('sends successive requests to successive pool members, and measures each backend', async () => {
    const sent: string[] = []
    const result = await load({
      clients: 2,
      durationSeconds: 0.05,
      pool: [
        { name: 'a', backend: 'postgres' as const },
        { name: 'b', backend: 'fs' as const }
      ],
      op: async ({ name }) => {
        sent.push(name)
      }
    })
    assert.ok(sent.length > 2, `expected several requests, got ${sent.length}`)
    sent.forEach((name, index) =>
      assert.equal(name, index % 2 === 0 ? 'a' : 'b', `request ${index}`)
    )
    const { postgres, fs } = result.byBackend ?? {}
    assert.ok(postgres && fs, 'expected a part for each backend')
    assert.ok(
      Math.abs(postgres.rate + fs.rate - result.rate) < 1e-9 * result.rate,
      "expected the backends' rates to add up to the combined rate"
    )
  })

  it('reports no backend parts when no pool member names a backend', async () => {
    const result = await load({
      clients: 1,
      durationSeconds: 0.01,
      pool: [{}, {}],
      op: async () => {}
    })
    assert.equal(result.byBackend, undefined)
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

  it('grows with the pool, since every pool member is filled', () => {
    const one = estimateMinutes({ ...base, withK6: true })
    const two = estimateMinutes({ ...base, withK6: true, poolSize: 2 })
    assert.ok(two > one, `expected ${two} > ${one}`)
  })
})

describe('deleteLoad', () => {
  it('refills before deleting each round, and reports zero failures when every call succeeds', async () => {
    const calls: string[] = []
    const result = await deleteLoad({
      clients: 1,
      durationSeconds: 0.02,
      deleteRoundSize: 2,
      pool: [
        {
          path: '/space/s/c',
          collection: {
            put: async () => {
              calls.push('put')
            }
          }
        }
      ],
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
      pool: [{ path: '/space/s/c', collection: { put: async () => {} } }],
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

  it('refills each Resource in the pool member its delete goes to', async () => {
    const puts: string[] = []
    const deletes: string[] = []
    const member = (path: string, backend: 'fs' | 'postgres') => ({
      path,
      backend,
      collection: {
        put: async (id: string) => {
          puts.push(`${path}/${id}`)
        }
      }
    })
    const result = await deleteLoad({
      clients: 1,
      durationSeconds: 0.02,
      deleteRoundSize: 4,
      pool: [member('/a', 'postgres'), member('/b', 'fs')],
      was: {
        request: async ({ path }) => {
          deletes.push(path)
        }
      }
    })
    const firstRound = ['/a/del-0-0', '/b/del-0-1', '/a/del-0-2', '/b/del-0-3']
    assert.deepEqual(puts.slice(0, 4), firstRound)
    assert.deepEqual(deletes.slice(0, 4), firstRound)
    assert.ok(result.byBackend?.postgres && result.byBackend.fs)
  })
})

describe('serialWriteLoad', () => {
  it('runs warm-up writes before the timed writes, untimed', async () => {
    const paths: string[] = []
    const result = await serialWriteLoad({
      pool: [{ path: '/space/s/c' }],
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
      pool: [{ path: '/space/s/c' }],
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

  it('rotates writes over the pool, the warm-up writes too', async () => {
    const paths: string[] = []
    const result = await serialWriteLoad({
      pool: [
        { path: '/a', backend: 'postgres' },
        { path: '/b', backend: 'fs' }
      ],
      warmUpWrites: 2,
      serialWrites: 3,
      was: {
        request: async ({ path }) => {
          paths.push(path)
        }
      }
    })
    assert.deepEqual(paths, [
      '/a/warm-0',
      '/b/warm-1',
      '/a/s-0',
      '/b/s-1',
      '/a/s-2'
    ])
    assert.ok(result.byBackend?.postgres && result.byBackend.fs)
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

describe('retryOnNetworkFault', () => {
  /**
   * An error shaped like ky's `TimeoutError`.
   * @returns {Error}
   */
  function timeoutError(): Error {
    const err = new Error('Request timed out.')
    err.name = 'TimeoutError'
    return err
  }

  it('runs the write again after a timeout, and returns its result', async () => {
    let calls = 0
    const result = await retryOnNetworkFault({
      op: async () => {
        calls++
        if (calls === 1) {
          throw timeoutError()
        }
        return 'stored'
      }
    })
    assert.equal(result, 'stored')
    assert.equal(calls, 2)
  })

  it('throws the timeout once every attempt timed out', async () => {
    let calls = 0
    await assert.rejects(
      retryOnNetworkFault({
        attempts: 3,
        op: async () => {
          calls++
          throw timeoutError()
        }
      }),
      { name: 'TimeoutError' }
    )
    assert.equal(calls, 3)
  })

  it('does not retry any other error', async () => {
    let calls = 0
    await assert.rejects(
      retryOnNetworkFault({
        op: async () => {
          calls++
          throw new Error('403 Forbidden')
        }
      }),
      /403/
    )
    assert.equal(calls, 1)
  })
  /**
   * The error was-client throws for a connection that never opened: its own
   * `WasError`, wrapping undici's `fetch failed`, wrapping the connect timeout.
   * @returns {Error}
   */
  function unopenedError(): Error {
    const connectTimeout = Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT'
    })
    const fetchFailed = new TypeError('fetch failed', { cause: connectTimeout })
    return Object.assign(new Error('fetch failed', { cause: fetchFailed }), {
      name: 'WasError'
    })
  }

  it("finds a timeout along the cause chain of was-client's WasError", async () => {
    let calls = 0
    const result = await retryOnNetworkFault({
      op: async () => {
        calls++
        if (calls === 1) {
          throw Object.assign(
            new Error('Request timed out.', { cause: timeoutError() }),
            { name: 'WasError' }
          )
        }
        return 'stored'
      }
    })
    assert.equal(result, 'stored')
    assert.equal(calls, 2)
  })

  it('runs a request whose connection never opened again, up to 8 times in all', async () => {
    let calls = 0
    const result = await retryOnNetworkFault({
      op: async () => {
        calls++
        if (calls < 8) {
          throw unopenedError()
        }
        return 'stored'
      }
    })
    assert.equal(result, 'stored')
    assert.equal(calls, 8)
  })

  it('throws once a connection failed to open 8 times', async () => {
    let calls = 0
    await assert.rejects(
      retryOnNetworkFault({
        op: async () => {
          calls++
          throw unopenedError()
        }
      }),
      { name: 'WasError' }
    )
    assert.equal(calls, 8)
  })

  it('runs a request whose connection closed partway through the response again', async () => {
    let calls = 0
    const result = await retryOnNetworkFault({
      op: async () => {
        calls++
        if (calls === 1) {
          throw terminatedError()
        }
        if (calls === 2) {
          throw Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET'
          })
        }
        return 'stored'
      }
    })
    assert.equal(result, 'stored')
    assert.equal(calls, 3)
  })

  it('counts each retry by its fault, and nothing for an error it throws', async () => {
    const before = retriedFaultCounts()
    const faults = [timeoutError(), unopenedError(), terminatedError()]
    await retryOnNetworkFault({
      op: async () => {
        const fault = faults.shift()
        if (fault !== undefined) {
          throw fault
        }
        return 'stored'
      }
    })
    await assert.rejects(
      retryOnNetworkFault({
        op: async () => {
          throw new Error('403 Forbidden')
        }
      })
    )
    const after = retriedFaultCounts()
    for (const fault of ['timed out', 'never connected', 'dropped'] as const) {
      assert.equal(
        (after.get(fault) ?? 0) - (before.get(fault) ?? 0),
        1,
        `expected one more "${fault}" retry`
      )
    }
  })
})

describe('formatRetries', () => {
  it('is none when nothing was retried', () => {
    assert.equal(formatRetries(new Map()), 'none')
  })

  it("gives the total and each fault's share, in a fixed order, leaving out a fault never retried", () => {
    const counts = new Map([
      ['dropped', 2],
      ['timed out', 21],
      ['never connected', 0]
    ] as const)
    assert.equal(formatRetries(counts), '23 (21 timed out, 2 dropped)')
  })
})

/**
 * The error was-client throws for a connection the other side closed after
 * the response headers arrived: its own `WasError`, wrapping undici's
 * `terminated`, wrapping the socket error, with the URL http-client records.
 * @returns {Error}
 */
function terminatedError(): Error {
  const socketError = Object.assign(new Error('other side closed'), {
    name: 'SocketError',
    code: 'UND_ERR_SOCKET'
  })
  const terminated = new TypeError('terminated', { cause: socketError })
  return Object.assign(new Error('terminated', { cause: terminated }), {
    name: 'WasError',
    requestUrl: 'https://host.example/space/s1/items/vc-4'
  })
}

describe('describeError', () => {
  it("adds the cause chain's messages and codes, and the URL requested", () => {
    assert.equal(
      describeError(terminatedError()),
      'terminated (other side closed, UND_ERR_SOCKET) requesting ' +
        '"https://host.example/space/s1/items/vc-4"'
    )
  })

  it('leaves out a URL the message already names', () => {
    const url = 'https://host.example/space/s1/items/vc-4'
    const err = Object.assign(new Error(`Request to "${url}" timed out.`), {
      requestUrl: url
    })
    assert.equal(describeError(err), `Request to "${url}" timed out.`)
  })

  it('is the message alone for an error with no cause', () => {
    assert.equal(describeError(new Error('403 Forbidden')), '403 Forbidden')
  })

  it('describes a thrown value that is not an error', () => {
    assert.equal(describeError('boom'), 'boom')
  })
})

describe('parseLoadSettings', () => {
  const values = { clients: '5', duration: '10', writes: '100' }

  it('runs the 10 MiB tests with every client unless capped', () => {
    assert.equal(parseLoadSettings(values).largeFileClients, 5)
  })

  it("takes --large-file-clients as the 10 MiB tests' client count", () => {
    assert.equal(
      parseLoadSettings({ ...values, 'large-file-clients': '2' })
        .largeFileClients,
      2
    )
  })

  it('rejects a --large-file-clients that is not a positive integer', () => {
    assert.throws(
      () => parseLoadSettings({ ...values, 'large-file-clients': '0' }),
      /positive integer/
    )
  })
})

describe('parseSplit', () => {
  it("parses each backend's percent, in the order given", () => {
    assert.deepEqual(parseSplit('postgres=30, fs=70'), [
      { backend: 'postgres', percent: 30 },
      { backend: 'fs', percent: 70 }
    ])
  })

  it('rejects percents that do not add up to 100', () => {
    assert.throws(() => parseSplit('fs=60,postgres=30'), /add up to 90/)
  })

  it('rejects a backend that is not a server backend id', () => {
    assert.throws(() => parseSplit('default=100'), /Unknown --split entry/)
  })

  it('rejects a backend named twice', () => {
    assert.throws(() => parseSplit('fs=50,fs=50'), /twice/)
  })

  it('rejects a zero percent', () => {
    assert.throws(() => parseSplit('fs=0,postgres=100'), /positive integer/)
  })

  it('rejects a split that needs more than 20 Collections per test', () => {
    assert.throws(
      () => parseSplit('fs=33,postgres=67'),
      /needs 100 Collections per test/
    )
  })
})

describe('backendPool', () => {
  it('is one member on the default backend, with no suffix, with no split', () => {
    assert.deepEqual(backendPool(), [{ suffix: '' }])
  })

  it('is one member per backend for an even split', () => {
    assert.deepEqual(backendPool(parseSplit('postgres=50,fs=50')), [
      { backend: 'postgres', suffix: '-postgres-0' },
      { backend: 'fs', suffix: '-fs-0' }
    ])
  })

  it("is the smallest pool that realizes the split, each backend's members spaced through it", () => {
    assert.deepEqual(
      backendPool(parseSplit('postgres=30,fs=70')).map(({ suffix }) => suffix),
      [
        '-fs-0',
        '-postgres-0',
        '-fs-1',
        '-fs-2',
        '-postgres-1',
        '-fs-3',
        '-fs-4',
        '-fs-5',
        '-postgres-2',
        '-fs-6'
      ]
    )
  })

  it('is one member for a single backend', () => {
    assert.deepEqual(backendPool(parseSplit('fs=100')), [
      { backend: 'fs', suffix: '-fs-0' }
    ])
  })
})

describe('describePool', () => {
  it("counts each backend's Collections in the split's order", () => {
    assert.equal(
      describePool(parseSplit('postgres=30,fs=70')),
      '10 Collections per test (3 on postgres, 7 on fs)'
    )
  })

  it('names a single Collection in the singular', () => {
    assert.equal(
      describePool(parseSplit('fs=100')),
      '1 Collection per test (1 on fs)'
    )
  })
})

describe('collectionBackend', () => {
  it("names the member's backend by its fixed id", () => {
    assert.deepEqual(collectionBackend({ backend: 'fs', suffix: '-fs-0' }), {
      backend: { id: 'fs' }
    })
  })

  it('names no backend for a member on the default backend', () => {
    assert.deepEqual(collectionBackend({ suffix: '' }), {})
  })
})

describe('missingBackends', () => {
  it('returns the split backends the listing lacks', () => {
    assert.deepEqual(
      missingBackends({
        split: parseSplit('postgres=50,fs=50'),
        listedIds: ['fs']
      }),
      ['postgres']
    )
  })

  it('returns nothing when the listing has every split backend', () => {
    assert.deepEqual(
      missingBackends({
        split: parseSplit('postgres=50,fs=50'),
        listedIds: ['postgres', 'fs']
      }),
      []
    )
  })
})

describe('createDeleteLoad', () => {
  it('sends successive creates to successive pool members, and removes each where it was created', async () => {
    const created: string[] = []
    const removed: string[] = []
    const result = await createDeleteLoad({
      clients: 2,
      durationSeconds: 0.02,
      pool: [
        { name: 'a', backend: 'postgres' as const },
        { name: 'b', backend: 'fs' as const },
        { name: 'c', backend: 'fs' as const }
      ],
      create: async ({ name }, worker, round) => {
        created.push(`${name} ${worker} ${round}`)
      },
      remove: async ({ name }, worker, round) => {
        removed.push(`${name} ${worker} ${round}`)
      }
    })
    assert.deepEqual(created.slice(0, 4), ['a 0 0', 'b 1 0', 'c 0 1', 'a 1 1'])
    assert.deepEqual(new Set(removed), new Set(created))
    assert.ok(result.byBackend?.postgres && result.byBackend.fs)
  })
})

describe('seedResourceCount', () => {
  it('fills a public and a private Collection per size, three per edge size, per pool member', () => {
    assert.equal(
      seedResourceCount({ sizes: [1, 500, 2000], edgeSizes: [1, 2000] }),
      2 * 2501 + 3 * 2001
    )
    assert.equal(
      seedResourceCount({
        sizes: [1, 500, 2000],
        edgeSizes: [1, 2000],
        poolSize: 2
      }),
      2 * (2 * 2501 + 3 * 2001)
    )
  })
})

describe('k6Measurement', () => {
  const metrics = {
    http_reqs: { values: { count: 30, rate: 3 } },
    http_req_duration: { values: { avg: 12 } },
    checks: { values: { fails: 1 } },
    'http_reqs{backend:postgres}': { values: { count: 10, rate: 1 } },
    'http_req_duration{backend:postgres}': { values: { avg: 20 } },
    'checks{backend:postgres}': { values: { fails: 1 } },
    'http_reqs{backend:fs}': { values: { count: 20, rate: 2 } },
    'http_req_duration{backend:fs}': { values: { avg: 8 } },
    'checks{backend:fs}': { values: { fails: 0 } }
  }

  it("reads the whole test, and each backend's part from its tagged submetrics", () => {
    assert.deepEqual(k6Measurement({ metrics, backends: ['postgres', 'fs'] }), {
      rate: 3,
      avgMs: 12,
      failed: 1,
      byBackend: {
        postgres: { rate: 1, avgMs: 20, failed: 1 },
        fs: { rate: 2, avgMs: 8, failed: 0 }
      }
    })
  })

  it('reads the whole test alone for a pool on the default backend', () => {
    assert.deepEqual(k6Measurement({ metrics, backends: [] }), {
      rate: 3,
      avgMs: 12,
      failed: 1
    })
  })
})

describe('backendCell', () => {
  const cell = {
    rate: 3,
    avgMs: 12,
    failed: 0,
    byBackend: { fs: { rate: 2, avgMs: 8, failed: 0 } }
  }

  it("is the backend's part of a measurement", () => {
    assert.deepEqual(backendCell(cell, 'fs'), { rate: 2, avgMs: 8, failed: 0 })
  })

  it("is a gap for a backend that answered none of the test's requests", () => {
    assert.equal(backendCell(cell, 'postgres'), undefined)
  })

  it('keeps a skip string and a gap as they are', () => {
    assert.equal(backendCell('skipped (no k6)', 'fs'), 'skipped (no k6)')
    assert.equal(backendCell(undefined, 'fs'), undefined)
  })
})

describe('formatMatrixTable', () => {
  it('renders a gap as -- and leaves it out of the failures', () => {
    assert.equal(
      formatMatrixTable([
        {
          category: 'public',
          payload: 'large',
          read: undefined,
          write: { rate: 1.5, avgMs: 600, failed: 0 }
        }
      ]),
      [
        '| Collection | Payload | Read | Write |',
        '|---|---|---:|---:|',
        '| Public | 10 MiB file | -- | 1.5 files/s (600.00 ms) |',
        '',
        'Failures: none'
      ].join('\n')
    )
  })
})

describe('sizeTestId', () => {
  it('kebab-cases a size test label', () => {
    assert.equal(sizeTestId('Public read'), 'public-read')
    assert.equal(sizeTestId('Signed delete'), 'signed-delete')
  })

  it('names the serial-write test without its --writes count', () => {
    assert.equal(sizeTestId('Write, 1 client (100 in a row)'), 'serial-write')
    assert.equal(sizeTestId('Write, 1 client (300 in a row)'), 'serial-write')
  })
})

describe('runResults', () => {
  const splitRead = {
    test: 'Signed read',
    size: 500,
    result: {
      rate: 212.4,
      avgMs: 23.4,
      failed: 0,
      byBackend: {
        postgres: { rate: 107.9, avgMs: 23.1, failed: 0 },
        fs: { rate: 104.5, avgMs: 23.8, failed: 0 }
      }
    }
  }

  it('gives the whole test, then each named backend part, in order', () => {
    assert.deepEqual(
      runResults({
        rows: [splitRead],
        matrixRows: [],
        backends: ['postgres', 'fs']
      }),
      [
        {
          suite: 'sizes',
          test: 'signed-read',
          size: 500,
          backend: 'all',
          rate: 212.4,
          avg_ms: 23.4,
          failed: 0
        },
        {
          suite: 'sizes',
          test: 'signed-read',
          size: 500,
          backend: 'postgres',
          rate: 107.9,
          avg_ms: 23.1,
          failed: 0
        },
        {
          suite: 'sizes',
          test: 'signed-read',
          size: 500,
          backend: 'fs',
          rate: 104.5,
          avg_ms: 23.8,
          failed: 0
        }
      ]
    )
  })

  it('gives only the whole test when no backend is named, as on a one-backend run', () => {
    assert.deepEqual(
      runResults({ rows: [splitRead], matrixRows: [] }).map(
        ({ backend }) => backend
      ),
      ['all']
    )
  })

  it('records a skipped test as one entry with its reason', () => {
    assert.deepEqual(
      runResults({
        rows: [{ test: 'Public read', size: 1, result: 'skipped (no k6)' }],
        matrixRows: []
      }),
      [
        {
          suite: 'sizes',
          test: 'public-read',
          size: 1,
          backend: 'all',
          skipped: 'skipped (no k6)'
        }
      ]
    )
  })

  it('records a test whose every call failed with a null average', () => {
    const [entry] = runResults({
      rows: [
        {
          test: 'Signed write',
          size: 1,
          result: { rate: 0, avgMs: undefined, failed: 12 }
        }
      ],
      matrixRows: []
    })
    assert.equal(entry?.avg_ms, null)
    assert.equal(entry?.failed, 12)
  })

  it('puts the matrix after the size tests, each cell read before write', () => {
    const results = runResults({
      rows: [{ test: 'Signed read', size: 1, result: { rate: 1, failed: 0 } }],
      matrixRows: [
        {
          category: 'encrypted',
          payload: 'small',
          read: { rate: 31.2, avgMs: 158, failed: 0 },
          write: { rate: 18.2, avgMs: 271, failed: 1 }
        }
      ]
    })
    assert.deepEqual(
      results.map(({ suite, test, category, payload }) => ({
        suite,
        test,
        category,
        payload
      })),
      [
        {
          suite: 'sizes',
          test: 'signed-read',
          category: undefined,
          payload: undefined
        },
        {
          suite: 'matrix',
          test: 'read',
          category: 'encrypted',
          payload: 'small'
        },
        {
          suite: 'matrix',
          test: 'write',
          category: 'encrypted',
          payload: 'small'
        }
      ]
    )
    assert.equal(results[2]?.failed, 1)
  })
})

describe('healthBuild', () => {
  it("reads a built server's version and build time", () => {
    assert.deepEqual(
      healthBuild({
        status: 'pass',
        version: '0.42.3',
        commit: null,
        builtAt: '2026-10-29T16:17:29.739Z'
      }),
      { version: '0.42.3', builtAt: '2026-10-29T16:17:29.739Z' }
    )
  })

  it('gives null for what a body leaves out, or a body that is not JSON', () => {
    assert.deepEqual(healthBuild({ status: 'pass' }), {
      version: null,
      builtAt: null
    })
    assert.deepEqual(healthBuild(undefined), { version: null, builtAt: null })
  })
})

describe('parseRunner', () => {
  it('accepts a name that is one safe path segment', () => {
    assert.equal(parseRunner('fly-iad'), 'fly-iad')
    assert.equal(parseRunner('laptop_omar.m3'), 'laptop_omar.m3')
  })

  it('rejects a name that could leave its folder', () => {
    assert.throws(() => parseRunner('../ops'), /--runner/)
    assert.throws(() => parseRunner('fly/iad'), /--runner/)
    assert.throws(() => parseRunner(''), /--runner/)
  })
})

describe('recordPath', () => {
  const startedAt = new Date('2026-10-29T16:40:02.118Z')

  it('files a run under its runner, then its host, named by its start', () => {
    assert.equal(
      recordPath({
        dir: 'perf-results',
        runner: 'fly-iad',
        serverUrl: 'https://staging.freewallet.me',
        startedAt
      }),
      'perf-results/fly-iad/staging.freewallet.me/2026-10-29T164002Z.json'
    )
  })

  it('puts the port after a dash, so the folder name has no colon', () => {
    assert.equal(
      recordPath({
        dir: 'perf-results',
        runner: 'laptop-omar',
        serverUrl: 'http://localhost:4455',
        startedAt
      }),
      'perf-results/laptop-omar/localhost-4455/2026-10-29T164002Z.json'
    )
  })
})
