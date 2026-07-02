/**
 * WebKMS keystore lifecycle tests (Vitest): POST / GET `/kms/keystores`,
 * GET / POST `/kms/keystores/:keystoreId`. Driven through `@interop/webkms-client`
 * wherever it has a method for the operation -- the client IS the conformance
 * suite for the webkms wire contract -- with raw `@interop/ezcap` invocations
 * for the parts it does not cover (list-by-controller, delegated creation,
 * wire-level response assertions).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { KmsClient } from '@interop/webkms-client'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { client, zcapClients } from './helpers.js'

describe('WebKMS keystore lifecycle (/kms/keystores)', () => {
  let fastify: FastifyInstance,
    backend: FileSystemBackend,
    serverUrl: string,
    keystoresUrl: string,
    dataDir: string,
    alice: any,
    aliceDelegatedApp: any,
    bob: any
  const PORT = 7801

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}`
    keystoresUrl = `${serverUrl}/kms/keystores`
    ;({ alice, aliceDelegatedApp, bob } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    backend = new FileSystemBackend({ dataDir })
    fastify = createApp({ serverUrl, backend })
    await fastify.listen({ port: PORT })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /** Creates a keystore for the given identity, resolving its bare config. */
  async function createKeystore(identity: any, config: object = {}) {
    return await KmsClient.createKeystore({
      url: keystoresUrl,
      config: { sequence: 0, controller: identity.did, ...config },
      invocationSigner: identity.signer
    })
  }

  /** Awaits a request expected to fail, returning the thrown error. */
  async function requestError(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
    } catch (err) {
      return err
    }
    assert.fail('expected the request to be rejected')
  }

  describe('create', () => {
    it('createKeystore provisions a keystore (bare config, defaults applied)', async () => {
      const config = await createKeystore(alice)
      // Server-generated id: the keystores URL plus a multibase (`z...`)
      // base58 local id.
      assert.match(
        config.id!,
        new RegExp(`^${keystoresUrl}/z[1-9A-HJ-NP-Za-km-z]+$`)
      )
      assert.equal(config.controller, alice.did)
      assert.equal(config.sequence, 0)
      // The hard-wired in-process module alias is applied when omitted.
      assert.equal(config.kmsModule, 'local-v1')
    })

    it('responds 201 with a Location header naming the new keystore', async () => {
      const response = await client({ signer: alice.signer }).request({
        url: keystoresUrl,
        method: 'POST',
        action: 'write',
        json: { sequence: 0, controller: alice.did }
      })
      assert.equal(response.status, 201)
      const config = response.data as { id: string }
      assert.equal(response.headers.get('location'), config.id)
    })

    it('a supplied kmsModule alias is echoed back (opaque on the wire)', async () => {
      const config = await createKeystore(alice, { kmsModule: 'my-module-v1' })
      assert.equal(config.kmsModule, 'my-module-v1')
    })

    it("[delegated] a provisioning app creates a keystore on the controller-to-be's behalf", async () => {
      // Alice delegates keystore creation (`write` on /kms/keystores) to her
      // app; the chain roots in the body's controller, so creation verifies.
      const zcap = await client({ signer: alice.signer }).delegate({
        invocationTarget: keystoresUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['write']
      })
      const response = await client({
        signer: aliceDelegatedApp.signer
      }).request({
        url: keystoresUrl,
        method: 'POST',
        action: 'write',
        capability: zcap,
        json: { sequence: 0, controller: alice.did }
      })
      assert.equal(response.status, 201)
      assert.equal(
        (response.data as { controller: string }).controller,
        alice.did
      )
    })

    it('[root] creation naming another DID as controller is controller-mismatch (400)', async () => {
      // Bob signs a bare-root invocation but names Alice as the controller:
      // Alice has authorized nothing.
      const err = await requestError(
        createKeystore(bob, { controller: alice.did })
      )
      assert.equal(err.status, 400)
      assert.equal(
        err.data.type,
        'https://wallet.storage/spec#controller-mismatch'
      )
    })

    it('[delegated] a chain not rooted in the body controller is controller-mismatch (400)', async () => {
      // The app's capability is delegated by Alice, but the body names Bob:
      // the chain does not root in Bob, so Bob has consented to nothing.
      const zcap = await client({ signer: alice.signer }).delegate({
        invocationTarget: keystoresUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['write']
      })
      const err = await requestError(
        client({ signer: aliceDelegatedApp.signer }).request({
          url: keystoresUrl,
          method: 'POST',
          action: 'write',
          capability: zcap,
          json: { sequence: 0, controller: bob.did }
        })
      )
      assert.equal(err.status, 400)
      assert.equal(
        err.data.type,
        'https://wallet.storage/spec#controller-mismatch'
      )
    })

    it('create requires sequence 0 (400)', async () => {
      const err = await requestError(createKeystore(alice, { sequence: 1 }))
      assert.equal(err.status, 400)
      assert.equal(err.data.errors[0].pointer, '#/sequence')
    })

    it('unknown fields are rejected (meterId, 400)', async () => {
      const err = await requestError(
        createKeystore(alice, { meterId: 'urn:uuid:some-meter' })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.errors[0].pointer, '#/meterId')
    })
  })

  describe('get', () => {
    it('the controller reads the stored config (root zcap)', async () => {
      const created = await createKeystore(alice)
      const kmsClient = new KmsClient({ keystoreId: created.id })
      const config = await kmsClient.getKeystore({
        invocationSigner: alice.signer
      })
      assert.deepEqual(config, created)
    })

    it('an unknown keystore is masked (404)', async () => {
      const kmsClient = new KmsClient({
        keystoreId: `${keystoresUrl}/z1111unknown`
      })
      const err = await requestError(
        kmsClient.getKeystore({ invocationSigner: alice.signer })
      )
      assert.equal(err.status, 404)
    })

    it('a non-controller read is masked (404)', async () => {
      const created = await createKeystore(alice)
      const kmsClient = new KmsClient({ keystoreId: created.id })
      const err = await requestError(
        kmsClient.getKeystore({ invocationSigner: bob.signer })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('list by controller', () => {
    it('returns only the caller-controlled keystores ({results})', async () => {
      const created = await createKeystore(alice)
      const response = await client({ signer: alice.signer }).request({
        url: `${keystoresUrl}?controller=${encodeURIComponent(alice.did)}`,
        method: 'GET',
        action: 'read'
      })
      assert.equal(response.status, 200)
      const { results } = response.data as { results: any[] }
      assert.ok(Array.isArray(results))
      assert.ok(results.length >= 1)
      for (const config of results) {
        assert.equal(config.controller, alice.did)
      }
      assert.ok(results.some((config: any) => config.id === created.id))
    })

    it("listing another controller's keystores is masked (404)", async () => {
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${keystoresUrl}?controller=${encodeURIComponent(alice.did)}`,
          method: 'GET',
          action: 'read'
        })
      )
      assert.equal(err.status, 404)
    })

    it('a controller with no keystores lists empty results (200, not an error)', async () => {
      // The delegated app's own DID controls no keystore (it only ever acts
      // via delegation).
      const response = await client({
        signer: aliceDelegatedApp.signer
      }).request({
        url: `${keystoresUrl}?controller=${encodeURIComponent(aliceDelegatedApp.did)}`,
        method: 'GET',
        action: 'read'
      })
      assert.equal(response.status, 200)
      assert.deepEqual((response.data as { results: any[] }).results, [])
    })

    it('the controller query parameter is required (400)', async () => {
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: keystoresUrl,
          method: 'GET',
          action: 'read'
        })
      )
      assert.equal(err.status, 400)
    })

    it('unexpected query parameters are rejected (400)', async () => {
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: `${keystoresUrl}?controller=${encodeURIComponent(alice.did)}&limit=5`,
          method: 'GET',
          action: 'read'
        })
      )
      assert.equal(err.status, 400)
    })
  })

  describe('update', () => {
    it('updateKeystore applies sequence previous+1 and returns the {config} wrapper', async () => {
      const created = await createKeystore(alice)
      const kmsClient = new KmsClient({ keystoreId: created.id })
      const result = await kmsClient.updateKeystore({
        config: { ...created, sequence: 1 },
        invocationSigner: alice.signer
      })
      // Note the response asymmetry: update wraps in `config`, unlike get.
      assert.deepEqual(result.config, { ...created, sequence: 1 })
      const config = await kmsClient.getKeystore({
        invocationSigner: alice.signer
      })
      assert.equal(config.sequence, 1)
    })

    it('a controller change takes effect immediately (new reads, old is masked)', async () => {
      const created = await createKeystore(alice)
      const kmsClient = new KmsClient({ keystoreId: created.id })
      await kmsClient.updateKeystore({
        config: { ...created, controller: bob.did, sequence: 1 },
        invocationSigner: alice.signer
      })

      const config = await kmsClient.getKeystore({
        invocationSigner: bob.signer
      })
      assert.equal(config.controller, bob.did)
      const err = await requestError(
        kmsClient.getKeystore({ invocationSigner: alice.signer })
      )
      assert.equal(err.status, 404)
    })

    it('a stale sequence is a 409 state conflict', async () => {
      const created = await createKeystore(alice)
      const kmsClient = new KmsClient({ keystoreId: created.id })
      // Replays the stored sequence instead of previous+1.
      const err = await requestError(
        kmsClient.updateKeystore({
          config: { ...created, sequence: 0 },
          invocationSigner: alice.signer
        })
      )
      assert.equal(err.status, 409)
    })

    it('kmsModule is immutable (409)', async () => {
      const created = await createKeystore(alice)
      const kmsClient = new KmsClient({ keystoreId: created.id })
      const err = await requestError(
        kmsClient.updateKeystore({
          config: { ...created, kmsModule: 'other-v9', sequence: 1 },
          invocationSigner: alice.signer
        })
      )
      assert.equal(err.status, 409)
    })

    it('the body id must match the request URL (400)', async () => {
      const created = await createKeystore(alice)
      const other = await createKeystore(alice)
      const kmsClient = new KmsClient({ keystoreId: created.id })
      const err = await requestError(
        kmsClient.updateKeystore({
          config: { ...created, id: other.id, sequence: 1 },
          invocationSigner: alice.signer
        })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.errors[0].pointer, '#/id')
    })

    it('a non-controller update is masked (404)', async () => {
      const created = await createKeystore(alice)
      const kmsClient = new KmsClient({ keystoreId: created.id })
      const err = await requestError(
        kmsClient.updateKeystore({
          config: { ...created, controller: bob.did, sequence: 1 },
          invocationSigner: bob.signer
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('authentication', () => {
    it('anonymous create is 401 (no public routes on the /kms facet)', async () => {
      const response = await fetch(keystoresUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sequence: 0, controller: alice.did })
      })
      assert.equal(response.status, 401)
    })

    it('anonymous reads are 401 too (unlike WAS public reads)', async () => {
      const created = await createKeystore(alice)
      const getResponse = await fetch(created.id!)
      assert.equal(getResponse.status, 401)
      const listResponse = await fetch(
        `${keystoresUrl}?controller=${encodeURIComponent(alice.did)}`
      )
      assert.equal(listResponse.status, 401)
    })
  })
})
