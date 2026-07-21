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
import type {
  CollectionEncryption,
  CollectionEncryptionEpoch
} from '../types.js'
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
  // Validate the OPTIONAL key-epoch fields (`epochs` / `currentEpoch`) when
  // present: shape-only safety rails against client bugs (a dropped epoch, a
  // dangling `currentEpoch`), never crypto verification -- the server holds no
  // key. Absent fields are a plain single-key-set marker and pass unchanged.
  assertValidEncryptionEpochs({
    marker: encryption as CollectionEncryption,
    requestName
  })

  // Validate the OPTIONAL scheme-version field when present (shape only).
  assertValidEncryptionVersion({ marker: encryption, requestName })

  // Preserve the whole marker (only `scheme` is typed today; keep any extra
  // forward-compat fields on a recognized scheme).
  return encryption as CollectionEncryption
}

/**
 * Validates the OPTIONAL `version` member of a Collection `encryption` marker --
 * the encryption scheme's version, a sibling of `scheme`. Shape-only: when
 * present it MUST be a positive safe integer, else `invalid-request-body` (400,
 * pointer `#/encryption/version`). Absent is a legacy/unversioned marker and
 * passes unchanged. Read from the still-`unknown`-shaped marker value: `version`
 * is a forward-compatibility field the server preserves opaquely, not part of
 * the typed `CollectionEncryption` shape.
 *
 * @param options {object}
 * @param options.marker {unknown}   the shape-validated marker value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {void}
 */
function assertValidEncryptionVersion({
  marker,
  requestName
}: {
  marker: unknown
  requestName?: string
}): void {
  const { version } = marker as { version?: unknown }
  if (version === undefined) {
    return
  }
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version <= 0
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "encryption.version" must be a positive safe integer.',
      pointer: '#/encryption/version'
    })
  }
}

/**
 * Validates the OPTIONAL key-epoch public-reference fields of a Collection
 * `encryption` marker (spec "Encrypted Collections"; the `key-epochs` feature).
 * Shape-only integrity checks that catch client bugs -- the server never
 * interprets key material, so these are safety rails, not cryptographic
 * verification. Rejects with `invalid-request-body` (400) and a precise
 * `pointer`. Rules:
 * - `epochs` and `currentEpoch` are all-or-nothing: either both absent (a plain
 *   single-key-set marker) or both present.
 * - `epochs`: a non-empty array; each entry an object with a non-empty string
 *   `id` (ids unique across the array) and a non-empty `recipients` array.
 * - each `recipients` entry carries the JWE recipients-entry members the
 *   marker requires: a `header` object with non-empty string `kid` and `alg`,
 *   plus a string `encrypted_key` (the wrapped epoch key).
 * - `currentEpoch`: a non-empty string naming an `id` that exists in `epochs`.
 *
 * @param options {object}
 * @param options.marker {CollectionEncryption}   the shape-validated marker
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {void}
 */
