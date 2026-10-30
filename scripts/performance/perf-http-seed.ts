/**
 * Fills a server with everything the load tests read and write, over signed
 * HTTP through `@interop/pws-client`: the Collection-size Spaces, then the
 * payload matrix. It works against any server, a local one `pnpm perf:fs`
 * starts or a deployed one `pnpm perf:remote` targets. Each test's
 * Collection is made once per pool member, on that member's backend.
 */
import type { Collection, JsonObject, PwsClient } from '@interop/pws-client'
import { spaceIdOfUrl } from '@interop/pws-client/paths'

import {
  backendPool,
  collectionBackend,
  credential,
  edgeSpaceLabels,
  fillConcurrently,
  itemIds,
  retryOnNetworkFault,
  seedConcurrency,
  type EncryptedReadIds,
  type MatrixPayload,
  type PoolMember
} from './perf-lib.js'
import { seedMatrix } from './perf-matrix-seed.js'
import type { EdgeTarget, TestTargets } from './perf-runner.js'

/**
 * Writes one Resource per id into the Collection over signed HTTP, several
 * at a time.
 * @param options {object}
 * @param options.collection {Collection}
 * @param options.ids {string[]}
 * @returns {Promise<void>}
 */
async function fillViaHttp({
  collection,
  ids
}: {
  collection: Collection
  ids: string[]
}): Promise<void> {
  await fillConcurrently({
    ids,
    concurrency: seedConcurrency,
    write: id =>
      retryOnNetworkFault({
        op: () => collection.put(id, credential(id) as JsonObject)
      })
  })
}

/**
 * Creates a Space holding one Collection of `size` Resources per pool member
 * (`items<suffix>`, on the member's backend) over signed HTTP.
 * @param options {object}
 * @param options.pws {PwsClient}
 * @param options.name {string}
 * @param options.size {number}
 * @param options.pool {PoolMember[]}
 * @returns {Promise<EdgeTarget[]>} each Collection's path, with no trailing
 *   slash, its backend and its handle, in pool order
 */
async function seedSpaceViaHttp({
  pws,
  name,
  size,
  pool
}: {
  pws: PwsClient
  name: string
  size: number
  pool: PoolMember[]
}): Promise<EdgeTarget[]> {
  const space = await retryOnNetworkFault({
    op: () => pws.createSpace({ name })
  })
  const targets: EdgeTarget[] = []
  for (const member of pool) {
    const collectionId = `items${member.suffix}`
    const collection = await retryOnNetworkFault({
      op: () =>
        space.createCollection({
          id: collectionId,
          name,
          ...collectionBackend(member)
        })
    })
    await fillViaHttp({ collection, ids: itemIds(size) })
    targets.push({
      path: `/space/${spaceIdOfUrl(space.url)}/${collectionId}`,
      backend: member.backend,
      collection
    })
  }
  return targets
}

/**
 * Seeds every Space the tests need, fresh, over signed HTTP: the
 * Collection-size Spaces, then the payload matrix.
 * @param options {object}
 * @param options.pws {PwsClient}
 * @param options.serverUrl {string}   the server's base URL
 * @param options.seed {Uint8Array}   the identity `pws` signs with
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @param [options.payloads] {MatrixPayload[]}   the matrix payloads to seed;
 *   every payload by default
 * @param [options.pool] {PoolMember[]}   the Collections each test spreads
 *   its load over; one on the server's default backend by default
 * @returns {Promise<{
 *   targets: TestTargets, encryptedIds: EncryptedReadIds
 * }>}
 */
export async function seedViaHttp({
  pws,
  serverUrl,
  seed,
  sizes,
  edgeSizes,
  payloads,
  pool = backendPool()
}: {
  pws: PwsClient
  serverUrl: string
  seed: Uint8Array
  sizes: number[]
  edgeSizes: number[]
  payloads?: readonly MatrixPayload[]
  pool?: PoolMember[]
}): Promise<{
  targets: TestTargets
  encryptedIds: EncryptedReadIds
}> {
  const seedStarted = performance.now()
  console.log('Filling Collections and the payload matrix...')

  const publicSpace = await retryOnNetworkFault({
    op: () => pws.createSpace({ name: 'perf-public' })
  })
  const privateSpace = await retryOnNetworkFault({
    op: () => pws.createSpace({ name: 'perf-private' })
  })
  for (const size of sizes) {
    for (const member of pool) {
      const collection = {
        id: `c-${size}${member.suffix}`,
        ...collectionBackend(member)
      }
      const publicCollection = await retryOnNetworkFault({
        op: () => publicSpace.createCollection(collection)
      })
      await fillViaHttp({ collection: publicCollection, ids: itemIds(size) })
      await retryOnNetworkFault({ op: () => publicCollection.setPublic() })
      const privateCollection = await retryOnNetworkFault({
        op: () => privateSpace.createCollection(collection)
      })
      await fillViaHttp({ collection: privateCollection, ids: itemIds(size) })
    }
  }
  const edgeSpaces = []
  for (const size of edgeSizes) {
    const seed = (label: string) =>
      seedSpaceViaHttp({ pws, name: `${label}-${size}`, size, pool })
    edgeSpaces.push({
      size,
      write: await seed(edgeSpaceLabels.write),
      remove: await seed(edgeSpaceLabels.remove),
      serial: await seed(edgeSpaceLabels.serial)
    })
  }
  const encryptedIds = await seedMatrix({ serverUrl, seed, payloads, pool })
  const seedSeconds = (performance.now() - seedStarted) / 1000
  console.log(`Filled in ${seedSeconds.toFixed(0)}s. Running tests...\n`)
  return {
    targets: {
      publicSpaceId: spaceIdOfUrl(publicSpace.url),
      privateSpaceId: spaceIdOfUrl(privateSpace.url),
      pool,
      edgeSpaces
    },
    encryptedIds
  }
}
