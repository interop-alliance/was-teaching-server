/**
 * Unit tests for the encryption-scheme library helpers (spec "Encryption Scheme
 * Registry"): the `edv` JWE structural validator (`isValidEdvEnvelope`), the EDV
 * Encrypted Document validator (`isValidEdvDocument`), the fail-closed scheme
 * gate (`assertSupportedEncryption`), the set-once transition check
 * (`assertEncryptionTransition`), the Resource-content-write conformance gate
 * (`assertEncryptedWriteConforms`), and the Resource-metadata conformance gate
 * (`assertEncryptedMetaConforms`). These cover the pure logic directly,
 * complementing the over-the-wire suites; in particular
 * `assertEncryptionTransition` still exercises the `encryption-immutable` (409)
 * scheme-change path, which the wire suite can no longer reach in v1 (a second
 * recognized scheme is not expressible).
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import {
  isValidEdvEnvelope,
  isValidEdvDocument
} from '../src/lib/edvEnvelope.js'
import {
  assertSupportedEncryption,
  assertEncryptionTransition,
  assertEncryptedWriteConforms,
  assertEncryptedMetaConforms
} from '../src/lib/encryption.js'
import {
  EncryptionImmutableError,
  UnsupportedEncryptionSchemeError,
  EncryptionSchemeMismatchError
} from '../src/errors.js'

/** A minimal valid flattened JWE-JSON envelope. */
const flattened = { protected: 'eyJhbGciOiJkaXIifQ', ciphertext: 'c1' }

/**
 * A minimal valid EDV Encrypted Document: the JWE nested under `jwe`, alongside
 * the opaque EDV bookkeeping members the codec emits. This is the actual stored
 * representation (`application/json`), not a bare JWE.
 */
const edvDocument = { id: 'z1', sequence: 0, indexed: [], jwe: flattened }

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

describe('isValidEdvDocument', () => {
  it('accepts an EDV Document with a valid `jwe` member', () => {
    assert.equal(isValidEdvDocument(edvDocument), true)
  })
  it('accepts a `jwe`-only object (no bookkeeping members)', () => {
    assert.equal(isValidEdvDocument({ jwe: flattened }), true)
  })
  const invalid: [string, unknown][] = [
    ['a non-object', 'not-an-object'],
    ['null', null],
    ['an array', [edvDocument]],
    ['a bare JWE (no `jwe` wrapper)', flattened],
    ['a plaintext JSON document', { hello: 'world' }],
    ['a `jwe` that is not a valid envelope', { jwe: { hello: 'world' } }],
    ['a non-object `jwe`', { jwe: 'nope' }]
  ]
  for (const [label, body] of invalid) {
    it(`rejects ${label}`, () => {
      assert.equal(isValidEdvDocument(body), false)
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
  it('accepts a conforming EDV Document under application/json', () => {
    assert.doesNotThrow(() =>
      assertEncryptedWriteConforms({
        collectionDescription: edv,
        contentType: 'application/json',
        body: edvDocument
      })
    )
  })
  it('accepts the media type with parameters (charset)', () => {
    assert.doesNotThrow(() =>
      assertEncryptedWriteConforms({
        collectionDescription: edv,
        contentType: 'application/JSON; charset=utf-8',
        body: edvDocument
      })
    )
  })
  it('rejects a wrong content type (422)', () => {
    assert.throws(
      () =>
        assertEncryptedWriteConforms({
          collectionDescription: edv,
          contentType: 'application/octet-stream',
          body: edvDocument
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
          body: edvDocument
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects a right content type but plaintext body (422)', () => {
    assert.throws(
      () =>
        assertEncryptedWriteConforms({
          collectionDescription: edv,
          contentType: 'application/json',
          body: { hello: 'world' }
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects a bare JWE (no `jwe` wrapper) as non-conforming (422)', () => {
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
})

describe('assertEncryptedMetaConforms', () => {
  const edv = { encryption: { scheme: 'edv' as const } }

  it('is a no-op for a plaintext Collection (any custom)', () => {
    assert.doesNotThrow(() =>
      assertEncryptedMetaConforms({
        collectionDescription: {},
        custom: { name: 'Hello', tags: { x: 'y' } }
      })
    )
  })
  it('accepts a conforming EDV Document `custom` (no media-type gate)', () => {
    assert.doesNotThrow(() =>
      assertEncryptedMetaConforms({
        collectionDescription: edv,
        custom: edvDocument
      })
    )
  })
  it('rejects a plaintext `{ name, tags }` custom (422)', () => {
    assert.throws(
      () =>
        assertEncryptedMetaConforms({
          collectionDescription: edv,
          custom: { name: 'Hello', tags: { x: 'y' } }
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects an undefined/absent custom (422)', () => {
    assert.throws(
      () =>
        assertEncryptedMetaConforms({
          collectionDescription: edv,
          custom: undefined
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects a bare JWE (no `jwe` wrapper) custom (422)', () => {
    assert.throws(
      () =>
        assertEncryptedMetaConforms({
          collectionDescription: edv,
          custom: flattened
        }),
      EncryptionSchemeMismatchError
    )
  })
})
