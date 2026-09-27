/**
 * The sandbox policy for hosted pages: the `Content-Security-Policy` header
 * every response on a WAS or `/kms` route carries, except a PDF. A Resource of
 * type `text/html` opened in a browser is a page hosted on this server's
 * origin, and a deployment may serve that origin as a wallet's own. The sandbox gives each such page an opaque origin, so its scripts
 * cannot read the origin's storage, cookies, or key material.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

import { bareMediaType } from './mediaType.js'

/**
 * The `Content-Security-Policy` value sent on every response but a PDF. A
 * hosted page keeps scripts, forms, dialogs, downloads and popups, and runs
 * with an opaque origin. A popup it opens inherits the sandbox, since the value
 * leaves out `allow-popups-to-escape-sandbox`: an escaped popup could load any
 * unsandboxed page on the origin, and would hold a `window.opener` handle back
 * to the hosted page. The value also leaves out `allow-same-origin` on purpose:
 * combined with `allow-scripts`, that token would let a page lift its own
 * sandbox. The header is always on, since the server cannot tell whether it is
 * deployed behind a wallet on the same origin.
 */
export const HOSTED_PAGE_SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-top-navigation-by-user-activation'

/**
 * The media type a response is sent without the sandbox policy. A browser
 * renders a PDF in its own viewer, whose scripts cannot reach the serving
 * origin's storage, and Chromium refuses to render a PDF in a sandboxed
 * document at all. Every other type keeps the policy, since HTML, SVG, XML and
 * a sniffed generic type can all run script on the origin.
 */
const UNSANDBOXED_MEDIA_TYPE = 'application/pdf'

/**
 * The `onSend` hook that stamps the hosted-page sandbox policy on a response,
 * unless the response is a PDF. Every route group installs it, so a route that
 * serves stored bytes cannot be added without it. A sandbox has no effect on a
 * response read with `fetch()`, so JSON responses carry it harmlessly. It runs
 * for every status -- 200, 304, a redirect, and the masked 404 alike -- so a
 * cached or refused response carries the same policy as a served one. It sets
 * no `X-Content-Type-Options`, so a Resource stored with no type or a generic
 * one is still sniffed, and a sniffed page runs sandboxed too.
 * @param _request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @param payload {unknown}
 * @returns {Promise<unknown>}
 */
export async function sandboxHostedPage(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<unknown> {
  const contentType = reply.getHeader('content-type')
  const mediaType = bareMediaType({
    contentType: typeof contentType === 'string' ? contentType : undefined
  })
  if (mediaType !== UNSANDBOXED_MEDIA_TYPE) {
    reply.header('content-security-policy', HOSTED_PAGE_SANDBOX_CSP)
  }
  return payload
}
