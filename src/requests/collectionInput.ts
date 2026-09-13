/**
 * Shared composition of a Collection Metadata object from a request body, for
 * the two writes that carry one: Create Collection (`POST /space/:spaceId/`)
 * and Update (or Create by Id) Collection (`PUT /space/:spaceId/:collectionId/meta`).
 * Both take the merged object -- the configuration members beside the
 * annotation members `custom` and `epoch` -- and both are a full replacement
 * (spec "Update (or Create by Id) Collection"): a writable member the request
 * omits is cleared, except where the spec says otherwise (see
 * `composeCollectionMetadata`).
 *
 * The work is split in two on the same boundary every handler keeps: the
 * shape checks run before authorization (a malformed body is a 400 whoever
 * sends it), while the checks that read Space or Collection state -- the
 * backend allowlist, the encryption transition, the `custom` envelope -- run
 * after it, so their 409/422 are observable only to an authorized caller.
 */
import type { FastifyRequest } from 'fastify'
import { assertSupportedBackend } from '../lib/backends.js'
import {
  assertSupportedEncryption,
  assertEncryptionDescriptorTransition
} from '../lib/encryption.js'
import {
  assertPlaintextNotEncrypted,
  assertSupportedPlaintext
} from '../lib/equalityIndex.js'
import {
  assertValidGenerator,
  assertValidGeneratorOrigin
} from '../lib/generator.js'
import { resolveMetadataCustom } from '../lib/customMetadata.js'
import { parseMetaEpoch } from '../lib/keyEpoch.js'
import {
  EncryptionHistoryLogGovernedError,
  InvalidRequestBodyError
} from '../errors.js'
import type { CollectionMetadata } from '../types.js'

/**
 * The shape-validated writable members of a Collection Metadata request body,
 * before any state is consulted. `backend` stays raw: its check reads the
 * Space's backends-available and so belongs after authorization.
 */
export interface ParsedCollectionMetadataBody {
  body: Record<string, unknown>
  name?: string
  encryption?: CollectionMetadata['encryption']
  plaintext?: CollectionMetadata['plaintext']
  generator?: CollectionMetadata['generator']
  generatorOrigin?: string
  epoch?: string
}

/**
 * Shape-checks the writable members of a Collection Metadata body (400 on a
 * malformed one). The body must be a JSON object. `name` must be a string
 * when present. The encryption descriptor, the `plaintext` declaration, the
 * app-attribution members and the top-level `epoch` are checked by their own
 * validators; the read-only members (`createdAt`, `updatedAt`, `createdBy`,
 * `url`, `linkset`) are ignored, as the spec requires, so a read-modify-write
 * round trip needs no stripping. `custom` is deferred: whether it must be a
 * plaintext `{ name, tags }` or an opaque envelope depends on the encryption
 * descriptor in effect after the write.
 * @param options {object}
 * @param options.body {unknown}   the parsed request body
 * @param options.requestName {string}   request name for the 400 error title
 * @returns {ParsedCollectionMetadataBody}
 */
export function parseCollectionMetadataBody({
  body,
  requestName
}: {
  body: unknown
  requestName: string
}): ParsedCollectionMetadataBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The Collection Metadata body must be a JSON object.'
    })
  }
  const record = body as Record<string, unknown>
  if (record.name !== undefined && typeof record.name !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The Collection Metadata "name" must be a string.',
      pointer: '#/name'
    })
  }
  // Validate the optional client-side encryption descriptor (shape only; the
  // server stores it opaquely and never decrypts). Absent => plaintext.
  const encryption = assertSupportedEncryption({
    encryption: record.encryption,
    requestName
  })
  // Validate the optional `plaintext` member (its `indexes` declaration is
  // the `equality-query` feature).
  const plaintext = assertSupportedPlaintext({
    plaintext: record.plaintext,
    requestName
  })
  // Validate the optional app-attribution members (shape only). Both are the
  // controller's assertions: stored verbatim, echoed on reads, never an
  // authorization input and never defaulted by the server.
  const generator = assertValidGenerator({
    generator: record.generator,
    requestName
  })
  const generatorOrigin = assertValidGeneratorOrigin({
    generatorOrigin: record.generatorOrigin,
    requestName
  })
  // The key-epoch stamp of the `custom` envelope (the `key-epochs` feature);
  // a present value must be a non-empty string.
  const { epoch } = parseMetaEpoch({ body: record, requestName })
  return {
    body: record,
    ...(record.name !== undefined && { name: record.name as string }),
    ...(encryption !== undefined && { encryption }),
    ...(plaintext !== undefined && { plaintext }),
    ...(generator !== undefined && { generator }),
    ...(generatorOrigin !== undefined && { generatorOrigin }),
    ...(epoch !== undefined && { epoch })
  }
}

/**
 * The encryption-descriptor checks a Collection Metadata write runs against
 * the Collection's current state: a direct `encryption` write on a
 * log-governed Collection is refused (`encryption-history-log-governed`,
 * 409), the descriptor is set-once (`encryption-immutable`, 409), and the
 * effective object may not carry both `plaintext` and `encryption` (400).
 * Update Collection runs it twice, once against its pre-lock read for a clean
 * early rejection and again against the prior the backend re-reads under its
 * lock.
 * @param options {object}
 * @param options.parsed {ParsedCollectionMetadataBody}   the shape-checked body
 * @param [options.existing] {CollectionMetadata}   the stored object, on an
 *   update (absent on a create)
 * @param [options.governedEncryption] {CollectionMetadata['encryption']}   the
 *   descriptor derived from the Collection's history log, when it has one
 * @param options.requestName {string}   request name for error titles
 */
