/**
 * End-to-end tests for at-rest WebKMS key-record encryption
 * (`KMS_RECORD_KEK`), driving `createApp` with a record KEK and
 * inspecting what lands on disk. Complements the pure-function coverage in
 * test/kms-record-cipher.test.ts:
 * - round-trip: a key generated under a KEK is stored encrypted (no plaintext
 *   secret on disk) yet still signs;
 * - off switch: unconfigured, the on-disk record is plaintext (regression guard
 *   for the teaching default);
 * - pass-through upgrade: a plaintext record written before a KEK was enabled
 *   still reads and signs after the switch is thrown;
 * - rotation: a record written under one KEK still signs after `currentKekId`
 *   is repointed to a second.
 */
import { it, describe, beforeAll } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  KmsClient,
  KeystoreAgent,
  type AsymmetricKey
} from '@interop/webkms-client'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { IdEncoder } from '@digitalcredentials/bnid'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { parseKekMultibase } from '../src/lib/kmsRecordCipher.js'
import type {
  IRootZcap,
  KmsRecordKekRegistry,
  RecordKek
} from '../src/types.js'
import { client, zcapClients } from './helpers.js'

/** A base58btc Multikey `secretKeyMultibase` for a raw 32-byte AES-256 key. */
function kekMultibase(key: Buffer): string {
  const bytes = Buffer.concat([Buffer.from([0xa2, 0x01]), key])
  return new IdEncoder({ encoding: 'base58', multibase: true }).encode(bytes)
}

/** A single-KEK registry (as config parsing would build). */
function singleKekRegistry(kek: RecordKek): KmsRecordKekRegistry {
  return { keks: new Map([[kek.id, kek]]), currentKekId: kek.id }
}

