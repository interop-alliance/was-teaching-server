/**
 * At-rest cipher for WebKMS key records (`KMS_RECORD_KEK`, the optional
 * hardening increment). Envelope-encrypts the
 * secret-bearing fields of a stored key so a disk/database dump exposes only
 * ciphertext and a `kekId`, while the wire projection (`KmsKeyDescription`) and
 * the whole authorization model stay byte-for-byte identical.
 *
 * The design mirrors bedrock's `@bedrock/record-cipher`: a deny-by-default field
 * split (an explicit plaintext allowlist; every other `key` field is a secret),
 * a fresh per-record content-encryption key (`A256GCM`) wrapped (`A256KW`) under
 * a config-supplied AES-256 KEK, and a per-record `kekId` so a rotated-in KEK
 * never forces a rewrite. It reuses the same `node:crypto` primitives the KMS
 * module already relies on for AES-KW (`id-aes256-wrap`), so no new crypto
 * dependency is introduced.
 *
 * This module is pure and backend-agnostic: KEK(s) are injected (no env reads
 * here), and it neither touches storage nor knows about Fastify. The
 * orchestration seam (`src/requests/KeyRequest.ts`) applies it around the
 * backend's `insertKey` / `getKey`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto'
import { IdDecoder } from '@digitalcredentials/bnid'
import type {
  KmsEncryptedEnvelope,
  KmsKeyRecord,
  KmsStoredKey,
  RecordKek,
  KmsRecordKekRegistry
} from '../types.js'

/**
 * The plaintext allowlist: the `KmsStoredKey` fields that stay in the clear (and
 * queryable) at rest. EVERY other field of `key` -- `privateKeyMultibase`,
 * `secret`, and any secret-bearing field added later -- is swept into the
 * envelope, so new secrets are protected by default unless explicitly added
 * here. (Bedrock additionally lists `controller`; this server never stores
 * `controller` on the key -- it is read from the live keystore config at
 * description time -- so it is simply absent.)
 */
export const PLAINTEXT_KEY_FIELDS: ReadonlySet<string> = new Set([
  '@context',
  'id',
  'type',
  'publicKeyMultibase',
  'maxCapabilityChainLength',
  'publicAlias',
  'publicAliasTemplate'
])

/**
 * The Multikey header for an AES-256 symmetric key (`0xa2 0x01`, the multicodec
 * varint for `aes-256`), the two bytes a `KMS_RECORD_KEK` multibase value
 * carries before its 32 key bytes -- matching bedrock's KEK encoding.
 */
const AES_256_MULTIKEY_HEADER = Buffer.from([0xa2, 0x01])

/** Content-encryption algorithm: AES-256-GCM (`A256GCM`). */
const CEK_ALGORITHM = 'aes-256-gcm'
/** GCM initialization-vector length in bytes (96-bit, per the JWE `A256GCM` profile). */
const GCM_IV_BYTES = 12
/**
 * Key-wrap algorithm: AES Key Wrap (RFC 3394) with a 256-bit KEK (`A256KW`),
 * the same primitive the KMS module uses for its AES-KW key type. Its default
 * IV is the RFC's `0xA6` octet repeated eight times; the wrap is integrity-
 * checked, so a wrong KEK throws on unwrap.
 */
const KEK_WRAP_ALGORITHM = 'id-aes256-wrap'
const KEK_WRAP_DEFAULT_IV = Buffer.alloc(8, 0xa6)

/**
 * Derives a KEK's non-secret, stable id from its raw key bytes: a SHA-256 digest
 * (one-way, so storing it per record leaks nothing about the key). Self-
 * describing and deterministic, so a rotated-in KEK gets a stable id from its
 * material alone -- the convention bedrock follows.
 * @param key {Buffer}   the 32-byte AES-256 KEK
 * @returns {string}   the derived `urn:kek:sha256:<hex>` id
 */
