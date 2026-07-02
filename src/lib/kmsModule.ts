/**
 * The single in-process WebKMS module this server hard-wires (`local-v1`;
 * Track B of `_spec/web-kms-roadmap.md`), mirroring bedrock's module split
 * (`bedrock-kms-module-core`) in one file: a pure-crypto core per key type, an
 * operation dispatch table keyed by `(key type, operation type)`, and the
 * generate/describe orchestration (record assembly, `publicAlias` /
 * `publicAliasTemplate` expansion). The module never touches storage -- the
 * request layer loads/inserts `KmsKeyRecord`s through the storage backend and
 * hands this module the (secret-bearing) stored key.
 *
 * Custody draws the line on what is served (see the roadmap's wire contract):
 * every operation here requires the custodial secret -- Ed25519 sign, X25519
 * deriveSecret, HMAC sign/verify, AES-KW wrap/unwrap. Asymmetric verify needs
 * only the public key and is deliberately not served (client-local instead);
 * requesting it is a clean 400, where bedrock surfaces an uncaught 500.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'
import {
  InvalidRequestBodyError,
  UnsupportedKeyOperationError
} from '../errors.js'
import type { IDID, KmsKeyDescription, KmsStoredKey } from '../types.js'

/** The JSON-LD context each supported key type's description carries. */
const KEY_TYPE_CONTEXTS: Record<string, string> = {
  Ed25519VerificationKey2020:
    'https://w3id.org/security/suites/ed25519-2020/v1',
  X25519KeyAgreementKey2020: 'https://w3id.org/security/suites/x25519-2020/v1',
  Sha256HmacKey2019: 'https://w3id.org/security/suites/hmac-2019/v1',
  AesKeyWrappingKey2019: 'https://w3id.org/security/suites/aes-2019/v1'
}

/**
 * AES Key Wrap (RFC 3394) parameters, per bedrock-kms-module-core `aeskw.js`:
 * AES-256 in key-wrap mode with the RFC's default initial value. The IV is the
 * integrity check -- `decipher.final()` throws when the unwrapped output would
 * not reproduce it (i.e. the wrong KEK or corrupted ciphertext).
 */
const AES_KW_ALGORITHM = 'id-aes256-wrap'
const AES_KW_DEFAULT_IV = Buffer.alloc(8, 0xa6)

/** Decodes a base64url (no padding) operation field into bytes. */
function decodeBase64url({
  value,
  field,
  requestName
}: {
  value: unknown
  field: string
  requestName: string
}): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: `Operation "${field}" must be a non-empty base64url string.`,
      pointer: `#/${field}`
    })
  }
  return Buffer.from(value, 'base64url')
}

/**
 * Expands a `publicAliasTemplate` against the key description, per bedrock's
 * use of the `url-template` package (RFC 6570): `{var}` substitutes the
 * percent-encoded description field, `{+var}` substitutes it raw (bedrock's
 * own test template is `{+controller}#{publicKeyMultibase}`). An unknown
 * variable expands to the empty string, as in RFC 6570.
 *
 * @param options {object}
 * @param options.template {string}
 * @param options.description {KmsKeyDescription}   expansion variables
 * @returns {string}
 */
function expandAliasTemplate({
  template,
  description
}: {
  template: string
  description: KmsKeyDescription
}): string {
  const variables = description as unknown as Record<string, unknown>
  return template.replace(
    /\{(\+?)([A-Za-z0-9_]+)\}/g,
    (_match, rawModifier: string, name: string) => {
      const value = variables[name]
      const expanded = typeof value === 'string' ? value : ''
      return rawModifier === '+' ? expanded : encodeURIComponent(expanded)
    }
  )
}

