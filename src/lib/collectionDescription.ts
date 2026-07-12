/**
 * Backend-agnostic normalization of a Collection Description about to be
 * persisted (the `key-epochs` / conditional-Collection-write feature). Both
 * storage backends run the same rule through {@link normalizeDescriptionWrite}
 * so their stored bodies and version arithmetic cannot drift; only the storage
 * of the resolved version differs downstream (a `_version` member in the
 * filesystem description file vs the Postgres `description_version` column).
 */
import type { CollectionDescription } from '../types.js'

/**
 * Splits an incoming Collection Description into the body to persist and the
 * description version to stamp. The two version-bearing members a wire or
 * archived description may carry are stripped from the body: `_version` (the
 * archive interchange token embedded by `exportSpace`) and
 * `descriptionVersion` (the out-of-band `ETag` validator that
 * `getCollectionDescription` attaches, which a caller may have spread back
 * in). The version to stamp resolves with the precedence: the explicit
 * `descriptionVersion` argument (the write path's monotonic bump), else the
 * archived `_version` (the import path), else 1 (a first write).
 *
 * @param options {object}
 * @param options.collectionDescription {CollectionDescription}
 * @param [options.descriptionVersion] {number}   the explicit version to stamp
 * @returns {{ body: CollectionDescription, version: number }}
 */
export function normalizeDescriptionWrite({
  collectionDescription,
  descriptionVersion
}: {
  collectionDescription: CollectionDescription
  descriptionVersion?: number
}): { body: CollectionDescription; version: number } {
  const {
    _version: incomingVersion,
    descriptionVersion: _staleVersion,
    ...body
  } = collectionDescription as CollectionDescription & {
    _version?: number
    descriptionVersion?: number
  }
  return { body, version: descriptionVersion ?? incomingVersion ?? 1 }
}
