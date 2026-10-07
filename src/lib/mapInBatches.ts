/**
 * Bounded-concurrency mapping for the filesystem backend's directory walks:
 * a Space with many Collections, a dir with many Resources, or a boot
 * migration over a whole store opens a bounded number of files at once.
 */

/**
 * How many items `mapInBatches` maps at once: Collection Metadata files in
 * a Space listing, sidecars in a Collection listing or a boot migration.
 */
const FILE_READ_BATCH = 32

/**
 * Maps each item through an async function, `FILE_READ_BATCH` items at a
 * time. The result keeps the order of `items`.
 * @param options {object}
 * @param options.items {T[]}
 * @param options.map {(item: T) => Promise<R>}
 * @returns {Promise<R[]>}
 */
export async function mapInBatches<T, R>({
  items,
  map
}: {
  items: T[]
  map: (item: T) => Promise<R>
}): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += FILE_READ_BATCH) {
    const batch = items.slice(start, start + FILE_READ_BATCH)
    results.push(...(await Promise.all(batch.map(map))))
  }
  return results
}