/**
 * Builds the public key-description projection of a stored key: the
 * allowlisted public fields plus the live keystore `controller` (never any
 * secret field), with the `publicAlias` / expanded `publicAliasTemplate`
 * override applied to `id`. Applied identically at generate time and on every
 * subsequent read, so descriptions are stable (the client caches them).
 *
 * @param options {object}
 * @param options.key {KmsStoredKey}   the stored (secret-bearing) key
 * @param options.controller {IDID}   the keystore's current controller
 * @returns {KmsKeyDescription}
 */
export function describeKmsKey({
  key,
  controller
}: {
  key: KmsStoredKey
  controller: IDID
}): KmsKeyDescription {
  const description: KmsKeyDescription = {
    '@context': key['@context'],
    id: key.id,
    type: key.type,
    ...(key.publicKeyMultibase !== undefined && {
      publicKeyMultibase: key.publicKeyMultibase
    }),
    controller
  }
  if (key.publicAlias !== undefined) {
    description.id = key.publicAlias
  } else if (key.publicAliasTemplate !== undefined) {
    description.id = expandAliasTemplate({
      template: key.publicAliasTemplate,
      description
    })
  }
  return description
}

/**
 * Generates key material for a supported key type and assembles the stored
 * key (full serialized form, secret material included) plus its public
 * description. Field names are protocol-fixed: the asymmetric pairs carry
 * `publicKeyMultibase` / `privateKeyMultibase`; the symmetric keys carry a
 * base64url 256-bit `secret` (bedrock-kms-module-core's per-type generators).
 *
 * @param options {object}
 * @param options.keyId {string}   the full key URL (`<keystoreId>/keys/<localId>`)
 * @param options.type {string}   the webkms key type
 * @param options.controller {IDID}   the keystore's current controller (for
 *   the returned description only -- never stored on the key)
 * @param [options.maxCapabilityChainLength] {number}
 * @param [options.publicAlias] {string}
 * @param [options.publicAliasTemplate] {string}
 * @returns {Promise<{ key: KmsStoredKey, keyDescription: KmsKeyDescription }>}
 */
export async function generateKmsKey({
  keyId,
  type,
  controller,
  maxCapabilityChainLength,
  publicAlias,
  publicAliasTemplate
}: {
  keyId: string
  type: string
  controller: IDID
  maxCapabilityChainLength?: number
  publicAlias?: string
  publicAliasTemplate?: string
}): Promise<{ key: KmsStoredKey; keyDescription: KmsKeyDescription }> {
  const context = KEY_TYPE_CONTEXTS[type]
  if (context === undefined) {
    throw new InvalidRequestBodyError({
      requestName: 'Generate Key',
      detail: `Unsupported key type "${type}".`,
      pointer: '#/invocationTarget/type'
    })
  }
  const key: KmsStoredKey = { '@context': context, id: keyId, type }
  if (type === 'Ed25519VerificationKey2020') {
    const keyPair = await Ed25519VerificationKey.generate()
    key.publicKeyMultibase = keyPair.publicKeyMultibase
    key.privateKeyMultibase = keyPair.privateKeyMultibase
  } else if (type === 'X25519KeyAgreementKey2020') {
    const keyPair = await X25519KeyAgreementKey2020.generate()
    key.publicKeyMultibase = keyPair.publicKeyMultibase
    key.privateKeyMultibase = keyPair.privateKeyMultibase
  } else {
    // Sha256HmacKey2019 / AesKeyWrappingKey2019: a 256-bit symmetric secret.
    key.secret = randomBytes(32).toString('base64url')
  }
  if (maxCapabilityChainLength !== undefined) {
    key.maxCapabilityChainLength = maxCapabilityChainLength
  }
  if (publicAlias !== undefined) {
    key.publicAlias = publicAlias
  }
  if (publicAliasTemplate !== undefined) {
    key.publicAliasTemplate = publicAliasTemplate
  }
  return { key, keyDescription: describeKmsKey({ key, controller }) }
}

/**
 * SignOperation on an Ed25519 key: signs the `verifyData` bytes with the
 * custodial private key. The signature is not a secret, so serving it is the
 * custody model WebKMS is built for.
 */
