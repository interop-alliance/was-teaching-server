/**
 * Unit tests for the encryption-scheme library helpers (spec "Encryption Scheme
 * Registry"): the `edv` envelope structural validator (`isValidEdvEnvelope`),
 * the fail-closed scheme gate (`assertSupportedEncryption`), the set-once
 * transition check (`assertEncryptionTransition`), and the Resource-write
 * conformance gate (`assertEncryptedWriteConforms`). These cover the pure logic
 * directly, complementing the over-the-wire suites; in particular
 * `assertEncryptionTransition` still exercises the `encryption-immutable` (409)
 * scheme-change path, which the wire suite can no longer reach in v1 (a second
 * recognized scheme is not expressible).
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import { isValidEdvEnvelope } from '../src/lib/edvEnvelope.js'
import {
  assertSupportedEncryption,
  assertEncryptionTransition,
  assertEncryptedWriteConforms
} from '../src/lib/encryption.js'
import {
  EncryptionImmutableError,
  UnsupportedEncryptionSchemeError,
  EncryptionSchemeMismatchError
} from '../src/errors.js'

/** A minimal valid flattened JWE-JSON envelope. */
const flattened = { protected: 'eyJhbGciOiJkaXIifQ', ciphertext: 'c1' }

describe('isValidEdvEnvelope', () => {
  const valid: [string, unknown][] = [
    ['flattened (protected + ciphertext)', flattened],
    [
      'flattened with encrypted_key + iv + tag',
      { protected: 'p', encrypted_key: 'k', iv: 'i', ciphertext: 'c', tag: 't' }
    ],
    [
      'general (recipients list)',
      {
        ciphertext: 'c',
        recipients: [{ header: { kid: 'k1' }, encrypted_key: 'ek1' }]
      }
    ],
    ['top-level encrypted_key only', { ciphertext: 'c', encrypted_key: 'k' }]
  ]
  for (const [label, body] of valid) {
    it(`accepts ${label}`, () => {
      assert.equal(isValidEdvEnvelope(body), true)
    })
  }

  const invalid: [string, unknown][] = [
    ['a non-object', 'not-an-object'],
    ['null', null],
    ['an array', [flattened]],
    ['a missing ciphertext', { protected: 'p' }],
    ['an empty-string ciphertext', { protected: 'p', ciphertext: '' }],
    ['a non-string ciphertext', { protected: 'p', ciphertext: 123 }],
    ['a non-string protected', { protected: 1, ciphertext: 'c' }],
    ['no key-delivery member', { ciphertext: 'c', iv: 'i', tag: 't' }],
    [
      'an empty recipients array (no other member)',
      { ciphertext: 'c', recipients: [] }
    ],
    ['a non-array recipients', { ciphertext: 'c', recipients: {} }],
    [
      'a recipient with non-string encrypted_key',
      { ciphertext: 'c', recipients: [{ encrypted_key: 5 }] }
    ],
    ['a plaintext JSON document', { hello: 'world' }]
  ]
  for (const [label, body] of invalid) {
    it(`rejects ${label}`, () => {
      assert.equal(isValidEdvEnvelope(body), false)
    })
  }
})

describe('assertSupportedEncryption', () => {
  it('accepts and returns a recognized `edv` marker', () => {
    assert.deepStrictEqual(
      assertSupportedEncryption({ encryption: { scheme: 'edv' } }),
      { scheme: 'edv' }
    )
  })
  it('preserves extra forward-compat fields on a recognized marker', () => {
    const marker = { scheme: 'edv', recipients: [{ id: 'k1' }] }
    assert.deepStrictEqual(
      assertSupportedEncryption({ encryption: marker }),
      marker
    )
  })
  it('returns undefined for an absent marker (plaintext)', () => {
    assert.equal(
      assertSupportedEncryption({ encryption: undefined }),
      undefined
    )
  })
  it('throws UnsupportedEncryptionSchemeError for an unrecognized scheme', () => {
    assert.throws(
      () => assertSupportedEncryption({ encryption: { scheme: 'rot13' } }),
      UnsupportedEncryptionSchemeError
    )
  })
})

describe('assertEncryptionTransition', () => {
  it('is a no-op declaring a marker on a Collection that lacks one', () => {
    assert.doesNotThrow(() =>
      assertEncryptionTransition({
        existing: undefined,
        incoming: { scheme: 'edv' }
      })
    )
  })
  it('is a no-op re-sending the same scheme', () => {
    assert.doesNotThrow(() =>
      assertEncryptionTransition({
        existing: { scheme: 'edv' },
        incoming: { scheme: 'edv' }
      })
    )
  })
  it('throws EncryptionImmutableError (409) changing an existing scheme', () => {
    // The 409 scheme-change path; two distinct schemes are cast in since v1's
    // `CollectionEncryption` type models only `edv`.
    assert.throws(
      () =>
        assertEncryptionTransition({
          existing: { scheme: 'edv' },
          incoming: { scheme: 'other' } as unknown as { scheme: 'edv' }
        }),
      EncryptionImmutableError
    )
  })
})

describe('assertEncryptedWriteConforms', () => {
  const edv = { encryption: { scheme: 'edv' as const } }

  it('is a no-op for a plaintext Collection (any body/content type)', () => {
    assert.doesNotThrow(() =>
      assertEncryptedWriteConforms({
        collectionDescription: {},
        contentType: 'application/json',
        body: { hello: 'world' }
      })
    )
  })
  it('accepts a conforming jose+json envelope', () => {
    assert.doesNotThrow(() =>
      assertEncryptedWriteConforms({
        collectionDescription: edv,
        contentType: 'application/jose+json',
        body: flattened
      })
    )
  })
  it('accepts the media type with parameters (charset)', () => {
    assert.doesNotThrow(() =>
      assertEncryptedWriteConforms({
        collectionDescription: edv,
        contentType: 'application/JOSE+JSON; charset=utf-8',
        body: flattened
      })
    )
  })
  it('rejects a wrong content type (422)', () => {
    assert.throws(
      () =>
        assertEncryptedWriteConforms({
          collectionDescription: edv,
          contentType: 'application/json',
          body: flattened
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects a missing content type (422)', () => {
    assert.throws(
      () =>
        assertEncryptedWriteConforms({
          collectionDescription: edv,
          contentType: undefined,
          body: flattened
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects a right content type but non-envelope body (422)', () => {
    assert.throws(
      () =>
        assertEncryptedWriteConforms({
          collectionDescription: edv,
          contentType: 'application/jose+json',
          body: { hello: 'world' }
        }),
      EncryptionSchemeMismatchError
    )
  })
})
