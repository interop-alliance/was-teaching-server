/**
 * The projections from a stored Space record to the two serializations of the
 * Space Metadata object this server hands out. `projectSpaceMetadata` is the
 * served object (spec "Space Metadata Data Model"): Read Space and the two
 * create responses that echo the object go through it. `archivedSpaceMetadata`
 * is the export archive's `.space.<spaceId>.json` entry, which keeps the
 * filesystem backend's on-disk layout (the validator embedded, no `url` or
 * `linkset`) and stamps only `backends`. Both derive `backends` here, so the
 * paths that materialize the object cannot drift on it.
 *
 * The server-derived members are `url`, `linkset` and `backends`; `createdBy`
 * is resolved earlier, on the write path (`lib/metadataWrite.ts`). `type` is
 * served lexically sorted (spec SHOULD), so the object has a canonical, stable
 * serialization.
 */
import type {
  BackendDescriptor,
  SpaceMetadata,
  StorageBackend,
  StoredSpaceMetadata
} from '../types.js'
import { listRegisteredBackends } from './backends.js'
import { embedMetadataValidator, stripMetadataValidator } from './etag.js'
import { linksetPath, spacePath } from './paths.js'

/**
 * Projects a stored Space record into the served Space Metadata object: the
 * stored body without its out-of-band `ETag` validator, `type` sorted, and the
 * server-derived `url`, `linkset` and `backends` stamped on.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend,
 *   read for the Space's backends-available listing
 * @param options.spaceId {string}
 * @param options.spaceMetadata {SpaceMetadata}   the stored object (a
 *   validator-bearing read result is accepted; the validator is stripped)
 * @param [options.backends] {BackendDescriptor[]}   the listing, when the
 *   caller knows it without a read: a create echo, since a Space that did not
 *   exist before the write has no registrations (registering one needs the
 *   Space Metadata object to authorize against). Read from storage otherwise.
 * @returns {Promise<SpaceMetadata>}
 */
export async function projectSpaceMetadata({
  storage,
  spaceId,
  spaceMetadata,
  backends
}: {
  storage: StorageBackend
  spaceId: string
  spaceMetadata: SpaceMetadata
  backends?: BackendDescriptor[]
}): Promise<SpaceMetadata> {
  const body = stripMetadataValidator(spaceMetadata)
  return {
    ...body,
    type: [...body.type].sort(),
    url: spacePath({ spaceId, trailingSlash: true }),
    linkset: linksetPath({ spaceId }),
    backends: backends ?? (await listRegisteredBackends({ storage, spaceId }))
  }
}

/**
 * Serializes a stored Space record as the export archive's
 * `.space.<spaceId>.json` entry: the stored body with its validator embedded
 * under the reserved `_generation` / `_version` members (the filesystem
 * backend's on-disk layout, so archives stay interchangeable between backends)
 * and the server-derived `backends` listing stamped on. The listing is
 * informational in an archive: import restores user-writable members only,
 * never a server-derived one. Both backends' `exportSpace` build the entry
 * here, from the record they already read.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the exporting backend, read for
 *   the Space's backends-available listing
 * @param options.spaceId {string}
 * @param options.spaceMetadata {StoredSpaceMetadata}   the stored record,
 *   validator included
 * @returns {Promise<Buffer>}   the entry's bytes
 */
export async function archivedSpaceMetadata({
  storage,
  spaceId,
  spaceMetadata
}: {
  storage: StorageBackend
  spaceId: string
  spaceMetadata: StoredSpaceMetadata
}): Promise<Buffer> {
  return Buffer.from(
    JSON.stringify(
      embedMetadataValidator({
        body: {
          ...stripMetadataValidator(spaceMetadata),
          backends: await listRegisteredBackends({ storage, spaceId })
        },
        generation: spaceMetadata.metaGeneration,
        version: spaceMetadata.metaVersion
      })
    )
  )
}
