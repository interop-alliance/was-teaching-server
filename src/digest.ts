/**
 * Request Body Integrity (spec "Request Body Integrity (Digest Header)"): binds
 * a request body to its HTTP Signature via the `Digest` header. Two hooks,
 * installed by every route group alongside the auth hooks:
 *
 * - `captureRawBody` (preParsing) tees the exact body bytes onto
 *   `request.rawBody` for JSON/text bodies, so the digest can be recomputed
 *   against what the client actually signed. Re-serializing the parsed body is
 *   not guaranteed byte-identical, so we keep the raw bytes instead. Streamed
 *   bodies (multipart uploads, tar imports) are left untouched so large uploads
 *   keep streaming.
 * - `verifyBodyDigest` (preValidation) enforces, for any request carrying a
 *   `Content-Type`: that the signature covers the `digest` header (MUST), that a
 *   `Digest` header is present, and -- when the raw body was captured --
 *   independently recomputes the body digest and compares it (SHOULD). A
 *   missing, malformed, uncovered, or non-matching digest is rejected with
 *   `invalid-authorization-header` (400).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { verifyHeaderValue } from '@interop/http-digest-header'
import { PassThrough, type Readable } from 'node:stream'
import { isJson } from './lib/isJson.js'
import { InvalidDigestError } from './errors.js'

/**
 * True for the body shapes `verifyBodyDigest` recomputes: JSON
 * (`application/json` / `+json`) and text. These reach handlers fully parsed
 * (object / string), so buffering their bytes is cheap; streamed bodies
 * (multipart, `application/x-tar`) are deliberately excluded.
 * @param contentType {string | undefined}
 * @returns {boolean}
 */
function isBufferableBody(contentType: string | undefined): boolean {
  return (
    isJson({ contentType }) ||
    (typeof contentType === 'string' && contentType.startsWith('text/'))
  )
}

/**
 * preParsing hook: for JSON/text bodies, tees the incoming payload into
 * `request.rawBody` while passing the same bytes through to Fastify's content-
 * type parser. Other (streamed) bodies pass through untouched.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @param payload {Readable}   the raw request body stream
 * @returns {Promise<Readable>}   the stream Fastify should parse
 */
export async function captureRawBody(
  request: FastifyRequest,
  _reply: FastifyReply,
  payload: Readable
): Promise<Readable> {
  if (!isBufferableBody(request.headers['content-type'])) {
    return payload
  }
  const chunks: Buffer[] = []
  const passthrough = new PassThrough()
  payload.on('data', chunk => {
    chunks.push(chunk as Buffer)
    passthrough.write(chunk)
  })
  payload.on('end', () => {
    request.rawBody = Buffer.concat(chunks)
    passthrough.end()
  })
  payload.on('error', err => passthrough.destroy(err))
  return passthrough
}

/**
 * preValidation hook: enforces the `Digest` header binding for any request that
 * carries a `Content-Type`. Bodyless requests (no `Content-Type`) and anonymous
 * reads (no parsed `request.zcap`) are passed through.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function verifyBodyDigest(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const contentType = request.headers['content-type']
  // Bodyless requests carry no Content-Type and no Digest -- nothing to bind.
  if (!contentType) {
    return
  }
  // No parsed auth headers: writes require auth (the auth hooks 401 first), so a
  // bodied request reaching here without `zcap` is a safe method that happens to
  // carry a Content-Type; leave it to the handler's policy decision.
  const { zcap } = request
  if (!zcap) {
    return
  }

  // MUST: `digest` is among the signature's covered (signed) headers.
  if (!zcap.headers.split(/\s+/).includes('digest')) {
    throw new InvalidDigestError({
      detail:
        'The request signature must cover the `digest` header when the ' +
        'request carries a body.'
    })
  }
  // The `Digest` header itself MUST be present.
  if (!zcap.digest) {
    throw new InvalidDigestError({
      detail: 'A `Digest` header is required when the request carries a body.'
    })
  }

  // SHOULD: independently recompute and compare, when the raw body was captured.
  // Streamed bodies (multipart, tar import) are not buffered; the covered-header
  // and presence checks above still bind the body to the signature.
  if (request.rawBody === undefined) {
    return
  }
  const { verified, error } = await verifyHeaderValue({
    data: request.rawBody,
    headerValue: zcap.digest
  })
  if (!verified) {
    throw new InvalidDigestError({
      detail: error
        ? 'The `Digest` header is malformed or uses an unsupported algorithm.'
        : 'The `Digest` header does not match the request body.',
      cause: error
    })
  }
}