export function assertCollectionMetadataTransition({
  parsed,
  existing,
  governedEncryption,
  requestName
}: {
  parsed: ParsedCollectionMetadataBody
  existing?: CollectionMetadata
  governedEncryption?: CollectionMetadata['encryption']
  requestName: string
}): void {
  if (governedEncryption !== undefined && parsed.encryption !== undefined) {
    throw new EncryptionHistoryLogGovernedError()
  }
  assertEncryptionDescriptorTransition({
    existing: existing?.encryption,
    incoming: parsed.encryption
  })
  assertPlaintextNotEncrypted({
    plaintext: parsed.plaintext ?? existing?.plaintext,
    encryption: parsed.encryption ?? existing?.encryption ?? governedEncryption,
    requestName
  })
}

/**
 * Composes the Collection Metadata object a write persists, from the parsed
 * body and the Collection's current state. Runs after authorization. The
 * rules, in order:
 *
 * - `id` is the URL's (or the body's, on Create Collection); `type` is
 *   `['Collection']`.
 * - `backend` is validated against the Space's backends-available (bad shape
 *   400, unknown id 409). A create with none gets the server default; an
 *   update with none keeps the stored selection (spec "Update (or Create by
 *   Id) Collection").
 * - `encryption`: a direct write on a log-governed Collection is refused
 *   (`encryption-history-log-governed`, 409). Otherwise the descriptor is
 *   set-once: an omitted member on an encrypted Collection is an attempt to
 *   clear it, `encryption-immutable` (409), as is any narrowing change.
 * - `plaintext` is the spec's one carve-out from clearing: an omitted member
 *   leaves the stored one untouched. The result may not carry both
 *   `plaintext` and `encryption` (400).
 * - `name`, `generator`, `generatorOrigin` and `epoch` are taken from the body
 *   alone: omitted means cleared. A create with no `name` gets the Collection
 *   id as its name.
 * - `custom`, when present, is the plaintext `{ name, tags }` object or, on an
 *   encrypted Collection, a conforming envelope (422 otherwise). An omitted
 *   `custom` is the cleared state on either kind of Collection and is never
 *   judged as an envelope, so a Collection born with no annotations stays
 *   writable without minting one.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server`
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.parsed {ParsedCollectionMetadataBody}   the shape-checked body
 * @param [options.existing] {CollectionMetadata}   the stored object, on an
 *   update (absent on a create)
 * @param [options.governedEncryption] {CollectionMetadata['encryption']}   the
 *   descriptor derived from the Collection's history log, when it has one
 * @param options.requestName {string}   request name for error titles
 * @returns {Promise<CollectionMetadata>}   the object to hand to
 *   `writeCollection` (validator-free; `createdBy` and the timestamps are the
 *   backend's to stamp)
 */
export async function composeCollectionMetadata({
  request,
  spaceId,
  collectionId,
  parsed,
  existing,
  governedEncryption,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  parsed: ParsedCollectionMetadataBody
  existing?: CollectionMetadata
  governedEncryption?: CollectionMetadata['encryption']
  requestName: string
}): Promise<CollectionMetadata> {
  const { storage } = request.server
  // An omitted `backend` keeps the stored selection on an update; only a
  // create with none gets the server default (spec "Update (or Create by Id)
  // Collection"). The carried-forward value is not re-validated against the
  // Space's backends-available: it was accepted when it was selected, and a
  // backend deregistered since must not make an unrelated rename fail.
  const backend =
    parsed.body.backend === undefined && existing?.backend !== undefined
      ? existing.backend
      : await assertSupportedBackend({
          storage,
          spaceId,
          backend: parsed.body.backend,
          requestName
        })
  // Checked here for a clean early rejection and again by the caller's
  // `assertTransition` under the backend's lock.
  assertCollectionMetadataTransition({
    parsed,
    existing,
    governedEncryption,
    requestName
  })
  const plaintext = parsed.plaintext ?? existing?.plaintext
  const encryption = parsed.encryption ?? governedEncryption

  // An omitted `custom` is the cleared state, on an encrypted Collection as
  // much as on a plaintext one (spec "Lifecycle": clearing the annotations is
  // a `PUT` carrying an empty `custom` object "or none at all"). It is never
  // run through the envelope validator, which judges a *present* value and
  // rejects `undefined` -- absence is not a malformed envelope, it is the
  // absence of annotations. Checking presence alone, rather than presence on
  // a create, is what lets an encrypted Collection born with no annotations
  // be updated afterward: every write would otherwise have to mint an
  // envelope, which a caller holding no keys (an `epoch` rotation, a rename)
  // cannot do.
  const custom =
    parsed.body.custom === undefined
      ? undefined
      : resolveMetadataCustom({
          collectionMetadata: { encryption },
          body: parsed.body,
          requestName
        })

  // A create with no `name` gets the id; an update with none clears it.
  const name =
    parsed.name ?? (existing === undefined ? collectionId : undefined)
  return {
    id: collectionId,
    type: ['Collection'],
    ...(name !== undefined && { name }),
    backend,
    ...(parsed.encryption !== undefined && { encryption: parsed.encryption }),
    ...(plaintext !== undefined && { plaintext }),
    ...(parsed.generator !== undefined && { generator: parsed.generator }),
    ...(parsed.generatorOrigin !== undefined && {
      generatorOrigin: parsed.generatorOrigin
    }),
    ...(parsed.epoch !== undefined && { epoch: parsed.epoch }),
    ...(custom !== undefined && {
      custom: custom as CollectionMetadata['custom']
    })
  }
}
