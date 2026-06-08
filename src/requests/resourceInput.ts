/**
 * Request-layer adapter: resolves a Fastify request into a transport-neutral
 * `ResourceInput` value object, so that storage backends never depend on
 * Fastify. JSON bodies pass through as parsed values; raw blob bodies and
 * multipart uploads are normalized to a readable byte stream.
 */
import type { FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { isJson } from '../lib/isJson.js'
import { MissingContentTypeError, InvalidRequestBodyError } from '../errors.js'
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
    // `request.file()` resolves `undefined` when the multipart request carries
    // no file part; guard it so that surfaces as a clean 400 rather than a raw
    // TypeError on the null dereference below.
    const file = await request.file()
    if (!file) {
      throw new InvalidRequestBodyError({
        requestName: 'Write Resource',
        detail: 'multipart request is missing a file part.'
      })
    }
    return { kind: 'binary', contentType: file.mimetype, stream: file.file }
  }
  return {
    kind: 'binary',
    contentType,
    stream: request.body as Readable
  }
}