export function deriveKekId(key: Buffer): string {
  return `urn:kek:sha256:${createHash('sha256').update(key).digest('hex')}`
}

/**
 * Parses a `secretKeyMultibase` (base58btc Multikey) AES-256 KEK into a
 * `RecordKek` (its raw key plus a derived id). Throws a plain `Error` on a
 * malformed value -- callers are config parsing (fails startup) and tests, not
 * the request path.
 * @param secretKeyMultibase {string}   the multibase (`z...`) KEK value
 * @returns {RecordKek}
 */
export function parseKekMultibase(secretKeyMultibase: string): RecordKek {
  const decoder = new IdDecoder({ encoding: 'base58', multibase: true })
  let decoded: Buffer
  try {
    decoded = Buffer.from(decoder.decode(secretKeyMultibase))
  } catch {
    throw new Error(
      'KMS_RECORD_KEK is not a valid multibase (base58btc) value.'
    )
  }
  if (!decoded.subarray(0, 2).equals(AES_256_MULTIKEY_HEADER)) {
    throw new Error(
      'KMS_RECORD_KEK must carry the AES-256 Multikey header (0xa2 0x01).'
    )
  }
  const key = decoded.subarray(2)
  if (key.length !== 32) {
    throw new Error(
      `KMS_RECORD_KEK must be a 256-bit (32-byte) key; got ${key.length} bytes.`
    )
  }
  return { id: deriveKekId(key), key }
}

/**
 * The KEK that wraps NEW records, or `undefined` when encryption is disabled
 * (no registry, or `currentKekId: null`).
 * @param [registry] {KmsRecordKekRegistry}
 * @returns {RecordKek | undefined}
 */
export function currentRecordKek(
  registry?: KmsRecordKekRegistry
): RecordKek | undefined {
  if (registry === undefined || registry.currentKekId === null) {
    return undefined
  }
  return registry.keks.get(registry.currentKekId)
}

/**
 * A KEK-lookup function over a registry, resolving a record's stored `kekId` to
 * its `RecordKek` for decryption (`undefined` when the KEK is not registered, or
 * there is no registry at all). The decrypt seam for the pass-through /
 * rotation upgrade paths.
 * @param [registry] {KmsRecordKekRegistry}
 * @returns {(kekId: string) => RecordKek | undefined}
 */
export function recordKekLoader(
  registry?: KmsRecordKekRegistry
): (kekId: string) => RecordKek | undefined {
  return (kekId: string) => registry?.keks.get(kekId)
}

/**
 * Encrypts the secret-bearing fields of a key record under a KEK, returning a
 * record whose `key` carries the allowlisted plaintext fields plus an
 * `encrypted` envelope in place of the secrets. Pure: the KEK is injected, no
 * storage or env access. The record's non-`key` members (`keystoreId`,
 * `localId`, `meta`) are unchanged.
 * @param options {object}
 * @param options.record {KmsKeyRecord}   the plaintext (secret-bearing) record
 * @param options.kek {RecordKek}   the KEK to wrap the fresh CEK under
 * @returns {KmsKeyRecord}   the at-rest record (secrets replaced by `encrypted`)
 */
