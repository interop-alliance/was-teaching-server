/**
 * Backend-agnostic normalization of a Space or Collection Metadata object
 * about to be persisted. Both storage backends run the same rules through
 * {@link normalizeMetadataWrite}, {@link stampSpaceMetadata} and
 * {@link stampCollectionMetadata} so their
 * stored bodies and validator arithmetic cannot drift; only the storage of the
 * resolved validator differs downstream (`_generation` / `_version` members in
 * the filesystem metadata file vs the Postgres `meta_generation` /
 * `meta_version` columns).
 */
import type {
  CollectionMetadata,
  IDID,
  MetadataValidatorParts,
  SpaceMetadata,
  StoredCollectionMetadata,
  StoredSpaceMetadata
} from '../types.js'
import { type EtagValidator, newGeneration } from './etag.js'

/**
 * Splits an incoming Space or Collection Metadata object into the body to
 * persist and the validator to stamp. The validator-bearing members a wire or
 * archived object may carry are stripped from the body: `_generation` /
 * `_version` (the filesystem file layout, and the archive interchange tokens
 * embedded by `exportSpace`) and `metaGeneration` / `metaVersion` (the
 * out-of-band `ETag` validator a read result attaches, which a caller may
 * have spread back in). The validator to stamp resolves with the precedence:
 * the explicit `validator` argument (the write path's monotonic bump), else
 * the archived `_generation` / `_version` pair (the import path), else a fresh
 * generation at version 1 (a first write).
 *
 * @param options {object}
 * @param options.metadata {T}   the Space or Collection Metadata object
 * @param [options.validator] {EtagValidator}   the explicit validator to stamp
 * @returns {{ body: T, validator: EtagValidator }}
 */
export function normalizeMetadataWrite<
  T extends CollectionMetadata | SpaceMetadata
>({
  metadata,
  validator
}: {
  metadata: T
  validator?: EtagValidator
}): { body: T; validator: EtagValidator } {
  const {
    _generation: incomingGeneration,
    _version: incomingVersion,
    metaGeneration: _staleGeneration,
    metaVersion: _staleVersion,
    ...body
  } = metadata as T &
    MetadataValidatorParts & { _generation?: string; _version?: number }
  const archived =
    incomingGeneration !== undefined && incomingVersion !== undefined
      ? { generation: incomingGeneration, version: incomingVersion }
      : undefined
  return {
    body: body as T,
    validator: validator ??
      archived ?? { generation: newGeneration(), version: 1 }
  }
}

/**
 * Resolves the server-managed `createdBy` of a Space Metadata object about to
 * be written by `writeSpace`, against the prior stored object read under the
 * backend's per-Space lock. The client-supplied object is wire input and may
 * carry its own `createdBy`; it is discarded, since the server alone is
 * authoritative for it.
 *
 * `createdBy` names the Space's creator, not its last writer: taken from this
 * write's invoker only when this write CREATES the Space, and preserved
 * verbatim afterward -- including preserved-as-absent, so a Space created with
 * no invoker (a token-provisioned create) never has a later writer backfilled
 * into it as its creator.
 *
 * @param options {object}
 * @param options.spaceMetadata {SpaceMetadata}   the supplied object
 * @param [options.prior] {StoredSpaceMetadata}   the stored object, if any
 * @param [options.createdBy] {IDID}   this write's invoker
 * @returns {SpaceMetadata}
 */
export function stampSpaceMetadata({
  spaceMetadata,
  prior,
  createdBy
}: {
  spaceMetadata: SpaceMetadata
  prior?: StoredSpaceMetadata
  createdBy?: IDID
}): SpaceMetadata {
  const { createdBy: _suppliedCreatedBy, ...rest } = spaceMetadata
  const creator = prior ? prior.createdBy : createdBy
  return {
    ...rest,
    ...(creator !== undefined && { createdBy: creator })
  }
}

/**
 * Resolves the server-managed members of a Collection Metadata object about
 * to be written by `writeCollection`, against the prior stored object read
 * under the backend's per-Collection lock. The server-managed members are the
 * backend's, never the body's: the client-supplied object is wire input and
 * may carry its own `createdBy` / `createdAt` / `updatedAt`, and all three are
 * discarded here, since the server alone is authoritative for them.
 *
 * `createdBy` names the Collection's creator, not its last writer: taken from
 * this write's invoker only when this write CREATES the Collection, and
 * preserved verbatim afterward -- including preserved-as-absent, so a
 * Collection created with no invoker never has a later writer backfilled into
 * it as its creator. `createdAt` is resolved on the same terms: stamped with
 * this write's clock only when this write creates the Collection, and
 * afterward preserved verbatim from the prior object -- including
 * preserved-as-absent, so a Collection stored without one (an object imported
 * from a pre-v0.5 archive, say) is never given a creation time later than its
 * own contents. `updatedAt` is this write's clock.
 *
 * `custom` is kept verbatim only when it is a non-empty object (`{ name, tags }`
 * on a plaintext Collection, the opaque envelope on an encrypted one); an
 * absent, empty, null, or non-object one clears it. `epoch` is kept only when
 * supplied: the stamp describes the `custom` envelope this write replaces
 * wholesale, so an omitted one clears rather than mislabels the new envelope.
 *
 * @param options {object}
 * @param options.collectionMetadata {CollectionMetadata}   the supplied object
 * @param [options.prior] {StoredCollectionMetadata}   the stored object, if any
 * @param [options.createdBy] {IDID}   this write's invoker
 * @returns {CollectionMetadata}
 */
export function stampCollectionMetadata({
  collectionMetadata,
  prior,
  createdBy
}: {
  collectionMetadata: CollectionMetadata
  prior?: StoredCollectionMetadata
  createdBy?: IDID
}): CollectionMetadata {
  const {
    createdBy: _suppliedCreatedBy,
    createdAt: _suppliedCreatedAt,
    updatedAt: _suppliedUpdatedAt,
    custom,
    epoch,
    ...rest
  } = collectionMetadata
  const creator = prior ? prior.createdBy : createdBy
  const now = new Date().toISOString()
  const createdAt = prior ? prior.createdAt : now
  const hasCustom =
    custom !== undefined &&
    custom !== null &&
    typeof custom === 'object' &&
    Object.keys(custom).length > 0
  return {
    ...rest,
    ...(creator !== undefined && { createdBy: creator }),
    ...(createdAt !== undefined && { createdAt }),
    updatedAt: now,
    ...(hasCustom && { custom }),
    ...(epoch !== undefined && { epoch })
  }
}
