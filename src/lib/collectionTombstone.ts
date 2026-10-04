/**
 * Collection tombstones. Delete Collection leaves the Collection Metadata
 * record in place, marked `deleted: true`. The tombstone keeps the
 * Collection's generation and takes the delete's write stamp. Nothing else of
 * the old body is kept. A tombstone reads as absent everywhere except the
 * Space listing under `?include=deleted`, which lists it with its stamp. Both
 * backends build the stored body and the listing item through this module.
 */
import type {
  CollectionTombstoneSummary,
  StoredCollectionTombstone,
  WriteStamp
} from '../types.js'
import { isCollectionTombstone as isTombstoneBody } from '@interop/space-archive'
import { embedMetadataValidator } from './metadataValidator.js'
import { collectionPath } from './paths.js'

/**
 * The stored body of a Collection tombstone: the `deleted` marker and the
 * delete's write stamp. The generation is kept beside it, out of band, as on
 * a live Collection Metadata object.
 * @param stamp {WriteStamp}   the delete's write stamp
 * @returns {{ deleted: true } & WriteStamp}
 */
export function collectionTombstoneBody(
  stamp: WriteStamp
): { deleted: true } & WriteStamp {
  const { updatedAt, updatedAtCounter, originId } = stamp
  return { deleted: true, updatedAt, updatedAtCounter, originId }
}

/**
 * The serialized Metadata file of a Collection tombstone, `.collection.<id>.json`
 * on disk and in an export archive: the tombstone body with the Collection's
 * generation embedded. It carries no local segment.
 * @param options {object}
 * @param options.stamp {WriteStamp}   the delete's write stamp
 * @param options.generation {string}   the Collection's generation
 * @returns {string}
 */
export function collectionTombstoneFile({
  stamp,
  generation
}: {
  stamp: WriteStamp
  generation: string
}): string {
  return JSON.stringify(
    embedMetadataValidator({ body: collectionTombstoneBody(stamp), generation })
  )
}

/**
 * Whether a stored Collection record is a tombstone, by the archive codec's
 * rule (`deleted: true`), narrowed to this server's stored shape.
 * @param record {object | undefined}   a stored Collection record, live or
 *   tombstoned
 * @returns {boolean}
 */
export function isCollectionTombstone(
  record: object | undefined
): record is StoredCollectionTombstone {
  return (
    record !== undefined && isTombstoneBody(record as Record<string, unknown>)
  )
}

/**
 * The listing item of a tombstoned Collection: its id, its canonical
 * trailing-slash URL, the `deleted` marker, and the delete's write stamp.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.stamp {WriteStamp}   the tombstone's stamp
 * @returns {CollectionTombstoneSummary}
 */
export function collectionTombstoneSummary({
  spaceId,
  collectionId,
  stamp
}: {
  spaceId: string
  collectionId: string
  stamp: WriteStamp
}): CollectionTombstoneSummary {
  return {
    id: collectionId,
    url: collectionPath({ spaceId, collectionId, trailingSlash: true }),
    ...collectionTombstoneBody(stamp)
  }
}