export function encryptKeyRecord({
  record,
  kek
}: {
  record: KmsKeyRecord
  kek: RecordKek
}): KmsKeyRecord {
  const publicFields: Record<string, unknown> = {}
  const secretFields: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(record.key)) {
    if (PLAINTEXT_KEY_FIELDS.has(field)) {
      publicFields[field] = value
    } else {
      secretFields[field] = value
    }
  }

  const plaintext = Buffer.from(JSON.stringify(secretFields), 'utf8')

  // Fresh per-record content-encryption key (CEK), A256GCM. The `protected`
  // header doubles as the GCM additional-authenticated-data (AAD), per JWE.
  const cek = randomBytes(32)
  const iv = randomBytes(GCM_IV_BYTES)
  const protectedHeader = Buffer.from(
    JSON.stringify({ enc: 'A256GCM' }),
    'utf8'
  ).toString('base64url')
  const cipher = createCipheriv(CEK_ALGORITHM, cek, iv)
  cipher.setAAD(Buffer.from(protectedHeader, 'ascii'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  // Wrap the CEK under the KEK (A256KW / RFC 3394).
  const wrap = createCipheriv(KEK_WRAP_ALGORITHM, kek.key, KEK_WRAP_DEFAULT_IV)
  const wrappedCek = Buffer.concat([wrap.update(cek), wrap.final()])

  const encrypted: KmsEncryptedEnvelope = {
    kekId: kek.id,
    jwe: {
      protected: protectedHeader,
      recipients: [
        {
          header: { alg: 'A256KW', kid: kek.id },
          encrypted_key: wrappedCek.toString('base64url')
        }
      ],
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: tag.toString('base64url')
    },
    encoding: 'json'
  }

  return {
    ...record,
    key: { ...publicFields, encrypted } as unknown as KmsStoredKey
  }
}

/**
 * Decrypts a key record: pass-through when `key.encrypted` is absent (a
 * plaintext record -- the default, and the pass-through upgrade path), else
 * looks up the KEK by the record's stored `kekId`, unwraps the CEK, decrypts the
 * secret subset, and splices the secret fields back onto the allowlisted ones
 * (dropping the envelope). Pure: KEK(s) injected via `kekLoader`, no storage or
 * env access. Throws a plain `Error` when the record's KEK is not registered or
 * the ciphertext fails to authenticate; the request seam wraps that as a 500.
 * @param options {object}
 * @param options.record {KmsKeyRecord}   the at-rest (or plaintext) record
 * @param options.kekLoader {(kekId: string) => RecordKek | undefined}   KEK lookup
 * @returns {KmsKeyRecord}   the decrypted record (secrets restored on `key`)
 */
export function decryptKeyRecord({
  record,
  kekLoader
}: {
  record: KmsKeyRecord
  kekLoader: (kekId: string) => RecordKek | undefined
}): KmsKeyRecord {
  const { encrypted } = record.key
  if (encrypted === undefined) {
    // Plaintext record: unconditional pass-through (so enabling a KEK on an
    // existing plaintext tree leaves old records readable).
    return record
  }

  const kek = kekLoader(encrypted.kekId)
  if (kek === undefined) {
    throw new Error(
      `No KEK registered for kekId "${encrypted.kekId}"; ` +
        'cannot decrypt WebKMS key record.'
    )
  }
  const { jwe } = encrypted

  // Unwrap the CEK (A256KW), then decrypt the secret subset (A256GCM). Both
  // steps authenticate: a wrong KEK fails the RFC 3394 integrity check, and a
  // tampered ciphertext fails the GCM tag.
  const wrappedCek = Buffer.from(jwe.recipients[0]!.encrypted_key, 'base64url')
  const unwrap = createDecipheriv(
    KEK_WRAP_ALGORITHM,
    kek.key,
    KEK_WRAP_DEFAULT_IV
  )
  const cek = Buffer.concat([unwrap.update(wrappedCek), unwrap.final()])

  const decipher = createDecipheriv(
    CEK_ALGORITHM,
    cek,
    Buffer.from(jwe.iv, 'base64url')
  )
  decipher.setAAD(Buffer.from(jwe.protected, 'ascii'))
  decipher.setAuthTag(Buffer.from(jwe.tag, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(jwe.ciphertext, 'base64url')),
    decipher.final()
  ])
  const secretFields = JSON.parse(plaintext.toString('utf8')) as Record<
    string,
    unknown
  >

  // Splice the secrets back onto the public fields, dropping the envelope.
  const { encrypted: _envelope, ...publicFields } = record.key
  return {
    ...record,
    key: { ...publicFields, ...secretFields } as KmsStoredKey
  }
}
