/**
 * The transport a pull loop reaches a peer through. `fromSpace` is a URL the
 * Space's controller supplies, so every request to it is bound the way the
 * peer log fetch is (`lib/peerWebvh.ts`): `https` only, the default port, no
 * credentials, no redirect followed, and a connection only to the public
 * addresses checked after DNS.
 *
 * `PeerFetch` is the seam. The plugin's `peerFetch` option replaces the
 * default in tests, since the bounds keep a real request out of the suite.
 * No environment variable reaches it.
 */
import { fetch } from 'undici'

import { PeerLogFetchError, PeerRequestError } from '../errors.js'
import { openPinnedAgent } from '../lib/peerWebvh.js'

/**
 * A peer's answer to one request: the status, the response headers, and the
 * body as a web stream. `release` frees the connection, and is called once
 * the body has been read or abandoned.
 */
export interface PeerResponse {
  status: number
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
  release(): void
}

/**
 * Makes one `GET` to a peer. Rejects with `PeerRequestError` when the URL is
 * refused or the request fails. A response of any status resolves.
 */
export type PeerFetch = (options: {
  url: string
  headers: Record<string, string>
  signal: AbortSignal
}) => Promise<PeerResponse>

/**
 * The default {@link PeerFetch}. Checks the URL, resolves its host and checks
 * every address, then makes the request through an agent that connects only
 * to those addresses, so a DNS answer that changes after the check is never
 * used. A redirect is answered as the status it is, not followed.
 * @param options {object}
 * @param options.url {string}
 * @param options.headers {Record<string, string>}
 * @param options.signal {AbortSignal}
 * @returns {Promise<PeerResponse>}
 */
export async function fetchFromPeer({
  url,
  headers,
  signal
}: {
  url: string
  headers: Record<string, string>
  signal: AbortSignal
}): Promise<PeerResponse> {
  let pinned: Awaited<ReturnType<typeof openPinnedAgent>>
  try {
    pinned = await openPinnedAgent({ url })
  } catch (err) {
    throw new PeerRequestError({
      url,
      detail:
        err instanceof PeerLogFetchError
          ? err.message
          : 'the host does not resolve.',
      cause: err
    })
  }
  const { href, agent, release } = pinned
  try {
    const response = await fetch(href, {
      redirect: 'manual',
      signal,
      dispatcher: agent,
      headers: { ...headers, 'accept-encoding': 'identity' }
    })
    return {
      status: response.status,
      headers: response.headers,
      body: response.body as ReadableStream<Uint8Array> | null,
      release
    }
  } catch (err) {
    release()
    throw new PeerRequestError({
      url,
      detail: 'the request failed.',
      cause: err
    })
  }
}
