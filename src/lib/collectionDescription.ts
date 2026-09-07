/**
 * Backend-agnostic normalization of a Collection Description about to be
 * persisted (the `key-epochs` / conditional-Collection-write feature). Both
 * storage backends run the same rule through {@link normalizeDescriptionWrite}
 * so their stored bodies and validator arithmetic cannot drift; only the
 * storage of the resolved validator differs downstream (`_generation` /
 * `_version` members in the filesystem description file vs the Postgres
 * `description_generation` / `description_version` columns).
 */
import type { CollectionDescription } from '../types.js'
import { type EtagValidator, newGeneration } from './etag.js'

/**
 * Splits an incoming Collection Description into the body to persist and the
 * description validator to stamp. The validator-bearing members a wire or
 * archived description may carry are stripped from the body: `_generation` /
 * `_version` (the archive interchange tokens embedded by `exportSpace`) and
 * `descriptionGeneration` / `descriptionVersion` (the out-of-band `ETag`
 * validator that `getCollectionDescription` attaches, which a caller may have
 * spread back in). The validator to stamp resolves with the precedence: the
 * explicit `validator` argument (the write path's monotonic bump), else the
 * archived `_generation` / `_version` pair (the import path), else a fresh
 * generation at version 1 (a first write).
 *
 * @param options {object}
 * @param options.collectionDescription {CollectionDescription}
 * @param [options.validator] {EtagValidator}   the explicit validator to stamp
 * @returns {{ body: CollectionDescription, validator: EtagValidator }}
 */
export function normalizeDescriptionWrite({
  collectionDescription,
  validator
}: {
  collectionDescription: CollectionDescription
  validator?: EtagValidator
}): { body: CollectionDescription; validator: EtagValidator } {
  const {
    _generation: incomingGeneration,
    _version: incomingVersion,
    descriptionGeneration: _staleGeneration,
    descriptionVersion: _staleVersion,
    ...body
  } = collectionDescription as CollectionDescription & {
    _generation?: string
    _version?: number
    descriptionGeneration?: string
    descriptionVersion?: number
  }
  const archived =
    incomingGeneration !== undefined && incomingVersion !== undefined
      ? { generation: incomingGeneration, version: incomingVersion }
      : undefined
  return {
    body,
    validator: validator ??
      archived ?? { generation: newGeneration(), version: 1 }
  }
}
