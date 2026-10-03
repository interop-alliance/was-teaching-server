/**
 * Tests for the default-on per-upload cap normalization at the backend
 * constructor seam: an unset cap becomes the shared default, an explicit
 * `Infinity` (from `MAX_UPLOAD_BYTES=unlimited`) disables it on the filesystem
 * backend, and the Postgres backend rejects an unbounded cap at construction
 * (its single-`bytea` writes buffer through memory).
 */
import { it, describe, afterAll } from 'vitest'
import assert from 'node:assert'
import type { TempFileSystemBackend } from '../src/testing.js'
import { PostgresBackend } from '../src/backends/postgres.js'
import { DEFAULT_MAX_UPLOAD_BYTES } from '../src/config.default.js'
import { openTempBackend } from './helpers.js'

describe('FileSystemBackend upload cap normalization', () => {
  const backends: TempFileSystemBackend[] = []

  afterAll(async () => {
    await Promise.all(backends.splice(0).map(backend => backend.close()))
  })

  async function open(options: Parameters<typeof openTempBackend>[0] = {}) {
    const backend = await openTempBackend({
      prefix: 'was-upload-limits-',
      ...options
    })
    backends.push(backend)
    return backend
  }

  it('applies DEFAULT_MAX_UPLOAD_BYTES when no cap is configured', async () => {
    const backend = await open()
    assert.equal(backend.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES)
  })

  it('honors a finite configured cap', async () => {
    const backend = await open({
      maxUploadBytes: 4096
    })
    assert.equal(backend.maxUploadBytes, 4096)
  })

  it('normalizes Infinity (explicit unlimited) to undefined (no cap)', async () => {
    const backend = await open({
      maxUploadBytes: Infinity
    })
    assert.equal(backend.maxUploadBytes, undefined)
  })

  it('normalizes an Infinity capacity to undefined (no limit)', async () => {
    const backend = await open({
      capacityBytes: Infinity
    })
    assert.equal(backend.capacityBytes, undefined)
  })
})

describe('PostgresBackend upload cap normalization', () => {
  it('rejects an unlimited (Infinity) per-upload cap at open', async () => {
    // The throw happens before the connection pool is created, so this needs
    // no reachable database.
    await assert.rejects(
      PostgresBackend.open({
        connectionString: 'postgres://was:was@localhost:5433/was',
        maxUploadBytes: Infinity
      }),
      /does not support an unlimited per-upload cap/
    )
  })
})
