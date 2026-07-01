/**
 * Collection client-side encryption marker helpers (spec "Encrypted
 * Collections"). A Collection MAY carry a non-secret `encryption` marker
 * declaring that its Resources are client-encrypted and naming the scheme; any
 * authorized reader discovers it by reading the Collection Description and then
 * decrypts with its own keys. The server never decrypts: it validates only the
 * marker's *shape* and enforces *set-once* immutability, storing the value
 * opaquely. This mirrors the backend-selection helpers in lib/backends.ts
 * (validate on write / preserve on read), kept separate because encryption is a
 * per-Collection client concern, not a backend capability.
 */
import type { CollectionEncryption } from '../types.js'
import {
  InvalidRequestBodyError,
  EncryptionImmutableError,
  UnsupportedEncryptionSchemeError,
  EncryptionSchemeMismatchError
} from '../errors.js'
import { isValidEdvDocument } from './edvEnvelope.js'

/**
 * The encryption schemes this server recognizes and can enforce on write (spec
 * "Encryption Scheme Registry"). Each entry pins the scheme token to its
 * required stored-representation media type and the structural validator for its
 * envelope profile. v1 has exactly one entry: `edv` (EDV-over-WAS), an EDV
 * **Encrypted Document** (a JSON object whose `jwe` member is a JWE in JSON
 * serialization) carried as `application/json` -- matching what the EDV codec
 * actually stores and how a native EDV server serves an Encrypted Document.
 * "Marked with a recognized scheme" structurally implies "non-conforming writes
 * rejected here" -- the fail-closed guarantee: a plaintext object under
 * `application/json` passes the media-type gate but fails the structural
 * `jwe` gate, so it is still rejected. Extending the registry (a new scheme, or
 * a new media type for an existing one) is the only place a scheme becomes
 * acceptable.
 */
export const SUPPORTED_ENCRYPTION_SCHEMES: Record<
  string,
  { mediaType: string; validateEnvelope: (body: unknown) => boolean }
> = {
  edv: {
    mediaType: 'application/json',
    validateEnvelope: isValidEdvDocument
  }
}

/**
 * Validates a client-supplied Collection `encryption` marker and returns the
 * normalized value to persist, or `undefined` when absent (plaintext). Two
 * gates: (1) shape -- a present value must be an object with a non-empty string
 * `scheme`, else `invalid-request-body` (400, pointer `#/encryption`); (2)
 * fail-closed scheme gate -- the `scheme` MUST name one this server recognizes
 * and can enforce on write (`SUPPORTED_ENCRYPTION_SCHEMES`), else
 * `unsupported-encryption-scheme` (400, pointer `#/encryption/scheme`). Taking
 * the spec's SHOULD path, the reference server refuses to store a marker it
 * cannot back with write-time validation, rather than storing an unknown scheme
 * opaquely. Unknown **extra fields** on an otherwise-recognized marker are still
 * preserved (the whole object is returned, not reduced to `{ scheme }`) so
 * future public-reference fields a newer client adds (e.g. recipient key
 * references) survive an older server unchanged.
 *
 * @param options {object}
 * @param [options.encryption] {unknown}   the request body's `encryption` value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {CollectionEncryption | undefined}   the marker to store, or undefined
 */
export function assertSupportedEncryption({
  encryption,
  requestName
}: {
  encryption?: unknown
  requestName?: string
}): CollectionEncryption | undefined {
  if (encryption === undefined) {
    return undefined
  }
  const scheme = (encryption as { scheme?: unknown })?.scheme
  if (
    typeof encryption !== 'object' ||
    encryption === null ||
    typeof scheme !== 'string' ||
    scheme.length === 0
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "encryption" must be an object with a non-empty string "scheme".',
      pointer: '#/encryption'
    })
  }
  // Fail closed: only a recognized scheme (one the server validates on write) is
  // accepted; an unknown scheme is rejected rather than stored opaquely.
  if (!Object.hasOwn(SUPPORTED_ENCRYPTION_SCHEMES, scheme)) {
    throw new UnsupportedEncryptionSchemeError({ scheme })
  }
  // Preserve the whole marker (only `scheme` is typed today; keep any extra
  // forward-compat fields on a recognized scheme).
  return encryption as CollectionEncryption
}

/**
 * Enforces set-once immutability of a Collection's `encryption` marker on
 * update. Call only when an `incoming` marker was supplied (and shape-validated)
 * by the request. Declaring a marker on a Collection that lacks one is allowed
 * (`absent -> present`: late declaration / migration of a pre-marker
 * Collection); re-sending the same `scheme` is a no-op. Changing the `scheme` of
 * an existing marker is rejected with `encryption-immutable` (409) -- it would
 * corrupt the stored, client-encrypted Resources. (Clearing is not expressible:
 * an absent body `encryption` leaves the existing marker untouched, and an
 * explicit non-object is already a 400 in `assertSupportedEncryption`.) The
 * `scheme` is the immutable identity; comparison deliberately ignores any
 * future public-reference fields, whose evolution (e.g. adding a recipient) is a
 * separate, allowed operation.
 *
 * @param options {object}
 * @param [options.existing] {CollectionEncryption}   the persisted marker
 * @param options.incoming {CollectionEncryption}   the validated request marker
 * @returns {void}
 */
