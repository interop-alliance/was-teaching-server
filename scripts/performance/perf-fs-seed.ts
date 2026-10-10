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
 * Usage: pnpm perf:fs:seed [--sizes 1,500] [--out .perf-fs-seed]
 */
import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'

import { FileSystemBackend } from '../../src/backends/filesystem.js'
import {
  credential,
  fillConcurrently,
  itemIds,
  parseSizes
} from './perf-lib.js'

const seedConcurrency = 10

const { values: args } = parseArgs({
  options: {
    sizes: { type: 'string', default: '1,500' },
    out: { type: 'string', default: '.perf-fs-seed' }
  }
})
const { sizes, edgeSizes } = parseSizes(args.sizes)

/**
 * Writes one Resource per id directly through the backend, several at a
 * time, under `createdBy`.
 * @param options {object}
 * @param options.backend {FileSystemBackend}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.ids {string[]}
 * @param options.createdBy {`did:${string}`}
 * @returns {Promise<void>}
 */
async function fill({
  backend,
  spaceId,
  collectionId,
  ids,
  createdBy
}: {
  backend: FileSystemBackend
  spaceId: string
  collectionId: string
  ids: string[]
  createdBy: `did:${string}`
}): Promise<void> {
  await fillConcurrently({
    ids,
    concurrency: seedConcurrency,
    write: id =>
      backend.writeResource({
        spaceId,
        collectionId,
        resourceId: id,
        input: {
          kind: 'json',
          contentType: 'application/json',
          data: credential(id)
        },
        createdBy
      })
  })
}

/**
 * Creates one Space with one Collection, filled to `size`, directly through
 * the backend.
 * @param options {object}
 * @param options.backend {FileSystemBackend}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.size {number}
 * @param options.controller {`did:${string}`}
 * @param options.makePublic {boolean}
 * @returns {Promise<void>}
 */
async function seedSpace({
  backend,
  spaceId,
  collectionId,
  size,
  controller,
  makePublic
}: {
  backend: FileSystemBackend
  spaceId: string
  collectionId: string
  size: number
  controller: `did:${string}`
  makePublic: boolean
}): Promise<void> {
  await backend.writeSpace({
    spaceId,
    spaceMetadata: { id: spaceId, type: ['Space'], controller },
    createdBy: controller
  })
  await backend.writeCollection({
    spaceId,
    collectionId,
    collectionMetadata: { id: collectionId, type: ['Collection'] },
    createdBy: controller
  })
  await fill({
    backend,
    spaceId,
    collectionId,
    ids: itemIds(size),
    createdBy: controller
  })
  if (makePublic) {
    await backend.writePolicy({
      spaceId,
      collectionId,
      policy: { type: 'PublicCanRead' }
    })
  }
}

/**
 * Opens a backend on `args.out`, seeds every Space `pnpm perf:fs --seed-dir`
 * expects, persists the signing identity and the sizes alongside it, and
 * closes the backend.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  // A reseed replaces the previous one in full, so Collections of a size no
  // longer listed do not linger beside the new `seed-meta.json`.
  await rm(args.out, { recursive: true, force: true })
  await mkdir(args.out, { recursive: true })
  const seed = Uint8Array.from(randomBytes(32))
  const keyPair = await Ed25519VerificationKey.generate({ seed })
  const controller = `did:key:${keyPair.fingerprint()}` as const

  const backend = await FileSystemBackend.open({ dataDir: args.out })
  try {
    for (const size of sizes) {
      await seedSpace({
        backend,
        spaceId: 'perf-public',
        collectionId: `c-${size}`,
        size,
        controller,
        makePublic: true
      })
      await seedSpace({
        backend,
        spaceId: 'perf-private',
        collectionId: `c-${size}`,
        size,
        controller,
        makePublic: false
      })
    }
    for (const size of edgeSizes) {
      for (const label of ['perf-write', 'perf-delete', 'perf-serial']) {
        await seedSpace({
          backend,
          spaceId: `${label}-${size}`,
          collectionId: 'items',
          size,
          controller,
          makePublic: false
        })
      }
    }
  } finally {
    await backend.close()
  }

  await writeFile(
    join(args.out, 'seed-meta.json'),
    JSON.stringify(
      {
        seed: Buffer.from(seed).toString('base64'),
        sizes,
        edgeSizes
      },
      null,
      2
    )
  )
  console.log(`Seeded ${args.out} (sizes: ${sizes.join(', ')})`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
