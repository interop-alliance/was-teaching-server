/**
 * Runs the payload matrix's timed tests against a server seeded by
 * `perf-matrix-seed.ts`: a read and a write test for each payload in each
 * Collection category. Every count is whole files: an encrypted 10 MiB read is
 * its document plus its chunks, and an encrypted 10 MiB write is the 12
 * requests was-client sends (the document, each chunk, the document again).
 * Encrypted writes reuse the read targets' stored envelopes and chunks at
 * fresh ids, so no encryption happens in the timed part, and no read
 * decrypts. Public reads go through the caller's unsigned reader (k6);
 * everything else is signed. Needs only a running server, so it works over
 * any backend.
 */
import { randomBytes } from 'node:crypto'

import type { JsonObject, WasClient } from '@interop/was-client'

import {
  createDeleteLoad,
  credential,
  largeFileBytes,
  load,
  matrixCategories,
  matrixPayloads,
  matrixSpaceIds,
  smallFileBytes,
  type MatrixCategory,
  type MatrixPayload,
  type MatrixRow,
  type Measurement
} from './perf-lib.js'

const octetStream = { 'content-type': 'application/octet-stream' }

/**
 * The encrypted read targets as stored: the JSON and 100 KiB envelopes, and
 * the 10 MiB file's document and chunks. Timed encrypted writes send copies.
 */
