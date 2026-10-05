/**
 * The reads a pull loop makes of a peer. Every read of the peer's Space is a
 * `GET` that invokes the registration's pull capability, signed as this
 * server's own `did:webvh` (`lib/syncIdentity.ts`). The peer's service
 * description is read unsigned.
 *
 * A read resolves for the statuses its caller handles and rejects with
 * `PeerRequestError` for every other one, so a peer that is down, a grant
 * that expired, and a masked `not-found` all end the cycle the same way.
 */
import { Readable } from 'node:stream'
import type { ISigner } from '@interop/data-integrity-core'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'

import {
  REPLICATION_DOCUMENT_MAX_BYTES,
  REPLICATION_REQUEST_TIMEOUT_MS
} from '../config.default.js'
import { PeerRequestError } from '../errors.js'
import { readBodyBounded } from '../lib/outboundAddress.js'
import type { IDelegatedZcap } from '../types.js'
import type { PeerFetch, PeerResponse } from './peerFetch.js'

/**
 * A buffered answer from a peer: the status, the `ETag` and `Content-Type`
 * headers when sent, and the body bytes.
 */
export interface PeerDocument {
  status: number
  etag?: string
  contentType?: string
  body: Buffer
}

export class PeerClient {
  #signer?: ISigner
  #capability?: IDelegatedZcap
  #peerFetch: PeerFetch

  /**
   * @param options {object}
   * @param options.peerFetch {PeerFetch}   the transport
   * @param [options.signer] {ISigner}   this server's sync signer; a client
   *   without one makes unsigned reads only
   * @param [options.capability] {IDelegatedZcap}   the pull capability the
   *   signed reads invoke
   */
  constructor({
    peerFetch,
    signer,
    capability
  }: {
    peerFetch: PeerFetch
    signer?: ISigner
    capability?: IDelegatedZcap
  }) {
    this.#peerFetch = peerFetch
    this.#signer = signer
    this.#capability = capability
  }

  /**
   * Makes one `GET`, signed unless `signed` is `false`. Resolves the raw
   * response for a status in `expect`, which the caller must release. Any
   * other status rejects.
   * @param options {object}
   * @param options.url {string}
   * @param options.expect {number[]}   the statuses the caller handles
   * @param [options.signed] {boolean}   default `true`
   * @param [options.ifNoneMatch] {string}   a held `ETag`, for a conditional
   *   read
   * @param [options.signal] {AbortSignal}   aborts the request; defaults to
   *   the request timeout
   * @returns {Promise<PeerResponse>}
   */
  async request({
    url,
    expect,
    signed = true,
    ifNoneMatch,
    signal = AbortSignal.timeout(REPLICATION_REQUEST_TIMEOUT_MS)
  }: {
    url: string
    expect: number[]
    signed?: boolean
    ifNoneMatch?: string
    signal?: AbortSignal
  }): Promise<PeerResponse> {
    let headers: Record<string, string> = {
      ...(ifNoneMatch !== undefined && { 'if-none-match': ifNoneMatch })
    }
    if (signed) {
      if (this.#signer === undefined || this.#capability === undefined) {
        throw new PeerRequestError({
          url,
          detail: 'the client holds no signer or capability.'
        })
      }
      const signedHeaders = await signCapabilityInvocation({
        url,
        method: 'GET',
        headers: { date: new Date().toUTCString() },
        capability: this.#capability,
        capabilityAction: 'GET',
        invocationSigner: this.#signer
      })
      headers = { ...headers, ...(signedHeaders as Record<string, string>) }
    }
    const response = await this.#peerFetch({ url, headers, signal })
    if (!expect.includes(response.status)) {
      await response.body?.cancel().catch(() => {})
      response.release()
      throw new PeerRequestError({
        url,
        detail: `the peer answered ${response.status}.`,
        status: response.status
      })
    }
    return response
  }

  /**
   * Makes one `GET` and buffers the body, up to `maxBytes`. A larger body
   * rejects with a `PeerRequestError` marked `bodyTooLarge`.
   * @param options {object}   as {@link PeerClient.request}
   * @param [options.maxBytes] {number}   defaults to
   *   `REPLICATION_DOCUMENT_MAX_BYTES`
   * @returns {Promise<PeerDocument>}
   */
  async read({
    maxBytes = REPLICATION_DOCUMENT_MAX_BYTES,
    ...options
  }: Parameters<PeerClient['request']>[0] & {
    maxBytes?: number
  }): Promise<PeerDocument> {
    const response = await this.request(options)
    try {
      const body = await readBodyBounded({ body: response.body, maxBytes })
      if (body === undefined) {
        throw new PeerRequestError({
          url: options.url,
          detail: `the body is larger than ${maxBytes} bytes.`,
          bodyTooLarge: true
        })
      }
      return {
        status: response.status,
        ...headerMembers(response),
        body
      }
    } catch (err) {
      if (err instanceof PeerRequestError) {
        throw err
      }
      throw new PeerRequestError({
        url: options.url,
        detail: 'the body could not be read.',
        cause: err
      })
    } finally {
      response.release()
    }
  }

