/**
 * Runs the payload matrix's timed tests against a server seeded by
 * `perf-matrix-seed.ts`: a read and a write test for each payload in each
 * Collection category. Every count is whole files: an encrypted 10 MiB read is
 * its document plus its chunks, and an encrypted 10 MiB write is the 12
 * requests was-client sends (the document, each chunk, the document again).
 * Encrypted writes reuse the read targets' stored envelopes and chunks at
 * fresh ids, so no encryption happens in the timed part, and no read
 * decrypts. Public reads go through the caller's unsigned reader (k6);
 * everything else is signed. Each test spreads its load over the pool of
 * Collections the seed made per category. Needs only a running server, so it
 * works over any backend.
 */
import { randomBytes } from 'node:crypto'

import type { JsonObject, WasClient } from '@interop/was-client'

import {
  backendPool,
  createDeleteLoad,
  credential,
  largeFileBytes,
  load,
  matrixCategories,
  matrixPayloads,
  matrixSpaceIds,
  retryOnNetworkFault,
  smallFileBytes,
  type EncryptedReadIds,
  type LoadSettings,
  type MatrixCategory,
  type MatrixPayload,
  type MatrixRow,
  type Measurement,
  type PoolMember,
  type PoolTarget
} from './perf-lib.js'

const octetStream = { 'content-type': 'application/octet-stream' }

/**
 * An encrypted read target as stored: its EDV id, its envelope, and its
 * chunks (none unless the file is over was-client's chunking threshold).
 * Timed encrypted writes send copies.
 */
interface EncryptedTarget {
  id: string
  envelope: JsonObject
  chunks: Uint8Array[]
}

/**
 * How the matrix reads and writes one payload in one category: the read
 * target's Resource id, how many chunks a read fetches after it, and how to
 * create one copy of the file at a path in the write Space.
 */
interface MatrixFile {
  readId: string
  chunkCount: number
  create: (options: { path: string; id: string }) => Promise<unknown>
}

/**
 * A matrix Resource's path: `id` in one pool member's `category` Collection
 * (`<category><suffix>`) of the read or the write Space.
 * @param options {object}
 * @param options.space {'read' | 'write'}
 * @param options.category {MatrixCategory}
 * @param options.suffix {string}   the pool member's
 * @param options.id {string}
 * @returns {string}
 */
function matrixPath({
  space,
  category,
  suffix,
  id
}: {
  space: 'read' | 'write'
  category: MatrixCategory
  suffix: string
  id: string
}): string {
  return `/space/${matrixSpaceIds[space]}/${category}${suffix}/${id}`
}

/**
 * Sends a signed GET and reads the whole body. A JSON body arrives already
 * downloaded and parsed (`response.data`, which was-client's HTTP layer fills
 * in, consuming the body); any other body is read here as bytes.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.path {string}
 * @returns {Promise<unknown>} the parsed JSON, or the bytes
 */
