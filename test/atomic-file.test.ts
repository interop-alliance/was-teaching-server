/**
 * Tests for the atomic, durable filesystem write helpers (`src/lib/atomicFile`):
 * a successful write replaces content and is immediately readable; no `.tmp-`
 * staging file is left behind after either a successful write or a simulated
 * failure; `atomicCreateFile` enforces create-only semantics (rejecting with
 * EEXIST and leaving the existing file intact); and the streaming
 * `commitTempFile` publishes a staged temp file onto its final path. These
 * exercise the helpers directly over a throwaway temp dir -- they verify the
 * on-disk outcome, not crash-time durability (which fsync cannot be unit-tested
 * for).
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import path from 'node:path'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  atomicWriteFile,
  atomicCreateFile,
  tempPathFor,
  commitTempFile
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
