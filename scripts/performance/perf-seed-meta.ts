/**
 * The contract between a seed script and its runner: the throwaway `did:key`
 * a seed writes Spaces under, and the `seed-meta.json` it leaves beside the
 * seed, so the runner can reload that identity (and issue valid signed
 * requests against the same Spaces) along with the seed's sizes. A seed may
 * record more members; the runner that reads them checks them.
 */
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'

/**
 * The seed-meta file's name inside a seed dir.
 */
export const seedMetaFile = 'seed-meta.json'

/**
 * Where each seed script writes its seed by default, and where its runner
 * looks for one: `pnpm perf:fs:seed`'s data dir, and `pnpm perf:pg:seed`'s
 * seed-meta (its data is the Postgres schema).
 */
export const defaultSeedDirs = {
  fs: '.perf-fs-seed',
  pg: '.perf-pg-seed'
} as const

/**
 * What every seed records: the 32-byte seed its `did:key` derives from, and
 * the Collection sizes it filled.
 */
export interface SeedMeta {
  seed: Uint8Array
  sizes: number[]
  edgeSizes: number[]
}

/**
 * Mints a fresh throwaway identity for a seed: the 32-byte seed, its key
 * pair, and the `did:key` the seeded Spaces are controlled by.
 * @returns {Promise<{
 *   seed: Uint8Array, keyPair: Ed25519VerificationKey,
 *   controller: `did:key:${string}`
 * }>}
 */
export async function createSeedIdentity(): Promise<{
  seed: Uint8Array
  keyPair: Ed25519VerificationKey
  controller: `did:key:${string}`
}> {
  const seed = Uint8Array.from(randomBytes(32))
  const keyPair = await Ed25519VerificationKey.generate({ seed })
  return { seed, keyPair, controller: `did:key:${keyPair.fingerprint()}` }
}

/**
 * Writes `seed-meta.json` into `seedDir`, the seed base64-encoded.
 * @param options {object}
 * @param options.seedDir {string}
 * @param options.meta {SeedMeta & object}   the seed's own members too
 * @returns {Promise<void>}
 */
export async function writeSeedMeta({
  seedDir,
  meta
}: {
  seedDir: string
  meta: SeedMeta & Record<string, unknown>
}): Promise<void> {
  const { seed, ...rest } = meta
  await writeFile(
    join(seedDir, seedMetaFile),
    JSON.stringify(
      { seed: Buffer.from(seed).toString('base64'), ...rest },
      null,
      2
    )
  )
}

/**
 * Reads the `seed-meta.json` a seed script wrote into `seedDir`, failing
 * with a message that names `seedCommand` when it is missing or not a seed.
 * @param options {object}
 * @param options.seedDir {string}
 * @param options.seedCommand {string}   how to (re)seed, e.g.
 *   `pnpm perf:pg:seed`
 * @param [options.hasOwnMembers] {(meta: Record<string, unknown>) => boolean}
 *   checks the members the seed records beyond `SeedMeta`'s
 * @returns {Promise<SeedMeta & OwnMembers>} with the seed decoded to bytes
 */
export async function readSeedMeta<
  OwnMembers extends object = Record<never, never>
>({
  seedDir,
  seedCommand,
  hasOwnMembers = () => true
}: {
  seedDir: string
  seedCommand: string
  hasOwnMembers?: (meta: Record<string, unknown>) => boolean
}): Promise<SeedMeta & OwnMembers> {
  const metaPath = join(seedDir, seedMetaFile)
  let text: string
  try {
    text = await readFile(metaPath, 'utf8')
  } catch (err) {
    throw new Error(`No seed at ${metaPath}. Run \`${seedCommand}\` first.`, {
      cause: err
    })
  }
  const meta = JSON.parse(text)
  if (
    typeof meta.seed !== 'string' ||
    !Array.isArray(meta.sizes) ||
    !Array.isArray(meta.edgeSizes) ||
    !hasOwnMembers(meta)
  ) {
    throw new Error(
      `${metaPath} is not a seed-meta.json. Reseed with \`${seedCommand}\`.`
    )
  }
  return { ...meta, seed: Uint8Array.from(Buffer.from(meta.seed, 'base64')) }
}
