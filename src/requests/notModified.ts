/**
 * The 304 Not Modified answer shared by every `ETag`-emitting read handler
 * (spec "Caching"). A handler calls this after authorization, with the
 * representation's current `ETag`, and returns the reply it gets back; the
 * decision itself is `isNotModified` in `lib/etag.ts`. The 304 carries the
 * `ETag` the 200 would have carried and no body; a representation with no
 * `ETag` (matched only by `*`) carries none.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  etagOf,
  type HeldValidators,
  isNotModified,
  parseIfNoneMatch
} from '../lib/etag.js'

/**
 * Answers 304 when the request's `If-None-Match` covers `etag`, else
 * `undefined` so the handler serves the full representation. A caller that
 * already parsed the header (to decide on a metadata-first read) passes
 * `held` in; otherwise it is parsed here.
 * @param options {object}
 * @param options.request {FastifyRequest}
 * @param options.reply {FastifyReply}
 * @param [options.held] {HeldValidators}   the parsed `If-None-Match`, when
 *   the caller has it already
 * @param [options.etag] {string}   the representation's current `ETag`
 * @returns {FastifyReply | undefined}
 */
export function notModifiedReply({
  request,
  reply,
  held = parseIfNoneMatch(request.headers['if-none-match']),
  etag
}: {
  request: FastifyRequest
  reply: FastifyReply
  held?: HeldValidators
  etag?: string
}): FastifyReply | undefined {
  if (!isNotModified({ held, etag })) {
    return undefined
  }
  const notModified = reply.status(304)
  if (etag !== undefined) {
    notModified.header('etag', etag)
  }
  return notModified.send()
}

/**
 * The conditional-read check a streaming GET (Get Resource, Get Chunk) runs
 * before opening the byte stream: when the client names the validators it
 * holds, read the representation's metadata and answer 304 if the current
 * `ETag` is among them. Only a conditional request pays for the metadata read;
 * an unconditional one resolves `undefined` at once. Resolves `undefined` on a
 * miss too, so the handler opens the stream as usual.
 * @param options {object}
 * @param options.request {FastifyRequest}
 * @param options.reply {FastifyReply}
 * @param options.readMetadata {() => Promise<{ generation?: string, version?:
 *   number }>}   reads the stored metadata (404 when absent), run only when
 *   the request is conditional
 * @returns {Promise<FastifyReply | undefined>}
 */
export async function notModifiedBeforeStream({
  request,
  reply,
  readMetadata
}: {
  request: FastifyRequest
  reply: FastifyReply
  readMetadata: () => Promise<{ generation?: string; version?: number }>
}): Promise<FastifyReply | undefined> {
  const held = parseIfNoneMatch(request.headers['if-none-match'])
  if (!held) {
    return undefined
  }
  const metadata = await readMetadata()
  return notModifiedReply({ request, reply, held, etag: etagOf(metadata) })
}
