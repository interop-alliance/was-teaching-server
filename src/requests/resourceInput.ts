/**
 * Request-layer adapter: resolves a Fastify request into a transport-neutral
 * `ResourceInput` value object, so that storage backends never depend on
 * Fastify. JSON bodies pass through as parsed values; raw blob bodies and
 * `multipart/form-data` uploads are normalized to a readable byte stream. Any
 * other `multipart/*` type is a raw blob body like any other media type. A
 * write into a Collection passes its Collection Metadata object, and the
 * resolver runs the encrypted-Collection conformance check on what will be
 * stored.
 */
import type { FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import {
  MissingContentTypeError,
  InvalidRequestBodyError,
  PayloadTooLargeError
} from '../errors.js'
import { isJsonContentType } from '@interop/storage-core'
import { isMultipartFormData } from '../lib/mediaType.js'
import { bufferedBodyLimit } from '../lib/bodyLimit.js'
import { parseJsonOrUndefined } from '../lib/jsonBytes.js'
import { assertEncryptedWriteConforms } from '../lib/encryption.js'
import type { CollectionEncryption, ResourceInput } from '../types.js'

/**
 * Reads the one file part of a `multipart/form-data` body into memory.
 *
 * Spec ("Content Types and Representations"): a multipart write MUST carry
 * exactly one file part -- reject zero file parts, or more than one, as
 * `invalid-request-body` (400). Iterate every part rather than calling
 * `request.file()` (which silently takes the first file part and ignores any
 * extras). `toBuffer()` drains each file part's stream, which both lets the
 * iterator advance to detect a second (disallowed) part and yields the exact
 * byte length to pre-flight the upload cap. Buffering the part in memory is
 * acceptable for this multipart convenience path (the HTML form workflow) --
 * large binaries should use the streaming raw-body path. The buffer is
 * bounded by the buffered-body limit (the multipart `fileSize` limit
 * `plugin.ts` derives from `storage.maxUploadBytes`): `toBuffer()` throws
 * `FST_REQ_FILE_TOO_LARGE` at the boundary, mapped here to `payload-too-large`
 * (413) naming that limit, and the server backend it is the cap of when one is
 * configured. The data-plane backend applies its own cap to the buffered part
 * when it writes.
 * @param request {import('fastify').FastifyRequest}
 * @returns {Promise<{ contentType: string, bytes: Buffer }>}   the part's own
 *   media type and bytes
 */
async function readMultipartFile(
  request: FastifyRequest
): Promise<{ contentType: string; bytes: Buffer }> {
  const { storage } = request.server
  let file: { contentType: string; bytes: Buffer } | undefined
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
      file = { contentType: part.mimetype, bytes: await part.toBuffer() }
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new PayloadTooLargeError({
          maxUploadBytes: bufferedBodyLimit(storage.maxUploadBytes),
          backendId:
            storage.maxUploadBytes === undefined
              ? undefined
              : storage.describe().id
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
  // The whole multipart body has been read; the `Digest` verdict over it
  // (taken by the preParsing hook) settles now, and a mismatch fails the
  // write before anything is stored.
  await request.multipartDigest
  return file
}

/**
 * A binary input over bytes already held in memory: a multipart file part, or
 * a `text/plain` string Fastify's built-in text parser produced.
 * @param options {object}
 * @param options.contentType {string}
 * @param options.bytes {Buffer}
 * @returns {ResourceInput}
 */
function bufferedBinaryInput({
  contentType,
  bytes
}: {
  contentType: string
  bytes: Buffer
}): ResourceInput {
  return {
    kind: 'binary',
    contentType,
    stream: Readable.from(bytes),
    declaredBytes: bytes.length
  }
}

/**
 * Resolves a content write. The input's kind follows the shape the route's
 * content-type parsers left in `request.body`, not the media type alone: a
 * stream is stored as received whatever its media type (a chunk write's route
 * scope removes the JSON and text parsers, since a chunk is a range of a
 * stream, not a document), a parsed value under a JSON media type is a
 * document, and a string or Buffer is wrapped as bytes.
 *
 * With `collectionMetadata`, runs the fail-closed encryption enforcement: if
 * the Collection declares a recognized `encryption` scheme, what will be
 * stored MUST be a conforming envelope of it (right media type + envelope
 * shape), else `encryption-scheme-mismatch` (422). For a raw body that is the
 * request's own content type and parsed body, checked before the body is
 * resolved so a wrong content type is refused without consuming the upload. A
 * `multipart/form-data` envelope stores its file part, so the check runs on
 * that part's content type and bytes once the part is read.
 * @param request {import('fastify').FastifyRequest}
 * @param [options] {object}
 * @param [options.collectionMetadata] {{ encryption?: CollectionEncryption }}
 *   the target Collection's stored Collection Metadata object, for a write
 *   into a Collection
 * @returns {Promise<ResourceInput>}
 */
export async function resolveResourceInput(
  request: FastifyRequest,
  {
    collectionMetadata
  }: { collectionMetadata?: { encryption?: CollectionEncryption } } = {}
): Promise<ResourceInput> {
  const contentType = request.headers['content-type']
  if (!contentType) {
    throw new MissingContentTypeError({ requestName: 'Write Resource' })
  }

  if (isMultipartFormData({ contentType })) {
    const file = await readMultipartFile(request)
    if (collectionMetadata) {
      assertEncryptedWriteConforms({
        collectionMetadata,
        contentType: file.contentType,
        body: isJsonContentType(file.contentType)
          ? parseJsonOrUndefined(file.bytes)
          : undefined
      })
    }
    return bufferedBinaryInput(file)
  }
  const body = request.body
  if (collectionMetadata) {
    assertEncryptedWriteConforms({ collectionMetadata, contentType, body })
  }
  if (body instanceof Readable) {
    // The raw stream the catch-all parser hands over. It carries its size in
    // `Content-Length` when present; expose it as `declaredBytes` so the
    // backend can pre-flight the quota check before streaming. Ignore an
    // absent or malformed value.
    const contentLength = Number(request.headers['content-length'])
    return {
      kind: 'binary',
      contentType,
      stream: body,
      declaredBytes:
        Number.isInteger(contentLength) && contentLength >= 0
          ? contentLength
          : undefined
    }
  }
  if (isJsonContentType(contentType)) {
    return { kind: 'json', contentType, data: body }
  }
  // A `text/plain` body arrives already parsed as a **string** (Fastify's
  // built-in text parser, which the `*` catch-all does not shadow). Wrap a
  // string (or Buffer) as a byte stream so it is written verbatim -- piping a
  // string into the backend's `stream.pipeline` would iterate it by UTF-16
  // code unit (one write per character, splitting astral-plane characters
  // into lone surrogates), corrupting the stored bytes.
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return bufferedBinaryInput({ contentType, bytes: Buffer.from(body) })
  }
  throw new InvalidRequestBodyError({
    requestName: 'Write Resource',
    detail: `A '${contentType}' body must arrive as a byte stream.`
  })
}
