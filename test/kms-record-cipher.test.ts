/**
 * Unit tests for the at-rest WebKMS key-record cipher (`KMS_RECORD_KEK`;
 * src/lib/kmsRecordCipher.ts) and its config parsing. Pure-function coverage:
 * the round-trip, the plaintext allowlist, the plaintext pass-through and KEK
 * rotation upgrade paths, KEK parsing, and authentication failures. The
 * end-to-end (on-disk, through `createApp`) behavior is covered by
 * test/kms-record-encryption.test.ts.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { IdEncoder } from '@digitalcredentials/bnid'

import {
  encryptKeyRecord,
  decryptKeyRecord,
  parseKekMultibase,
  deriveKekId,
  currentRecordKek,
  recordKekLoader,
  PLAINTEXT_KEY_FIELDS
} from '../src/lib/kmsRecordCipher.js'
import { parseKmsRecordKek } from '../src/config.default.js'
import type { KmsKeyRecord, RecordKek } from '../src/types.js'

/** A base58btc Multikey `secretKeyMultibase` for a raw 32-byte AES-256 key. */
function kekMultibase(key: Buffer): string {
  const bytes = Buffer.concat([Buffer.from([0xa2, 0x01]), key])
  return new IdEncoder({ encoding: 'base58', multibase: true }).encode(bytes)
}

/** A fresh AES-256 KEK (a raw key wrapped as a `RecordKek`). */
function randomKek(): RecordKek {
  return parseKekMultibase(kekMultibase(randomBytes(32)))
}

/** A sample Ed25519 stored key record (asymmetric: `privateKeyMultibase`). */
function ed25519Record(): KmsKeyRecord {
  return {
    keystoreId: 'ks1',
    localId: 'key1',
    meta: {
      created: '2026-07-04T00:00:00.000Z',
      updated: '2026-07-04T00:00:00.000Z'
    },
    key: {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      id: 'https://was.example/kms/keystores/ks1/keys/key1',
      type: 'Ed25519VerificationKey2020',
      publicKeyMultibase: 'z6MkpublicExample',
      privateKeyMultibase: 'zPRIVATEsecretExample',
      maxCapabilityChainLength: 3,
      publicAlias: 'did:key:z6Mkalias#z6Mkalias'
    }
  }
}

/** A sample HMAC stored key record (symmetric: `secret`). */
function hmacRecord(): KmsKeyRecord {
  return {
    keystoreId: 'ks1',
    localId: 'key2',
    meta: {
      created: '2026-07-04T00:00:00.000Z',
      updated: '2026-07-04T00:00:00.000Z'
    },
    key: {
      '@context': 'https://w3id.org/security/suites/hmac-2019/v1',
      id: 'https://was.example/kms/keystores/ks1/keys/key2',
      type: 'Sha256HmacKey2019',
      secret: randomBytes(32).toString('base64url')
    }
  }
}

