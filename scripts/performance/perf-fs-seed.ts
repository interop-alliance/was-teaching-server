/**
 * Pre-seeds a filesystem data dir for `pnpm perf:fs --seed-dir <path>`, so a
 * run can skip refilling Collections over signed HTTP every time.
 *
 * Writes directly through `FileSystemBackend`'s own write methods (the same
 * class the server uses), under a throwaway `did:key` whose private key it
 * persists alongside the data (`seed-meta.json`), so a later run can reload
 * the identity and issue valid signed requests against the same Spaces. The
 * on-disk result is what a real signed write over HTTP would have produced:
 * `createdBy` and `controller` are explicitly set to that same `did:key`,
 * matching what the request handlers set from `invokerDid(request)`.
 *
 * The seeded layout matches what `pnpm perf:fs` builds for itself when no
 * `--seed-dir` is given: a `perf-public` Space (one public Collection per
 * size), a `perf-private` Space (one private Collection per size), and three
 * Spaces per edge size (`perf-write-<size>`, `perf-delete-<size>`,
 * `perf-serial-<size>`), each with a single `items` Collection.
 *
 * It then seeds the payload matrix (`scripts/performance/perf-matrix-seed.ts`)
 * over signed HTTP, through an in-process server on the same backend, since
 * an encrypted Collection's key epoch and EDV envelopes are made by
 * was-client: the `perf-matrix-read` and `perf-matrix-write` Spaces. The
 * encrypted read targets' EDV ids go into `seed-meta.json` too. No binary
 * ballast: see `scripts/performance/perf-fs.ts`.
 *
 * Usage: pnpm perf:fs:seed [--sizes 1,500,2000] [--out .perf-fs-seed]
 */
import { mkdir, rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { FileSystemBackend } from '../../src/backends/filesystem.js'
import { formatSeedPlan, parseSizes, seedSizeSpaces } from './perf-lib.js'
import { seedMatrixInProcess } from './perf-matrix-seed.js'
import {
  createSeedIdentity,
  defaultSeedDirs,
  writeSeedMeta
} from './perf-seed-meta.js'

const { values: args } = parseArgs({
  options: {
    sizes: { type: 'string', default: '1,500,2000' },
    out: { type: 'string', default: defaultSeedDirs.fs }
  }
})
const { sizes, edgeSizes } = parseSizes(args.sizes)

/**
 * Opens a backend on `args.out`, seeds every Space `pnpm perf:fs --seed-dir`
 * expects (the Collection-size Spaces directly, then the payload matrix over
 * HTTP), persists the signing identity, the sizes and the encrypted read
 * targets' ids alongside it, and closes the backend.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  console.log(
    formatSeedPlan({
      target: `${args.out} (--out)`,
      sizes,
      ballast: 'none (the OS page cache would hold it all; see perf-fs.ts)'
    })
  )
  // A reseed replaces the previous one in full, so Collections of a size no
  // longer listed do not linger beside the new `seed-meta.json`.
  await rm(args.out, { recursive: true, force: true })
  await mkdir(args.out, { recursive: true })
  const { seed, controller } = await createSeedIdentity()

  const backend = await FileSystemBackend.open({ dataDir: args.out })
  try {
    await seedSizeSpaces({ backend, sizes, edgeSizes, controller })
  } catch (err) {
    await backend.close()
    throw err
  }

  console.log('Seeding the payload matrix...')
  const encryptedIds = await seedMatrixInProcess({ backend, seed })

  await writeSeedMeta({
    seedDir: args.out,
    meta: { seed, sizes, edgeSizes, encryptedIds }
  })
  console.log(
    `Seeded ${args.out} (sizes: ${sizes.join(', ')}; matrix, no ballast)`
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
