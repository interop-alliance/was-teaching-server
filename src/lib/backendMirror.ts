/**
 * The container copies a server backend other than the default holds. Both
 * server backends refuse a Resource write into a Collection, or a Space, that
 * has no Metadata object in their own store, and read the Collection's
 * `unique` index declarations under their lock. The default backend is the
 * control plane and owns every Space and Collection Metadata object; a
 * Collection selecting another server backend's id therefore gets a copy of
 * its Metadata object there, written through after the control-plane write,
 * and the Space Metadata object is copied on the first Collection the
 * backend serves in that Space and refreshed by every later Update Space.
 * The Collection's governing history log is copied the same way, after each
 * control-plane write of it, because the write-once recheck a Resource write
 * runs inside the data backend's lock reads the log from that backend's own
 * store; the copy is what closes the race with a guarded log create there.
 * Reads never consult a copy. A copy takes the data backend's own write stamp
 * and generation, so the `changes` feed served from that backend carries the
 * copy's validator on its `collection-metadata` and `collection-log`
 * documents; the pull loop reads the objects themselves from the control
 * plane and never the feed's.
 *
 * The copies follow the write itself: `mirroringControlPlane` wraps the
 * default backend so each write or delete of a container object, and each
 * replicated apply of one, is followed by the copy it calls for. The set
 * exposes the wrapped backend as `default`, which is what the handlers, the
 * import path and the pull loop write through, so no writer has to remember
 * the copy.
 *
 * The two stores make a write-through non-atomic: a fault between the
 * control-plane write and the copy leaves the copy behind, and the next
 * write of the object, or a retried request, brings it level. A Resource
 * write that lands between a log's control-plane commit and its copy's
 * commit committed before the log write was answered, the same order the
 * single-backend gate produces. Delete Collection sweeps every other server
 * backend for a copy after the control plane's delete, on a retry too, so a
 * fault between the two leaves nothing behind for good.
 */
import { SpaceNotFoundError } from '../errors.js'
import type { ApplyResult } from './replicaApply.js'
import { withoutStampMembers } from './hlc.js'
import { stripMetadataValidator } from './metadataValidator.js'
import type { ServerBackends } from './serverBackends.js'
import type {
  CollectionMetadata,
  SpaceMetadata,
  StorageBackend
} from '../types.js'

/**
 * The copy of a Space Metadata object a server backend keeps: the stored
 * object's `controller` and user-writable members, and nothing the copy's own
 * write stamps.
 * @param stored {SpaceMetadata}
 * @returns {SpaceMetadata}
 */
function spaceCopyOf(stored: SpaceMetadata): SpaceMetadata {
  const { id, type, controller, name } = stored
  return {
    id,
    type,
    controller,
    ...(name !== undefined && { name })
  }
}

/**
 * Ensures `backend` holds a Space Metadata object for the Space, writing a
 * copy of the control plane's user-writable members when it does not. A
 * no-op for the default backend.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.backend {StorageBackend}   the server backend the copy is
 *   for
 * @param options.spaceId {string}
 * @returns {Promise<void>}
 * @throws {SpaceNotFoundError}   the control plane holds no such Space
 */
export async function ensureMirroredSpace({
  serverBackends,
  backend,
  spaceId
}: {
  serverBackends: ServerBackends
  backend: StorageBackend
  spaceId: string
}): Promise<void> {
  if (backend === serverBackends.default) {
    return
  }
  if (await backend.getSpaceMetadata({ spaceId })) {
    return
  }
  const stored = await serverBackends.default.getSpaceMetadata({ spaceId })
  if (!stored) {
    throw new SpaceNotFoundError({ requestName: 'Write Collection' })
  }
  await backend.writeSpace({ spaceId, spaceMetadata: spaceCopyOf(stored) })
}

/**
 * Refreshes the copy of a Space Metadata object in every server backend that
 * holds one, after Update Space stored it on the control plane, so a
 * promoted `controller` or a new `name` reaches each copy. A backend holding
 * no copy is left alone: it gets one on the first Collection it serves.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.metadata {SpaceMetadata}   the stored object as the
 *   control-plane write left it
 * @returns {Promise<void>}
 */