async function ed25519Sign({
  key,
  operation
}: {
  key: KmsStoredKey
  operation: Record<string, unknown>
}): Promise<{ signatureValue: string }> {
  const data = decodeBase64url({
    value: operation.verifyData,
    field: 'verifyData',
    requestName: 'Sign Operation'
  })
  const keyPair = await Ed25519VerificationKey.from({ ...key })
  const signature = await keyPair.signer().sign({ data })
  return { signatureValue: Buffer.from(signature).toString('base64url') }
}

/**
 * DeriveSecretOperation on an X25519 key: raw ECDH against the submitted peer
 * public key -- no KDF is applied; the caller runs the shared secret through
 * one (bedrock parity). A peer whose `type` does not match the key's is a
 * clean 400 (bedrock throws an uncaught 500; the client pre-checks, so only
 * non-client callers hit this).
 */
async function x25519DeriveSecret({
  key,
  operation
}: {
  key: KmsStoredKey
  operation: Record<string, unknown>
}): Promise<{ secret: string }> {
  const requestName = 'Derive Secret Operation'
  const publicKey = operation.publicKey as
    { type?: string; publicKeyMultibase?: string } | undefined
  if (typeof publicKey !== 'object' || publicKey === null) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Operation "publicKey" must be a public key object.',
      pointer: '#/publicKey'
    })
  }
  if (publicKey.type !== key.type) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        `The given public key type "${publicKey.type}" does not match the` +
        ` key agreement key's type "${key.type}".`,
      pointer: '#/publicKey/type'
    })
  }
  const keyPair = await X25519KeyAgreementKey2020.from({ ...key })
  let secret: Uint8Array
  try {
    secret = await keyPair.deriveSecret({ publicKey })
  } catch {
    // A malformed / wrong-header `publicKeyMultibase` is a client error.
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Operation "publicKey.publicKeyMultibase" is not a valid key.',
      pointer: '#/publicKey/publicKeyMultibase'
    })
  }
  return { secret: Buffer.from(secret).toString('base64url') }
}

/** Computes the HMAC-SHA-256 of `verifyData` under the key's secret. */
function hmacDigest({
  key,
  operation,
  requestName
}: {
  key: KmsStoredKey
  operation: Record<string, unknown>
  requestName: string
}): Buffer {
  const data = decodeBase64url({
    value: operation.verifyData,
    field: 'verifyData',
    requestName
  })
  const secret = Buffer.from(key.secret as string, 'base64url')
  return createHmac('sha256', secret).update(data).digest()
}

/** SignOperation on an HMAC key. */
async function hmacSign({
  key,
  operation
}: {
  key: KmsStoredKey
  operation: Record<string, unknown>
}): Promise<{ signatureValue: string }> {
  const digest = hmacDigest({ key, operation, requestName: 'Sign Operation' })
  return { signatureValue: digest.toString('base64url') }
}

/**
 * VerifyOperation on an HMAC key -- the one served verify (a client cannot
 * check an HMAC without the symmetric secret). A wrong-*length*
 * `signatureValue` is an ordinary `verified: false`, checked before
 * `timingSafeEqual` (which throws on mismatched lengths -- the bedrock rough
 * edge that surfaces as a 500 there).
 */
async function hmacVerify({
  key,
  operation
}: {
  key: KmsStoredKey
  operation: Record<string, unknown>
}): Promise<{ verified: boolean }> {
  const requestName = 'Verify Operation'
  const signature = decodeBase64url({
    value: operation.signatureValue,
    field: 'signatureValue',
    requestName
  })
  const expected = hmacDigest({ key, operation, requestName })
  const verified =
    signature.length === expected.length && timingSafeEqual(signature, expected)
  return { verified }
}

