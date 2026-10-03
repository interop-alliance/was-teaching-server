/**
 * Tests that the filesystem backend leaves no staging temp file behind: one an
 * earlier process left (swept when the backend starts, once stale) and one a streamed
 * upload was writing when its client disconnected (removed by the write path).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import http from 'node:http'
import path from 'node:path'
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { TEMP_FILE_ORPHAN_AGE_MS } from '../src/lib/atomicFile.js'
import {
  STORE_FILE_NAME,
  STORE_MIGRATIONS
} from '../src/backends/filesystemStore.js'
import { startTestServer, zcapClients } from './helpers.js'

/**
 * The `.tmp-` staging files in `dir` (none when `dir` is absent).
 */
async function tempFilesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[])
  return entries.filter(name => name.startsWith('.tmp-'))
}

/**
 * Polls `check` every 20 ms until it returns true, failing after `timeoutMs`.
 */
async function waitFor(
  check: () => Promise<boolean>,
  { timeoutMs = 5000, what }: { timeoutMs?: number; what: string }
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('Staging temp-file cleanup (filesystem backend)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    collectionDir: string
  const orphanDir = path.join('spaces', 'orphan-space', 'orphan-collection')

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    // Stamped, as the earlier process would have left it.
    await writeFile(
      path.join(dataDir, STORE_FILE_NAME),
      JSON.stringify({ version: STORE_MIGRATIONS.length })
    )
    // Temp files an earlier process was killed while writing.
    // Their mtime is older than the orphan age, so the sweep removes them.
    const stale = new Date(Date.now() - TEMP_FILE_ORPHAN_AGE_MS - 60_000)
    for (const dir of [orphanDir, 'keystores']) {
      const orphan = path.join(dataDir, dir, '.tmp-orphan')
      await mkdir(path.dirname(orphan), { recursive: true })
      await writeFile(orphan, 'partial')
      await utimes(orphan, stale, stale)
    }
    // One another process sharing the data directory is still writing.
    await writeFile(path.join(dataDir, 'keystores', '.tmp-live'), 'partial')
    ;({ fastify, serverUrl } = await startTestServer({
      backend: await FileSystemBackend.open({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))
    const space = await alice.was.createSpace({
      id: alice.space1.id,
      controller: alice.did
    })
    await space.createCollection({ id: 'uploads' })
    collectionDir = path.join(dataDir, 'spaces', alice.space1.id, 'uploads')
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('backend startup removes stale temp files and keeps a fresh one', async () => {
    assert.deepEqual(await tempFilesIn(path.join(dataDir, orphanDir)), [])
    assert.deepEqual(await tempFilesIn(path.join(dataDir, 'keystores')), [
      '.tmp-live'
    ])
  })

  it('a streamed upload whose client disconnects mid-body leaves no temp file', async () => {
    const url = `${serverUrl}/space/${alice.space1.id}/uploads/abandoned`
    const body = Buffer.alloc(1024 * 1024, 7)
    const headers = await signCapabilityInvocation({
      url,
      method: 'PUT',
      headers: {
        date: new Date().toUTCString(),
        'content-type': 'application/octet-stream'
      },
      body,
      invocationSigner: alice.signer,
      capabilityAction: 'PUT'
    })
    const request = http.request(url, {
      method: 'PUT',
      headers: { ...headers, 'content-length': String(body.length) }
    })
    request.on('error', () => {
      // The socket is destroyed on purpose below.
    })
    request.write(body.subarray(0, 64 * 1024))
    // The server has verified the signature and begun staging the body.
    await waitFor(async () => (await tempFilesIn(collectionDir)).length > 0, {
      what: 'the upload to start staging'
    })
    request.destroy()
    await waitFor(async () => (await tempFilesIn(collectionDir)).length === 0, {
      what: 'the staging file to be removed'
    })
    const entries = await readdir(collectionDir)
    assert.ok(
      !entries.some(name => name.includes('abandoned')),
      `no representation of the abandoned upload: ${entries.join(', ')}`
    )
  })
})
