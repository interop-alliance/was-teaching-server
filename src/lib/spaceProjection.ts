/**
 * The projections from a stored Space record to the two serializations of the
 * Space Metadata object this server hands out. `projectSpaceMetadata` is the
 * served object (spec "Space Metadata Data Model"): Read Space and the two
 * create responses that echo the object go through it. `archivedSpaceMetadata`
 * is the export archive's `.space.<spaceId>.json` entry, which keeps the
 * filesystem backend's on-disk layout (the generation embedded and the stamp
 * members bare, no local validator segment, no `url` or `linkset`) and adds
 * only `backends`. Both derive `backends` here, so the
 * paths that materialize the object cannot drift on it. The served object
 * also carries `replicas`, the Space's replica registrations on this server.
 * An archive carries no `replicas`: a registration is this server's own and
 * is not exported.
 *
 * The server-derived members are `url`, `linkset`, `backends` and `replicas`;
 * `createdBy`
 * is resolved earlier, on the write path (`lib/metadataWrite.ts`). `type` is
 * served lexically sorted (spec SHOULD), so the object has a canonical, stable
 * serialization.
 */
import type {
  BackendDescriptor,
  IDID,
  ReplicaSummary,
  SpaceMetadata,
  StorageBackend,
  StoredSpaceMetadata
} from '../types.js'
import { listRegisteredBackends } from './backends.js'
import {
  embedMetadataValidator,
  stripMetadataValidator
} from './metadataValidator.js'
import { linksetPath, spacePath } from './paths.js'

/**
 * Composes the Space Metadata object a write stores from a request body: the
 * user-writable members `controller` and `name` (kept only when the body
 * carries one), under the server-decided `id` and `type`. Create Space and
 * Update Space both go through it, so the two cannot drift on which members
 * a client may write. A server-derived member (`createdBy`, `url`, ...) or an
 * unknown one in the body is neither stored nor echoed.
 *
 * @param options {object}
 * @param options.id {string}
 * @param options.type {string[]}   the validated `type`, not the body's
 * @param options.body {{ controller: IDID, name?: string }}
 * @returns {SpaceMetadata}
 */
export function writableSpaceMetadata({
  id,
  type,
  body
}: {
  id: string
  type: string[]
  body: { controller: IDID; name?: string }
}): SpaceMetadata {
  return {
    id,
    type,
    controller: body.controller,
    ...(body.name !== undefined && { name: body.name })
  }
}

/**
 * The Space's replica registrations as the Space Metadata object lists them:
 * each record's `fromSpace`, `toSpace` and `role`, in registration id order.
 * The registration id, the capability and the loop state stay out.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.spaceId {string}
 * @returns {Promise<ReplicaSummary[]>}
 */
export async function listReplicaSummaries({
  storage,
  spaceId
}: {
  storage: StorageBackend
  spaceId: string
}): Promise<ReplicaSummary[]> {
  const replicas = await storage.listReplicas({ spaceId })
  return replicas.map(({ record: { fromSpace, toSpace, role } }) => ({
    fromSpace,
    toSpace,
    role
  }))
}

/**
 * Projects a stored Space record into the served Space Metadata object: the
 * stored body without its out-of-band `ETag` validator, `type` sorted, and the
 * server-derived `url`, `linkset`, `backends` and `replicas` stamped on.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend,
 *   read for the Space's backends-available listing
 * @param options.spaceId {string}
 * @param options.spaceMetadata {SpaceMetadata}   the stored object (a
 *   validator-bearing read result is accepted; the validator is stripped)
 * @param [options.backends] {BackendDescriptor[]}   passed only by a create
 *   echo, which marks the Space as just created: it did not exist before the
 *   write, so it has no registrations (registering one needs the Space
 *   Metadata object to authorize against). The listing is then used as given
 *   and `replicas` is empty, with no storage read for either. Without it, both
 *   are read from storage.
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
  const isCreateEcho = backends !== undefined
  const [listedBackends, replicas] = isCreateEcho
    ? [backends, []]
    : await Promise.all([
        listRegisteredBackends({ storage, spaceId }),
        listReplicaSummaries({ storage, spaceId })
      ])
  return {
    ...body,
    type: [...body.type].sort(),
    url: spacePath({ spaceId, trailingSlash: true }),
    linkset: linksetPath({ spaceId }),
    backends: listedBackends,
    replicas
  }
}

/**
 * Serializes a stored Space record as the export archive's
 * `.space.<spaceId>.json` entry: the stored body, stamp members included,
 * with its generation embedded under the reserved `_generation` member (the
 * filesystem backend's on-disk layout, so archives stay interchangeable
 * between backends) and the server-derived `backends` listing added. The
 * local validator segment is this server's own and is left out. The listing is
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
        generation: spaceMetadata.metaGeneration
      })
    )
  )
}
