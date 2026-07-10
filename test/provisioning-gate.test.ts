/**
 * Provisioning gate tests (Vitest): the `authorizeProvisioning` plugin option
 * and the built-in onboarding-token check (`onboardingToken` /
 * `WAS_ONBOARDING_TOKEN`) over the two open provisioning endpoints
 * (`POST /spaces/`, `POST /kms/keystores`). Covers the onboarding-token happy
 * and error paths, custom `grant`/`deny`/`verify` decisions, the registration
 * -time mutual-exclusion guard, and the default (neither configured) zcap path
 * as a regression guard.
 */
import { it, describe, afterEach } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { AuthorizeProvisioning } from '../src/types.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Provisioning gate', () => {
  let alice: any
  let serverUrl: string
  const TOKEN = 'super-secret-onboarding-token'

  // Per-test teardown: each `boot()` registers its server + temp dir here.
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  /**
   * Boots a server on an OS-assigned ephemeral port with the given provisioning
   * config over a fresh temp dir, sets the suite `serverUrl` and rebuilds Alice's
   * client to match, and registers its teardown for `afterEach`.
   * @param options {object}
   * @param [options.onboardingToken] {string}
   * @param [options.authorizeProvisioning] {AuthorizeProvisioning}
   * @returns {Promise<{ fastify: FastifyInstance, backend: FileSystemBackend }>}
   */
  async function boot({
    onboardingToken,
    authorizeProvisioning
  }: {
    onboardingToken?: string
    authorizeProvisioning?: AuthorizeProvisioning
  } = {}): Promise<{ fastify: FastifyInstance; backend: FileSystemBackend }> {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'was-provisioning-'))
    const backend = new FileSystemBackend({ dataDir })
    const started = await startTestServer({
      backend,
      ...(onboardingToken !== undefined && { onboardingToken }),
      ...(authorizeProvisioning !== undefined && { authorizeProvisioning })
    })
    const { fastify } = started
    serverUrl = started.serverUrl
    ;({ alice } = await zcapClients({ serverUrl }))
    cleanups.push(async () => {
      await fastify.close()
      await rm(dataDir, { recursive: true, force: true })
    })
    return { fastify, backend }
  }

  /** A minimal Create Space body naming Alice as controller. */
  function createSpaceBody(id: string) {
    return { id, name: 'Provisioned Space', controller: alice.did }
  }

  describe('onboardingToken configured', () => {
    it('POST /spaces/ with a correct Bearer token creates the space (201)', async () => {
      const { backend } = await boot({ onboardingToken: TOKEN })
      const spaceId = `token-space-${crypto.randomUUID()}`
      const response = await fetch(new URL('/spaces/', serverUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(createSpaceBody(spaceId))
      })
      assert.equal(response.status, 201)
      assert.equal(
        response.headers.get('location'),
        `${serverUrl}/spaces/${spaceId}`
      )
      // The space landed in storage with the body's controller.
      const stored = await backend.getSpaceDescription({ spaceId })
      assert.equal(stored?.controller, alice.did)

      // Normal auth still works afterwards: a signed GET by the controller
      // returns the space description (200), proving the token gate does not
      // disturb the zcap path for subsequent operations.
      const signed = await alice.was.request({
        path: `/space/${spaceId}`,
        method: 'GET'
      })
      assert.equal(signed.status, 200)
    })

    it('POST /spaces/ with no Authorization header returns 401', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/spaces/', serverUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSpaceBody('no-auth'))
      })
      assert.equal(response.status, 401)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })

    it('POST /spaces/ with a wrong Bearer token returns 403', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/spaces/', serverUrl), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer not-the-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(createSpaceBody('wrong-token'))
      })
      assert.equal(response.status, 403)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })

    it('POST /spaces/ with a zcap-signed invocation but no token returns 401', async () => {
      await boot({ onboardingToken: TOKEN })
      let thrown: any
      try {
        await alice.was.createSpace(createSpaceBody('signed-no-token'))
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a signed create with no token to be rejected')
      assert.equal(thrown.status, 401)
    })

    it('POST /kms/keystores with a correct Bearer token creates the keystore (201)', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/kms/keystores', serverUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ controller: alice.did, sequence: 0 })
      })
      assert.equal(response.status, 201)
      assert.ok(response.headers.get('location'))
    })

    it('POST /kms/keystores with no token returns 401', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/kms/keystores', serverUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controller: alice.did, sequence: 0 })
      })
      assert.equal(response.status, 401)
    })

    it('POST /spaces (no trailing slash) with a correct Bearer token gets the canonical 308 redirect', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/spaces', serverUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(createSpaceBody('no-slash')),
        redirect: 'manual'
      })
      assert.equal(response.status, 308)
      assert.equal(response.headers.get('location'), '/spaces/')
    })

    it('non-provisioning routes are unaffected: anonymous GET /spaces/ is 200', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/spaces/', serverUrl))
      assert.equal(response.status, 200)
    })
  })

  describe('custom authorizeProvisioning', () => {
    it("a 'deny' decision returns 403 on POST /spaces/", async () => {
      await boot({ authorizeProvisioning: async () => 'deny' as const })
      const response = await fetch(new URL('/spaces/', serverUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSpaceBody('denied'))
      })
      assert.equal(response.status, 403)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })

    it("a 'grant' decision creates the space with no auth headers (201)", async () => {
      const { backend } = await boot({
        authorizeProvisioning: async () => 'grant' as const
      })
      const spaceId = `granted-${crypto.randomUUID()}`
      const response = await fetch(new URL('/spaces/', serverUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSpaceBody(spaceId))
      })
      assert.equal(response.status, 201)
      const stored = await backend.getSpaceDescription({ spaceId })
      assert.equal(stored?.controller, alice.did)
    })

    it("a 'verify' decision leaves the normal zcap create-space path working (201)", async () => {
      await boot({ authorizeProvisioning: async () => 'verify' as const })
      const space = await alice.was.createSpace(
        createSpaceBody(`verified-${crypto.randomUUID()}`)
      )
      assert.ok(space.id)
    })
  })

  it('rejects on ready() when both onboardingToken and authorizeProvisioning are set', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'was-provisioning-'))
    // Never listens -- the rejection happens at `ready()` -- so any valid base
    // URL will do, and this test stays independent of the boots above.
    const fastify = createApp({
      serverUrl: 'http://localhost',
      backend: new FileSystemBackend({ dataDir }),
      onboardingToken: TOKEN,
      authorizeProvisioning: async () => 'grant' as const
    })
    try {
      await assert.rejects(async () => {
        await fastify.ready()
      }, /authorizeProvisioning and onboardingToken are mutually exclusive/)
    } finally {
      await fastify.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('default (neither option): a zcap-signed create space still returns 201', async () => {
    await boot()
    const space = await alice.was.createSpace(
      createSpaceBody(`default-${crypto.randomUUID()}`)
    )
    assert.ok(space.id)
  })
})
