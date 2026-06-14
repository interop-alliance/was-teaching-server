/**
 * Request-layer adapter: resolves a Fastify request into a transport-neutral
 * `ResourceInput` value object, so that storage backends never depend on
 * Fastify. JSON bodies pass through as parsed values; raw blob bodies and
 * multipart uploads are normalized to a readable byte stream.
 */
import type { FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import { isJson } from '../lib/isJson.js'
import {
  MissingContentTypeError,
  InvalidRequestBodyError,
  PayloadTooLargeError
} from '../errors.js'
import type { ResourceInput } from '../types.js'

/**
 * @param request {import('fastify').FastifyRequest}
 * @returns {Promise<ResourceInput>}
 */
export async function resolveResourceInput(
  request: FastifyRequest
): Promise<ResourceInput> {
  const contentType = request.headers['content-type']
  if (!contentType) {
    throw new MissingContentTypeError({ requestName: 'Write Resource' })
  }

  if (isJson({ contentType })) {
    return { kind: 'json', contentType, data: request.body }
  }
  if (contentType.startsWith('multipart')) {
    // Spec ("Content Types and Representations"): a multipart write MUST carry
    // exactly one file part -- reject zero file parts, or more than one, as
    // `invalid-request-body` (400). Iterate every part rather than calling
    // `request.file()` (which silently takes the first file part and ignores any
    // extras). `toBuffer()` drains each file part's stream, which both lets the
    // iterator advance to detect a second (disallowed) part and yields the exact
    // byte length to pre-flight the upload cap. Buffering the part in memory is
    // acceptable for this multipart convenience path (the HTML form workflow) --
    // large binaries should use the streaming raw-body path. The buffer is
    // bounded by the backend's `maxUploadBytes` (the multipart `fileSize` limit
    // set in `server.ts`): `toBuffer()` throws `FST_REQ_FILE_TOO_LARGE` at the
    // boundary, mapped here to `payload-too-large` (413).
    const { storage } = request.server
    let file: { mimetype: string; bytes: Buffer } | undefined
    for await (const part of request.parts()) {
      if (part.type !== 'file') {
        continue
      }
      if (file) {
        throw new InvalidRequestBodyError({
          requestName: 'Write Resource',
          detail: 'multipart request must carry exactly one file part.'
        })
      }
      try {
        file = { mimetype: part.mimetype, bytes: await part.toBuffer() }
      } catch (err) {
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new PayloadTooLargeError({
            maxUploadBytes: storage.maxUploadBytes!,
            backendId: storage.describe().id
          })
        }
        throw err
      }
    }
    if (!file) {
      throw new InvalidRequestBodyError({
        requestName: 'Write Resource',
        detail: 'multipart request is missing a file part.'
      })
    }
    return {
      kind: 'binary',
      contentType: file.mimetype,
      stream: Readable.from(file.bytes),
      declaredBytes: file.bytes.length
    }
  }
  // A raw (non-multipart) blob body carries its size in `Content-Length` when
  // present; expose it as `declaredBytes` so the backend can pre-flight the
  // quota check before streaming. Ignore an absent or malformed value.
  const contentLength = Number(request.headers['content-length'])
  return {
    kind: 'binary',
    contentType,
    stream: request.body as Readable,
    declaredBytes:
      Number.isInteger(contentLength) && contentLength >= 0
        ? contentLength
        : undefined
  }
}
