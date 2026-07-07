/**
 * HTTP-layer integration test for the default-on count quotas: a filesystem
 * backend configured with `maxSpacesPerController: 1` accepts a controller's
 * first `POST /spaces/` and rejects the second with 507 `quota-exceeded`.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

describe('Count quota (Spaces per controller)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any
  const PORT = 7799

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}`
    ;({ alice } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-count-quota-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir, maxSpacesPerController: 1 })
    })
    await fastify.listen({ port: PORT })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('accepts the first Space then rejects a second by the same controller with 507', async () => {
    // First create for Alice succeeds.
    const space = await alice.was.createSpace({
      id: alice.space1.id,
      name: 'Alice Space 1',
      controller: alice.did
    })
    assert.equal(space.id, alice.space1.id)

    // Second create by the same controller is over the cap: the client maps the
    // 507 to a thrown error carrying the quota-exceeded problem type.
    let error: any
    try {
      await alice.was.createSpace({
        id: alice.space2.id,
        name: 'Alice Space 2',
        controller: alice.did
      })
    } catch (err) {
      error = err
    }
    assert.ok(error, 'expected the second create to be rejected')
    assert.equal(error.status, 507)
    assert.ok(
      String(error.type).endsWith('#quota-exceeded'),
      `expected a quota-exceeded type, got ${error.type}`
    )
  })
})
