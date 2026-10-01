/**
 * Server identity runbook tests (Vitest): drives the administrator's runbooks
 * for the server's `did:webvh` with the `di` command-line tool from
 * `@interop/did-cli`, spawned as a child process against an in-process server.
 * Covers minting the DID over the server's export-signing key, rotating that
 * key after a seed change, rotating the log's update key, and restoring the
 * log after a data wipe. Each step checks `instance.serverDid` on `/service`.
 */
import { it, describe, beforeAll, afterAll, expect } from 'vitest'
import assert from 'node:assert'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { IDID } from '../src/types.js'
import { startTestServer } from './helpers.js'

const execFileAsync = promisify(execFile)

// A `SECRET_KEY_SEED` in the environment would seed the CLI's webvh update
// key, so it is kept out of the child's environment.
const { SECRET_KEY_SEED: _unusedSeed, ...inheritedEnv } = process.env

/**
 * Resolves the `di` binary through the devDependency's own `bin` map rather
 * than `node_modules/.bin`, so the spawn does not depend on a shell shim.
 */
function diBinPath(): string {
  const require = createRequire(import.meta.url)
  const packageJsonPath = require.resolve('@interop/did-cli/package.json')
  const packageJson = require(packageJsonPath) as {
    bin: { di: string }
  }
  return path.join(path.dirname(packageJsonPath), packageJson.bin.di)
}

/**
 * Reads the `id` member of the JSON document the CLI prints after its
 * `... saved to ...` status lines.
 */
function printedDid(stdout: string): string {
  const match = stdout.match(/"id":\s*"([^"]+)"/)
  assert.ok(match, `no DID in CLI output:\n${stdout}`)
  return match[1]!
}

