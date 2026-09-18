/**
 * The effective limit on a buffered request body: the size Fastify's buffering
 * content-type parsers (`application/json`, `+json`, `text/*`) accept, and the
 * bound `captureRawBody` applies while it accumulates those bytes. This module
 * derives the limit (`bufferedBodyLimit`) and reads a body under it
 * (`readBoundedBody`), the one algorithm every buffered read shares.
 *
 * A buffered body is held in memory in full, so the limit exists whether or not
 * a per-upload cap is configured. It is derived from the active backend's
 * `maxUploadBytes` so that the same bytes are accepted as JSON and as
 * `application/octet-stream` (the unbuffered catch-all parser), rather than
 * being cut off at Fastify's 1 MiB default.
 */
import type { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { DEFAULT_MAX_UPLOAD_BYTES } from '../config.default.js'
import { PayloadTooLargeError } from '../errors.js'

/**
 * Derives the buffered-body limit from a backend's per-upload cap. A finite cap
 * is the limit; an absent one (`MAX_UPLOAD_BYTES=unlimited`, which the backends
 * normalize to `undefined`) falls back to {@link DEFAULT_MAX_UPLOAD_BYTES},
 * because an unbounded buffered body is an unbounded allocation. Fastify
 * requires a positive integer, so the result is rounded down and never below 1.
 * @param maxUploadBytes {number|undefined}   the backend's per-upload cap, as
 *   the backend normalized it (`undefined` means no cap)
 * @returns {number}   the buffered-body limit in bytes
 */
export function bufferedBodyLimit(maxUploadBytes: number | undefined): number {
  const limit =
    maxUploadBytes !== undefined && Number.isFinite(maxUploadBytes)
      ? Math.floor(maxUploadBytes)
      : DEFAULT_MAX_UPLOAD_BYTES
  return Math.max(1, limit)
}

/**
 * Reads a request body stream into one buffer, bounded by the route's
 * `bodyLimit`. An announced over-limit `Content-Length` is refused before a
 * byte is read; a chunked body is refused at the byte that crosses the limit,
 * and the rest of it is never read. Either refusal is `PayloadTooLargeError`
 * (413) and marks the reply `Connection: close`, as Fastify's own limit does:
 * the client may still be sending the unread rest, which the server will not
 * drain, so a kept-alive connection would sit stuck until a timeout.
 *
 * The stream is iterated without `destroyOnReturn`: the raw request stream is
 * the socket's, and destroying it half-read would tear the connection down
 * before the 413 is written.
 * @param options {object}
 * @param options.request {FastifyRequest}
 * @param options.reply {FastifyReply}
 * @param options.payload {Readable}   the body stream
 * @param [options.backendId] {string}   the backend named in the 413 detail,
 *   when the limit is that backend's `maxUploadBytes`; absent when it is the
 *   server's own buffered-body limit
 * @returns {Promise<Buffer>}   the whole body
 */
export async function readBoundedBody({
  request,
  reply,
  payload,
  backendId
}: {
  request: FastifyRequest
  reply: FastifyReply
  payload: Readable
  backendId?: string
}): Promise<Buffer> {
  const limit = request.routeOptions.bodyLimit
  const tooLarge = (uploadBytes?: number) => {
    reply.header('connection', 'close')
    return new PayloadTooLargeError({
      maxUploadBytes: limit,
      backendId,
      uploadBytes
    })
  }
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    throw tooLarge(declared)
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of payload.iterator({ destroyOnReturn: false })) {
    received += (chunk as Buffer).byteLength
    if (received > limit) {
      throw tooLarge()
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}
