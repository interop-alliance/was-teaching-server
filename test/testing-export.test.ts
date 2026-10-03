/**
 * The `was-teaching-server/testing` export: the boot it carries works end to
 * end, the temp backend removes its dir on close and on a failed open, a
 * failed boot or provisioning cleans up after itself, and nothing the entry
 * point loads is a test runner.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'

import { provisionServerIdentity, zcapClients } from './helpers.js'
import {
  openTempBackend,
  provisionWebvhIdentity,
  startTestServer
} from '../src/testing.js'

// Run in a child process, outside Vitest: records every module the entry
// point's import graph resolves and prints the ones that are a test runner.
const IMPORT_GRAPH_PROBE = `
import { registerHooks } from 'node:module'
const resolved = []
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    resolved.push(result.url)
    return result
  }
})
await import(process.argv[1])
const runners = resolved.filter(url =>
  /\\/node_modules\\/(vitest|mocha|jest|ava|tap)\\/|^node:test/.test(url)
)
console.log(JSON.stringify({ count: resolved.length, runners }))
process.exit(0)
`

describe('testing export', () => {
  it('boots a server on a localhost URL over a temp backend', async () => {
    const backend = await openTempBackend()
    let fastify: FastifyInstance | undefined
    try {
      const started = await startTestServer({ backend })
      fastify = started.fastify
      assert.equal(started.serverUrl, `http://localhost:${started.port}`)
      assert.equal(fastify.serverUrl, started.serverUrl)
      const response = await fetch(`${started.serverUrl}/service`)
      assert.equal(response.status, 200)
    } finally {
      await fastify?.close()
      await backend.close()
    }
  })

  it('shows the listening URL to the plugin at listen time', async () => {
    const probe = net.createServer()
    await new Promise<void>(resolve => probe.listen(0, resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise(resolve => probe.close(resolve))

    // The server DID is hosted at the listening URL, so the plugin's
    // listen-time read resolves it only if it sees that URL.
    const seed = randomBytes(32)
    const backend = await openTempBackend()
    await provisionServerIdentity({
      backend,
      serverUrl: `http://localhost:${port}`,
      seed
    })
    const lines: string[] = []
    const { fastify } = await startTestServer({
      backend,
      port,
      serverKeySeed: seed,
      logger: {
        level: 'warn',
        stream: { write: (line: string) => lines.push(line) }
      }
    })
    try {
      // Fastify does not await `onListen` hooks, and a resolved DID logs
      // nothing, so give the plugin's read time to warn.
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.deepEqual(lines, [])
    } finally {
      await fastify.close()
    }
  })

  it('removes the temp data dir on close', async () => {
    const backend = await openTempBackend({ prefix: 'was-testing-export-' })
    assert.match(backend.dataDir, /was-testing-export-/)
    assert.ok((await stat(backend.dataDir)).isDirectory())
    await backend.close()
    await assert.rejects(stat(backend.dataDir), { code: 'ENOENT' })
  })

  it('removes the temp data dir when the backend fails to open', async () => {
    const prefix = `was-testing-export-refused-${process.pid}-`
    await assert.rejects(
      openTempBackend({ prefix, originId: 'not a valid origin id' }),
      { name: 'StoreOriginIdError' }
    )
    const left = (await readdir(tmpdir())).filter(name =>
      name.startsWith(prefix)
    )
    assert.deepEqual(left, [])
  })

  it('closes the server and its backend when the boot fails', async () => {
    const first = await startTestServer({ backend: await openTempBackend() })
    try {
      const backend = await openTempBackend()
      await assert.rejects(startTestServer({ backend, port: first.port }), {
        code: 'EADDRINUSE'
      })
      // The plugin owned the backend, so closing the failed instance closed it.
      await assert.rejects(stat(backend.dataDir), { code: 'ENOENT' })
    } finally {
      await first.fastify.close()
    }
  })

  it('provisions a did:webvh identity, typed by the keys asked for', async () => {
    const { fastify, serverUrl } = await startTestServer({
      backend: await openTempBackend()
    })
    try {
      const { alice } = await zcapClients({ serverUrl })
      const identity = await provisionWebvhIdentity({
        owner: alice,
        serverUrl,
        withLadderKey: true
      })
      assert.match(identity.did, /^did:webvh:/)
      assert.equal(identity.clientKeyPair.controller, identity.did)
      assert.equal(identity.ladderKeyPair.controller, identity.did)
      assert.equal(identity.transientKeyPair, undefined)
      const log = await fetch(
        new URL('id/did.jsonl', identity.spaceUrl).toString()
      )
      assert.notEqual(log.status, 200, 'the log is not world-readable')
      const metadata = await alice.was.space(identity.spaceId).describe()
      assert.equal(metadata?.controller, alice.did)
    } finally {
      await fastify.close()
    }
  })

  it('deletes the Space when provisioning fails after creating it', async () => {
    const { fastify, serverUrl } = await startTestServer({
      backend: await openTempBackend()
    })
    try {
      const { alice } = await zcapClients({ serverUrl })
      // `meta` is a reserved Collection id, so the Collection create is refused.
      await assert.rejects(
        provisionWebvhIdentity({
          owner: alice,
          serverUrl,
          collectionId: 'meta'
        })
      )
      const listing = await alice.was.listSpaces()
      assert.deepEqual(listing.items, [])
    } finally {
      await fastify.close()
    }
  })

  it('loads no test runner anywhere in its import graph', async () => {
    const entryPoint = new URL('../src/testing.ts', import.meta.url)
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        IMPORT_GRAPH_PROBE,
        entryPoint.href
      ],
      { cwd: fileURLToPath(new URL('..', import.meta.url)) }
    )
    const { count, runners } = JSON.parse(stdout.trim().split('\n').at(-1)!)
    assert.ok(count > 1, 'the probe saw the import graph')
    assert.deepEqual(runners, [])
  })

  it('maps the ./testing export to the file built from src/testing.ts', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    )
    const target = packageJson.exports['./testing']
    assert.deepEqual(target, {
      types: './dist/testing.d.ts',
      import: './dist/testing.js'
    })
    // `tsc` emits `dist/<name>.js` from `src/<name>.ts` (rootDir `src`), so
    // the export resolves once built only while that source file exists.
    const source = target.import
      .replace(/^\.\/dist\//, '../src/')
      .replace(/\.js$/, '.ts')
    await access(new URL(source, import.meta.url))
  })
})