async function readBody({
  was,
  path
}: {
  was: WasClient
  path: string
}): Promise<unknown> {
  const response = await was.request({ path })
  if (response.data !== undefined) {
    return response.data
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Reads one file whole: the Resource at `path`, then each of its
 * `chunkCount` chunks.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.path {string}
 * @param options.chunkCount {number}
 * @returns {Promise<unknown[]>} the Resource's body, then each chunk's
 */
async function readFile({
  was,
  path,
  chunkCount
}: {
  was: WasClient
  path: string
  chunkCount: number
}): Promise<unknown[]> {
  const bodies = [await readBody({ was, path })]
  for (let index = 0; index < chunkCount; index++) {
    bodies.push(await readBody({ was, path: `${path}/chunks/${index}` }))
  }
  return bodies
}

/**
 * Reads the encrypted read targets' stored envelopes and chunks, untimed,
 * for the encrypted write tests to copy. A chunked envelope names its chunk
 * count in its cleartext `stream`; an inline one has no `stream`. Every pool
 * member holds each target at the same id, so one member's copy is read.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.encryptedIds {EncryptedReadIds}
 * @param options.suffix {string}   the pool member to read from
 * @returns {Promise<Map<MatrixPayload, EncryptedTarget>>} a target for each
 *   payload `encryptedIds` names, in the matrix's payload order
 */
async function loadEncryptedTargets({
  was,
  encryptedIds,
  suffix
}: {
  was: WasClient
  encryptedIds: EncryptedReadIds
  suffix: string
}): Promise<Map<MatrixPayload, EncryptedTarget>> {
  const targets = new Map<MatrixPayload, EncryptedTarget>()
  for (const payload of matrixPayloads) {
    const id = encryptedIds[payload]
    if (id === undefined) {
      continue
    }
    const path = matrixPath({
      space: 'read',
      category: 'encrypted',
      suffix,
      id
    })
    const envelope = (await retryOnNetworkFault({
      op: () => readBody({ was, path })
    })) as JsonObject
    const stream = envelope.stream as { chunks: number } | undefined
    const [, ...chunks] = await retryOnNetworkFault({
      op: () => readFile({ was, path, chunkCount: stream?.chunks ?? 0 })
    })
    targets.set(payload, { id, envelope, chunks: chunks as Uint8Array[] })
  }
  return targets
}

/**
 * The plaintext files, for the public and plaintext categories: each read
 * target's id is its payload name, and a write sends a JSON credential or
 * random bytes.
 * @param options {object}
 * @param options.was {WasClient}
 * @returns {Record<MatrixPayload, MatrixFile>}
 */
function plaintextFiles({
  was
}: {
  was: WasClient
}): Record<MatrixPayload, MatrixFile> {
  const bytesFile = (readId: MatrixPayload, bytes: number): MatrixFile => {
    const body = Uint8Array.from(randomBytes(bytes))
    return {
      readId,
      chunkCount: 0,
      create: ({ path }) =>
        was.request({ path, method: 'PUT', headers: octetStream, body })
    }
  }
  return {
    json: {
      readId: 'json',
      chunkCount: 0,
      create: ({ path, id }) =>
        was.request({ path, method: 'PUT', json: credential(id) })
    },
    small: bytesFile('small', smallFileBytes),
    large: bytesFile('large', largeFileBytes)
  }
}

/**
 * An encrypted file: its read target's id is its EDV id, a read fetches its
 * chunks too, and a write sends a copy of the stored envelope -- a chunked
 * one the way was-client writes it: the document guarded with
 * `If-None-Match: *`, each chunk, then the document again.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.target {EncryptedTarget}
 * @returns {MatrixFile}
 */
function encryptedFile({
  was,
  target
}: {
  was: WasClient
  target: EncryptedTarget
}): MatrixFile {
  const { id: readId, envelope, chunks } = target
  return {
    readId,
    chunkCount: chunks.length,
    create: async ({ path, id }) => {
      const document = { ...envelope, id }
      if (chunks.length === 0) {
        await was.request({ path, method: 'PUT', json: document })
        return
      }
      await was.request({
        path,
        method: 'PUT',
        headers: { 'if-none-match': '*' },
        json: document
      })
      for (const [index, chunk] of chunks.entries()) {
        await was.request({
          path: `${path}/chunks/${index}`,
          method: 'PUT',
          headers: octetStream,
          body: chunk
        })
      }
      await was.request({ path, method: 'PUT', json: document })
    }
  }
}

/**
 * Runs every matrix test, category by category, reporting each result as it
 * completes. It runs the payloads the seed wrote, the ones `encryptedIds`
 * names. JSON writes create a new Resource each time; binary writes
 * create and then delete, untimed, so the write Space stays near empty
 * across runs.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.settings {LoadSettings}
 * @param options.encryptedIds {EncryptedReadIds}
 * @param options.publicRead {(targets: PoolTarget[], clients?: number) => Promise<Measurement | string>}
 *   the unsigned read of a public read target in each pool member (k6) by
 *   that many clients, or a skip string
 * @param options.report {(result: object) => Promise<void>}   called with each
 *   `{ category, payload, operation, result }` as it completes
 * @param [options.pool] {PoolMember[]}   the Collections per category the
 *   seed made; one by default
 * @returns {Promise<MatrixRow[]>}
 */
export async function runMatrix({
  was,
  settings,
  encryptedIds,
  publicRead,
  report,
  pool = backendPool()
}: {
  was: WasClient
  settings: LoadSettings
  encryptedIds: EncryptedReadIds
  publicRead: (
    targets: PoolTarget[],
    clients?: number
  ) => Promise<Measurement | string>
  report: (result: {
    category: MatrixCategory
    payload: MatrixPayload
    operation: 'read' | 'write'
    result: Measurement | string
  }) => Promise<void>
  pool?: PoolMember[]
}): Promise<MatrixRow[]> {
  const { durationSeconds } = settings
  // Fresh ids each run: the seeded schema persists across runs, and a write
  // test measures creating a file, not replacing one.
  const runTag = randomBytes(4).toString('hex')
  const plaintext = plaintextFiles({ was })
  const encryptedTargets = await loadEncryptedTargets({
    was,
    encryptedIds,
    suffix: pool[0]!.suffix
  })
  const rows: MatrixRow[] = []
  for (const category of matrixCategories) {
    for (const [payload, target] of encryptedTargets) {
      const { readId, chunkCount, create } =
        category === 'encrypted'
          ? encryptedFile({ was, target })
          : plaintext[payload]
      const clients =
        payload === 'large' ? settings.largeFileClients : settings.clients
      const readTargets = pool.map(({ backend, suffix }) => ({
        path: matrixPath({ space: 'read', category, suffix, id: readId }),
        backend
      }))
      const read =
        category === 'public'
          ? await publicRead(readTargets, clients)
          : await load({
              clients,
              durationSeconds,
              pool: readTargets,
              op: ({ path }) => readFile({ was, path, chunkCount })
            })
      await report({ category, payload, operation: 'read', result: read })

      const idFor = (worker: number, count: number) =>
        `${runTag}-${payload}-${worker}-${count}`
      const pathFor = ({ suffix }: PoolMember, id: string) =>
        matrixPath({ space: 'write', category, suffix, id })
      const createAt = (member: PoolMember, worker: number, count: number) => {
        const id = idFor(worker, count)
        return create({ path: pathFor(member, id), id })
      }
      const write =
        payload === 'json'
          ? await load({ clients, durationSeconds, pool, op: createAt })
          : await createDeleteLoad({
              clients,
              durationSeconds,
              pool,
              create: createAt,
              remove: (member, worker, round) =>
                was.request({
                  path: pathFor(member, idFor(worker, round)),
                  method: 'DELETE'
                })
            })
      await report({ category, payload, operation: 'write', result: write })
      rows.push({ category, payload, read, write })
    }
  }
  return rows
}