  /**
   * Makes one `GET` and parses the body as a JSON object.
   * @param options {object}   as {@link PeerClient.read}
   * @returns {Promise<PeerDocument & { json: Record<string, unknown> }>}
   *   `json` is `{}` for a status that carries no body (a 304)
   */
  async readJson(
    options: Parameters<PeerClient['read']>[0]
  ): Promise<PeerDocument & { json: Record<string, unknown> }> {
    const document = await this.read(options)
    if (document.body.length === 0) {
      return { ...document, json: {} }
    }
    let json: unknown
    try {
      json = JSON.parse(document.body.toString('utf8'))
    } catch (err) {
      throw new PeerRequestError({
        url: options.url,
        detail: 'the body is not JSON.',
        cause: err
      })
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new PeerRequestError({
        url: options.url,
        detail: 'the body is not a JSON object.'
      })
    }
    return { ...document, json: json as Record<string, unknown> }
  }

  /**
   * Makes one `GET` of a Resource representation and hands its body over as
   * a stream, for a backend to store under its own upload cap. The caller
   * calls `release` once the stream has been consumed or abandoned.
   *
   * The timeout bounds the wait for the response, and then each wait for the
   * peer's next chunk. It does not bound the whole transfer, so a large body
   * on a slow link is read to its end, and time the consumer spends between
   * two reads does not count.
   * @param options {object}
   * @param options.url {string}
   * @param [options.idleTimeoutMs] {number}   defaults to the request timeout
   * @returns {Promise<{ etag?: string, contentType?: string, declaredBytes?: number, stream: Readable, release: () => void }>}
   */
  async readStream({
    url,
    idleTimeoutMs = REPLICATION_REQUEST_TIMEOUT_MS
  }: {
    url: string
    idleTimeoutMs?: number
  }): Promise<{
    etag?: string
    contentType?: string
    declaredBytes?: number
    stream: Readable
    release: () => void
  }> {
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        controller.abort(
          new PeerRequestError({
            url,
            detail: `the peer sent nothing for ${idleTimeoutMs} ms.`
          })
        )
      }, idleTimeoutMs)
      timer.unref()
    }
    arm()
    let response: PeerResponse
    try {
      response = await this.request({
        url,
        expect: [200],
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
    const { body } = response
    // Rejects a pending read on the idle timeout, whether or not the
    // transport honors the signal.
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason),
        { once: true }
      )
    })
    aborted.catch(() => {})
    /**
     * Yields the body chunk by chunk, with the idle timer armed only while a
     * read of the peer is pending.
     */
    async function* chunks(): AsyncGenerator<Uint8Array> {
      if (body === null) {
        return
      }
      const reader = body.getReader()
      try {
        for (;;) {
          arm()
          const { done, value } = await Promise.race([reader.read(), aborted])
          clearTimeout(timer)
          if (done) {
            return
          }
          yield value
        }
      } finally {
        clearTimeout(timer)
        await reader.cancel().catch(() => {
          // best-effort -- the stream may already be closed or errored
        })
      }
    }
    const declared = Number(response.headers.get('content-length'))
    return {
      ...headerMembers(response),
      ...(Number.isSafeInteger(declared) &&
        response.headers.get('content-length') !== null && {
          declaredBytes: declared
        }),
      stream: Readable.from(chunks(), { objectMode: false }),
      release: () => {
        clearTimeout(timer)
        response.release()
      }
    }
  }
}

/**
 * The `ETag` and `Content-Type` of a response, each left out when not sent.
 * @param response {PeerResponse}
 * @returns {{ etag?: string, contentType?: string }}
 */
function headerMembers(response: PeerResponse): {
  etag?: string
  contentType?: string
} {
  const etag = response.headers.get('etag')
  const contentType = response.headers.get('content-type')
  return {
    ...(etag !== null && { etag }),
    ...(contentType !== null && { contentType })
  }
}
