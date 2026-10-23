/**
 * Import Space across the server backends. The control plane (the default
 * backend) takes the whole plan less the Resources of every Collection that
 * selects another server backend, so it holds each Collection's Metadata
 * object, policies and governing log as it does for a live write. Each other
 * server backend takes a plan of its own Collections alone, carrying their
 * Resources, sidecars, chunks and governing log and no policy (the Metadata
 * object and the log travel with it as the copies that backend keeps,
 * lib/backendMirror.ts), over a copy of the Space Metadata object written
 * first. The policy copies follow the control plane's import, read back from
 * its records, since that import stores them inside the backend, past the
 * write-through, and a copy carries the control plane's own validator. The
 * counts add up across the imports; `collectionsCreated` and
 * `collectionsSkipped` count the control plane's alone.
 *
 * A Collection the control plane already holds is routed by the live
 * object's selection, not the archive's: import skips an existing Metadata
 * object, so the Resources must land where that object's `backend.id` reads
 * them from. The archive's selection decides only for a Collection the import
 * creates.
 *
 * The other backends import first and the control plane last. Two stores make
 * the import non-atomic; in this order a fault in another backend's import
 * leaves the control plane untouched, so no Collection is created with its
 * Resources absent. What landed on the other backend is skipped by the retry
 * and reachable once the control plane's import lands.
 *
 * A plan naming a backend the Space's backends-available does not list is
 * refused before anything is written (`unsupported-backend`, 409): a server
 * backend this deployment does not configure, or an external id the Space
 * has not registered. A registered external backend's Resources import into
 * the control plane, as a live write of them would before an adapter
 * served them.
 */
import { UnsupportedBackendError } from '../errors.js'
import {
  ensureMirroredSpace,
  mirrorCollectionPolicies
} from './backendMirror.js'
import type { ImportPlan, ImportPlanCollection } from './importTar.js'
import { DEFAULT_BACKEND_ID, type ServerBackends } from './serverBackends.js'
import type { ImportStats, StorageBackend } from '../types.js'

/**
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.plan {ImportPlan}   the archive's merge plan, its
 *   provenance already judged
 * @param options.provenance {ImportStats['provenance']}   the verdict counts,
 *   returned unchanged
 * @param [options.restoreSpaceMetadata] {boolean}   whether the control
 *   plane applies the archived Space Metadata object's user-writable members
 * @returns {Promise<ImportStats>}
 */
export async function importSpaceAcrossBackends({
  serverBackends,
  spaceId,
  plan,
  provenance,
  restoreSpaceMetadata
}: {
  serverBackends: ServerBackends
  spaceId: string
  plan: ImportPlan
  provenance: ImportStats['provenance']
  restoreSpaceMetadata?: boolean
}): Promise<ImportStats> {
  const control = serverBackends.default
  const byBackend = new Map<StorageBackend, ImportPlanCollection[]>()
  const controlCollections: ImportPlanCollection[] = []
  const routed: ImportPlanCollection[] = []
  const liveMetadata = await Promise.all(
    plan.collections.map(({ collectionId }) =>
      control.getCollectionMetadata({ spaceId, collectionId })
    )
  )
  for (const [index, collection] of plan.collections.entries()) {
    const live = liveMetadata[index]
    const backendId = (live ?? collection.collectionMetadata).backend?.id
    const backend = serverBackends.resolve(backendId)
    if (backend === undefined) {
      const registered =
        backendId !== undefined &&
        backendId !== DEFAULT_BACKEND_ID &&
        (await control.getBackend({ spaceId, backendId }))
      if (!registered) {
        throw new UnsupportedBackendError({
          backendId: backendId ?? DEFAULT_BACKEND_ID,
          detail:
            `The archived Collection "${collection.collectionId}" selects ` +
            `backend '${backendId}', which is not in this Space's ` +
            'backends-available list.'
        })
      }
    }
    if (backend === undefined || backend === control) {
      controlCollections.push(collection)
      continue
    }
    routed.push(collection)
    controlCollections.push({
      ...collection,
      resources: [],
      resourcePolicies: new Map(),
      detachedResourcePolicies: collection.resourcePolicies,
      resourceMetadata: new Map(),
      chunkFiles: []
    })
    const own = byBackend.get(backend) ?? []
    // The copy the backend creates names the selection the control plane's
    // object holds, so the two agree on an existing Collection.
    own.push({
      ...collection,
      collectionMetadata: {
        ...collection.collectionMetadata,
        backend: (live ?? collection.collectionMetadata).backend
      },
      collectionPolicy: undefined,
      resourcePolicies: new Map()
    })
    byBackend.set(backend, own)
  }

  const resources = { created: 0, skipped: 0 }
  for (const [backend, collections] of byBackend) {
    await ensureMirroredSpace({ serverBackends, backend, spaceId })
    const own = await backend.importSpace({
      spaceId,
      plan: {
        sourceSpaceId: plan.sourceSpaceId,
        collections,
        collectionTombstones: []
      },
      provenance
    })
    resources.created += own.resourcesCreated
    resources.skipped += own.resourcesSkipped
  }
  const stats = await control.importSpace({
    spaceId,
    plan: { ...plan, collections: controlCollections },
    provenance,
    restoreSpaceMetadata
  })
  for (const { collectionId, resourcePolicies } of routed) {
    await mirrorCollectionPolicies({
      serverBackends,
      spaceId,
      collectionId,
      resourceIds: resourcePolicies.keys()
    })
  }
  stats.resourcesCreated += resources.created
  stats.resourcesSkipped += resources.skipped
  return stats
}
