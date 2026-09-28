/**
 * Tests for the atomic, durable filesystem write helpers (`src/lib/atomicFile`):
 * a successful write replaces content and is immediately readable; no `.tmp-`
 * staging file is left behind after either a successful write or a simulated
 * failure; `atomicCreateFile` enforces create-only semantics (rejecting with
 * EEXIST and leaving the existing file intact); and the streaming
 * `commitTempFile` publishes a staged temp file onto its final path; and
 * `sweepTempFiles` removes stale staging files at any depth, keeps fresh
 * ones, and skips a directory it cannot read. These
 * exercise the helpers directly over a throwaway temp dir -- they verify the
 * on-disk outcome, not crash-time durability (which fsync cannot be unit-tested
 * for).
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import path from 'node:path'
import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  utimes,
  chmod
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import pino from 'pino'

import {
  atomicWriteFile,
  atomicCreateFile,
  tempPathFor,
  commitTempFile,
  sweepTempFiles,
  TEMP_FILE_ORPHAN_AGE_MS
} from '../src/lib/atomicFile.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'atomic-file-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * The `.tmp-` staging files a write leaves in `dir`, if any.
 */
async function tempLeftovers(): Promise<string[]> {
  const entries = await readdir(dir)
  return entries.filter(name => name.startsWith('.tmp-'))
}

describe('tempPathFor', () => {
  it('stages into a .tmp- dot-file in the same directory as the target', () => {
    const target = path.join(dir, 'sub', 'record.json')
    const temp = tempPathFor(target)
    assert.equal(path.dirname(temp), path.dirname(target))
    assert.ok(path.basename(temp).startsWith('.tmp-'))
  })
})

describe('atomicWriteFile', () => {
  it('writes data that is immediately readable', async () => {
    const filePath = path.join(dir, 'record.json')
    await atomicWriteFile({ filePath, data: '{"a":1}' })
    assert.equal(await readFile(filePath, 'utf8'), '{"a":1}')
  })

  it('replaces the prior content of an existing file', async () => {
    const filePath = path.join(dir, 'record.json')
    await atomicWriteFile({ filePath, data: 'first' })
    await atomicWriteFile({ filePath, data: 'second' })
    assert.equal(await readFile(filePath, 'utf8'), 'second')
  })

  it('accepts a Buffer payload', async () => {
    const filePath = path.join(dir, 'blob.bin')
    const bytes = Buffer.from([0, 1, 2, 3, 255])
    await atomicWriteFile({ filePath, data: bytes })
    assert.deepEqual(await readFile(filePath), bytes)
  })

  it('leaves no .tmp- staging file behind after a successful write', async () => {
    await atomicWriteFile({
      filePath: path.join(dir, 'record.json'),
      data: 'x'
    })
    assert.deepEqual(await tempLeftovers(), [])
  })

  it('cleans up the staging file and does not create the target on failure', async () => {
    // A non-existent directory makes the temp-file open fail, simulating a
    // mid-write failure. Nothing should be left behind, and the target within
    // the (missing) directory must not appear.
    const filePath = path.join(dir, 'missing', 'record.json')
    await assert.rejects(atomicWriteFile({ filePath, data: 'x' }))
    assert.deepEqual(await tempLeftovers(), [])
  })
})

describe('atomicCreateFile', () => {
  it('creates a new file that is immediately readable', async () => {
    const filePath = path.join(dir, 'key.json')
    await atomicCreateFile({ filePath, data: '{"secret":true}' })
    assert.equal(await readFile(filePath, 'utf8'), '{"secret":true}')
  })

  it('leaves no .tmp- staging file behind after a successful create', async () => {
    await atomicCreateFile({ filePath: path.join(dir, 'key.json'), data: 'x' })
    assert.deepEqual(await tempLeftovers(), [])
  })

  it('rejects with EEXIST when the target already exists and leaves it intact', async () => {
    const filePath = path.join(dir, 'key.json')
    await writeFile(filePath, 'original')
    await assert.rejects(
      atomicCreateFile({ filePath, data: 'replacement' }),
      (err: NodeJS.ErrnoException) => err.code === 'EEXIST'
    )
    // The pre-existing file must survive untouched, and no temp is left behind.
    assert.equal(await readFile(filePath, 'utf8'), 'original')
    assert.deepEqual(await tempLeftovers(), [])
  })
})

describe('commitTempFile', () => {
  it('publishes a staged temp file onto its final path', async () => {
    const filePath = path.join(dir, 'blob.bin')
    const tempPath = tempPathFor(filePath)
    await writeFile(tempPath, 'streamed-body')
    await commitTempFile({ tempPath, filePath })
    assert.equal(await readFile(filePath, 'utf8'), 'streamed-body')
    // The temp file is consumed by the rename, leaving nothing behind.
    assert.deepEqual(await tempLeftovers(), [])
  })
})

describe('sweepTempFiles', () => {
  const logger = pino({ level: 'silent' })
  // An mtime older than the orphan age, so the sweep treats the file as stale.
  const stale = new Date(Date.now() - TEMP_FILE_ORPHAN_AGE_MS - 60_000)

  it('removes stale staging files at any depth and keeps every other file', async () => {
    const nested = path.join(dir, 'space', 'collection')
    await mkdir(nested, { recursive: true })
    const kept = path.join(nested, 'r.json')
    await writeFile(kept, '{}')
    await utimes(kept, stale, stale)
    for (const orphan of [
      tempPathFor(kept),
      tempPathFor(path.join(dir, 'top.json'))
    ]) {
      await writeFile(orphan, 'orphan')
      await utimes(orphan, stale, stale)
    }
    assert.equal(await sweepTempFiles({ root: dir, logger }), 2)
    assert.deepEqual(await readdir(nested), ['r.json'])
    assert.deepEqual(await tempLeftovers(), [])
  })

  it('keeps a staging file modified more recently than the orphan age', async () => {
    const live = tempPathFor(path.join(dir, 'live.json'))
    await writeFile(live, 'in flight')
    assert.equal(await sweepTempFiles({ root: dir, logger }), 0)
    assert.deepEqual(await readdir(dir), [path.basename(live)])
  })

  it('skips an unreadable directory and still sweeps the rest', async ({
    skip
  }) => {
    if (process.getuid?.() === 0) {
      skip('root reads a directory whatever its mode')
    }
    const locked = path.join(dir, 'locked')
    await mkdir(locked)
    const orphan = tempPathFor(path.join(dir, 'top.json'))
    await writeFile(orphan, 'orphan')
    await utimes(orphan, stale, stale)
    await chmod(locked, 0o000)
    try {
      assert.equal(await sweepTempFiles({ root: dir, logger }), 1)
    } finally {
      await chmod(locked, 0o700)
    }
  })

  it('sweeps nothing under an absent root', async () => {
    assert.equal(
      await sweepTempFiles({ root: path.join(dir, 'missing'), logger }),
      0
    )
  })
})