export async function mirrorSpaceMetadata({
  serverBackends,
  spaceId,
  metadata
}: {
  serverBackends: ServerBackends
  spaceId: string
  metadata: SpaceMetadata
}): Promise<void> {
  for (const backend of serverBackends.others()) {
    if (await backend.getSpaceMetadata({ spaceId })) {
      await backend.writeSpace({
        spaceId,
        spaceMetadata: spaceCopyOf(metadata)
      })
    }
  }
}

/**
 * Writes through a Collection Metadata object the control plane just stored
 * to the server backend its `backend.id` selects, when that is another
 * server backend. The copy carries the stored members less the write stamp
 * and validator; the server-managed members are the copy's own.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.metadata {CollectionMetadata}   the stored object as the
 *   control-plane write left it
 * @returns {Promise<void>}
 */
export async function mirrorCollectionMetadata({
  serverBackends,
  spaceId,
  collectionId,
  metadata
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionId: string
  metadata: CollectionMetadata
}): Promise<void> {
  const backend = serverBackends.resolveOther(metadata.backend?.id)
  if (backend === undefined) {
    return
  }
  await ensureMirroredSpace({ serverBackends, backend, spaceId })
  const {
    createdAt: _createdAt,
    created: _created,
    createdBy,
    ...writable
  } = withoutStampMembers(stripMetadataValidator(metadata))
  await backend.writeCollection({
    spaceId,
    collectionId,
    collectionMetadata: writable,
    createdBy
  })
}

/**
 * Writes through a Collection's governing history log the control plane just
 * stored to the server backend the Collection selects, when that is another
 * server backend. The whole log is written, unconditionally: the control
 * plane evaluated the request's precondition and the line contract. The
 * copy of the Collection Metadata object is written first when the backend
 * holds none, so a copy an earlier fault left out is brought level here.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.body {string}   the log as stored, JSON Lines
 * @returns {Promise<void>}
 */
export async function mirrorCollectionLog({
  serverBackends,
  spaceId,
  collectionId,
  body
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionId: string
  body: string
}): Promise<void> {
  const metadata = await serverBackends.default.getCollectionMetadata({
    spaceId,
    collectionId
  })
  const backend = serverBackends.resolveOther(metadata?.backend?.id)
  if (metadata === undefined || backend === undefined) {
    return
  }
  if (!(await backend.getCollectionMetadata({ spaceId, collectionId }))) {
    await mirrorCollectionMetadata({
      serverBackends,
      spaceId,
      collectionId,
      metadata
    })
  }
  await backend.writeCollectionLog({ spaceId, collectionId, body })
}

/**
 * Removes the copy of a deleted Collection from every server backend other
 * than the default that holds one, so the Resources it holds go with the
 * Collection. Run after the control plane's delete whatever its outcome, so
 * a retry after a fault between the two removes the copy the first attempt
 * left behind. A backend holding no copy of the Space or the Collection is
 * left alone.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<void>}
 */
export async function mirrorCollectionDelete({
  serverBackends,
  spaceId,
  collectionId
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionId: string
}): Promise<void> {
  for (const backend of serverBackends.others()) {
    if (!(await backend.getSpaceMetadata({ spaceId }))) {
      continue
    }
    if (await backend.getCollectionMetadata({ spaceId, collectionId })) {
      await backend.deleteCollection({ spaceId, collectionId })
    }
  }
}

/**
 * The default backend as the server writes through it: every write or
 * delete of a Space or Collection Metadata object or of a governing log,
 * and every replicated apply of one, is followed by the copy the other
 * server backends keep. Every other member is the wrapped backend's own, so
 * the result reads, stamps and closes as that backend does.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}   the set the backend is
 *   the default of
 * @param options.backend {StorageBackend}   the default backend as opened
 * @returns {StorageBackend}
 */
