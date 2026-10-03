/**
 * Backend-agnostic normalization of a Space or Collection Metadata object
 * about to be persisted. Both storage backends run the same rules through
 * {@link normalizeMetadataWrite}, {@link stampSpaceMetadata},
 * {@link stampCollectionMetadata} and {@link restampImportedMetadata} so their
 * stored bodies cannot drift; only the storage of the generation and the
 * local validator segment differs downstream (`_generation` / `_local`
 * members in the filesystem metadata file vs Postgres columns). The write
 * stamp (`updatedAt`, `updatedAtCounter`, `originId`) is part of the stored
 * body on both: it is a wire member.
 */
import type {
  CollectionMetadata,
  IDID,
  MetadataValidatorParts,
  SpaceMetadata,
  StoredCollectionMetadata,
  StoredSpaceMetadata,
  WriteStamp
} from '../types.js'
import {
  type EmbeddedMetadataValidator,
  importedGeneration,
  withoutStampMembers
} from './etag.js'

/**
 * Strips the validator-bearing and stamp members an incoming Space or
 * Collection Metadata object may carry, leaving the body to persist: the
 * embedded `_generation` / `_local` (the filesystem file layout; an archived
 * object carries `_generation`), `metaGeneration` / `metaLocal` (the
 * out-of-band parts a read result attaches, which a caller may have spread
 * back in), and the stamp members, which only the backend's clock sets. The
 * embedded `_generation` is handed back on its own, for the import path that
 * keeps an archived record's generation.
 *
 * @param options {object}
 * @param options.metadata {T}   the Space or Collection Metadata object
 * @returns {{ body: T, embeddedGeneration?: string }}
 */
export function normalizeMetadataWrite<
  T extends CollectionMetadata | SpaceMetadata
>({ metadata }: { metadata: T }): { body: T; embeddedGeneration?: string } {
  const {
    _generation: embeddedGeneration,
    _local: _embeddedLocal,
    metaGeneration: _staleGeneration,
    metaLocal: _staleLocal,
    ...body
  } = metadata as T & MetadataValidatorParts & EmbeddedMetadataValidator
  return {
    body: withoutStampMembers(body) as T,
    ...(embeddedGeneration !== undefined && { embeddedGeneration })
  }
}

/**
 * Re-stamps a Metadata object an import is about to store: the body without
 * any archived stamp or validator member, carrying this server's freshly
 * minted `stamp` instead, and the generation it is stored under (the
 * archived `_generation` when the object carries one this server could have
 * minted, else a fresh one). The
 * archived stamp is read for provenance verification only, before this runs;
 * a stamp an archive could choose would let an importer date a record ahead
 * of every peer.
 *
 * @param options {object}
 * @param options.metadata {T}   the archived object
 * @param options.stamp {WriteStamp}   minted by the importing backend's clock
 * @returns {{ body: T, generation: string }}
 */
export function restampImportedMetadata<
  T extends CollectionMetadata | SpaceMetadata
>({
  metadata,
  stamp
}: {
  metadata: T
  stamp: WriteStamp
}): { body: T; generation: string } {
  const { body, embeddedGeneration } = normalizeMetadataWrite({ metadata })
  return {
    body: { ...body, ...stamp },
    generation: importedGeneration(embeddedGeneration)
  }
}

/**
 * Resolves the server-managed members of a Space Metadata object about to be
 * written by `writeSpace`, against the prior stored object read under the
 * backend's per-Space lock. The client-supplied object is wire input and may
 * carry its own `createdBy`, or any of the members the server derives per
 * read (`url`, `linkset`, `backends`; `lib/spaceProjection.ts`); all are
 * discarded, since the server alone is authoritative for them, and the
 * derived ones are never stored at all. The write stamp is this write's
 * `stamp`.
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
 * @param options.stamp {WriteStamp}   this write's stamp
 * @returns {SpaceMetadata}
 */
export function stampSpaceMetadata({
  spaceMetadata,
  prior,
  createdBy,
  stamp
}: {
  spaceMetadata: SpaceMetadata
  prior?: StoredSpaceMetadata
  createdBy?: IDID
  stamp: WriteStamp
}): SpaceMetadata {
  const {
    createdBy: _suppliedCreatedBy,
    url: _suppliedUrl,
    linkset: _suppliedLinkset,
    backends: _suppliedBackends,
    ...rest
  } = spaceMetadata
  const creator = prior ? prior.createdBy : createdBy
  return {
    ...normalizeMetadataWrite({ metadata: rest }).body,
    ...(creator !== undefined && { createdBy: creator }),
    ...stamp
  }
}

/**
 * Resolves the server-managed members of a Collection Metadata object about
 * to be written by `writeCollection`, against the prior stored object read
 * under the backend's per-Collection lock. The server-managed members are the
 * backend's, never the body's: the client-supplied object is wire input and
 * may carry its own `createdBy` / `createdAt` or stamp members, and all are
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
 * own contents. The write stamp is this write's `stamp`, and a creating
 * write's `createdAt` is the stamp's `updatedAt`.
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
 * @param options.stamp {WriteStamp}   this write's stamp
 * @returns {CollectionMetadata}
 */
export function stampCollectionMetadata({
  collectionMetadata,
  prior,
  createdBy,
  stamp
}: {
  collectionMetadata: CollectionMetadata
  prior?: StoredCollectionMetadata
  createdBy?: IDID
  stamp: WriteStamp
}): CollectionMetadata {
  const {
    createdBy: _suppliedCreatedBy,
    createdAt: _suppliedCreatedAt,
    custom,
    epoch,
    ...rest
  } = normalizeMetadataWrite({ metadata: collectionMetadata }).body
  const creator = prior ? prior.createdBy : createdBy
  const createdAt = prior ? prior.createdAt : stamp.updatedAt
  const hasCustom =
    custom !== undefined &&
    custom !== null &&
    typeof custom === 'object' &&
    Object.keys(custom).length > 0
  return {
    ...rest,
    ...(creator !== undefined && { createdBy: creator }),
    ...(createdAt !== undefined && { createdAt }),
    ...stamp,
    ...(hasCustom && { custom }),
    ...(epoch !== undefined && { epoch })
  }
}