describe('Server identity runbooks (di CLI)', () => {
  const binPath = diBinPath()
  let fastify: FastifyInstance,
    serverUrl: string,
    port: number,
    walletDir: string,
    dataDir: string,
    wipedDataDir: string,
    adminDid: IDID,
    seed: Uint8Array,
    serverDid: string,
    logPath: string,
    firstExportSigningKey: string

  /**
   * Runs `di` with the suite's wallet directory; rejects with the CLI's
   * stderr on a non-zero exit.
   */
  async function di(
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(process.execPath, [binPath, ...args], {
        env: {
          ...inheritedEnv,
          WALLET_DIR: walletDir,
          DIDS_DIR: path.join(walletDir, 'dids')
        },
        timeout: 30_000
      })
    } catch (err: any) {
      throw new Error(
        `di ${args.join(' ')} failed:\n${err.stderr ?? ''}${err.stdout ?? ''}`,
        { cause: err }
      )
    }
  }

  async function serviceInstance(): Promise<any> {
    const response = await fetch(`${serverUrl}/service`)
    assert.equal(response.status, 200)
    const document = (await response.json()) as any
    return document.instance
  }

  async function boot({ dir }: { dir: string }): Promise<void> {
    ;({ fastify, serverUrl, port } = await startTestServer({
      backend: new FileSystemBackend({ dataDir: dir }),
      serverKeySeed: seed,
      adminDid,
      port
    }))
  }

  async function logVersion(): Promise<string> {
    const { stdout } = await di([
      'did',
      'show',
      'server-id',
      '--meta',
      '--json'
    ])
    const { versionId } = JSON.parse(stdout)
    assert.ok(versionId, `no versionId in CLI output:\n${stdout}`)
    return versionId
  }

  function signingKeyMultibase(exportSigningKey: string): string {
    assert.match(exportSigningKey, /^did:key:z/)
    return exportSigningKey.slice('did:key:'.length)
  }

  async function putLog(): Promise<void> {
    await di([
      'was',
      'put',
      'server/id/did.jsonl',
      logPath,
      '--content-type',
      'text/jsonl'
    ])
  }

  beforeAll(async () => {
    walletDir = await mkdtemp(path.join(tmpdir(), 'was-runbook-wallet-'))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-runbook-data-'))
    wipedDataDir = await mkdtemp(path.join(tmpdir(), 'was-runbook-wiped-'))
    // The admin DID is a boot option, so it is created before the server.
    const { stdout } = await di([
      'did',
      'create',
      'key',
      '--save',
      '--handle',
      'admin'
    ])
    adminDid = printedDid(stdout) as IDID
    assert.match(adminDid, /^did:key:z6Mk/)
    seed = randomBytes(32)
    port = 0
    await boot({ dir: dataDir })
  })
  afterAll(async () => {
    await fastify?.close()
    await rm(walletDir, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
    await rm(wipedDataDir, { recursive: true, force: true })
  })

  it('mint runbook: publishes a log that the server advertises as serverDid', async () => {
    await di([
      'was',
      'space',
      'add',
      `${serverUrl}/space/server`,
      '--handle',
      'server',
      '--did',
      'admin'
    ])
    await di([
      'was',
      'collection',
      'create',
      'server',
      '--id',
      'id',
      '--name',
      'Server identity'
    ])
    await di(['was', 'publish', 'server/id'])

    const instance = await serviceInstance()
    assert.equal(instance.serverDid, undefined)
    firstExportSigningKey = instance.exportSigningKey
    const { stdout } = await di([
      'did',
      'create',
      'webvh',
      '--url',
      `${serverUrl}/space/server/id`,
      '--verification-key',
      signingKeyMultibase(firstExportSigningKey),
      '--purpose',
      'assertionMethod',
      '--vm-id-fragment',
      'multibase',
      '--save',
      '--handle',
      'server-id'
    ])
    serverDid = printedDid(stdout)
    const { stdout: metaOutput } = await di([
      'did',
      'meta',
      'server-id',
      '--json'
    ])
    logPath = JSON.parse(metaOutput).files?.log
    assert.ok(logPath, `no log path in CLI output:\n${metaOutput}`)
    await putLog()

    const advertised = (await serviceInstance()).serverDid
    assert.match(
      advertised,
      /^did:webvh:[^:]+:localhost%3A\d+:space:server:id$/
    )
    assert.equal(advertised, serverDid)

    const served = await fetch(`${serverUrl}/space/server/id/did.jsonl`)
    assert.equal(served.status, 200)
    assert.equal(await served.text(), await readFile(logPath, 'utf8'))
    expect(await logVersion()).toMatch(/^1-/)
  })

  it('seed rotation runbook: replace-key restores serverDid under a new seed', async () => {
    await fastify.close()
    seed = randomBytes(32)
    await boot({ dir: dataDir })

    const instance = await serviceInstance()
    assert.equal(instance.serverDid, undefined)
    assert.notEqual(instance.exportSigningKey, firstExportSigningKey)

    await di([
      'did',
      'webvh',
      'replace-key',
      'server-id',
      '--verification-key',
      signingKeyMultibase(instance.exportSigningKey),
      '-y'
    ])
    await putLog()

    assert.equal((await serviceInstance()).serverDid, serverDid)
    expect(await logVersion()).toMatch(/^2-/)
  })

  it('update-key rotation runbook: rotate-keys keeps serverDid', async () => {
    await di(['did', 'webvh', 'rotate-keys', 'server-id', '-y'])
    await putLog()

    assert.equal((await serviceInstance()).serverDid, serverDid)
    expect(await logVersion()).toMatch(/^3-/)
  })

  it('restore after a wipe runbook: re-publishing the local log restores serverDid', async () => {
    await fastify.close()
    await boot({ dir: wipedDataDir })
    assert.equal((await serviceInstance()).serverDid, undefined)

    await di([
      'was',
      'collection',
      'create',
      'server',
      '--id',
      'id',
      '--name',
      'Server identity'
    ])
    await di(['was', 'publish', 'server/id'])
    await putLog()

    assert.equal((await serviceInstance()).serverDid, serverDid)
    const served = await fetch(`${serverUrl}/space/server/id/did.jsonl`)
    assert.equal(served.status, 200)
    assert.equal(await served.text(), await readFile(logPath, 'utf8'))
  })
})