export function assertEncryptionTransition({
  existing,
  incoming
}: {
  existing?: CollectionEncryption
  incoming: CollectionEncryption
}): void {
  if (existing !== undefined && existing.scheme !== incoming.scheme) {
    throw new EncryptionImmutableError()
  }
}

/**
 * Fail-closed structural validation of a Resource **content** write into an
 * encrypted Collection (spec "Encryption Scheme Registry"). When the target
 * Collection declares a recognized `encryption` scheme, a write MUST be a
 * conforming envelope of that scheme -- two gates: (1) the request `Content-Type`
 * MUST be the scheme's registered media type (so a binary/`octet-stream`,
 * `multipart`, or plain `application/json` upload is rejected outright), and (2)
 * the parsed body MUST satisfy the scheme's structural envelope profile. A
 * failure of either is `encryption-scheme-mismatch` (422). No-op when the
 * Collection has no marker (plaintext) or -- defensively -- an unrecognized
 * scheme (which `assertSupportedEncryption` prevents from ever being stored), so
 * plaintext Collections and API documents are unaffected. The server validates
 * structure only; it never decrypts. Call this **after** capability verification
 * and the 404-if-missing check, and before resolving the body stream, so a wrong
 * content type is rejected without consuming the upload and a 422 is observable
 * only to a caller already authorized to write the target.
 *
 * @param options {object}
 * @param options.collectionDescription {{ encryption?: CollectionEncryption }}
 *   the target Collection's stored description
 * @param [options.contentType] {string}   the request `Content-Type` header
 * @param options.body {unknown}   the parsed request body (an object for the
 *   `application/<suffix>+json` media types the scheme registry uses)
 * @returns {void}
 */
export function assertEncryptedWriteConforms({
  collectionDescription,
  contentType,
  body
}: {
  collectionDescription: { encryption?: CollectionEncryption }
  contentType?: string
  body: unknown
}): void {
  const scheme = collectionDescription.encryption?.scheme
  if (scheme === undefined) {
    return
  }
  const profile = SUPPORTED_ENCRYPTION_SCHEMES[scheme]
  if (!profile) {
    return
  }
  // Gate 1: the stored representation's media type. Compare the bare media type
  // (parameters like `; charset=utf-8` stripped), case-insensitively.
  const mediaType = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (mediaType !== profile.mediaType) {
    throw new EncryptionSchemeMismatchError({
      detail: `A write into a Collection encrypted with the '${scheme}' scheme must use Content-Type '${profile.mediaType}'.`
    })
  }
  // Gate 2: the envelope's structural profile (server validates shape, not
  // contents -- it never decrypts).
  if (!profile.validateEnvelope(body)) {
    throw new EncryptionSchemeMismatchError({
      detail: `Resource body is not a structurally valid '${scheme}' encryption envelope.`
    })
  }
}

/**
 * Fail-closed structural validation of a Resource **metadata** write (`PUT
 * /meta`) into an encrypted Collection (spec "Encrypted Collections"). When the
 * target Collection declares a recognized `encryption` scheme, the user-writable
 * `custom` object MUST be a conforming envelope of that scheme -- the same
 * structural profile used for content -- so a plaintext `{ name, tags }` cannot
 * be stored server-visibly. Unlike {@link assertEncryptedWriteConforms} there is
 * **no media-type gate**: the metadata document itself stays `application/json`
 * (its server-managed top-level fields are plaintext); only the `custom`
 * sub-value is the envelope. A non-conforming `custom` is
 * `encryption-scheme-mismatch` (422). No-op when the Collection has no marker
 * (plaintext) or -- defensively -- an unrecognized scheme. The server validates
 * structure only; it never decrypts. Call this **after** capability verification
 * and the 404-if-missing check, before the write, so a 422 is observable only to
 * a caller already authorized to write the target.
 *
 * @param options {object}
 * @param options.collectionDescription {{ encryption?: CollectionEncryption }}
 *   the target Collection's stored description
 * @param options.custom {unknown}   the request body's `custom` value
 * @returns {void}
 */
export function assertEncryptedMetaConforms({
  collectionDescription,
  custom
}: {
  collectionDescription: { encryption?: CollectionEncryption }
  custom: unknown
}): void {
  const scheme = collectionDescription.encryption?.scheme
  if (scheme === undefined) {
    return
  }
  const profile = SUPPORTED_ENCRYPTION_SCHEMES[scheme]
  if (!profile) {
    return
  }
  if (!profile.validateEnvelope(custom)) {
    throw new EncryptionSchemeMismatchError({
      detail: `Resource metadata "custom" is not a structurally valid '${scheme}' encryption envelope.`
    })
  }
}