interface EncryptedTemplates {
  json: JsonObject
  small: JsonObject
  large: { document: JsonObject; chunks: Uint8Array[] }
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
 * Reads the encrypted read targets' stored envelopes and chunks, untimed,
 * for the encrypted write tests to copy.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.encryptedIds {Record<MatrixPayload, string>}
 * @returns {Promise<EncryptedTemplates>}
 */
async function loadEncryptedTemplates({
  was,
  encryptedIds
}: {
  was: WasClient
  encryptedIds: Record<MatrixPayload, string>
}): Promise<EncryptedTemplates> {
  const base = `/space/${matrixSpaceIds.read}/encrypted`
  const readEnvelope = async (id: string) =>
    (await readBody({ was, path: `${base}/${id}` })) as JsonObject
  const document = await readEnvelope(encryptedIds.large)
  const { chunks: chunkCount } = document.stream as { chunks: number }
  const chunks: Uint8Array[] = []
  for (let index = 0; index < chunkCount; index++) {
    chunks.push(
      (await readBody({
        was,
        path: `${base}/${encryptedIds.large}/chunks/${index}`
      })) as Uint8Array
    )
  }
  return {
    json: await readEnvelope(encryptedIds.json),
    small: await readEnvelope(encryptedIds.small),
    large: { document, chunks }
  }
}

/**
 * Builds one matrix read: a signed GET of the read target, and for the
 * encrypted 10 MiB file, its document and then each chunk.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.category {MatrixCategory}
 * @param options.payload {MatrixPayload}
 * @param options.encryptedIds {Record<MatrixPayload, string>}
 * @param options.chunkCount {number}
 * @returns {() => Promise<unknown>}
 */
function readOperation({
  was,
  category,
  payload,
  encryptedIds,
  chunkCount
}: {
  was: WasClient
  category: MatrixCategory
  payload: MatrixPayload
  encryptedIds: Record<MatrixPayload, string>
  chunkCount: number
}): () => Promise<unknown> {
  const base = `/space/${matrixSpaceIds.read}/${category}`
  if (category !== 'encrypted') {
    return () => readBody({ was, path: `${base}/${payload}` })
  }
  const path = `${base}/${encryptedIds[payload]}`
  if (payload !== 'large') {
    return () => readBody({ was, path })
  }
  return async () => {
    await readBody({ was, path })
    for (let index = 0; index < chunkCount; index++) {
      await readBody({ was, path: `${path}/chunks/${index}` })
    }
  }
}

/**
 * Creates one file at `id` in the write Space: a JSON credential or random
 * bytes in the public and plaintext Collections, and a copy of the stored
 * envelope (with its chunks, for the 10 MiB file) in the encrypted one.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.category {MatrixCategory}
 * @param options.payload {MatrixPayload}
 * @param options.id {string}
 * @param options.templates {EncryptedTemplates}
 * @param options.files {{ small: Uint8Array, large: Uint8Array }}
 * @returns {Promise<void>}
 */
async function createFile({
  was,
  category,
  payload,
  id,
  templates,
  files
}: {
  was: WasClient
  category: MatrixCategory
  payload: MatrixPayload
  id: string
  templates: EncryptedTemplates
  files: { small: Uint8Array; large: Uint8Array }
}): Promise<void> {
  const path = `/space/${matrixSpaceIds.write}/${category}/${id}`
  if (category !== 'encrypted') {
    if (payload === 'json') {
      await was.request({ path, method: 'PUT', json: credential(id) })
      return
    }
    await was.request({
      path,
      method: 'PUT',
      headers: octetStream,
      body: files[payload]
    })
    return
  }
  if (payload !== 'large') {
    await was.request({
      path,
      method: 'PUT',
      json: { ...templates[payload], id }
    })
    return
  }
  const document = { ...templates.large.document, id }
  await was.request({
    path,
    method: 'PUT',
    headers: { 'if-none-match': '*' },
    json: document
  })
  for (const [index, chunk] of templates.large.chunks.entries()) {
    await was.request({
      path: `${path}/chunks/${index}`,
      method: 'PUT',
      headers: octetStream,
      body: chunk
    })
  }
  await was.request({ path, method: 'PUT', json: document })
}

/**
 * Runs every matrix test, category by category, reporting each result as it
 * completes. JSON writes create a new Resource each time; binary writes
 * create and then delete, untimed, so the write Space stays near empty
 * across runs.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.clients {number}
 * @param options.durationSeconds {number}
 * @param options.encryptedIds {Record<MatrixPayload, string>}
 * @param options.publicRead {(path: string) => Promise<Measurement | string>}
 *   the unsigned read of a public read target (k6), or a skip string
 * @param options.report {(result: object) => Promise<void>}   called with each
 *   `{ category, payload, operation, result }` as it completes
 * @returns {Promise<MatrixRow[]>}
 */
export async function runMatrix({
  was,
  clients,
  durationSeconds,
  encryptedIds,
  publicRead,
  report
}: {
  was: WasClient
  clients: number
  durationSeconds: number
  encryptedIds: Record<MatrixPayload, string>
  publicRead: (path: string) => Promise<Measurement | string>
  report: (result: {
    category: MatrixCategory
    payload: MatrixPayload
    operation: 'read' | 'write'
    result: Measurement | string
  }) => Promise<void>
}): Promise<MatrixRow[]> {
  // Fresh ids each run: the seeded schema persists across runs, and a write
  // test measures creating a file, not replacing one.
  const runTag = randomBytes(4).toString('hex')
  const templates = await loadEncryptedTemplates({ was, encryptedIds })
  const files = {
    small: Uint8Array.from(randomBytes(smallFileBytes)),
    large: Uint8Array.from(randomBytes(largeFileBytes))
  }
  const rows: MatrixRow[] = []
  for (const category of matrixCategories) {
    for (const payload of matrixPayloads) {
      const read =
        category === 'public'
          ? await publicRead(`/space/${matrixSpaceIds.read}/public/${payload}`)
          : await load({
              clients,
              durationSeconds,
              op: readOperation({
                was,
                category,
                payload,
                encryptedIds,
                chunkCount: templates.large.chunks.length
              })
            })
      await report({ category, payload, operation: 'read', result: read })

      const idFor = (worker: number, count: number) =>
        `${runTag}-${payload}-${worker}-${count}`
      const create = (worker: number, count: number) =>
        createFile({
          was,
          category,
          payload,
          id: idFor(worker, count),
          templates,
          files
        })
      const write =
        payload === 'json'
          ? await load({ clients, durationSeconds, op: create })
          : await createDeleteLoad({
              clients,
              durationSeconds,
              create,
              remove: (worker, round) =>
                was.request({
                  path: `/space/${matrixSpaceIds.write}/${category}/${idFor(worker, round)}`,
                  method: 'DELETE'
                })
            })
      await report({ category, payload, operation: 'write', result: write })
      rows.push({ category, payload, read, write })
    }
  }
  return rows
}
