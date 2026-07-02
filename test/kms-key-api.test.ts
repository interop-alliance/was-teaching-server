/**
 * WebKMS key operation tests (Vitest): POST `/kms/keystores/:keystoreId/keys`
 * (generate), POST / GET `/kms/keystores/:keystoreId/keys/:keyId` (operation
 * dispatch / public key description) -- Track B of `_spec/web-kms-roadmap.md`.
 * Driven through `@interop/webkms-client`'s `KeystoreAgent` and all four key
 * classes wherever the client covers the operation (the client IS the
 * conformance suite for the webkms wire contract), with raw `@interop/ezcap`
 * invocations for what it does not: wire-level delegated-invocation
 * assertions and key description GETs (the client's keyId-only description
 * fetch is broken in the fork). Delegated invocations are additionally
 * driven through the client's `fromCapability` path, which works against
 * this http://localhost server as of `@interop/webkms-client@14.5.0` (the
 * loopback exception to its `https:`-only delegated-target check).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  KmsClient,
  KeystoreAgent,
  AsymmetricKey,
  KeyAgreementKey,
  Hmac,
  Kek
} from '@interop/webkms-client'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { IRootZcap } from '../src/types.js'
import { client, zcapClients } from './helpers.js'

describe('WebKMS key operations (/kms/keystores/:keystoreId/keys)', () => {
  let fastify: FastifyInstance,
    backend: FileSystemBackend,
    serverUrl: string,
    keystoresUrl: string,
    keystoreId: string,
    keystoreAgent: KeystoreAgent,
    dataDir: string,
    alice: any,
    aliceDelegatedApp: any,
    bob: any
  const PORT = 7802

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}`
    keystoresUrl = `${serverUrl}/kms/keystores`
    ;({ alice, aliceDelegatedApp, bob } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    backend = new FileSystemBackend({ dataDir })
    fastify = createApp({ serverUrl, backend })
    await fastify.listen({ port: PORT })

    // Provision Alice's keystore and hang a KeystoreAgent off it, the way a
    // wallet would at login. The agent only needs a `getSigner()` capability
    // agent; Alice's root signer plays that part.
    const config = await KmsClient.createKeystore({
      url: keystoresUrl,
      config: { sequence: 0, controller: alice.did },
      invocationSigner: alice.signer
    })
    keystoreId = config.id
    keystoreAgent = new KeystoreAgent({
      capabilityAgent: { getSigner: () => alice.signer } as any,
      keystoreId,
      kmsClient: new KmsClient({ keystoreId })
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /**
   * The root capability for a target URL (the keystore, for key routes) in
   * object form: the ezcap client requires `https:` targets for *string* root
   * capability ids, and the object form is the escape hatch for the http
   * dev/test server (it reduces to the bare `zcap id="..."` header either
   * way). Its controller is the keystore controller -- the same root the
   * server synthesizes during verification.
   */
  function rootZcap(target: string): IRootZcap {
    return {
      '@context': 'https://w3id.org/zcap/v1',
      id: `urn:zcap:root:${encodeURIComponent(target)}`,
      invocationTarget: target,
      controller: alice.did
    }
  }

  /** Fetches a key description via a raw root-zcap GET (action `read`). */
  async function getDescription(keyUrl: string, signer = alice.signer) {
    const response = await client({ signer }).request({
      url: keyUrl,
      method: 'GET',
      action: 'read',
      capability: rootZcap(keystoreId)
    })
    return response.data as any
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

  describe('generate', () => {
    it('generateKey provisions an Ed25519 signing key (AsymmetricKey)', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      assert.ok(key instanceof AsymmetricKey)
      // Server-generated key URL under the keystore's keys collection.
      assert.match(
        key.kmsId!,
        new RegExp(`^${keystoreId}/keys/z[1-9A-HJ-NP-Za-km-z]+$`)
      )
      // No alias: the description id IS the key URL.
      assert.equal(key.id, key.kmsId)
      const description = (await key.getKeyDescription()) as any
      assert.equal(
        description['@context'],
        'https://w3id.org/security/suites/ed25519-2020/v1'
      )
      assert.equal(description.type, 'Ed25519VerificationKey2020')
      assert.equal(description.controller, alice.did)
      // The multikey header drives the client's algorithm mapping.
      assert.match(description.publicKeyMultibase, /^z6Mk/)
      assert.equal(key.algorithm, 'Ed25519')
    })

    it('responds 200 with a Location header and a {keyId, keyDescription} body', async () => {
      const response = await client({ signer: alice.signer }).request({
        url: `${keystoreId}/keys`,
        method: 'POST',
        action: 'generateKey',
        capability: rootZcap(keystoreId),
        json: {
          type: 'GenerateKeyOperation',
          invocationTarget: { type: 'Ed25519VerificationKey2020' }
        }
      })
      // 200, not the keystore create's 201 (webkms-switch parity); the client
      // reads the key id from the body, never the header.
      assert.equal(response.status, 200)
      const { keyId, keyDescription } = response.data as any
      assert.equal(response.headers.get('location'), keyId)
      assert.equal(keyDescription.id, keyId)
      assert.equal(keyDescription.controller, alice.did)
    })

    it('generates the symmetric and key-agreement types with their suite contexts', async () => {
      const hmac = (await keystoreAgent.generateKey({ type: 'hmac' })) as Hmac
      assert.ok(hmac instanceof Hmac)
      const kek = (await keystoreAgent.generateKey({ type: 'kek' })) as Kek
      assert.ok(kek instanceof Kek)
      const keyAgreement = (await keystoreAgent.generateKey({
        type: 'keyAgreement'
      })) as KeyAgreementKey
      assert.ok(keyAgreement instanceof KeyAgreementKey)

      const hmacDescription = await getDescription(hmac.id!)
      assert.equal(
        hmacDescription['@context'],
        'https://w3id.org/security/suites/hmac-2019/v1'
      )
      assert.equal(hmacDescription.type, 'Sha256HmacKey2019')
      const kekDescription = await getDescription(kek.id!)
      assert.equal(
        kekDescription['@context'],
        'https://w3id.org/security/suites/aes-2019/v1'
      )
      assert.equal(kekDescription.type, 'AesKeyWrappingKey2019')
      const keyAgreementDescription = await getDescription(
        (keyAgreement as any).kmsId
      )
      assert.equal(
        keyAgreementDescription['@context'],
        'https://w3id.org/security/suites/x25519-2020/v1'
      )
      assert.match(keyAgreementDescription.publicKeyMultibase, /^z6LS/)

      // The description projection never carries secret material.
      for (const description of [
        hmacDescription,
        kekDescription,
        keyAgreementDescription
      ]) {
        assert.ok(!('secret' in description))
        assert.ok(!('privateKeyMultibase' in description))
      }
    })

    it('an unsupported key type is 400', async () => {
      const err = await requestError(
        keystoreAgent.kmsClient.generateKey({
          type: 'urn:webkms:multikey:P-256',
          invocationSigner: alice.signer
        })
      )
      assert.equal(err.status, 400)
    })

    it('publicAliasTemplate expands against the key description', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric',
        publicAliasTemplate: 'did:key:{publicKeyMultibase}#{publicKeyMultibase}'
      })) as AsymmetricKey
      const description = (await key.getKeyDescription()) as any
      const { publicKeyMultibase } = description
      assert.equal(
        key.id,
        `did:key:${publicKeyMultibase}#${publicKeyMultibase}`
      )
      // The KMS key URL is unchanged; only the description id is aliased --
      // and stably so on every subsequent read.
      assert.notEqual(key.id, key.kmsId)
      const reread = await getDescription(key.kmsId!)
      assert.equal(reread.id, key.id)
    })

    it('publicAlias is used verbatim as the description id', async () => {
      const alias = 'did:example:alias#key-1'
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric',
        publicAlias: alias
      })) as AsymmetricKey
      assert.equal(key.id, alias)
    })

    it('publicAlias and publicAliasTemplate together are 400', async () => {
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: `${keystoreId}/keys`,
          method: 'POST',
          action: 'generateKey',
          capability: rootZcap(keystoreId),
          json: {
            type: 'GenerateKeyOperation',
            invocationTarget: {
              type: 'Ed25519VerificationKey2020',
              publicAlias: 'did:example:alias#key-1',
              publicAliasTemplate: 'did:key:{publicKeyMultibase}'
            }
          }
        })
      )
      assert.equal(err.status, 400)
    })

    it('maxCapabilityChainLength outside 1-10 is 400', async () => {
      for (const maxCapabilityChainLength of [0, 11]) {
        const err = await requestError(
          client({ signer: alice.signer }).request({
            url: `${keystoreId}/keys`,
            method: 'POST',
            action: 'generateKey',
            capability: rootZcap(keystoreId),
            json: {
              type: 'GenerateKeyOperation',
              invocationTarget: {
                type: 'Ed25519VerificationKey2020',
                maxCapabilityChainLength
              }
            }
          })
        )
        assert.equal(err.status, 400)
      }
    })

    it('a duplicate key record insert is the protocol 409 (storage contract)', async () => {
      // Key local ids are server-generated 128-bit random values, so the API
      // cannot collide; the storage layer still enforces insert-once.
      const record = {
        keystoreId: 'zTestKeystore',
        localId: 'zTestKey',
        meta: { created: 'now', updated: 'now' },
        key: {
          '@context': 'https://w3id.org/security/suites/hmac-2019/v1',
          id: 'urn:test:key',
          type: 'Sha256HmacKey2019',
          secret: randomBytes(32).toString('base64url')
        }
      }
      await backend.insertKey({
        keystoreId: record.keystoreId,
        localId: record.localId,
        record
      })
      const err = await requestError(
        backend.insertKey({
          keystoreId: record.keystoreId,
          localId: record.localId,
          record
        })
      )
      assert.equal(err.statusCode, 409)
    })
  })

  describe('sign and verify', () => {
    it('AsymmetricKey.sign round-trips, verified client-side', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const data = new TextEncoder().encode('hello was-teaching-server')
      const signature = await key.sign({ data })
      assert.ok(signature instanceof Uint8Array)

      // Asymmetric verification is deliberately client-local: verify against
      // the description's publicKeyMultibase, never the KMS.
      const { publicKeyMultibase, type } =
        (await key.getKeyDescription()) as any
      const verifierKey = await Ed25519VerificationKey.from({
        type,
        publicKeyMultibase
      })
      const verifier = verifierKey.verifier()
      assert.equal(await verifier.verify({ data, signature }), true)
      const tampered = new TextEncoder().encode('tampered data')
      assert.equal(await verifier.verify({ data: tampered, signature }), false)
    })

    it('server VerifyOperation on an asymmetric key is a clean 400', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const data = new TextEncoder().encode('data')
      const signature = await key.sign({ data })
      // AsymmetricKey.verify exists for API symmetry with Hmac.verify but is
      // not served (custody: verify needs only the public key).
      const err = await requestError(
        key.verify({ data, signature: signature as any })
      )
      assert.equal(err.status, 400)
    })

    it('Hmac.sign / Hmac.verify round-trip through the KMS', async () => {
      const hmac = (await keystoreAgent.generateKey({ type: 'hmac' })) as Hmac
      const data = new TextEncoder().encode('hmac me')
      const signature = (await hmac.sign({ data })) as Uint8Array
      // HMAC-SHA-256: a 32-byte tag.
      assert.equal(signature.length, 32)
      assert.equal(await hmac.verify({ data, signature }), true)
      const tampered = new TextEncoder().encode('tampered')
      assert.equal(await hmac.verify({ data: tampered, signature }), false)
    })

    it('a wrong-length signatureValue is verified:false, not an error', async () => {
      const hmac = (await keystoreAgent.generateKey({ type: 'hmac' })) as Hmac
      // 3 bytes -- bedrock's uncaught `timingSafeEqual` RangeError case.
      const response = await client({ signer: alice.signer }).request({
        url: hmac.id!,
        method: 'POST',
        action: 'verify',
        capability: rootZcap(keystoreId),
        json: {
          type: 'VerifyOperation',
          invocationTarget: hmac.id,
          verifyData: Buffer.from('data').toString('base64url'),
          signatureValue: Buffer.from([1, 2, 3]).toString('base64url')
        }
      })
      assert.equal(response.status, 200)
      assert.deepEqual(response.data, { verified: false })
    })
  })

  describe('key agreement (X25519 deriveSecret)', () => {
    it('deriveSecret matches the locally computed ECDH secret', async () => {
      const keyAgreementKey = (await keystoreAgent.generateKey({
        type: 'keyAgreement'
      })) as KeyAgreementKey
      const peer = await X25519KeyAgreementKey2020.generate()
      // Send only the peer's public fields (never its private key).
      const secret = await keyAgreementKey.deriveSecret({
        publicKey: {
          id: peer.id,
          type: peer.type,
          publicKeyMultibase: peer.publicKeyMultibase
        }
      })
      // The same raw shared secret, derived on the peer's side against the
      // KMS key's public description.
      const kmsDescription = await getDescription(
        (keyAgreementKey as any).kmsId
      )
      const expected = await peer.deriveSecret({ publicKey: kmsDescription })
      assert.deepEqual(Buffer.from(secret), Buffer.from(expected))
    })

    it('a mismatched publicKey.type is a clean 400', async () => {
      const keyAgreementKey = (await keystoreAgent.generateKey({
        type: 'keyAgreement'
      })) as KeyAgreementKey
      const keyUrl = (keyAgreementKey as any).kmsId
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: keyUrl,
          method: 'POST',
          action: 'deriveSecret',
          capability: rootZcap(keystoreId),
          json: {
            type: 'DeriveSecretOperation',
            invocationTarget: keyUrl,
            publicKey: {
              type: 'Ed25519VerificationKey2020',
              publicKeyMultibase:
                'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
            }
          }
        })
      )
      assert.equal(err.status, 400)
    })
  })

  describe('key wrapping (AES-KW)', () => {
    it('wrapKey / unwrapKey round-trips a content encryption key', async () => {
      const kek = (await keystoreAgent.generateKey({ type: 'kek' })) as Kek
      const contentKey = new Uint8Array(randomBytes(32))
      const wrappedKey = (await kek.wrapKey({
        unwrappedKey: contentKey
      })) as Uint8Array
      // RFC 3394: wrapping a 32-byte key yields 40 bytes.
      assert.equal(wrappedKey.length, 40)
      const unwrapped = await kek.unwrapKey({ wrappedKey: wrappedKey as any })
      assert.deepEqual(Buffer.from(unwrapped!), Buffer.from(contentKey))
    })

    it('a failed unwrap resolves null, not an error', async () => {
      const kek = (await keystoreAgent.generateKey({ type: 'kek' })) as Kek
      const otherKek = (await keystoreAgent.generateKey({
        type: 'kek'
      })) as Kek
      const wrappedKey = (await kek.wrapKey({
        unwrappedKey: new Uint8Array(randomBytes(32))
      })) as Uint8Array
      // Corrupted ciphertext: the RFC 3394 integrity check rejects it.
      const corrupted = new Uint8Array(wrappedKey)
      corrupted[0]! ^= 1
      assert.equal(await kek.unwrapKey({ wrappedKey: corrupted as any }), null)
      // Wrong KEK: same contract.
      assert.equal(
        await otherKek.unwrapKey({ wrappedKey: wrappedKey as any }),
        null
      )
    })
  })

  describe('delegated capabilities', () => {
    it('a key-scoped delegated zcap signs (target attenuation)', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const keyUrl = key.kmsId!
      // Alice delegates `sign` on this one key to her app; the chain roots in
      // the keystore's root capability, attenuated down to the key URL.
      const zcap = await client({ signer: alice.signer }).delegate({
        capability: rootZcap(keystoreId),
        invocationTarget: keyUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['sign']
      })
      const data = new TextEncoder().encode('signed via delegation')
      const response = await client({
        signer: aliceDelegatedApp.signer
      }).request({
        url: keyUrl,
        method: 'POST',
        action: 'sign',
        capability: zcap,
        json: {
          type: 'SignOperation',
          invocationTarget: keyUrl,
          verifyData: Buffer.from(data).toString('base64url')
        }
      })
      assert.equal(response.status, 200)
      const { signatureValue } = response.data as { signatureValue: string }
      const { publicKeyMultibase, type } =
        (await key.getKeyDescription()) as any
      const verifierKey = await Ed25519VerificationKey.from({
        type,
        publicKeyMultibase
      })
      const verified = await verifierKey.verifier().verify({
        data,
        signature: new Uint8Array(Buffer.from(signatureValue, 'base64url'))
      })
      assert.equal(verified, true)
    })

    it('the webkms-client signs via a delegated zcap (fromCapability, http loopback)', async () => {
      // The full Track E client path: the delegee holds only the delegated
      // zcap and drives the key through the client's own class -- possible
      // against an http://localhost server since webkms-client@14.5.0.
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const keyUrl = key.kmsId!
      const zcap = await client({ signer: alice.signer }).delegate({
        capability: rootZcap(keystoreId),
        invocationTarget: keyUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['read', 'sign']
      })
      const delegatedKey = await AsymmetricKey.fromCapability({
        capability: zcap,
        invocationSigner: aliceDelegatedApp.signer
      })
      const data = new TextEncoder().encode('signed via the client')
      const signature = await delegatedKey.sign({ data })
      const { publicKeyMultibase, type } =
        (await key.getKeyDescription()) as any
      const verifierKey = await Ed25519VerificationKey.from({
        type,
        publicKeyMultibase
      })
      assert.equal(
        await verifierKey.verifier().verify({ data, signature }),
        true
      )
    })

    it('a keystore-scoped delegated zcap reaches any of its keys', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const zcap = await client({ signer: alice.signer }).delegate({
        capability: rootZcap(keystoreId),
        invocationTarget: keystoreId,
        controller: aliceDelegatedApp.did,
        allowedActions: ['sign']
      })
      const response = await client({
        signer: aliceDelegatedApp.signer
      }).request({
        url: key.kmsId!,
        method: 'POST',
        action: 'sign',
        capability: zcap,
        json: {
          type: 'SignOperation',
          invocationTarget: key.kmsId,
          verifyData: Buffer.from('data').toString('base64url')
        }
      })
      assert.equal(response.status, 200)
    })

    it('a key-scoped zcap does not reach a sibling key (404)', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const siblingKey = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const zcap = await client({ signer: alice.signer }).delegate({
        capability: rootZcap(keystoreId),
        invocationTarget: key.kmsId!,
        controller: aliceDelegatedApp.did,
        allowedActions: ['sign']
      })
      // The ezcap client refuses to even send this (its confused-deputy
      // check), so sign the invocation by hand -- exactly what a buggy or
      // malicious client would put on the wire.
      const url = siblingKey.kmsId!
      const json = {
        type: 'SignOperation',
        invocationTarget: url,
        verifyData: Buffer.from('data').toString('base64url')
      }
      const headers = await signCapabilityInvocation({
        url,
        method: 'POST',
        headers: {},
        json,
        capability: zcap,
        capabilityAction: 'sign',
        invocationSigner: aliceDelegatedApp.signer
      })
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(json)
      })
      assert.equal(response.status, 404)
    })

    it('the delegated action must match the operation (404)', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const zcap = await client({ signer: alice.signer }).delegate({
        capability: rootZcap(keystoreId),
        invocationTarget: key.kmsId!,
        controller: aliceDelegatedApp.did,
        allowedActions: ['read']
      })
      const err = await requestError(
        client({ signer: aliceDelegatedApp.signer }).request({
          url: key.kmsId!,
          method: 'POST',
          action: 'sign',
          capability: zcap,
          json: {
            type: 'SignOperation',
            invocationTarget: key.kmsId,
            verifyData: Buffer.from('data').toString('base64url')
          }
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('key description', () => {
    it('the controller reads the description (read action, root zcap)', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const description = await getDescription(key.kmsId!)
      assert.equal(description.id, key.kmsId)
      assert.equal(description.controller, alice.did)
      assert.ok(description.publicKeyMultibase)
      assert.ok(!('privateKeyMultibase' in description))
    })

    it("a non-controller's read is masked (404)", async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const err = await requestError(getDescription(key.kmsId!, bob.signer))
      assert.equal(err.status, 404)
    })

    it('an unknown key is masked (404)', async () => {
      const err = await requestError(
        getDescription(`${keystoreId}/keys/z1111unknown`)
      )
      assert.equal(err.status, 404)
    })

    it('an unknown keystore is masked (404)', async () => {
      const unknownKeystore = `${keystoresUrl}/z1111unknown`
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: `${unknownKeystore}/keys/z2222unknown`,
          method: 'GET',
          action: 'read',
          capability: rootZcap(unknownKeystore)
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('operation envelope', () => {
    it('the invocationTarget must match the request URL (400)', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const otherKey = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: key.kmsId!,
          method: 'POST',
          action: 'sign',
          capability: rootZcap(keystoreId),
          json: {
            type: 'SignOperation',
            // Names the sibling key, posted to `key` -- webkms-switch's
            // invocation-target-vs-request-URL 400.
            invocationTarget: otherKey.kmsId,
            verifyData: Buffer.from('data').toString('base64url')
          }
        })
      )
      assert.equal(err.status, 400)
    })

    it('an unknown operation type is a clean 400 not-supported', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      for (const type of ['FooOperation', 'GenerateKeyOperation']) {
        const err = await requestError(
          client({ signer: alice.signer }).request({
            url: key.kmsId!,
            method: 'POST',
            action: 'sign',
            capability: rootZcap(keystoreId),
            json: { type, invocationTarget: key.kmsId }
          })
        )
        assert.equal(err.status, 400)
      }
    })

    it('an unsupported operation/key-type combo is a clean 400', async () => {
      // SignOperation on a key-wrapping key: well-formed, wrong key type.
      const kek = (await keystoreAgent.generateKey({ type: 'kek' })) as Kek
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: kek.id!,
          method: 'POST',
          action: 'sign',
          capability: rootZcap(keystoreId),
          json: {
            type: 'SignOperation',
            invocationTarget: kek.id,
            verifyData: Buffer.from('data').toString('base64url')
          }
        })
      )
      assert.equal(err.status, 400)
      assert.equal(
        err.data.type,
        'https://wallet.storage/spec#invalid-request-body'
      )
    })

    it('unexpected envelope properties are rejected (400)', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: key.kmsId!,
          method: 'POST',
          action: 'sign',
          capability: rootZcap(keystoreId),
          json: {
            type: 'SignOperation',
            invocationTarget: key.kmsId,
            verifyData: Buffer.from('data').toString('base64url'),
            proofPurpose: 'assertionMethod'
          }
        })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.errors[0].pointer, '#/proofPurpose')
    })
  })

  describe('authentication', () => {
    it('anonymous key requests are 401', async () => {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const generateResponse = await fetch(`${keystoreId}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'GenerateKeyOperation',
          invocationTarget: { type: 'Ed25519VerificationKey2020' }
        })
      })
      assert.equal(generateResponse.status, 401)
      const getResponse = await fetch(key.kmsId!)
      assert.equal(getResponse.status, 401)
    })
  })
})