describe('KMS record cipher (KMS_RECORD_KEK)', () => {
  describe('encryptKeyRecord / decryptKeyRecord round-trip', () => {
    it('restores an asymmetric key record exactly', () => {
      const kek = randomKek()
      const original = ed25519Record()
      const encrypted = encryptKeyRecord({ record: original, kek })
      const decrypted = decryptKeyRecord({
        record: encrypted,
        kekLoader: recordKekLoader({
          keks: new Map([[kek.id, kek]]),
          currentKekId: kek.id
        })
      })
      assert.deepEqual(decrypted, original)
    })

    it('restores a symmetric (HMAC) key record exactly', () => {
      const kek = randomKek()
      const original = hmacRecord()
      const encrypted = encryptKeyRecord({ record: original, kek })
      const decrypted = decryptKeyRecord({
        record: encrypted,
        kekLoader: () => kek
      })
      assert.deepEqual(decrypted, original)
    })

    it('the on-disk record carries no plaintext secret material', () => {
      const kek = randomKek()
      const original = ed25519Record()
      const encrypted = encryptKeyRecord({ record: original, kek })
      // Secret fields replaced by the envelope; no cleartext secret anywhere.
      assert.equal(encrypted.key.privateKeyMultibase, undefined)
      assert.equal(encrypted.key.secret, undefined)
      assert.ok(encrypted.key.encrypted, 'has an `encrypted` envelope')
      assert.equal(encrypted.key.encrypted!.kekId, kek.id)
      assert.equal(encrypted.key.encrypted!.encoding, 'json')
      const serialized = JSON.stringify(encrypted)
      assert.ok(
        !serialized.includes('zPRIVATEsecretExample'),
        'private key material is not present in the serialized record'
      )
    })
  })

  describe('plaintext allowlist', () => {
    it('keeps allowlisted public fields readable without the KEK', () => {
      const kek = randomKek()
      const original = ed25519Record()
      const encrypted = encryptKeyRecord({ record: original, kek })
      // Every allowlisted field present on the original stays verbatim on the
      // encrypted record (no KEK required to read them).
      for (const field of PLAINTEXT_KEY_FIELDS) {
        assert.deepEqual(
          (encrypted.key as unknown as Record<string, unknown>)[field],
          (original.key as unknown as Record<string, unknown>)[field],
          `allowlisted field "${field}" is preserved in the clear`
        )
      }
    })

    it('sweeps a newly-added non-allowlisted field into the envelope', () => {
      const kek = randomKek()
      const original = ed25519Record()
      // A hypothetical future secret-bearing field is deny-by-default.
      ;(original.key as unknown as Record<string, unknown>).futureSecret =
        'zHushHush'
      const encrypted = encryptKeyRecord({ record: original, kek })
      assert.equal(
        (encrypted.key as unknown as Record<string, unknown>).futureSecret,
        undefined
      )
      assert.ok(!JSON.stringify(encrypted).includes('zHushHush'))
      const decrypted = decryptKeyRecord({
        record: encrypted,
        kekLoader: () => kek
      })
      assert.equal(
        (decrypted.key as unknown as Record<string, unknown>).futureSecret,
        'zHushHush'
      )
    })
  })

  describe('pass-through and rotation upgrade paths', () => {
    it('passes a plaintext record through unchanged (no `encrypted`)', () => {
      const plaintext = ed25519Record()
      // No KEK registered at all: a plaintext record still reads.
      const decrypted = decryptKeyRecord({
        record: plaintext,
        kekLoader: recordKekLoader(undefined)
      })
      assert.deepEqual(decrypted, plaintext)
    })

    it('decrypts a record after the current KEK is rotated forward', () => {
      const kek1 = randomKek()
      const kek2 = randomKek()
      assert.notEqual(kek1.id, kek2.id)
      // Written under kek1...
      const encrypted = encryptKeyRecord({ record: ed25519Record(), kek: kek1 })
      // ...still decrypts after currentKekId is repointed to kek2, because both
      // KEKs remain in the registry for unwrap.
      const registry = {
        keks: new Map([
          [kek1.id, kek1],
          [kek2.id, kek2]
        ]),
        currentKekId: kek2.id
      }
      assert.equal(currentRecordKek(registry)!.id, kek2.id)
      const decrypted = decryptKeyRecord({
        record: encrypted,
        kekLoader: recordKekLoader(registry)
      })
      assert.equal(decrypted.key.privateKeyMultibase, 'zPRIVATEsecretExample')
    })
  })

  describe('authentication failures', () => {
    it('throws when the record`s KEK is not registered', () => {
      const encrypted = encryptKeyRecord({
        record: ed25519Record(),
        kek: randomKek()
      })
      assert.throws(
        () =>
          decryptKeyRecord({ record: encrypted, kekLoader: () => undefined }),
        /No KEK registered/
      )
    })

    it('throws when the wrong KEK is supplied (RFC 3394 integrity check)', () => {
      const encrypted = encryptKeyRecord({
        record: ed25519Record(),
        kek: randomKek()
      })
      const wrongKek = randomKek()
      assert.throws(() =>
        decryptKeyRecord({
          record: encrypted,
          kekLoader: () => ({
            id: encrypted.key.encrypted!.kekId,
            key: wrongKek.key
          })
        })
      )
    })

    it('throws when the ciphertext is tampered (GCM tag mismatch)', () => {
      const kek = randomKek()
      const encrypted = encryptKeyRecord({ record: hmacRecord(), kek })
      // Flip the ciphertext; the CEK unwrap still succeeds, the GCM tag does not.
      const jwe = encrypted.key.encrypted!.jwe
      const bytes = Buffer.from(jwe.ciphertext, 'base64url')
      bytes[0] = bytes[0]! ^ 0xff
      jwe.ciphertext = bytes.toString('base64url')
      assert.throws(() =>
        decryptKeyRecord({ record: encrypted, kekLoader: () => kek })
      )
    })
  })

  describe('parseKekMultibase / deriveKekId', () => {
    it('round-trips a 32-byte AES-256 Multikey value', () => {
      const raw = randomBytes(32)
      const kek = parseKekMultibase(kekMultibase(raw))
      assert.ok(kek.key.equals(raw))
      assert.equal(kek.id, deriveKekId(raw))
      // The derived id is stable and does not leak the key material.
      assert.match(kek.id, /^urn:kek:sha256:[0-9a-f]{64}$/)
      assert.ok(!kek.id.includes(raw.toString('hex')))
    })

    it('rejects a non-multibase value', () => {
      assert.throws(() => parseKekMultibase('not-a-multibase!'), /multibase/)
    })

    it('rejects a value without the AES-256 Multikey header', () => {
      const noHeader = new IdEncoder({
        encoding: 'base58',
        multibase: true
      }).encode(randomBytes(34))
      assert.throws(() => parseKekMultibase(noHeader), /Multikey header/)
    })

    it('rejects a wrong-length key', () => {
      const short = Buffer.concat([Buffer.from([0xa2, 0x01]), randomBytes(16)])
      const mb = new IdEncoder({ encoding: 'base58', multibase: true }).encode(
        short
      )
      assert.throws(() => parseKekMultibase(mb), /32-byte/)
    })
  })

  describe('parseKmsRecordKek (config)', () => {
    it('returns undefined when unset or empty (encryption disabled)', () => {
      assert.equal(parseKmsRecordKek(undefined), undefined)
      assert.equal(parseKmsRecordKek(''), undefined)
      assert.equal(parseKmsRecordKek('   '), undefined)
    })

    it('builds a single-KEK registry with currentKekId set', () => {
      const raw = randomBytes(32)
      const registry = parseKmsRecordKek(kekMultibase(raw))
      assert.ok(registry)
      assert.equal(registry!.currentKekId, deriveKekId(raw))
      assert.equal(registry!.keks.size, 1)
      assert.ok(registry!.keks.get(deriveKekId(raw))!.key.equals(raw))
    })
  })
})
