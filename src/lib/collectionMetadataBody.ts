/**
 * The shape check of a Collection Metadata body, shared by the two writes
 * that carry one (Create Collection, Update or Create by Id Collection) and
 * by Import Space, which applies it to an archived Collection Metadata
 * object. One parser, so a member added to the live write's shape check is
 * checked on import too, and an archive cannot store a descriptor no live
 * write could.
 */
import { assertSupportedEncryption } from './encryption.js'
import {
  assertPlaintextNotEncrypted,
  assertSupportedPlaintext
} from './equalityIndex.js'
import { assertValidGenerator } from './generator.js'
import { assertValidRevisions } from './revisions.js'
import { parseMetaEpoch } from './keyEpoch.js'
import { InvalidRequestBodyError } from '../errors.js'
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
  revisions?: CollectionMetadata['revisions']
  epoch?: string
}

/**
 * Shape-checks the writable members of a Collection Metadata body (400 on a
 * malformed one). The body must be a JSON object. `name` must be a string
 * when present. The encryption descriptor, the `revisions` descriptor, the
 * `plaintext` declaration, the app-attribution members and the top-level
 * `epoch` are checked by their own validators, and `plaintext` beside
 * `encryption` in one body is refused; the read-only members (`createdAt`, `updatedAt`, `createdBy`,
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
  // The two exclude each other. The write handlers check again against the
  // stored object, since one member may come from the body and the other
  // from the stored or governed state.
  assertPlaintextNotEncrypted({ plaintext, encryption, requestName })
  // Validate the optional app-attribution object (shape only). It is the
  // controller's assertion: stored verbatim, echoed on reads, never an
  // authorization input and never defaulted by the server.
  const generator = assertValidGenerator({
    generator: record.generator,
    requestName
  })
  // Validate the optional `revisions` descriptor (shape only; its set-once
  // rule reads the stored object and runs after authorization).
  const revisions = assertValidRevisions({
    revisions: record.revisions,
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
    ...(revisions !== undefined && { revisions }),
    ...(epoch !== undefined && { epoch })
  }
}
