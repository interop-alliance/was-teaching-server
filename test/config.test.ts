/**
 * Tests for the centralized env config surface (loadConfigFromEnv and its
 * per-variable parsers): fail-fast startup on a missing SERVER_URL or any
 * malformed value, including the sub-path rejection the URL-join sites
 * require -- plus the same serverUrl validation at fastifyWas registration.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { IdEncoder } from '@digitalcredentials/bnid'

import {
  DEFAULT_PORT,
  assertValidServerUrl,
  loadConfigFromEnv,
  parseMaxUploadBytes,
  parsePort,
  parseServerUrl,
  parseStorageLimit
} from '../src/config.default.js'
import { deriveKekId } from '../src/lib/kmsRecordCipher.js'
import { createApp } from '../src/server.js'

/** A base58btc Multikey `secretKeyMultibase` for a raw 32-byte AES-256 key. */
function kekMultibase(key: Buffer): string {
  const bytes = Buffer.concat([Buffer.from([0xa2, 0x01]), key])
  return new IdEncoder({ encoding: 'base58', multibase: true }).encode(bytes)
}

describe('parseServerUrl', () => {
  it('requires SERVER_URL (unset, empty, and whitespace-only all throw)', () => {
    for (const raw of [undefined, '', '   ']) {
      assert.throws(() => parseServerUrl(raw), /SERVER_URL is required/)
    }
  })

  it('accepts an origin-only http(s) URL and preserves it byte-for-byte', () => {
    // ZCap invocationTarget URLs compare as exact strings, so the configured
    // value must never be normalized (e.g. no trailing slash added).
    assert.equal(
      parseServerUrl('http://localhost:3002'),
      'http://localhost:3002'
    )
    assert.equal(
      parseServerUrl('https://was.example.com/'),
      'https://was.example.com/'
    )
  })

  it('trims surrounding whitespace', () => {
    assert.equal(
      parseServerUrl(' http://localhost:3002 '),
      'http://localhost:3002'
    )
  })

  it('rejects a value that is not an absolute URL', () => {
    assert.throws(() => parseServerUrl('not-a-valid-url'), /absolute URL/)
    assert.throws(() => parseServerUrl('localhost:3002'), /http: or https:/)
  })

  it('rejects non-http(s) protocols', () => {
    assert.throws(() => parseServerUrl('ftp://example.com'), /http: or https:/)
  })

  it('rejects a URL with a path, query, or fragment (sub-path unsupported)', () => {
    assert.throws(() => parseServerUrl('https://example.com/was'), /sub-path/)
    assert.throws(() => parseServerUrl('https://example.com?x=1'), /sub-path/)
    assert.throws(() => parseServerUrl('https://example.com#frag'), /sub-path/)
  })
})

describe('parsePort', () => {
  it('defaults to DEFAULT_PORT when unset or empty', () => {
    assert.equal(parsePort(undefined), DEFAULT_PORT)
    assert.equal(parsePort(''), DEFAULT_PORT)
  })

  it('parses a valid port', () => {
    assert.equal(parsePort('8080'), 8080)
  })

  it('rejects non-integer and out-of-range values', () => {
    for (const raw of ['abc', '3.14', '0', '-1', '65536']) {
      assert.throws(() => parsePort(raw), /PORT must be an integer/)
    }
  })
})

describe('parseStorageLimit', () => {
  it('returns undefined when unset or empty', () => {
    assert.equal(parseStorageLimit(undefined), undefined)
    assert.equal(parseStorageLimit(''), undefined)
    assert.equal(parseStorageLimit('   '), undefined)
  })

  it('returns Infinity for "unlimited" (case-insensitive, trimmed)', () => {
    assert.equal(parseStorageLimit('unlimited'), Infinity)
    assert.equal(parseStorageLimit('  UNLIMITED  '), Infinity)
  })

  it('parses a non-negative integer number of bytes', () => {
    assert.equal(parseStorageLimit('1048576'), 1048576)
    assert.equal(parseStorageLimit('0'), 0)
  })

  it('rejects malformed values (mentioning unlimited)', () => {
    for (const raw of ['lots', '-1', '3.14']) {
      assert.throws(
        () => parseStorageLimit(raw),
        /STORAGE_LIMIT_PER_SPACE must be.*unlimited/s
      )
    }
  })
})

describe('parseMaxUploadBytes', () => {
  it('returns undefined when unset or empty', () => {
    assert.equal(parseMaxUploadBytes(undefined), undefined)
    assert.equal(parseMaxUploadBytes(''), undefined)
    assert.equal(parseMaxUploadBytes('   '), undefined)
  })

  it('returns Infinity for "unlimited" (case-insensitive, trimmed)', () => {
    assert.equal(parseMaxUploadBytes('unlimited'), Infinity)
    assert.equal(parseMaxUploadBytes('  Unlimited  '), Infinity)
  })

  it('parses a non-negative integer number of bytes', () => {
    assert.equal(parseMaxUploadBytes('65536'), 65536)
    assert.equal(parseMaxUploadBytes('0'), 0)
  })

  it('rejects malformed values (mentioning unlimited)', () => {
    for (const raw of ['huge', '-1', '2.5']) {
      assert.throws(
        () => parseMaxUploadBytes(raw),
        /MAX_UPLOAD_BYTES must be.*unlimited/s
      )
    }
  })
})

