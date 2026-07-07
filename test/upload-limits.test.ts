/**
 * Tests for the default-on per-upload cap normalization at the backend
 * constructor seam: an unset cap becomes the shared default, an explicit
 * `Infinity` (from `MAX_UPLOAD_BYTES=unlimited`) disables it on the filesystem
 * backend, and the Postgres backend rejects an unbounded cap at construction
 * (its single-`bytea` writes buffer through memory).
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { it, describe, afterAll, beforeAll } from 'vitest'
import assert from 'node:assert'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { PostgresBackend } from '../src/backends/postgres.js'
import { DEFAULT_MAX_UPLOAD_BYTES } from '../src/config.default.js'

describe('FileSystemBackend upload cap normalization', () => {
  let dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-upload-limits-'))
  })

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('applies DEFAULT_MAX_UPLOAD_BYTES when no cap is configured', () => {
    const backend = new FileSystemBackend({ dataDir })
    assert.equal(backend.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES)
  })

  it('honors a finite configured cap', () => {
    const backend = new FileSystemBackend({ dataDir, maxUploadBytes: 4096 })
    assert.equal(backend.maxUploadBytes, 4096)
  })

  it('normalizes Infinity (explicit unlimited) to undefined (no cap)', () => {
    const backend = new FileSystemBackend({
      dataDir,
      maxUploadBytes: Infinity
    })
    assert.equal(backend.maxUploadBytes, undefined)
  })

  it('normalizes an Infinity capacity to undefined (no limit)', () => {
    const backend = new FileSystemBackend({
      dataDir,
      capacityBytes: Infinity
    })
    assert.equal(backend.capacityBytes, undefined)
  })
})

describe('PostgresBackend upload cap normalization', () => {
  it('rejects an unlimited (Infinity) per-upload cap at construction', () => {
    // The throw happens before the connection pool is created, so this needs
    // no reachable database.
    assert.throws(
      () =>
        new PostgresBackend({
          connectionString: 'postgres://was:was@localhost:5433/was',
          maxUploadBytes: Infinity
        }),
      /does not support an unlimited per-upload cap/
    )
  })
})
