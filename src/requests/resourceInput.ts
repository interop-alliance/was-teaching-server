/**
 * Request-layer adapter: resolves a Fastify request into a transport-neutral
 * `ResourceInput` value object, so that storage backends never depend on
 * Fastify. JSON bodies pass through as parsed values; raw blob bodies and
 * multipart uploads are normalized to a readable byte stream.
 */
import type { FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { isJson } from '../lib/isJson.js'
import type { ResourceInput } from '../types.js'

/**
 * @param request {import('fastify').FastifyRequest}
 * @returns {Promise<ResourceInput>}
 */
export async function resolveResourceInput(
  request: FastifyRequest
): Promise<ResourceInput> {
  const contentType = request.headers['content-type']

  if (isJson({ contentType })) {
    return { kind: 'json', contentType: contentType!, data: request.body }
  }
  if (contentType?.startsWith('multipart')) {
    const file = await request.file()
    return { kind: 'binary', contentType: file!.mimetype, stream: file!.file }
  }
  return {
    kind: 'binary',
    contentType: contentType!,
    stream: request.body as Readable
  }
}