export function mirroringControlPlane({
  serverBackends,
  backend
}: {
  serverBackends: ServerBackends
  backend: StorageBackend
}): StorageBackend {
  const mirrored: Pick<
    StorageBackend,
    | 'writeSpace'
    | 'writeCollection'
    | 'writeCollectionLog'
    | 'deleteCollection'
    | 'deleteSpace'
    | 'applySpaceName'
    | 'applyCollection'
    | 'applyCollectionLog'
  > = {
    async writeSpace(options) {
      const result = await backend.writeSpace(options)
      // A created Space has no copy yet; one follows the first Collection a
      // backend serves in it.
      if (!result.created) {
        await mirrorSpaceMetadata({
          serverBackends,
          spaceId: options.spaceId,
          metadata: result.metadata
        })
      }
      return result
    },
    async writeCollection(options) {
      const result = await backend.writeCollection(options)
      await mirrorCollectionMetadata({
        serverBackends,
        spaceId: options.spaceId,
        collectionId: options.collectionId,
        metadata: result.metadata
      })
      return result
    },
    async writeCollectionLog(options) {
      const validator = await backend.writeCollectionLog(options)
      if (validator !== undefined) {
        await mirrorCollectionLog({
          serverBackends,
          spaceId: options.spaceId,
          collectionId: options.collectionId,
          body: options.body
        })
      }
      return validator
    },
    async deleteCollection(options) {
      const outcome = await backend.deleteCollection(options)
      // The sweep runs on a repeat delete too, so a copy a faulted first
      // attempt left behind goes on the retry.
      if (outcome !== 'absent') {
        await mirrorCollectionDelete({ serverBackends, ...options })
      }
      return outcome
    },
    async deleteSpace(options) {
      await backend.deleteSpace(options)
      await mirrorSpaceDelete({ serverBackends, spaceId: options.spaceId })
    },
    async applySpaceName(options) {
      const result = await backend.applySpaceName(options)
      if (result.outcome === 'applied') {
        const stored = await backend.getSpaceMetadata({
          spaceId: options.spaceId
        })
        if (stored) {
          await mirrorSpaceMetadata({
            serverBackends,
            spaceId: options.spaceId,
            metadata: stored
          })
        }
      }
      return result
    },
    async applyCollection(options): Promise<ApplyResult> {
      const result = await backend.applyCollection(options)
      if (result.outcome !== 'applied') {
        return result
      }
      const { spaceId, collectionId } = options
      if (options.collection.deleted) {
        await mirrorCollectionDelete({ serverBackends, spaceId, collectionId })
        return result
      }
      // The copy is of the object as stored, merged over the held one.
      const stored = await backend.getCollectionMetadata({
        spaceId,
        collectionId
      })
      if (stored) {
        await mirrorCollectionMetadata({
          serverBackends,
          spaceId,
          collectionId,
          metadata: stored
        })
      }
      return result
    },
    async applyCollectionLog(options) {
      const result = await backend.applyCollectionLog(options)
      if (result.outcome === 'applied') {
        await mirrorCollectionLog({
          serverBackends,
          spaceId: options.spaceId,
          collectionId: options.collectionId,
          body: options.body
        })
      }
      return result
    }
  }
  // Every other member is read off the backend itself, and a method is bound
  // to it so its private fields resolve; a property set lands on it too.
  return new Proxy(backend, {
    get(target, property) {
      if (Object.hasOwn(mirrored, property)) {
        return mirrored[property as keyof typeof mirrored]
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target)
    }
  })
}

/**
 * Removes a deleted Space's copy from every server backend other than the
 * default, with the Collections and Resources each holds for it. A backend
 * holding no copy is left alone.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @returns {Promise<void>}
 */
export async function mirrorSpaceDelete({
  serverBackends,
  spaceId
}: {
  serverBackends: ServerBackends
  spaceId: string
}): Promise<void> {
  for (const backend of serverBackends.others()) {
    if (await backend.getSpaceMetadata({ spaceId })) {
      await backend.deleteSpace({ spaceId })
    }
  }
}
