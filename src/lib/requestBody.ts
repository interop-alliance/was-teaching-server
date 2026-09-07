/**
 * Request-body shape guards shared by the request handlers: the "must be a JSON
 * object" check and the "no properties beyond an allowlist" check, both failing
 * with `InvalidRequestBodyError` (400). Handlers keep their own field-level
 * validation; these cover only the envelope shape every strict body shares.
 */
import type { Readable } from 'node:stream'
import type { FastifyRequest } from 'fastify'
import { InvalidRequestBodyError, PayloadTooLargeError } from '../errors.js'
import { isPlainObject } from './isPlainObject.js'

/**
 * Resolves a request body as UTF-8 text whatever parser it reached the
 * handler through: the buffered bytes the digest hook captured for a `text/*`
 * body, a string the built-in text parser produced, or the raw stream the
 * catch-all parser passes through for any other media type. For a route whose
 * body is text by definition (a JSON Lines log), not a representation stored
 * under its own media type.
 *
 * The body is buffered in memory, so it is bounded: the stream is rejected
 * with `PayloadTooLargeError` (413) as soon as it exceeds `maxBytes`, and an
 * already-buffered body is checked against the same cap. Fastify's own
 * `bodyLimit` covers only the parsers that buffer, not the raw pass-through
 * stream, so the cap is applied here.
 * @param options {object}
 * @param options.request {FastifyRequest}
 * @param options.maxBytes {number}   the cap in bytes
 * @param options.backendId {string}   the backend named in the 413 detail
 * @returns {Promise<string>}
 */
export async function readTextBody({
  request,
  maxBytes,
  backendId
}: {
  request: FastifyRequest
  maxBytes: number
  backendId: string
}): Promise<string> {
  const tooLarge = (uploadBytes?: number) =>
    new PayloadTooLargeError({
      maxUploadBytes: maxBytes,
      backendId,
      uploadBytes
    })
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(declared)
  }
  const buffered =
    request.rawBody ??
    (typeof request.body === 'string'
      ? Buffer.from(request.body, 'utf8')
      : Buffer.isBuffer(request.body)
        ? request.body
        : undefined)
  if (buffered !== undefined) {
    if (buffered.byteLength > maxBytes) {
      throw tooLarge(buffered.byteLength)
    }
    return buffered.toString('utf8')
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request.body as Readable) {
    received += (chunk as Buffer).byteLength
    if (received > maxBytes) {
      throw tooLarge()
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Asserts a parsed body is a plain JSON object (not null, not an array) and
 * narrows it.
 * @param options {object}
 * @param options.body {unknown}   the parsed request body
 * @param options.requestName {string}   request name used in the error title
 * @param options.detail {string}   problem detail for the failure
 * @returns {Record<string, unknown>}   the body, narrowed
 */
export function assertJsonObjectBody({
  body,
  requestName,
  detail
}: {
  body: unknown
  requestName: string
  detail: string
}): Record<string, unknown> {
  if (!isPlainObject(body)) {
    throw new InvalidRequestBodyError({ requestName, detail })
  }
  return body
}

/**
 * Asserts an object carries no keys outside `allowedKeys`. The failure names
 * the offending key as `Unexpected <label> "<key>".`, with a JSON pointer of
 * `<pointerPrefix>/<key>` when a prefix is given (omit it for query strings,
 * which have no body pointer).
 * @param options {object}
 * @param options.value {Record<string, unknown>}   the object to check
 * @param options.allowedKeys {string[]}   the permitted property names
 * @param options.requestName {string}   request name used in the error title
 * @param options.label {string}   what the object is, for the detail text
 *   (e.g. `operation property`, `query parameter`)
 * @param [options.pointerPrefix] {string}   JSON pointer to the object
 *   (`#` for the body root, `#/invocationTarget` for a nested object)
 * @returns {void}
 */
export function assertOnlyAllowedKeys({
  value,
  allowedKeys,
  requestName,
  label,
  pointerPrefix
}: {
  value: Record<string, unknown>
  allowedKeys: readonly string[]
  requestName: string
  label: string
  pointerPrefix?: string
}): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Unexpected ${label} "${key}".`,
        ...(pointerPrefix !== undefined && {
          // RFC 6901 reference-token escaping: `~` then `/`, in that order.
          pointer: `${pointerPrefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
        })
      })
    }
  }
}
