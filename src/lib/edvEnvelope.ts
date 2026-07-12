/**
 * Structural validator for the `edv` encryption scheme's envelope profile (spec
 * "Encryption Scheme Registry"). An `edv`-encrypted Resource is stored as an EDV
 * **Encrypted Document** -- a JSON object whose `jwe` member is a JWE in JSON
 * serialization (general or flattened, RFC7516). This checks only its *shape* so
 * the server can fail closed on a non-envelope write into an encrypted
 * Collection. The server MUST NOT attempt decryption and MUST NOT interpret the
 * ciphertext or key values -- it validates that the document carries a
 * plausible JWE, not that it decrypts.
 */

/**
 * True if `entry` is a structurally valid JWE general-serialization
 * `recipients` array entry: an object whose OPTIONAL `header` is an object and
 * whose OPTIONAL `encrypted_key` is a string. Purely structural (values are
 * never decoded); shared by {@link isValidEdvEnvelope} and the Collection
 * key-epoch marker validator (`lib/encryption.ts`), which reuses the JWE
 * recipients entry shape verbatim -- one wire vocabulary.
 *
 * @param entry {unknown}   one element of a `recipients` array
 * @returns {boolean}
 */
export function isValidJweRecipientEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return false
  }
  const recipient = entry as Record<string, unknown>
  if (
    recipient.header !== undefined &&
    (typeof recipient.header !== 'object' ||
      recipient.header === null ||
      Array.isArray(recipient.header))
  ) {
    return false
  }
  if (
    recipient.encrypted_key !== undefined &&
    typeof recipient.encrypted_key !== 'string'
  ) {
    return false
  }
  return true
}

/**
 * True if `body` is a structurally valid JWE-JSON-serialization object: an
 * object with a required non-empty string `ciphertext`; optional string
 * `protected` / `iv` / `tag` / `encrypted_key`; an optional `recipients` array
 * of `{ header?: object, encrypted_key?: string }`; and at least one key-delivery
 * member present (`recipients` non-empty, top-level `encrypted_key`, or
 * `protected` -- covering general, flattened, and direct JWE serializations).
 * Purely structural: values are never decoded or decrypted.
 *
 * @param body {unknown}   the parsed request body to check
 * @returns {boolean}
 */
export function isValidEdvEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false
  }
  const envelope = body as Record<string, unknown>

  // Required: a non-empty string `ciphertext`.
  if (
    typeof envelope.ciphertext !== 'string' ||
    envelope.ciphertext.length === 0
  ) {
    return false
  }

  // Optional string members.
  for (const key of ['protected', 'iv', 'tag', 'encrypted_key'] as const) {
    if (envelope[key] !== undefined && typeof envelope[key] !== 'string') {
      return false
    }
  }

  // Optional `recipients`: an array of `{ header?: object, encrypted_key?: string }`.
  let hasRecipient = false
  if (envelope.recipients !== undefined) {
    if (!Array.isArray(envelope.recipients)) {
      return false
    }
    for (const entry of envelope.recipients) {
      if (!isValidJweRecipientEntry(entry)) {
        return false
      }
    }
    hasRecipient = envelope.recipients.length > 0
  }

  // anyOf: at least one key-delivery member -- a general-serialization
  // `recipients` list, a flattened top-level `encrypted_key`, or a `protected`
  // header (direct encryption, no per-recipient key).
  return (
    hasRecipient ||
    typeof envelope.encrypted_key === 'string' ||
    typeof envelope.protected === 'string'
  )
}

/**
 * True if `body` is a structurally valid EDV **Encrypted Document**: a JSON
 * object whose `jwe` member is a valid JWE-JSON envelope ({@link
 * isValidEdvEnvelope}). This is the actual stored representation the EDV codec
 * produces -- `documentCipher.encrypt` nests the JWE under `jwe` alongside EDV
 * bookkeeping members (`id`, `sequence`, `indexed`), which are opaque to the
 * server and not checked. A bare JWE (top-level `ciphertext`, no `jwe`) or a
 * plaintext object fails this check, so an enforcing server fails closed on a
 * non-envelope write. Purely structural: values are never decoded or decrypted.
 *
 * @param body {unknown}   the parsed request body (or `custom` sub-value) to check
 * @returns {boolean}
 */
export function isValidEdvDocument(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false
  }
  return isValidEdvEnvelope((body as { jwe?: unknown }).jwe)
}
