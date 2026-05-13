/**
 * Local test runner — starts a Fastify server in-process, then delegates to
 * the conformance suite (plus storage unit tests) via a child process so that
 * worker threads spawned by `node --test` never try to bind the port themselves.
 * Usage: node test/setup.js [--test-only]
 */
import { createApp } from '../src/server.js'
import { spawn } from 'node:child_process'
import { glob } from 'glob'

const PORT = 3777
const serverUrl = `http://localhost:${PORT}`

const fastify = createApp({ serverUrl })
await fastify.listen({ port: PORT })

const testArg = process.argv.includes('--test-only') ? '--test-only' : '--test'
const conformanceFiles = (await glob('conformance/*.test.js')).sort()
const testFiles = ['test/storage.test.js', ...conformanceFiles]

const child = spawn(process.execPath, [testArg, ...testFiles], {
  env: { ...process.env, TEST_SERVER_URL: serverUrl },
  stdio: 'inherit',
  cwd: process.cwd()
})

child.on('close', async (code) => {
  await fastify.close()
  process.exit(code ?? 0)
})
