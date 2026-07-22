/**
 * Error-registry wire-coverage stragglers (Vitest): the last two error classes
 * in `src/errors.ts` that previously had no wire-level regression guard --
 * `EncryptionImmutableError` (409) and `InvalidCollectionError` (400). These
 * assert the server's wire contract directly (status codes, problem `type`s)
 * via the signed `was.request()` escape hatch (raw `HttpResponse` / raw
 * errors), mirroring `wire-contract-api.test.ts`.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Error registry wire coverage', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any
  const spaceId = `error-registry-space-${crypto.randomUUID()}`

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    await alice.was.createSpace({
      id: spaceId,
      name: 'Error Registry Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /** Captures the raw error from a `was.request()` rejection. */
  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
      assert.fail('expected the request to be rejected')
    } catch (err) {
      return err
    }
  }

  /** Reads a Collection Description over the wire (raw JSON). */
  async function readDesc(collectionId: string): Promise<any> {
    const response = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'GET'
    })
    return response.data
  }

  describe('EncryptionImmutableError (409)', () => {
    // FINDING (WAS-49): `EncryptionImmutableError` is NOT reachable over the
    // HTTP wire in this server -- `UnsupportedEncryptionSchemeError` (400)
    // always fires first on the only path that could otherwise reach it.
    //
    // The 409 has two throw sites (src/lib/encryption.ts:376 and :457):
    //
    //  1. The scheme-CHANGE site (`assertEncryptionTransition`, :457) requires
    //     an `incoming` marker whose `scheme` differs from the persisted one.
    //     But an update's marker must first pass `assertSupportedEncryption`
    //     (CollectionRequest.put), whose fail-closed gate rejects any `scheme`
    //     not in `SUPPORTED_ENCRYPTION_SCHEMES` with
    //     `unsupported-encryption-scheme` (400). v1 registers exactly one
    //     scheme (`edv`), so any scheme that DIFFERS from an existing `edv`
    //     marker is by definition unrecognized and 400s at that earlier gate --
    //     never reaching the 409. (Re-sending the same `edv` scheme is a no-op,
    //     not a change.) A second recognized scheme would be needed to reach
    //     the 409 over the wire; that requires a `src/` change, out of scope.
    //
    //  2. The marker-CLEAR site (`assertEncryptionMarkerTransition`, :376,
    //     `incoming === undefined`) is unreachable from the handler: the PUT
    //     handler only calls the transition when `suppliedEncryption !==
    //     undefined`, and an absent body `encryption` leaves the existing
    //     marker untouched rather than clearing it. There is no wire request
    //     that reaches the transition with an undefined `incoming`.
    //
    // The 409 keeps its lib-layer guard in `test/encryption-lib.test.ts`. Here
    // we pin the reachable wire shape: the masking 400, plus proof the stored
    // marker is not corrupted.
    it('scheme change masked by unsupported-encryption-scheme (400), marker intact', async () => {
      const collectionId = 'immutable-wire'
      await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: { scheme: 'edv' } }
      })
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/${collectionId}`,
          method: 'PUT',
          json: { id: collectionId, encryption: { scheme: 'aes-gcm-siv' } }
        })
      )
      // The fail-closed scheme gate fires before the set-once 409 check.
      assert.equal(err.response.status, 400)
      assert.equal(
        err.data.type,
        'https://wallet.storage/spec#unsupported-encryption-scheme'
      )
      assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/scheme')
      // The stored marker is unchanged -- the 409's invariant still holds.
      assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
        scheme: 'edv'
      })
    })
  })

  describe('InvalidCollectionError (400)', () => {
    // `InvalidCollectionError` (src/errors.ts:401) is thrown at
    // CollectionRequest.put (src/requests/CollectionRequest.ts:239) when the
    // Update (or Create By Id) Collection request has no body. A signed,
    // bodyless PUT (no Content-Type, so the digest hooks pass through) reaches
    // the handler and trips the `if (!body)` guard -- a plain wire-reachable
    // `invalid-request-body` (400).
    it('a bodyless PUT to a Collection yields invalid-request-body (400)', async () => {
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/no-body-collection`,
          method: 'PUT'
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(
        err.data.type,
        'https://wallet.storage/spec#invalid-request-body'
      )
      assert.equal(err.data.title, 'Invalid Collection Description body')
    })

    it('a JSON `null` body PUT to a Collection yields invalid-request-body (400)', async () => {
      // A parsed body of `null` is also falsy, so the same guard fires -- this
      // covers the bodied (signed `Digest`) path to the error in addition to
      // the bodyless one above.
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/null-body-collection`,
          method: 'PUT',
          json: null
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(
        err.data.type,
        'https://wallet.storage/spec#invalid-request-body'
      )
      assert.equal(err.data.title, 'Invalid Collection Description body')
    })
  })
})
