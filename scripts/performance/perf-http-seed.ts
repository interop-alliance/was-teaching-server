/**
 * Fills a server with everything the load tests read and write, over signed
 * HTTP through `@interop/was-client`: the Collection-size Spaces, then the
 * payload matrix. It works against any server, a local one `pnpm perf:fs`
 * starts or a deployed one `pnpm perf:remote` targets.
 */
import type { Collection, JsonObject, WasClient } from '@interop/was-client'

import {
  credential,
  edgeSpaceLabels,
  fillConcurrently,
  itemIds,
  retryOnTimeout,
  seedConcurrency,
  type EncryptedReadIds,
  type MatrixPayload
} from './perf-lib.js'
import { seedMatrix } from './perf-matrix-seed.js'
import type { TestTargets } from './perf-runner.js'

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
      retryOnTimeout({
        op: () => collection.put(id, credential(id) as JsonObject)
      })
  })
}

/**
 * Creates a Space holding one Collection of `size` Resources over signed
 * HTTP.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.name {string}
 * @param options.size {number}
 * @returns {Promise<{ path: string, collection: Collection }>} the
 *   Collection's path, with no trailing slash, and its handle
 */
async function seedSpaceViaHttp({
  was,
  name,
  size
}: {
  was: WasClient
  name: string
  size: number
}): Promise<{ path: string; collection: Collection }> {
  const space = await was.createSpace({ name })
  const collection = await space.createCollection({ id: 'items', name })
  await fillViaHttp({ collection, ids: itemIds(size) })
  return { path: `/space/${space.id}/items`, collection }
}

/**
 * Seeds every Space the tests need, fresh, over signed HTTP: the
 * Collection-size Spaces, then the payload matrix.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.serverUrl {string}   the server's base URL
 * @param options.seed {Uint8Array}   the identity `was` signs with
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @param [options.payloads] {MatrixPayload[]}   the matrix payloads to seed;
 *   every payload by default
 * @returns {Promise<{
 *   targets: TestTargets, encryptedIds: EncryptedReadIds
 * }>}
 */
export async function seedViaHttp({
  was,
  serverUrl,
  seed,
  sizes,
  edgeSizes,
  payloads
}: {
  was: WasClient
  serverUrl: string
  seed: Uint8Array
  sizes: number[]
  edgeSizes: number[]
  payloads?: readonly MatrixPayload[]
}): Promise<{
  targets: TestTargets
  encryptedIds: EncryptedReadIds
}> {
  const seedStarted = performance.now()
  console.log('Filling Collections and the payload matrix...')

  const publicSpace = await was.createSpace({ name: 'perf-public' })
  const privateSpace = await was.createSpace({ name: 'perf-private' })
  for (const size of sizes) {
    const publicCollection = await publicSpace.createCollection({
      id: `c-${size}`
    })
    await fillViaHttp({ collection: publicCollection, ids: itemIds(size) })
    await publicCollection.setPublic()
    const privateCollection = await privateSpace.createCollection({
      id: `c-${size}`
    })
    await fillViaHttp({ collection: privateCollection, ids: itemIds(size) })
  }
  const edgeSpaces = []
  for (const size of edgeSizes) {
    const seed = (label: string) =>
      seedSpaceViaHttp({ was, name: `${label}-${size}`, size })
    edgeSpaces.push({
      size,
      write: await seed(edgeSpaceLabels.write),
      remove: await seed(edgeSpaceLabels.remove),
      serial: await seed(edgeSpaceLabels.serial)
    })
  }
  const encryptedIds = await seedMatrix({ serverUrl, seed, payloads })
  const seedSeconds = (performance.now() - seedStarted) / 1000
  console.log(`Filled in ${seedSeconds.toFixed(0)}s. Running tests...\n`)
  return {
    targets: {
      publicSpaceId: publicSpace.id,
      privateSpaceId: privateSpace.id,
      edgeSpaces
    },
    encryptedIds
  }
}