function assertValidEncryptionEpochs({
  marker,
  requestName
}: {
  marker: CollectionEncryption
  requestName?: string
}): void {
  const { epochs, currentEpoch } = marker
  // All-or-nothing: `epochs` and `currentEpoch` appear together or not at all.
  if ((epochs === undefined) !== (currentEpoch === undefined)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "encryption.epochs" and "encryption.currentEpoch" must both be present or both absent.',
      pointer: '#/encryption/epochs'
    })
  }
  if (epochs === undefined) {
    return
  }
  if (!Array.isArray(epochs) || epochs.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Collection "encryption.epochs" must be a non-empty array.',
      pointer: '#/encryption/epochs'
    })
  }
  const ids = new Set<string>()
  epochs.forEach((epoch, epochIndex) => {
    const pointer = `#/encryption/epochs/${epochIndex}`
    if (typeof epoch !== 'object' || epoch === null || Array.isArray(epoch)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: 'Each "encryption.epochs" entry must be an object.',
        pointer
      })
    }
    const { id, recipients } = epoch as CollectionEncryptionEpoch
    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidRequestBodyError({
        requestName,
        detail:
          'Each "encryption.epochs" entry must have a non-empty string "id".',
        pointer: `${pointer}/id`
      })
    }
    if (ids.has(id)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Duplicate "encryption.epochs" id "${id}".`,
        pointer: `${pointer}/id`
      })
    }
    ids.add(id)
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new InvalidRequestBodyError({
        requestName,
        detail:
          'Each "encryption.epochs" entry must have a non-empty "recipients" array.',
        pointer: `${pointer}/recipients`
      })
    }
    recipients.forEach((recipient, recipientIndex) => {
      const rPointer = `${pointer}/recipients/${recipientIndex}`
      // The JWE recipients-entry members the wrapped-epoch-key marker needs:
      // `header.kid` / `header.alg` and the wrapped key `encrypted_key`. The
      // member checks (optional chaining included) already reject every
      // non-object or malformed entry, so no generic JWE-entry shape test runs
      // first.
      const header = (
        recipient as { header?: { kid?: unknown; alg?: unknown } }
      )?.header
      if (
        typeof header?.kid !== 'string' ||
        header.kid.length === 0 ||
        typeof header.alg !== 'string' ||
        header.alg.length === 0 ||
        typeof (recipient as { encrypted_key?: unknown }).encrypted_key !==
          'string'
      ) {
        throw new InvalidRequestBodyError({
          requestName,
          detail:
            'Each "recipients" entry must have a "header" object with non-empty string "kid" and "alg", plus a string "encrypted_key".',
          pointer: rPointer
        })
      }
    })
  })
  if (typeof currentEpoch !== 'string' || currentEpoch.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "encryption.currentEpoch" must be a non-empty string.',
      pointer: '#/encryption/currentEpoch'
    })
  }
  if (!ids.has(currentEpoch)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: `Collection "encryption.currentEpoch" ("${currentEpoch}") does not name an epoch in "epochs".`,
      pointer: '#/encryption/currentEpoch'
    })
  }
}

/**
 * Enforces the epoch-safety rails on an UPDATE, when the existing marker already
 * carries `epochs` (spec "Encrypted Collections"; the `key-epochs` feature).
 * Call only when an `incoming` marker was supplied and shape-validated. Rules
 * (both `invalid-request-body`, 400):
 * - **append-only**: every existing epoch id must still be present in
 *   `incoming.epochs` -- dropping an epoch would strand every Resource stamped
 *   with it (the removed reader could still hold that epoch's key, but no
 *   remaining reader could find it).
 * - **`currentEpoch` never moves backwards**: the incoming `currentEpoch` must
 *   equal the existing one OR name an epoch id that was NOT in the existing
 *   `epochs` list (a freshly appended epoch). This is the array-order-independent
 *   formulation of "monotonic".
 *
 * Recipients WITHIN an existing epoch MAY change (adding a recipient wraps the
 * epoch key to it; escrow adds entries to old epochs), so that is not
 * restricted. A first declaration of `epochs` on a marker that had none is
 * likewise unrestricted (there is nothing to append to yet).
 *
 * @param options {object}
 * @param [options.existing] {CollectionEncryption}   the persisted marker
 * @param options.incoming {CollectionEncryption}   the validated request marker
 * @returns {void}
 */
export function assertEncryptionEpochsTransition({
  existing,
  incoming
}: {
  existing?: CollectionEncryption
  incoming: CollectionEncryption
}): void {
  const existingEpochs = existing?.epochs
  if (existingEpochs === undefined || existingEpochs.length === 0) {
    // No prior epochs: a first epoch declaration has nothing to append to.
    return
  }
  const incomingIds = new Set((incoming.epochs ?? []).map(epoch => epoch.id))
  // Append-only: no existing epoch id may vanish.
  for (const epoch of existingEpochs) {
    if (!incomingIds.has(epoch.id)) {
      throw new InvalidRequestBodyError({
        detail: `Collection "encryption.epochs" is append-only: epoch "${epoch.id}" may not be removed.`,
        pointer: '#/encryption/epochs'
      })
    }
  }
  // `currentEpoch` never moves backwards: keep it, or repoint it to a
  // newly-appended epoch id (one that did not exist before).
  const existingIds = new Set(existingEpochs.map(epoch => epoch.id))
  const { currentEpoch } = incoming
  if (
    currentEpoch !== existing?.currentEpoch &&
    existingIds.has(currentEpoch as string)
  ) {
    throw new InvalidRequestBodyError({
      detail: `Collection "encryption.currentEpoch" may not move back to the existing epoch "${currentEpoch}"; repoint it only to a newly appended epoch.`,
      pointer: '#/encryption/currentEpoch'
    })
  }
}

/**
 * Enforces the full `encryption`-marker transition rails against a persisted
 * marker in one call: set-once immutability
 * ({@link assertEncryptionTransition}) plus the key-epoch rails
 * ({@link assertEncryptionEpochsTransition}). Unlike those two -- which require
 * a supplied `incoming` -- this also accepts an absent one: a write whose
 * description would CLEAR an existing marker is rejected with
 * `encryption-immutable` (409), on the same terms as changing it. The request
 * layer uses this twice per Update Collection: once against its own
 * (pre-lock) read for a clean early rejection, and again as the
 * `writeCollection` `assertTransition` callback, re-evaluated inside the
 * backend's lock/transaction against the freshly re-read description -- so a
 * concurrent marker write cannot be silently clobbered and the epoch
 * append-only rail holds unconditionally, not just under `If-Match`.
 *
 * @param options {object}
 * @param [options.existing] {CollectionEncryption}   the persisted marker
 * @param [options.incoming] {CollectionEncryption}   the marker about to be
 *   persisted (absent when the write would drop the marker entirely)
 * @returns {void}
 */
export function assertEncryptionMarkerTransition({
  existing,
  incoming
}: {
  existing?: CollectionEncryption
  incoming?: CollectionEncryption
}): void {
  if (existing === undefined) {
    // Nothing persisted yet: a first declaration (or a plaintext Collection
    // staying plaintext) has no rails to check.
    return
  }
  if (incoming === undefined) {
    throw new EncryptionImmutableError()
  }
  assertEncryptionTransition({ existing, incoming })
  assertEncryptionEpochsTransition({ existing, incoming })
  assertEncryptionVersionTransition({ existing, incoming })
}

/**
 * Enforces the scheme-version rail on an UPDATE, when the existing marker
 * already carries a `version` (spec "Encrypted Collections"; the scheme-version
 * field). Call only when an `incoming` marker was supplied (and shape-validated).
 * Once set, the marker's `version` follows the same never-backwards philosophy
 * as `currentEpoch`: an update may not REMOVE it and may not DECREASE it
 * (increasing is allowed, a future scheme migration). Either violation is
 * `invalid-request-body` (400, pointer `#/encryption/version`). A marker that
 * had no prior `version` is unrestricted (a first declaration -- including
 * ADDING a version to a versionless marker -- has nothing to move backwards
 * from). Both values are read from the still-`unknown`-shaped marker: `version`
 * is preserved opaquely, not part of the typed `CollectionEncryption` shape.
 *
 * @param options {object}
 * @param [options.existing] {CollectionEncryption}   the persisted marker
 * @param options.incoming {CollectionEncryption}   the validated request marker
 * @returns {void}
 */
export function assertEncryptionVersionTransition({
  existing,
  incoming
}: {
  existing?: CollectionEncryption
  incoming: CollectionEncryption
}): void {
  const existingVersion = (existing as { version?: unknown } | undefined)
    ?.version
  if (typeof existingVersion !== 'number') {
    // No prior version: a first declaration has nothing to move backwards from.
    return
  }
  const incomingVersion = (incoming as { version?: unknown }).version
  if (incomingVersion === undefined) {
    throw new InvalidRequestBodyError({
      detail:
        'Collection "encryption.version" may not be removed once it has been set.',
      pointer: '#/encryption/version'
    })
  }
  if ((incomingVersion as number) < existingVersion) {
    throw new InvalidRequestBodyError({
      detail: `Collection "encryption.version" may not decrease (from ${existingVersion} to ${incomingVersion as number}).`,
      pointer: '#/encryption/version'
    })
  }
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