describe('loadConfigFromEnv', () => {
  it('fails fast when SERVER_URL is unset', () => {
    assert.throws(() => loadConfigFromEnv({}), /SERVER_URL is required/)
  })

  it('returns the full typed config with defaults applied', () => {
    const config = loadConfigFromEnv({ SERVER_URL: 'http://localhost:3002' })
    assert.equal(config.serverUrl, 'http://localhost:3002')
    assert.equal(config.port, DEFAULT_PORT)
    assert.equal(config.databaseUrl, undefined)
    assert.equal(config.storageLimitPerSpace, undefined)
    assert.equal(config.maxUploadBytes, undefined)
    assert.equal(config.enabledBackendProviders, undefined)
    assert.equal(config.kmsRecordKek, undefined)
    assert.equal(config.onboardingToken, undefined)
  })

  it('parses each configured variable', () => {
    const config = loadConfigFromEnv({
      SERVER_URL: 'https://was.example.com',
      PORT: '8080',
      DATABASE_URL: ' postgres://was:was@localhost:5433/was ',
      STORAGE_LIMIT_PER_SPACE: '1048576',
      MAX_UPLOAD_BYTES: '65536',
      WAS_ENABLED_BACKENDS: 'gdrive, s3',
      WAS_ONBOARDING_TOKEN: ' abc123 '
    })
    assert.equal(config.serverUrl, 'https://was.example.com')
    assert.equal(config.port, 8080)
    assert.equal(config.databaseUrl, 'postgres://was:was@localhost:5433/was')
    assert.equal(config.storageLimitPerSpace, 1048576)
    assert.equal(config.maxUploadBytes, 65536)
    assert.deepEqual(config.enabledBackendProviders, ['gdrive', 's3'])
    assert.equal(config.onboardingToken, 'abc123')
  })

  it('resolves "unlimited" limits to Infinity', () => {
    const config = loadConfigFromEnv({
      SERVER_URL: 'http://localhost:3002',
      STORAGE_LIMIT_PER_SPACE: 'unlimited',
      MAX_UPLOAD_BYTES: 'unlimited'
    })
    assert.equal(config.storageLimitPerSpace, Infinity)
    assert.equal(config.maxUploadBytes, Infinity)
  })

  it('propagates a malformed value with the offending variable named', () => {
    assert.throws(
      () =>
        loadConfigFromEnv({
          SERVER_URL: 'http://localhost:3002',
          STORAGE_LIMIT_PER_SPACE: 'lots'
        }),
      /STORAGE_LIMIT_PER_SPACE/
    )
  })
})

describe('loadConfigFromEnv (KMS record KEK vars)', () => {
  it('builds a registry from the KMS_RECORD_KEK alias', () => {
    const raw = randomBytes(32)
    const config = loadConfigFromEnv({
      SERVER_URL: 'http://localhost:3002',
      KMS_RECORD_KEK: kekMultibase(raw)
    })
    assert.ok(config.kmsRecordKek)
    assert.equal(config.kmsRecordKek!.keks.size, 1)
    assert.equal(config.kmsRecordKek!.currentKekId, deriveKekId(raw))
  })

  it('registers KMS_RECORD_KEKS with KMS_RECORD_CURRENT_KEK override', () => {
    const raw1 = randomBytes(32)
    const raw2 = randomBytes(32)
    const config = loadConfigFromEnv({
      SERVER_URL: 'http://localhost:3002',
      KMS_RECORD_KEKS: `${kekMultibase(raw1)}, ${kekMultibase(raw2)}`,
      KMS_RECORD_CURRENT_KEK: deriveKekId(raw2)
    })
    assert.ok(config.kmsRecordKek)
    assert.equal(config.kmsRecordKek!.keks.size, 2)
    assert.equal(config.kmsRecordKek!.currentKekId, deriveKekId(raw2))
  })

  it('supports the decrypt-only posture (KMS_RECORD_CURRENT_KEK=none)', () => {
    const raw = randomBytes(32)
    const config = loadConfigFromEnv({
      SERVER_URL: 'http://localhost:3002',
      KMS_RECORD_KEK: kekMultibase(raw),
      KMS_RECORD_CURRENT_KEK: 'none'
    })
    assert.ok(config.kmsRecordKek)
    assert.equal(config.kmsRecordKek!.currentKekId, null)
    assert.equal(config.kmsRecordKek!.keks.size, 1)
  })

  it('fails fast when both KMS_RECORD_KEK and KMS_RECORD_KEKS are set', () => {
    assert.throws(
      () =>
        loadConfigFromEnv({
          SERVER_URL: 'http://localhost:3002',
          KMS_RECORD_KEK: kekMultibase(randomBytes(32)),
          KMS_RECORD_KEKS: kekMultibase(randomBytes(32))
        }),
      /only one of KMS_RECORD_KEK or KMS_RECORD_KEKS/
    )
  })
})

describe('fastifyWas serverUrl validation', () => {
  it('rejects a path-bearing serverUrl at registration', async () => {
    const fastify = createApp({ serverUrl: 'https://example.com/was' })
    await assert.rejects(async () => {
      await fastify.ready()
    }, /sub-path/)
    await fastify.close()
  })

  it('still allows omitting serverUrl (test compositions)', async () => {
    const fastify = createApp()
    await fastify.ready()
    await fastify.close()
  })

  it('exposes assertValidServerUrl for downstream compositions', () => {
    assert.doesNotThrow(() => assertValidServerUrl('http://localhost:3002'))
    assert.throws(
      () => assertValidServerUrl('http://localhost:3002/app'),
      /sub-path/
    )
  })
})
