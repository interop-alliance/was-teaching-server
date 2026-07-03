/**
 * Request Body Integrity (spec "Request Body Integrity (Digest Header)"): binds
 * a request body to its HTTP Signature via the `Digest` header. Two hooks,
 * installed by every route group alongside the auth hooks:
 *
 * - `captureRawBody` (preParsing) tees the exact body bytes onto
 *   `request.rawBody` for JSON/text bodies, so the digest can be recomputed
 *   against what the client actually signed. Re-serializing the parsed body is
 *   not guaranteed byte-identical, so we keep the raw bytes instead. Streamed
 *   bodies (multipart uploads, tar imports, raw blobs) are not buffered; instead
 *   they pass through a hashing transform that verifies the `Digest`
 *   incrementally at end-of-stream, so large/binary uploads keep streaming yet
 *   are still bound to the signature.
 * - `verifyBodyDigest` (preValidation) enforces, for any request carrying a
 *   `Content-Type`: that the signature covers the `digest` header (MUST), that a
 *   `Digest` header is present, and -- when the raw body was captured --
 *   independently recomputes the body digest and compares it (SHOULD). A
 *   missing, malformed, uncovered, or non-matching digest is rejected with
 *   `invalid-authorization-header` (400).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { verifyHeaderValue } from '@interop/http-digest-header'
import { PassThrough, Transform, type Readable } from 'node:stream'
import { createHash } from 'node:crypto'
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
 * Compares an incrementally-computed SHA-256 digest against a `Digest` header
 * value, mirroring `@interop/http-digest-header`'s encodings without buffering
 * the body: the multihash form (`mh=u<base64url(0x12 0x20 <digest>)>`, what WAS
 * clients send) and the RFC 9651 `SHA-256=<base64>` form (colons stripped).
 * @param options {object}
 * @param options.sha256Digest {Buffer}   the computed 32-byte SHA-256 digest
 * @param options.headerValue {string}   the request's `Digest` header value
 * @returns {boolean}
 */
function digestMatches({
  sha256Digest,
  headerValue
}: {
  sha256Digest: Buffer
  headerValue: string
}): boolean {
  const [key = '', rawValue] = headerValue.split(/=(.+)/)
  if (key === 'mh') {
    const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), sha256Digest])
    return rawValue === `u${multihash.toString('base64url')}`
  }
  if (key.replace('-', '').toLowerCase() === 'sha256') {
    const expected = (rawValue ?? '').replace(/^:(.*):$/, '$1')
    return expected === sha256Digest.toString('base64')
  }
  // Only SHA-256 is supported (as in the library); anything else cannot match.
  return false
}

/**
 * A pass-through Transform that hashes the streamed bytes (SHA-256) and, at
 * end-of-stream, verifies the accumulated digest against the request's `Digest`
 * header -- erroring the stream (which fails the write) on a mismatch. This
 * binds a streamed/binary body to its signed `Digest` without buffering it. A
 * mismatch surfaces mid-write; consumers that persist the stream remove any
 * partial output on the resulting error (see the filesystem backend's blob
 * write).
 */
class DigestVerifyStream extends Transform {
  private readonly _hash = createHash('sha256')
  private readonly _digestHeader: string
  constructor(digestHeader: string) {
    super()
    this._digestHeader = digestHeader
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this._hash.update(chunk)
    callback(null, chunk)
  }
  override _flush(callback: (error?: Error | null) => void): void {
    const matched = digestMatches({
      sha256Digest: this._hash.digest(),
      headerValue: this._digestHeader
    })
    callback(
      matched
        ? null
        : new InvalidDigestError({
            detail: 'The `Digest` header does not match the request body.'
          })
    )
  }
}

/**
 * preParsing hook: for JSON/text bodies, tees the incoming payload into
 * `request.rawBody` while passing the same bytes through to Fastify's content-
 * type parser (so `verifyBodyDigest` can recompute the digest). Other (streamed)
 * bodies are not buffered; when the request is signed with a `Digest` they pass
 * through a `DigestVerifyStream` that verifies that digest incrementally, so a
 * swapped binary/large body under a valid signed `Digest` is still rejected.
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
    // Streamed (non-buffered) body. Bind it to the signature by hashing it as it
    // flows; an unsigned/anonymous body (no `Digest`) has nothing to verify.
    // `parseAuthHeaders` (onRequest) has already run, so `request.zcap` is set
    // for a signed request.
    const digestHeader = request.zcap?.digest
    if (!digestHeader) {
      return payload
    }
    const verify = new DigestVerifyStream(digestHeader)
    payload.on('error', err => verify.destroy(err))
    return payload.pipe(verify)
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

  // MUST: `digest` is among the signature's covered (signed) headers. Guard the
  // `headers` param itself: an `Authorization` header that omits `headers="..."`
  // leaves it undefined, and splitting that would be a 500 rather than the
  // intended `invalid-authorization-header` (400).
  if (!zcap.headers || !zcap.headers.split(/\s+/).includes('digest')) {
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
  // Streamed bodies (multipart, tar import, raw blobs) are not buffered here;
  // `captureRawBody` has already wrapped them in a `DigestVerifyStream` that
  // verifies the digest incrementally as the body is consumed.
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