describe('WebKMS at-rest key-record encryption (KMS_RECORD_KEK)', () => {
  let alice: any
  const PORT = 7815
  const serverUrl = `http://localhost:${PORT}`

  beforeAll(async () => {
    ;({ alice } = await zcapClients({ serverUrl }))
  })

  /**
   * Boots a server over `dataDir` with the given (optional) record-KEK registry
   * and hangs a KeystoreAgent off a freshly-provisioned keystore. Reuses the
   * fixed `serverUrl` / `PORT` so a caller can tear the server down and boot a
   * second one over the same `dataDir` (the pass-through / rotation upgrades).
   */
  async function bootServer({
    dataDir,
    kmsRecordKek
  }: {
    dataDir: string
    kmsRecordKek?: KmsRecordKekRegistry
  }): Promise<{
    fastify: FastifyInstance
    keystoreAgent: KeystoreAgent
    keystoreId: string
  }> {
    const backend = new FileSystemBackend({ dataDir })
    const fastify = createApp({ serverUrl, backend, kmsRecordKek })
    await fastify.listen({ port: PORT })
    const config = await KmsClient.createKeystore({
      url: `${serverUrl}/kms/keystores`,
      config: { sequence: 0, controller: alice.did },
      invocationSigner: alice.signer
    })
    const keystoreId = config.id!
    const keystoreAgent = new KeystoreAgent({
      capabilityAgent: { getSigner: () => alice.signer } as any,
      keystoreId,
      kmsClient: new KmsClient({ keystoreId })
    })
    return { fastify, keystoreAgent, keystoreId }
  }

  /** Re-attaches a KeystoreAgent to an already-provisioned keystore URL. */
  function reattach(keystoreId: string): KeystoreAgent {
    return new KeystoreAgent({
      capabilityAgent: { getSigner: () => alice.signer } as any,
      keystoreId,
      kmsClient: new KmsClient({ keystoreId })
    })
  }

  /** The on-disk record file for a key, given its full `kmsId` URL. */
  function keyFile(dataDir: string, kmsId: string): string {
    // kmsId is `<serverUrl>/kms/keystores/<keystoreLocalId>/keys/<keyLocalId>`.
    const [keystoreLocalId, keyLocalId] = kmsId
      .slice(`${serverUrl}/kms/keystores/`.length)
      .split('/keys/')
    return path.join(
      dataDir,
      'keystores',
      keystoreLocalId!,
      'keys',
      `${keyLocalId}.json`
    )
  }

  /** Reads a stored key record off disk. */
  async function readRecord(dataDir: string, kmsId: string): Promise<any> {
    return JSON.parse(await readFile(keyFile(dataDir, kmsId), 'utf8'))
  }

  /**
   * Server-side sign (exercises the decrypt path -- an asymmetric SignOperation
   * needs the private key), then client-local verify against the public key.
   */
  async function signVerifies(key: AsymmetricKey): Promise<boolean> {
    const data = new TextEncoder().encode('at-rest encryption round-trip')
    const signature = await key.sign!({ data })
    const { publicKeyMultibase, type } = (await key.getKeyDescription()) as any
    const verifier = (
      await Ed25519VerificationKey.from({ type, publicKeyMultibase })
    ).verifier()
    return verifier.verify({ data, signature })
  }

  it('stores an encrypted record (no plaintext secret) that still signs', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'was-kek-'))
    const kek = parseKekMultibase(kekMultibase(randomBytes(32)))
    const { fastify, keystoreAgent } = await bootServer({
      dataDir,
      kmsRecordKek: singleKekRegistry(kek)
    })
    try {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey

      // On disk: the secret is gone, replaced by the envelope under this KEK.
      const record = await readRecord(dataDir, key.kmsId!)
      assert.equal(record.key.privateKeyMultibase, undefined)
      assert.ok(record.key.encrypted, 'record carries an `encrypted` envelope')
      assert.equal(record.key.encrypted.kekId, kek.id)
      assert.equal(record.key.encrypted.encoding, 'json')
      // The public projection field stays in the clear (allowlist), so a reader
      // never needs the KEK to describe the key.
      assert.ok(typeof record.key.publicKeyMultibase === 'string')

      // ...and the key still operates end-to-end (server decrypts to sign).
      assert.equal(await signVerifies(key), true)
    } finally {
      await fastify.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('off switch: unconfigured, the on-disk record is plaintext', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'was-kek-'))
    const { fastify, keystoreAgent } = await bootServer({ dataDir })
    try {
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const record = await readRecord(dataDir, key.kmsId!)
      assert.equal(record.key.encrypted, undefined, 'no envelope')
      assert.ok(
        typeof record.key.privateKeyMultibase === 'string',
        'private key material is stored in the clear (the teaching default)'
      )
    } finally {
      await fastify.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('pass-through upgrade: a plaintext record still reads after a KEK is enabled', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'was-kek-'))
    // Phase 1: no KEK -- generate a plaintext key, then shut down.
    const first = await bootServer({ dataDir })
    let kmsId: string
    try {
      const key = (await first.keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      kmsId = key.kmsId!
      const record = await readRecord(dataDir, kmsId)
      assert.equal(
        record.key.encrypted,
        undefined,
        'phase 1 record is plaintext'
      )
    } finally {
      await first.fastify.close()
    }

    // Phase 2: enable a KEK over the SAME data tree. The old plaintext record is
    // not retroactively encrypted, but it still decrypts (pass-through) and
    // signs.
    const backend = new FileSystemBackend({ dataDir })
    const kek = parseKekMultibase(kekMultibase(randomBytes(32)))
    const fastify = createApp({
      serverUrl,
      backend,
      kmsRecordKek: singleKekRegistry(kek)
    })
    await fastify.listen({ port: PORT })
    try {
      const keystoreLocalId = kmsId
        .slice(`${serverUrl}/kms/keystores/`.length)
        .split('/keys/')[0]!
      const keystoreAgent = reattach(
        `${serverUrl}/kms/keystores/${keystoreLocalId}`
      )
      const key = (await keystoreAgent.getAsymmetricKey({
        kmsId,
        id: kmsId,
        type: 'Ed25519VerificationKey2020'
      } as any)) as AsymmetricKey
      // The stored record is still plaintext (never rewritten)...
      const record = await readRecord(dataDir, kmsId)
      assert.equal(record.key.encrypted, undefined)
      // ...yet the server reads it and signs.
      assert.equal(await signVerifies(key), true)
    } finally {
      await fastify.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('list keys under a KEK returns the same public descriptions as Get Key (no envelope leak)', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'was-kek-'))
    const kek = parseKekMultibase(kekMultibase(randomBytes(32)))
    const { fastify, keystoreAgent, keystoreId } = await bootServer({
      dataDir,
      kmsRecordKek: singleKekRegistry(kek)
    })
    // The keystore's root capability, in object form (the http-loopback escape
    // hatch the ezcap client requires for a non-https target).
    const rootZcap: IRootZcap = {
      '@context': 'https://w3id.org/zcap/v1',
      id: `urn:zcap:root:${encodeURIComponent(keystoreId)}`,
      invocationTarget: keystoreId,
      controller: alice.did
    }
    try {
      // Generate two asymmetric keys -- each stored as an encrypted envelope.
      const keys = [
        (await keystoreAgent.generateKey({
          type: 'asymmetric'
        })) as AsymmetricKey,
        (await keystoreAgent.generateKey({
          type: 'asymmetric'
        })) as AsymmetricKey
      ]
      // Both records are on disk in encrypted form (guard for the premise).
      for (const key of keys) {
        assert.ok((await readRecord(dataDir, key.kmsId!)).key.encrypted)
      }

      // List through the KEK-configured server.
      const { results } = (
        await client({ signer: alice.signer }).request({
          url: `${keystoreId}/keys`,
          method: 'GET',
          action: 'read',
          capability: rootZcap
        })
      ).data as any

      // Every listed description equals the per-key Get Key description (the
      // canonical projection) and carries no envelope or secret field -- so the
      // at-rest cipher is invisible on the wire, exactly as list-without-a-KEK.
      for (const key of keys) {
        const expected = (
          await client({ signer: alice.signer }).request({
            url: key.kmsId!,
            method: 'GET',
            action: 'read',
            capability: rootZcap
          })
        ).data as any
        const listed = results.find((entry: any) => entry.id === expected.id)
        assert.ok(listed, `listing is missing ${key.kmsId}`)
        // The Get Key projection plus the list-only `keyUrl` stamp.
        assert.deepEqual(listed, { ...expected, keyUrl: key.kmsId })
        assert.ok(!('encrypted' in listed))
        assert.ok(!('privateKeyMultibase' in listed))
        assert.ok(!('secret' in listed))
      }
    } finally {
      await fastify.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('list keys enumerates public descriptions even when the KEK is gone; secret reads fail (recovery path)', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'was-kek-'))
    const kek = parseKekMultibase(kekMultibase(randomBytes(32)))

    // Phase 1: generate two keys wrapped under `kek`, then shut down.
    const first = await bootServer({
      dataDir,
      kmsRecordKek: singleKekRegistry(kek)
    })
    let keystoreId: string
    let kmsIds: string[]
    try {
      const keyA = (await first.keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const keyB = (await first.keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      keystoreId = first.keystoreId
      kmsIds = [keyA.kmsId!, keyB.kmsId!]
      assert.ok((await readRecord(dataDir, keyA.kmsId!)).key.encrypted)
    } finally {
      await first.fastify.close()
    }

    // Phase 2: boot over the SAME data tree with NO KEK configured -- the KEK
    // that wrapped these records is lost (the recovery scenario this endpoint
    // exists for: a frozen did:webvh log whose key id must be rediscovered).
    const backend = new FileSystemBackend({ dataDir })
    const fastify = createApp({ serverUrl, backend })
    await fastify.listen({ port: PORT })
    const rootZcap: IRootZcap = {
      '@context': 'https://w3id.org/zcap/v1',
      id: `urn:zcap:root:${encodeURIComponent(keystoreId)}`,
      invocationTarget: keystoreId,
      controller: alice.did
    }
    try {
      // List still enumerates the public descriptions -- decrypt-free, so a
      // missing KEK does not block it (nor does one poison record deny the rest).
      const { results } = (
        await client({ signer: alice.signer }).request({
          url: `${keystoreId}/keys`,
          method: 'GET',
          action: 'read',
          capability: rootZcap
        })
      ).data as any
      assert.deepEqual(
        results.map((entry: any) => entry.id).sort(),
        [...kmsIds].sort()
      )
      for (const entry of results) {
        assert.ok(entry.publicKeyMultibase, 'public key material is present')
        assert.ok(!('privateKeyMultibase' in entry))
        assert.ok(!('encrypted' in entry))
      }

      // ...but a read that needs the secret (Get Key decrypts through the seam)
      // fails loudly without the KEK -- the contrast that proves list is not
      // silently reading ciphertext as key material.
      let getStatus: number | undefined
      try {
        await client({ signer: alice.signer }).request({
          url: kmsIds[0]!,
          method: 'GET',
          action: 'read',
          capability: rootZcap
        })
      } catch (err) {
        getStatus = (err as { status?: number }).status
      }
      assert.equal(getStatus, 500)
    } finally {
      await fastify.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rotation: a record written under one KEK still signs after currentKekId is repointed', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'was-kek-'))
    const kek1 = parseKekMultibase(kekMultibase(randomBytes(32)))
    const kek2 = parseKekMultibase(kekMultibase(randomBytes(32)))

    // Phase 1: current KEK is kek1 -- generate a key wrapped under it.
    const first = await bootServer({
      dataDir,
      kmsRecordKek: singleKekRegistry(kek1)
    })
    let kmsId: string
    try {
      const key = (await first.keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      kmsId = key.kmsId!
      const record = await readRecord(dataDir, kmsId)
      assert.equal(record.key.encrypted.kekId, kek1.id)
    } finally {
      await first.fastify.close()
    }

    // Phase 2: rotate -- both KEKs registered, currentKekId repointed to kek2.
    // The record keeps its kek1 wrapping and must still decrypt.
    const backend = new FileSystemBackend({ dataDir })
    const rotated: KmsRecordKekRegistry = {
      keks: new Map([
        [kek1.id, kek1],
        [kek2.id, kek2]
      ]),
      currentKekId: kek2.id
    }
    const fastify = createApp({ serverUrl, backend, kmsRecordKek: rotated })
    await fastify.listen({ port: PORT })
    try {
      const keystoreLocalId = kmsId
        .slice(`${serverUrl}/kms/keystores/`.length)
        .split('/keys/')[0]!
      const keystoreAgent = reattach(
        `${serverUrl}/kms/keystores/${keystoreLocalId}`
      )
      const key = (await keystoreAgent.getAsymmetricKey({
        kmsId,
        id: kmsId,
        type: 'Ed25519VerificationKey2020'
      } as any)) as AsymmetricKey
      assert.equal(await signVerifies(key), true)
    } finally {
      await fastify.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
