/**
 * WAS conformance tests — Collection client-side encryption marker
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 *
 * Wire-contract coverage for the non-secret `encryption` marker (spec
 * "Encrypted Collections"): the server persists and echoes it, validates its
 * shape, enforces set-once immutability, a delegated consumer that did not
 * create the Collection discovers the marker by reading its Description, and the
 * fail-closed content/metadata envelope profile is enforced -- including the
 * encrypted-metadata profile (an opaque `custom` envelope on `/meta`, its own
 * `metaVersion` ETag, and replication of a metadata edit through the changes
 * feed). Raw `rootClient.request()` is used to send/inspect the marker (the
 * published high-level client does not yet forward `encryption`).
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { Collection } from '@interop/was-client'

import {
  buildZcapClients,
  createSpace,
  generateId,
  serverUrl
} from './helpers.js'

/**
 * A minimal conforming EDV Encrypted Document: the stored representation for an
 * `edv` Collection (a JSON object whose `jwe` member is a JWE-JSON envelope),
 * reused for both a content write and a `/meta` `custom` envelope.
 */
const edvDocument = {
  id: 'z1',
  sequence: 0,
  indexed: [],
  jwe: { protected: 'eyJhbGciOiJkaXI', ciphertext: 'c1phertext' }
}

describe('Encryption marker API', () => {
  let alice: any, bob: any

  before(async () => {
    ;({ alice, bob } = await buildZcapClients())
    alice.space1 = { id: generateId() }
    await createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Encryption Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
  })

  after(async () => {
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}`, serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  })

  /** POSTs a Collection (raw, so an `encryption` marker can be sent). */
  function createCollection(json: object): Promise<any> {
    return alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json
    })
  }

  it('[root] persists and echoes the marker on create', async () => {
    const response = await createCollection({
      id: 'vault',
      name: 'Vault',
      encryption: { scheme: 'edv' }
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual(response.data.encryption, { scheme: 'edv' })

    const read = await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/vault`, serverUrl).toString(),
      method: 'GET'
    })
    assert.deepStrictEqual(read.data.encryption, { scheme: 'edv' })
  })

  it('a delegated consumer discovers the marker by reading the Description', async () => {
    // Alice grants Bob read on the vault; Bob -- who did not create it --
    // rebuilds a handle and reads the Description, seeing the marker (this is how
    // a consuming app learns to decrypt with its own keys).
    const zcap = await alice.was
      .space(alice.space1.id)
      .collection('vault')
      .grant({ to: bob.did, actions: ['GET'] })

    const handle = bob.was.fromCapability(zcap)
    assert.ok(handle instanceof Collection)
    const description = (await handle.describe()) as any
    assert.deepStrictEqual(description.encryption, { scheme: 'edv' })
  })

  it('[root] rejects a malformed marker (400 invalid-request-body)', async () => {
    let expectedError: any
    try {
      await createCollection({ id: 'bad', encryption: { foo: 1 } })
    } catch (err) {
      expectedError = err
    }
    assert.ok(
      expectedError,
      'expected the malformed-marker create to be rejected'
    )
    assert.equal(expectedError.response.status, 400)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#invalid-request-body'
    )
  })

  it('[root] rejects an unrecognized scheme (400 unsupported-encryption-scheme)', async () => {
    // With v1 recognizing only `edv`, naming any other scheme -- whether on a
    // fresh Collection or as a change to `vault` -- is rejected by the
    // fail-closed scheme gate before the set-once `encryption-immutable` check
    // could apply, so the stored marker cannot be corrupted either way.
    let expectedError: any
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/vault`, serverUrl).toString(),
        method: 'PUT',
        action: 'PUT',
        json: { id: 'vault', encryption: { scheme: 'other' } }
      })
    } catch (err) {
      expectedError = err
    }
    assert.ok(expectedError, 'expected the unrecognized scheme to be rejected')
    assert.equal(expectedError.response.status, 400)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#unsupported-encryption-scheme'
    )
  })

  it('[root] rejects a non-envelope write into an encrypted Collection (422 scheme-mismatch)', async () => {
    // The fail-closed guarantee (spec "Encryption Scheme Registry"): the `vault`
    // Collection is `edv`, so a plaintext JSON write is structurally rejected --
    // server-visible plaintext can never land in an encrypted Collection, even
    // from a writer that forgets (or refuses) to encrypt.
    let expectedError: any
    try {
      await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space1.id}/vault/plaintext-doc`,
          serverUrl
        ).toString(),
        method: 'PUT',
        action: 'PUT',
        json: { hello: 'world' }
      })
    } catch (err) {
      expectedError = err
    }
    assert.ok(expectedError, 'expected the plaintext write to be rejected')
    assert.equal(expectedError.response.status, 422)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#encryption-scheme-mismatch'
    )
  })

  it('[root] accepts a conforming EDV Document into an encrypted Collection', async () => {
    // The stored representation is an EDV Encrypted Document (`{ jwe, ... }`)
    // under `application/json` -- what the EDV codec actually produces.
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/vault/envelope-doc`,
        serverUrl
      ).toString(),
      method: 'PUT',
      action: 'PUT',
      body: new TextEncoder().encode(JSON.stringify(edvDocument)),
      headers: { 'content-type': 'application/json' }
    })
    assert.equal(response.status, 204)
  })

  it('[root] rejects a plaintext `custom` on PUT /meta of an encrypted Collection (422)', async () => {
    // Spec "Encrypted Collections": on an encrypted Collection a resource's
    // user-writable `custom` metadata MUST be a conforming envelope, so a
    // plaintext `{ name }` is fail-closed rejected -- server-visible plaintext
    // name/tags can never land in an encrypted Collection.
    let expectedError: any
    try {
      await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space1.id}/vault/envelope-doc/meta`,
          serverUrl
        ).toString(),
        method: 'PUT',
        action: 'PUT',
        json: { custom: { name: 'leaked' } }
      })
    } catch (err) {
      expectedError = err
    }
    assert.ok(
      expectedError,
      'expected the plaintext /meta write to be rejected'
    )
    assert.equal(expectedError.response.status, 422)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#encryption-scheme-mismatch'
    )
  })

  it('[root] accepts an envelope `custom` on PUT /meta and returns its metaVersion ETag', async () => {
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/vault/envelope-doc/meta`,
        serverUrl
      ).toString(),
      method: 'PUT',
      action: 'PUT',
      json: { custom: edvDocument }
    })
    assert.equal(response.status, 204)
    // The `/meta` sub-resource carries its own ETag (`metaVersion`).
    assert.ok(response.headers.get('etag'), 'expected a /meta ETag')

    // GET /meta returns the opaque envelope verbatim (no plaintext name leaked).
    const read = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/vault/envelope-doc/meta`,
        serverUrl
      ).toString(),
      method: 'GET'
    })
    assert.deepStrictEqual(read.data.custom, edvDocument)
  })

  it('[root] replicates the encrypted metadata edit in the changes feed', async () => {
    // Decision 6: a metadata-only edit rides the change feed -- the resource
    // re-surfaces carrying the opaque `custom` envelope and a `metaVersion`, so a
    // replicating client picks up the metadata change without decryption.
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/vault/query`,
        serverUrl
      ).toString(),
      method: 'POST',
      action: 'POST',
      json: { profile: 'changes', limit: 100 }
    })
    assert.equal(response.status, 200)
    const doc = response.data.documents.find(
      (entry: any) => entry.id === 'envelope-doc'
    )
    assert.ok(doc, 'expected the edited resource in the feed')
    assert.deepStrictEqual(doc.custom, edvDocument)
    assert.equal(typeof doc.metaVersion, 'number')
  })
})
