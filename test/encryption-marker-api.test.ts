/**
 * Encryption-marker API tests (Vitest): the server's accept / validate /
 * persist / set-once handling of a Collection's client-side `encryption` marker
 * (spec "Encrypted Collections"). The server never decrypts -- it stores the
 * marker opaquely, validates only its shape, and enforces set-once immutability.
 *
 * These assert the server's wire contract directly (status codes, problem
 * `type`s, the echoed Description) via the signed `was.request()` escape hatch
 * (raw `HttpResponse` / raw errors), mirroring `wire-contract-api.test.ts` --
 * the high-level handles hide exactly those details. End-to-end coverage through
 * the high-level client lives in `@interop/was-client`'s own EDV integration
 * suite and the `@interop/was-conformance-suite` marker test.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Encryption marker API', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any
  const spaceId = `enc-marker-space-${crypto.randomUUID()}`

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    await alice.was.createSpace({
      id: spaceId,
      name: 'Encryption Marker Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /** Reads a Collection Description over the wire (raw JSON). */
  async function readDesc(collectionId: string): Promise<any> {
    const response = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'GET'
    })
    return response.data
  }

  /** Captures the raw error from a `was.request()` rejection. */
  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
      assert.fail('expected the request to be rejected')
    } catch (err) {
      return err
    }
  }

  /** A marker recipient entry (the JWE recipients-entry shape). */
  const recipient = (kid: string) => ({
    header: { kid, alg: 'ECDH-ES+A256KW' },
    encrypted_key: `wrapped-${kid}`
  })
  /** A valid two-epoch marker, `currentEpoch` = the newest. */
  const twoEpochMarker = () => ({
    scheme: 'edv',
    currentEpoch: 'urn:epoch:2',
    epochs: [
      { id: 'urn:epoch:2', recipients: [recipient('did:key:zApp1#ka')] },
      { id: 'urn:epoch:1', recipients: [recipient('did:key:zApp2#ka')] }
    ]
  })

  it('persists and echoes the marker on create', async () => {
    const collectionId = 'vault'
    const response = await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Vault', encryption: { scheme: 'edv' } }
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual(response.data.encryption, { scheme: 'edv' })
    assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('omits the marker for a plaintext collection (no encryption sent)', async () => {
    const collectionId = 'plain'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Plain' }
    })
    assert.equal((await readDesc(collectionId)).encryption, undefined)
  })

  it('preserves unknown extra marker fields opaquely (forward-compat)', async () => {
    const collectionId = 'forward'
    const marker = { scheme: 'edv', recipients: [{ id: 'k1', type: 'X' }] }
    const response = await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: marker }
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual((await readDesc(collectionId)).encryption, marker)
  })

  it('rejects a marker object without a string scheme (400)', async () => {
    const err = await rejection(
      alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: 'bad-noscheme', encryption: { foo: 1 } }
      })
    )
    assert.equal(err.response.status, 400)
    // The http-client layer pre-parses the problem+json body onto `err.data`.
    assert.match(err.data.type, /#invalid-request-body/)
    assert.equal(err.data.errors?.[0]?.pointer, '#/encryption')
  })

  it('rejects a non-object marker (400)', async () => {
    const err = await rejection(
      alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: 'bad-string', encryption: 'edv' }
      })
    )
    assert.equal(err.response.status, 400)
  })

  it('rejects an unrecognized scheme on create (400 unsupported-encryption-scheme)', async () => {
    const err = await rejection(
      alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: 'bad-scheme', encryption: { scheme: 'aes-gcm-siv' } }
      })
    )
    assert.equal(err.response.status, 400)
    assert.match(err.data.type, /#unsupported-encryption-scheme/)
    assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/scheme')
  })

  it('allows declaring a marker on an existing plaintext collection (absent -> present)', async () => {
    const collectionId = 'late-declare'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Late' }
    })
    const put = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    assert.equal(put.status, 204)
    assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('allows re-sending the same marker (same -> same is a no-op)', async () => {
    const collectionId = 'idempotent'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    const put = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    assert.equal(put.status, 204)
  })

  it('rejects changing to an unrecognized scheme (400 unsupported-encryption-scheme, marker unchanged)', async () => {
    // With v1 recognizing only `edv`, a scheme *change* names a scheme the
    // server cannot enforce, so the fail-closed `unsupported-encryption-scheme`
    // gate fires first -- before the set-once `encryption-immutable` (409) check,
    // which the direct-transition unit test below still exercises. Either way the
    // stored marker cannot be corrupted.
    const collectionId = 'immutable'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    const err = await rejection(
      alice.was.request({
        path: `/space/${spaceId}/${collectionId}`,
        method: 'PUT',
        json: { id: collectionId, encryption: { scheme: 'other' } }
      })
    )
    assert.equal(err.response.status, 400)
    assert.match(err.data.type, /#unsupported-encryption-scheme/)
    // The stored marker is unchanged.
    assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('leaves an existing marker untouched when an update omits encryption', async () => {
    const collectionId = 'untouched'
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    // A name-only update must not clear the marker (client #8: merge, not
    // replace) -- and it must succeed (204), not trip `encryption-immutable`.
    const put = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, name: 'Renamed' }
    })
    assert.equal(put.status, 204)
    const desc = await readDesc(collectionId)
    assert.equal(desc.name, 'Renamed')
    assert.deepStrictEqual(desc.encryption, { scheme: 'edv' })
  })

  describe('key-epoch marker validation', () => {
    it('accepts a valid multi-epoch marker and round-trips it verbatim on GET', async () => {
      const collectionId = 'epochs-ok'
      const marker = twoEpochMarker()
      const response = await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: marker }
      })
      assert.equal(response.status, 201)
      assert.deepStrictEqual((await readDesc(collectionId)).encryption, marker)
    })

    it('rejects a malformed recipient entry (400)', async () => {
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/`,
          method: 'POST',
          json: {
            id: 'epochs-badrecip',
            encryption: {
              scheme: 'edv',
              currentEpoch: 'urn:epoch:1',
              epochs: [{ id: 'urn:epoch:1', recipients: [{ foo: 1 }] }]
            }
          }
        })
      )
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-request-body/)
    })

    it('rejects `epochs` without `currentEpoch` (400)', async () => {
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/`,
          method: 'POST',
          json: {
            id: 'epochs-nocurrent',
            encryption: {
              scheme: 'edv',
              epochs: [
                { id: 'urn:epoch:1', recipients: [recipient('did:key:z#ka')] }
              ]
            }
          }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('rejects `currentEpoch` without `epochs` (400)', async () => {
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/`,
          method: 'POST',
          json: {
            id: 'epochs-noepochs',
            encryption: { scheme: 'edv', currentEpoch: 'urn:epoch:1' }
          }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('rejects a dangling `currentEpoch` (400)', async () => {
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/`,
          method: 'POST',
          json: {
            id: 'epochs-dangling',
            encryption: {
              scheme: 'edv',
              currentEpoch: 'urn:epoch:missing',
              epochs: [
                { id: 'urn:epoch:1', recipients: [recipient('did:key:z#ka')] }
              ]
            }
          }
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/currentEpoch')
    })

    it('rejects dropping an epoch on update (400 append-only)', async () => {
      const collectionId = 'epochs-drop'
      await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: twoEpochMarker() }
      })
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/${collectionId}`,
          method: 'PUT',
          json: {
            id: collectionId,
            encryption: {
              scheme: 'edv',
              currentEpoch: 'urn:epoch:2',
              epochs: [
                {
                  id: 'urn:epoch:2',
                  recipients: [recipient('did:key:zApp1#ka')]
                }
              ]
            }
          }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('rejects moving `currentEpoch` back to an older epoch on update (400)', async () => {
      const collectionId = 'epochs-rollback'
      await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: twoEpochMarker() }
      })
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/${collectionId}`,
          method: 'PUT',
          json: {
            id: collectionId,
            encryption: { ...twoEpochMarker(), currentEpoch: 'urn:epoch:1' }
          }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('allows appending an epoch + repointing `currentEpoch` (204)', async () => {
      const collectionId = 'epochs-append'
      await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: twoEpochMarker() }
      })
      const grown = {
        scheme: 'edv',
        currentEpoch: 'urn:epoch:3',
        epochs: [
          { id: 'urn:epoch:3', recipients: [recipient('did:key:zApp1#ka')] },
          ...twoEpochMarker().epochs
        ]
      }
      const put = await alice.was.request({
        path: `/space/${spaceId}/${collectionId}`,
        method: 'PUT',
        json: { id: collectionId, encryption: grown }
      })
      assert.equal(put.status, 204)
      assert.deepStrictEqual((await readDesc(collectionId)).encryption, grown)
    })

    it('allows adding a recipient to an existing epoch (204)', async () => {
      const collectionId = 'epochs-addrecip'
      await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: twoEpochMarker() }
      })
      const withNewRecipient = {
        scheme: 'edv',
        currentEpoch: 'urn:epoch:2',
        epochs: [
          {
            id: 'urn:epoch:2',
            recipients: [
              recipient('did:key:zApp1#ka'),
              recipient('did:key:zApp3#ka')
            ]
          },
          twoEpochMarker().epochs[1]
        ]
      }
      const put = await alice.was.request({
        path: `/space/${spaceId}/${collectionId}`,
        method: 'PUT',
        json: { id: collectionId, encryption: withNewRecipient }
      })
      assert.equal(put.status, 204)
    })
  })

  describe('key-epoch stamping (WAS-Key-Epoch header + /meta epoch)', () => {
    const collectionId = 'epoch-stamp'
    const resUrl = (rid: string) => `/space/${spaceId}/${collectionId}/${rid}`
    const metaOf = async (rid: string) =>
      (
        await alice.was.request({
          path: `/space/${spaceId}/${collectionId}/${rid}/meta`,
          method: 'GET'
        })
      ).data

    it('stamps the declared epoch and round-trips it through /meta, listing, and the changes feed', async () => {
      await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'Epoch Stamp' }
      })
      const put = await alice.was.request({
        path: resUrl('r1'),
        method: 'PUT',
        json: { id: 'r1', hello: 'world' },
        headers: { 'was-key-epoch': 'urn:epoch:1' }
      })
      assert.equal(put.status, 204)

      assert.equal((await metaOf('r1')).epoch, 'urn:epoch:1')

      const listing = await alice.was.request({
        path: `/space/${spaceId}/${collectionId}/`,
        method: 'GET'
      })
      const item = listing.data.items.find((entry: any) => entry.id === 'r1')
      assert.equal(item.epoch, 'urn:epoch:1')

      const changes = await alice.was.request({
        path: `/space/${spaceId}/${collectionId}/query`,
        method: 'POST',
        json: { profile: 'changes' }
      })
      const doc = changes.data.documents.find((entry: any) => entry.id === 'r1')
      assert.equal(doc.epoch, 'urn:epoch:1')
    })

    it('PUT /meta with `epoch` sets it; without preserves it', async () => {
      // Supplying `epoch` replaces the stamp.
      await alice.was.request({
        path: `/space/${spaceId}/${collectionId}/r1/meta`,
        method: 'PUT',
        json: { custom: {}, epoch: 'urn:epoch:2' }
      })
      assert.equal((await metaOf('r1')).epoch, 'urn:epoch:2')
      // Omitting `epoch` preserves the stored value (unlike `custom`).
      await alice.was.request({
        path: `/space/${spaceId}/${collectionId}/r1/meta`,
        method: 'PUT',
        json: { custom: { name: 'x' } }
      })
      assert.equal((await metaOf('r1')).epoch, 'urn:epoch:2')
    })

    it('a content rewrite WITHOUT the header clears the stamp', async () => {
      await alice.was.request({
        path: resUrl('r1'),
        method: 'PUT',
        json: { id: 'r1', hello: 'again' }
      })
      assert.equal((await metaOf('r1')).epoch, undefined)
    })

    it('rejects an empty WAS-Key-Epoch header (400)', async () => {
      const err = await rejection(
        alice.was.request({
          path: resUrl('r-bad'),
          method: 'PUT',
          json: { id: 'r-bad' },
          headers: { 'was-key-epoch': '' }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('rejects a non-string / empty `epoch` in a /meta body (400)', async () => {
      await alice.was.request({
        path: resUrl('r2'),
        method: 'PUT',
        json: { id: 'r2' }
      })
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/${collectionId}/r2/meta`,
          method: 'PUT',
          json: { custom: {}, epoch: 123 }
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '/epoch')
    })
  })

  describe('Collection Description conditional writes (ETag / If-Match)', () => {
    it('GET returns an ETag; matching If-Match bumps it; stale If-Match 412s', async () => {
      const collectionId = 'cas-col'
      const created = await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'CAS' }
      })
      assert.equal(created.status, 201)

      const got = await alice.was.request({
        path: `/space/${spaceId}/${collectionId}`,
        method: 'GET'
      })
      const etag = got.headers.get('etag')
      assert.ok(etag, 'GET Collection surfaces an ETag')

      const updated = await alice.was.request({
        path: `/space/${spaceId}/${collectionId}`,
        method: 'PUT',
        json: { id: collectionId, name: 'CAS updated' },
        headers: { 'if-match': etag! }
      })
      assert.equal(updated.status, 204)
      const newEtag = updated.headers.get('etag')
      assert.notEqual(newEtag, etag)

      // The original (now stale) validator is rejected -- the lost-update guard.
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/${collectionId}`,
          method: 'PUT',
          json: { id: collectionId, name: 'CAS conflict' },
          headers: { 'if-match': etag! }
        })
      )
      assert.equal(err.response.status, 412)
      assert.match(err.data.type, /#precondition-failed/)
    })

    it('an unconditional PUT still works (no If-Match)', async () => {
      const collectionId = 'cas-uncond'
      await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'Uncond' }
      })
      const put = await alice.was.request({
        path: `/space/${spaceId}/${collectionId}`,
        method: 'PUT',
        json: { id: collectionId, name: 'Uncond updated' }
      })
      assert.equal(put.status, 204)
      assert.ok(put.headers.get('etag'))
    })

    it('two sequential updates: the second reusing the first stale ETag 412s', async () => {
      const collectionId = 'cas-sequential'
      const created = await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'Seq' }
      })
      const etag0 = created.headers.get('etag')!
      // First update with the create ETag succeeds.
      const first = await alice.was.request({
        path: `/space/${spaceId}/${collectionId}`,
        method: 'PUT',
        json: { id: collectionId, name: 'Seq 1' },
        headers: { 'if-match': etag0 }
      })
      assert.equal(first.status, 204)
      // Second update reusing the now-stale etag0 loses.
      const err = await rejection(
        alice.was.request({
          path: `/space/${spaceId}/${collectionId}`,
          method: 'PUT',
          json: { id: collectionId, name: 'Seq 2' },
          headers: { 'if-match': etag0 }
        })
      )
      assert.equal(err.response.status, 412)
    })
  })
})