/** WrapKeyOperation on an AES-KW key encryption key. */
async function aesWrapKey({
  key,
  operation
}: {
  key: KmsStoredKey
  operation: Record<string, unknown>
}): Promise<{ wrappedKey: string }> {
  const unwrapped = decodeBase64url({
    value: operation.unwrappedKey,
    field: 'unwrappedKey',
    requestName: 'Wrap Key Operation'
  })
  const secret = Buffer.from(key.secret as string, 'base64url')
  const cipher = createCipheriv(AES_KW_ALGORITHM, secret, AES_KW_DEFAULT_IV)
  const wrapped = Buffer.concat([cipher.update(unwrapped), cipher.final()])
  return { wrappedKey: wrapped.toString('base64url') }
}

/**
 * UnwrapKeyOperation on an AES-KW key encryption key. A failed unwrap -- the
 * RFC 3394 integrity check rejecting the ciphertext (wrong KEK, corrupted
 * `wrappedKey`) -- resolves `unwrappedKey: null` rather than erroring: that is
 * the client's documented contract (`Kek.unwrapKey` resolves null when the key
 * does not match), which no bedrock layer actually implements (there the
 * `decipher.final()` throw surfaces as a 500).
 */
async function aesUnwrapKey({
  key,
  operation
}: {
  key: KmsStoredKey
  operation: Record<string, unknown>
}): Promise<{ unwrappedKey: string | null }> {
  const wrapped = decodeBase64url({
    value: operation.wrappedKey,
    field: 'wrappedKey',
    requestName: 'Unwrap Key Operation'
  })
  const secret = Buffer.from(key.secret as string, 'base64url')
  try {
    const decipher = createDecipheriv(
      AES_KW_ALGORITHM,
      secret,
      AES_KW_DEFAULT_IV
    )
    const unwrapped = Buffer.concat([
      decipher.update(wrapped),
      decipher.final()
    ])
    return { unwrappedKey: unwrapped.toString('base64url') }
  } catch {
    return { unwrappedKey: null }
  }
}

/**
 * The operation dispatch table: which operation envelope `type`s this module
 * serves for each key type, and the pure-crypto implementation for each pair.
 * Deliberate omissions (custody is the criterion): `VerifyOperation` on the
 * asymmetric and key-agreement types (verify client-locally against the
 * description's `publicKeyMultibase`), and every cross-type combination.
 */
const KEY_OPERATIONS: Record<
  string,
  Record<
    string,
    (options: {
      key: KmsStoredKey
      operation: Record<string, unknown>
    }) => Promise<object>
  >
> = {
  Ed25519VerificationKey2020: { SignOperation: ed25519Sign },
  X25519KeyAgreementKey2020: { DeriveSecretOperation: x25519DeriveSecret },
  Sha256HmacKey2019: { SignOperation: hmacSign, VerifyOperation: hmacVerify },
  AesKeyWrappingKey2019: {
    WrapKeyOperation: aesWrapKey,
    UnwrapKeyOperation: aesUnwrapKey
  }
}

/**
 * Runs a key operation envelope against a stored key, dispatching on
 * `(key.type, operation.type)`. An operation this module does not serve for
 * the key's type -- or does not recognize at all -- is a clean 400
 * `UnsupportedKeyOperationError` (where bedrock's dispatch throws an uncaught
 * "Unsupported operation" that surfaces as a 500).
 *
 * @param options {object}
 * @param options.key {KmsStoredKey}   the stored (secret-bearing) key
 * @param options.operation {Record<string, unknown>}   the validated envelope
 * @returns {Promise<object>}   the operation's wire result (`signatureValue` /
 *   `verified` / `secret` / `wrappedKey` / `unwrappedKey`)
 */
export async function runKeyOperation({
  key,
  operation
}: {
  key: KmsStoredKey
  operation: Record<string, unknown>
}): Promise<object> {
  const operationType = operation.type as string
  const runOperation = KEY_OPERATIONS[key.type]?.[operationType]
  if (runOperation === undefined) {
    throw new UnsupportedKeyOperationError({
      operationType,
      keyType: key.type
    })
  }
  return await runOperation({ key, operation })
}
