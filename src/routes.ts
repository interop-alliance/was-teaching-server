/**
 * Route layer: maps URL patterns to *Request handler methods. Each group first
 * installs the `requireAuthHeadersOrPublicRead` then `parseAuthHeaders`
 * onRequest hooks, and redirects the non-canonical slash variant of a path to
 * the canonical form with a 308 (spec "Reading This Document"). A container
 * -- the `/spaces/` repository, a Space, a Collection, a Resource's `chunks/`
 * -- is canonically addressed WITH the trailing slash: `GET` lists its
 * members, `POST` adds one, `DELETE` removes the container, and `PUT` is not
 * defined there (405). What a container *is* lives at its `meta`
 * sub-resource: `GET`/`PUT /space/:spaceId/meta` is the Space Metadata object
 * and `GET`/`PUT /space/:spaceId/:collectionId/meta` the Collection Metadata
 * object, and every other sub-resource path (`policy`, `linkset`, `meta`,
 * a Resource) carries no trailing slash. No two registered paths differ only
 * by a trailing slash. (The WebKMS `/kms` group is the exception on both
 * counts: it installs the strict `requireAuthHeaders` -- the webkms protocol
 * has no public reads -- and no slash redirects, since the protocol's URLs
 * are exact.)
 */
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
  HTTPMethods
} from 'fastify'
import { SpacesRepositoryRequest } from './requests/SpacesRepositoryRequest.js'
import { SpaceRequest } from './requests/SpaceRequest.js'
import { handleError, MethodNotAllowedError } from './errors.js'
import { ResourceRequest } from './requests/ResourceRequest.js'
import { ChunkRequest } from './requests/ChunkRequest.js'
import { CollectionRequest } from './requests/CollectionRequest.js'
import { PolicyRequest, type PolicyParams } from './requests/PolicyRequest.js'
import { BackendRequest } from './requests/BackendRequest.js'
import { KeystoreRequest } from './requests/KeystoreRequest.js'
import { KeyRequest } from './requests/KeyRequest.js'
import { RevocationRequest } from './requests/RevocationRequest.js'
import {
  parseAuthHeaders,
  requireAuthHeaders,
  requireAuthHeadersOrPublicRead
} from './auth-header-hooks.js'
import { captureRawBody, verifyBodyDigest } from './digest.js'
import {
  provisioningGateFor,
  unlessProvisioningAuthorized
} from './provisioning.js'

/**
 * Installs the `handleError` error handler and the hook chain every route group
 * shares, in the one order they all rely on: the optional provisioning gate,
 * the auth-header requirement, `parseAuthHeaders`, `captureRawBody`,
 * `verifyBodyDigest`, then the POST `Cache-Control: no-store` marking.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}
 * @param [options.provisioningRoutes] {string[]}   route URLs (exactly as
 *   registered in this group) whose POSTs go through the provisioning gate;
 *   omit for groups with no provisioning endpoint
 * @param [options.strictAuth] {boolean}   require auth headers on every method
 *   (`requireAuthHeaders`) rather than letting safe reads through
 *   (`requireAuthHeadersOrPublicRead`, the default)
 * @returns {void}
 */
function installGroupHooks(
  app: FastifyInstance,
  {
    provisioningRoutes,
    strictAuth = false
  }: { provisioningRoutes?: string[]; strictAuth?: boolean } = {}
): void {
  app.setErrorHandler(handleError)

  if (provisioningRoutes) {
    // Gate provisioning (Create Space / Create Keystore): the configured policy
    // may grant/deny, or (the default) allow -- in which case the normal zcap
    // path below runs.
    app.addHook('onRequest', provisioningGateFor(provisioningRoutes))
  }
  // The auth and digest hooks are skipped for a request the gate granted (it
  // carries a Bearer token, not an HTTP Signature).
  if (strictAuth) {
    // Every operation is privileged: 401 when auth headers are absent.
    app.addHook('onRequest', unlessProvisioningAuthorized(requireAuthHeaders))
  } else {
    // Writes require auth; reads (GET/HEAD) may proceed unauthenticated so the
    // handler can fall back to an access-control policy (e.g. a public Space,
    // Collection or Resource). In the SpacesRepository group that fallback is
    // the spec's empty-items 200 for an anonymous List Spaces, never an error
    // (the exception to 404 masking).
    app.addHook(
      'onRequest',
      unlessProvisioningAuthorized(requireAuthHeadersOrPublicRead)
    )
  }
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', unlessProvisioningAuthorized(parseAuthHeaders))
  // Capture raw body bytes (JSON/text) so the digest can be recomputed against
  // exactly what the client signed (spec "Request Body Integrity").
  app.addHook('preParsing', captureRawBody)
  // Enforce the Digest header binding: require it covered by the signature and,
  // when the raw body is available, recompute and compare it.
  app.addHook('preValidation', unlessProvisioningAuthorized(verifyBodyDigest))
  // Mark the response to a non-idempotent operation non-cacheable (spec
  // "Caching"). Only POST is non-idempotent here; reads carry an `ETag` for
  // validation instead, and the spec defers further `Cache-Control` semantics.
  app.addHook('onSend', markPostNoStore)
}

/**
 * The `onSend` hook that stamps `Cache-Control: no-store` on the response to
 * a non-idempotent POST, whatever its status (spec "Caching"). Two kinds of
 * POST are left alone: a slash-variant redirect, which is a cacheable 308 that
 * performs nothing, and a route registered with `config.safe` -- a read that
 * uses POST only to carry a body (Query, Export).
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @param payload {unknown}
 * @returns {Promise<unknown>}
 */
async function markPostNoStore(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<unknown> {
  if (
    request.method === 'POST' &&
    !request.routeOptions.config.safe &&
    (reply.statusCode < 300 || reply.statusCode >= 400)
  ) {
    reply.header('cache-control', 'no-store')
  }
  return payload
}

/**
 * Route config marking a POST route as a read (safe in the RFC 9110 sense):
 * it uses POST only to carry a request body, so `markPostNoStore` leaves its
 * response cacheable.
 */
const safeRoute = { config: { safe: true } }

/**
 * Splits a request URL into its path and its query string (`?` included, or
 * empty), so a redirect can rewrite the path and carry the query over.
 * @param url {string}   the request URL (path plus optional query string)
 * @returns {{ pathPart: string, query: string }}
 */
function splitQuery(url: string): { pathPart: string; query: string } {
  const queryIndex = url.indexOf('?')
  return queryIndex === -1
    ? { pathPart: url, query: '' }
    : { pathPart: url.slice(0, queryIndex), query: url.slice(queryIndex) }
}

/**
 * Toggles the trailing slash on the request's actual path (preserving any query
 * string), returning the canonical target for a slash/no-slash redirect. Built
 * from `request.url` rather than the route template so the `Location` carries
 * the concrete ids (`/space/abc123`), not the literal `/space/:spaceId` -- which
 * a client cannot follow.
 * @param url {string}   the request URL (path plus optional query string)
 * @param addSlash {boolean}   append (true) or strip (false) the trailing slash
 * @returns {string}
 */
function toggleTrailingSlash(url: string, addSlash: boolean): string {
  const { pathPart, query } = splitQuery(url)
  const canonical = addSlash
    ? pathPart.endsWith('/')
      ? pathPart
      : `${pathPart}/`
    : pathPart.endsWith('/')
      ? pathPart.slice(0, -1)
      : pathPart
  return `${canonical}${query}`
}

/**
 * Redirects to the trailing-slash canonical form of the request URL with a
 * `308` (Permanent Redirect), which -- unlike the default `302` -- requires the
 * client to replay the same method and body, so a redirected POST/PUT is not
 * silently downgraded to GET.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {FastifyReply}
 */
function redirectAddSlash(
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  return reply.redirect(toggleTrailingSlash(request.url, true), 308)
}

/**
 * Redirects to the no-trailing-slash canonical form of the request URL (see
 * {@link redirectAddSlash} for the `308` rationale).
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {FastifyReply}
 */
function redirectStripSlash(
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  return reply.redirect(toggleTrailingSlash(request.url, false), 308)
}

/**
 * Redirects the retired `/space/:spaceId/collections` endpoint (either slash
 * form) to the Space container URL, which lists and creates Collections since
 * v0.5, with a `308` so a POST is replayed as a POST (spec "Reserved Path
 * Segment Registry": a server MAY answer the retired path with a 308 to the
 * Space URL). Rewrites the path rather than toggling its slash, preserving
 * any query string. The rewrite strips the trailing `collections` segment off
 * the request path as sent, rather than rebuilding the path from
 * `request.params.spaceId` -- the router has already percent-decoded that
 * param, so rebuilding from it would emit a `Location` naming a different
 * resource (`/space/a%2Fb/collections` would redirect to `/space/a/b/`) or
 * inject a query into the path (`a%3Fx=1`). Toggling the request path
 * verbatim, as the slash redirects do, keeps the id byte-identical to what
 * the client sent.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {FastifyReply}
 */
function redirectCollectionsToSpace(
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  const { pathPart, query } = splitQuery(request.url)
  // Both registered forms end in `collections` or `collections/`; dropping
  // that leaves the Space container URL, trailing slash included.
  const spaceUrl = pathPart.replace(/collections\/?$/, '')
  return reply.redirect(`${spaceUrl}${query}`, 308)
}

/**
 * Answers a method that is not defined at a URL with `405 Method Not Allowed`.
 * Two kinds of URL use it. A container URL refuses `PUT` (spec: a server MUST
 * answer a `PUT` at the Space URL with 405; the same for a Collection), since a
 * container is described at its `meta` sub-resource. And a reserved endpoint
 * refuses every method it does not implement (spec "Methods at Reserved
 * Endpoints"; see `refuseUnimplementedMethods`). Registered explicitly rather
 * than left to fall through, so the `Allow` header can name what the URL does
 * accept -- and so a request to a reserved endpoint does not reach the
 * parametric route one level up, whose reserved-id guard would answer the
 * unrelated `409 reserved-id`.
 * @param allow {string[]}   the methods implemented at the URL
 * @param targetName {string}   what the URL addresses, named in the detail
 * @param [hint] {string}   one sentence naming where the refused operation
 *   lives instead
 * @returns {(request: FastifyRequest) => never}
 */
function methodNotAllowed(
  allow: string[],
  targetName: string,
  hint?: string
): (request: FastifyRequest) => never {
  return () => {
    throw new MethodNotAllowedError({
      allow,
      targetName,
      ...(hint !== undefined && { hint })
    })
  }
}

/**
 * The methods a WAS container URL (a Space or a Collection) accepts: list its
 * members, add one, delete the container.
 */
const CONTAINER_METHODS: HTTPMethods[] = ['GET', 'HEAD', 'POST', 'DELETE']

/**
 * The order an `Allow` header lists methods in, so the header reads the same
 * however the routes happen to be registered.
 */
const ALLOW_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'QUERY']

/** The sentence a container-URL `PUT` refusal carries. */
const CONTAINER_PUT_HINT =
  'A container is described at its "meta" sub-resource.'

/** The sentence a Metadata-URL `DELETE` refusal carries. */
const CONTAINER_META_DELETE_HINT =
  'A Metadata object is removed by deleting the container it describes.'

/**
 * Registers a `405 Method Not Allowed` route for every method a reserved
 * endpoint does not implement (spec "Methods at Reserved Endpoints"), with an
 * `Allow` header naming the methods it does. Without these, a method the
 * endpoint lacks falls through to the parametric route one level up -- a
 * Collection or Resource operation on the reserved segment as an id -- and is
 * refused as a `409 reserved-id`, which answers a question the request never
 * asked. The refusal is registered before any storage access and does not
 * look at the path's ids, so it answers the same whether or not the Space,
 * Collection, or Resource exists.
 *
 * The implemented set is read from the router itself (`hasRoute`), so the
 * `Allow` header cannot drift from the routes. That makes the call order
 * matter: call it at the end of the route group that owns the endpoints, after
 * their real routes and before any refusal is added. Every method Fastify
 * routes is considered except `OPTIONS`, which the CORS plugin's preflight
 * route answers. `HEAD` is never registered here: Fastify exposes it beside
 * every `GET`, so it is implemented wherever `GET` is and refused wherever a
 * `GET` refusal is registered.
 * @param app {import('fastify').FastifyInstance}   the owning route group
 * @param endpoints {object[]}   the reserved endpoints, each a route `url`
 *   template, the `targetName` its refusal names, and optional per-method
 *   `hints`
 * @returns {void}
 */
function refuseUnimplementedMethods(
  app: FastifyInstance,
  endpoints: {
    url: string
    targetName: string
    hints?: Partial<Record<string, string>>
  }[]
): void {
  const candidates = app.supportedMethods.filter(method => method !== 'OPTIONS')
  for (const { url, targetName, hints = {} } of endpoints) {
    const allow = candidates
      .filter(method => app.hasRoute({ url, method: method as HTTPMethods }))
      .sort((a, b) => ALLOW_ORDER.indexOf(a) - ALLOW_ORDER.indexOf(b))
    for (const method of candidates) {
      if (method === 'HEAD' || allow.includes(method)) {
        continue
      }
      app.route({
        method: method as HTTPMethods,
        url,
        handler: methodNotAllowed(allow, targetName, hints[method])
      })
    }
  }
}

/**
 * The methods the bare (no-slash) form of a container URL redirects for: the
 * container's own plus `PUT`, so a `PUT` at the bare form reaches the 405
 * rather than a 404. OPTIONS is left to the CORS plugin's preflight route.
 */
const CONTAINER_REDIRECT_METHODS: HTTPMethods[] = [...CONTAINER_METHODS, 'PUT']

/**
 * Registers SpacesRepository routes (POST/GET /spaces). Installs the
 * `requireAuthHeadersOrPublicRead` then `parseAuthHeaders` onRequest hooks and
 * the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initSpacesRepositoryRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  // `/spaces` (no trailing slash) is gated too, so a token-authorized request
  // reaches the canonical-slash 308 redirect below instead of failing the
  // auth-header check first.
  installGroupHooks(app, { provisioningRoutes: ['/spaces', '/spaces/'] })

  // Add a Space to a SpacesRepository (Create Space)
  app.post('/spaces', redirectAddSlash)
  app.post('/spaces/', SpacesRepositoryRequest.post)

  // List Spaces
  app.get('/spaces', redirectAddSlash)
  app.get('/spaces/', SpacesRepositoryRequest.get)
}

/**
 * Registers Space routes: the Space container (list/add Collections, delete
 * the Space), its Metadata object at `meta`, the retired `collections`
 * redirect, and the policy / linkset / backends / quotas / revocation /
 * export / import sub-resources. Installs the auth hooks and the
 * `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initSpaceRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  installGroupHooks(app)

  // The Space container: canonically `/space/:spaceId/`; the bare form
  // redirects there for every WAS method (a 308 replays the method and body).
  // Listed explicitly rather than `app.all`, which would also claim OPTIONS
  // and shadow the CORS plugin's preflight route with a redirect a browser
  // will not follow.
  app.route({
    method: CONTAINER_REDIRECT_METHODS,
    url: '/space/:spaceId',
    handler: redirectAddSlash
  })
  // List Collections (a `GET` of the container lists its members)
  app.get('/space/:spaceId/', SpaceRequest.listCollections)
  // Add Collection to a Space
  app.post('/space/:spaceId/', SpaceRequest.post)
  // Delete Space
  app.delete('/space/:spaceId/', SpaceRequest.delete)
  // `PUT` is not defined at the container: the Space is written at `meta`.
  app.put(
    '/space/:spaceId/',
    methodNotAllowed(CONTAINER_METHODS, 'Space', CONTAINER_PUT_HINT)
  )

  // The Space Metadata object (reserved `meta` segment; static-beats-parametric
  // routing keeps it ahead of the `:collectionId` parameter in the Collection
  // routes, and `meta` is a reserved Collection id -- see `lib/validateId.ts`).
  // Read Space, and Update (or Create by Id) Space.
  app.get('/space/:spaceId/meta', SpaceRequest.getMeta)
  app.put('/space/:spaceId/meta', SpaceRequest.putMeta)

  // The retired `collections` endpoint (reserved segment): listing and
  // creating Collections moved to the Space URL in v0.5, so both slash forms
  // redirect there for the two methods it served.
  app.get('/space/:spaceId/collections', redirectCollectionsToSpace)
  app.get('/space/:spaceId/collections/', redirectCollectionsToSpace)
  app.post('/space/:spaceId/collections', redirectCollectionsToSpace)
  app.post('/space/:spaceId/collections/', redirectCollectionsToSpace)

  // Space access-control policy (reserved segment; Fastify routes static
  // segments ahead of the `:collectionId` parameter, so this never collides).
  // A policy is not public data, so its GET is privileged even though the
  // group's hook lets safe methods through: the route-level `requireAuthHeaders`
  // (run after the group chain) demands the auth headers (401). The same
  // applies to the Collection- and Resource-level policy GETs below.
  app.get<{ Params: PolicyParams }>(
    '/space/:spaceId/policy',
    { onRequest: requireAuthHeaders },
    PolicyRequest.get
  )
  app.put('/space/:spaceId/policy', PolicyRequest.put)
  app.delete('/space/:spaceId/policy', PolicyRequest.delete)

  // Space linkset (RFC9264 policy discovery)
  app.get('/space/:spaceId/linkset', SpaceRequest.linkset)

  // Space Backends Available (reserved segment; static-beats-parametric routing
  // keeps this ahead of the `:collectionId` parameter in the Collection routes).
  app.get('/space/:spaceId/backends', SpaceRequest.listBackends)

  // Register / replace / deregister an `external` backend record. Static
  // `backends` beats the parametric `:collectionId` / `:resourceId` of the
  // Collection/Resource route groups, so these resolve correctly (the same
  // mechanism that keeps the GET above and the singular `/backend` working).
  app.post('/space/:spaceId/backends', BackendRequest.post)
  app.put('/space/:spaceId/backends/:backendId', BackendRequest.put)
  app.delete('/space/:spaceId/backends/:backendId', BackendRequest.delete)

  // Space Quota report (reserved segment; static-beats-parametric routing keeps
  // this ahead of the `:collectionId` parameter). The per-Collection breakdown
  // (spec's `?include=collections`) is opt-in via that query string -- see the
  // handler note on the ZCap query-string limitation.
  app.get('/space/:spaceId/quotas', SpaceRequest.quotas)

  // Revoke a zcap delegated from this Space (`:revocationId` = the URL-encoded
  // id of the capability being revoked, which is also the request body). Four
  // segments deep, so it shadows no Collection or Resource route.
  app.post(
    '/space/:spaceId/zcaps/revocations/:revocationId',
    RevocationRequest.postSpace
  )

  // POST /space/12345/export
  app.post('/space/:spaceId/export', safeRoute, SpaceRequest.export)

  // POST /space/12345/import
  app.addContentTypeParser('application/x-tar', (_req, body, done) => {
    done(null, body)
  })
  app.post('/space/:spaceId/import', SpaceRequest.import)

  // Every Space-level reserved endpoint refuses the methods it does not
  // implement with a 405, rather than letting them fall through to a
  // Collection operation on the reserved segment. Last in the group, so the
  // implemented set above is complete when it is read.
  refuseUnimplementedMethods(app, [
    {
      url: '/space/:spaceId/meta',
      targetName: 'Space Metadata',
      hints: { DELETE: CONTAINER_META_DELETE_HINT }
    },
    { url: '/space/:spaceId/policy', targetName: 'Space policy' },
    { url: '/space/:spaceId/backends', targetName: 'Space backends' },
    { url: '/space/:spaceId/collections', targetName: 'retired collections' },
    { url: '/space/:spaceId/collections/', targetName: 'retired collections' },
    { url: '/space/:spaceId/export', targetName: 'Space export' },
    { url: '/space/:spaceId/import', targetName: 'Space import' },
    { url: '/space/:spaceId/linkset', targetName: 'Space linkset' },
    { url: '/space/:spaceId/query', targetName: 'Space query' },
    { url: '/space/:spaceId/quotas', targetName: 'Space quotas' }
  ])
}

/**
 * Registers Collection routes: the Collection container (list/add Resources,
 * delete the Collection), its Metadata object at `meta` with the governing
 * history log beneath it, and the policy / linkset / backend / quota / query
 * sub-resources. Installs the auth hooks and the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initCollectionRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  installGroupHooks(app)

  // The Collection container: canonically `/space/:spaceId/:collectionId/`;
  // the bare form redirects there for every WAS method (see the Space
  // container's note on OPTIONS).
  app.route({
    method: CONTAINER_REDIRECT_METHODS,
    url: '/space/:spaceId/:collectionId',
    handler: redirectAddSlash
  })
  // List Collection items (a `GET` of the container lists its members)
  app.get('/space/:spaceId/:collectionId/', CollectionRequest.list)
  // Add Resource to a Collection
  app.post('/space/:spaceId/:collectionId/', CollectionRequest.post)
  // Delete Collection
  app.delete('/space/:spaceId/:collectionId/', CollectionRequest.delete)
  // `PUT` is not defined at the container: the Collection is written at `meta`.
  app.put(
    '/space/:spaceId/:collectionId/',
    methodNotAllowed(CONTAINER_METHODS, 'Collection', CONTAINER_PUT_HINT)
  )

  // Collection access-control policy (reserved segment; static-beats-parametric
  // routing keeps this ahead of the `:resourceId` parameter).
  app.get<{ Params: PolicyParams }>(
    '/space/:spaceId/:collectionId/policy',
    { onRequest: requireAuthHeaders },
    PolicyRequest.get
  )
  app.put('/space/:spaceId/:collectionId/policy', PolicyRequest.put)
  app.delete('/space/:spaceId/:collectionId/policy', PolicyRequest.delete)

  // Collection linkset (RFC9264 policy discovery)
  app.get('/space/:spaceId/:collectionId/linkset', CollectionRequest.linkset)

  // The Collection Metadata object (reserved `meta` segment): the merged
  // description-plus-annotations object. Like the Space-level `meta`, this one
  // sits at the next level's id position (`:resourceId`), so `meta` is a
  // reserved Resource id; static-beats-parametric routing keeps it ahead of
  // the `:resourceId` parameter in Resource routes.
  // Read Collection Metadata, and Update (or Create by Id) Collection: a full
  // replacement that creates the Collection when absent.
  app.get('/space/:spaceId/:collectionId/meta', CollectionRequest.getMeta)
  app.put('/space/:spaceId/:collectionId/meta', CollectionRequest.putMeta)
  // The Collection's governing history log (the `governed-history-logs`
  // feature), a sub-resource beside `/meta`: not a Resource of the Collection,
  // so it needs no reserved id, but it sits at the Resource `/meta` depth and
  // must be registered here, ahead of the `:resourceId/meta` Resource route.
  app.get('/space/:spaceId/:collectionId/meta/log', CollectionRequest.getLog)
  app.put('/space/:spaceId/:collectionId/meta/log', CollectionRequest.putLog)

  // Collection Backend Selected (reserved segment; static-beats-parametric
  // routing keeps this ahead of the `:resourceId` parameter in Resource routes).
  app.get('/space/:spaceId/:collectionId/backend', CollectionRequest.getBackend)

  // Per-Collection Quota report (reserved segment; static-beats-parametric
  // routing keeps this ahead of the `:resourceId` parameter in Resource routes).
  app.get('/space/:spaceId/:collectionId/quota', CollectionRequest.getQuota)

  // Collection query (reserved segment; spec "Collection-level reserved
  // endpoints"). The WAS server serves the replication change feed as the
  // `changes` profile; params ride the signed
  // POST body. Static-beats-parametric routing keeps this ahead of the
  // `:resourceId` parameter in Resource routes.
  app.post(
    '/space/:spaceId/:collectionId/query',
    safeRoute,
    CollectionRequest.query
  )

  // Every Collection-level reserved endpoint refuses the methods it does not
  // implement with a 405 (see the Space group's note).
  refuseUnimplementedMethods(app, [
    {
      url: '/space/:spaceId/:collectionId/policy',
      targetName: 'Collection policy'
    },
    {
      url: '/space/:spaceId/:collectionId/linkset',
      targetName: 'Collection linkset'
    },
    {
      url: '/space/:spaceId/:collectionId/meta',
      targetName: 'Collection Metadata',
      hints: { DELETE: CONTAINER_META_DELETE_HINT }
    },
    {
      url: '/space/:spaceId/:collectionId/meta/log',
      targetName: 'Collection history log'
    },
    {
      url: '/space/:spaceId/:collectionId/backend',
      targetName: 'Collection backend'
    },
    {
      url: '/space/:spaceId/:collectionId/quota',
      targetName: 'Collection quota'
    },
    {
      url: '/space/:spaceId/:collectionId/query',
      targetName: 'Collection query'
    }
  ])
}

/**
 * Registers Resource routes (create-by-id, get, delete a Resource). Installs the
 * auth hooks and the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initResourceRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  installGroupHooks(app)

  // Create a Resource by Id
  app.put(
    '/space/:spaceId/:collectionId/:resourceId/', // no trailing slash allowed
    redirectStripSlash
  )
  app.put('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.put)

  // Head Resource. Declared before the GET route so it overrides Fastify's
  // auto-exposed HEAD (which would share the GET handler and stream the body
  // without a Content-Length); this handler reads only the Metadata and sets
  // Content-Type/Content-Length from it (spec "Content Types and Representations").
  app.head('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.head)

  // Get Resource
  app.get('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.get)

  // Delete Resource
  app.delete(
    '/space/:spaceId/:collectionId/:resourceId',
    ResourceRequest.delete
  )

  // Resource access-control policy (reserved segment)
  app.get<{ Params: PolicyParams }>(
    '/space/:spaceId/:collectionId/:resourceId/policy',
    { onRequest: requireAuthHeaders },
    PolicyRequest.get
  )
  app.put('/space/:spaceId/:collectionId/:resourceId/policy', PolicyRequest.put)
  app.delete(
    '/space/:spaceId/:collectionId/:resourceId/policy',
    PolicyRequest.delete
  )

  // Resource metadata (reserved segment; spec "Resource Metadata Data Model")
  app.get(
    '/space/:spaceId/:collectionId/:resourceId/meta',
    ResourceRequest.getMeta
  )
  // Update Resource Metadata (full replacement of the user-writable `custom`).
  app.put(
    '/space/:spaceId/:collectionId/:resourceId/meta',
    ResourceRequest.putMeta
  )

  // Chunked Resource chunks (the `chunked-streams` feature). The member form
  // (`chunks/:chunkIndex`) addresses one stored chunk; the container form
  // (`chunks/`) is the discovery/reassembly listing. The `chunks` segment sits
  // below the Resource level, so it needs no reserved-id entry (`meta` does,
  // because it is also addressed one level up, on a Collection and a Space).

  // Store a chunk by index
  app.put(
    '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex/', // no trailing slash allowed
    redirectStripSlash
  )
  app.put(
    '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex',
    ChunkRequest.put
  )

  // Head Chunk. Declared before the GET route for the same reason as Head
  // Resource: serve Content-Type/Content-Length from stored metadata without
  // opening the byte stream.
  app.head(
    '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex',
    ChunkRequest.head
  )

  // Get a chunk's bytes
  app.get(
    '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex',
    ChunkRequest.get
  )

  // Delete a chunk
  app.delete(
    '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex',
    ChunkRequest.delete
  )

  // List a Resource's chunks (container form; trailing slash is canonical)
  app.get(
    '/space/:spaceId/:collectionId/:resourceId/chunks', // trailing slash required
    redirectAddSlash
  )
  app.get(
    '/space/:spaceId/:collectionId/:resourceId/chunks/',
    ChunkRequest.list
  )

  // Every Resource-level reserved endpoint refuses the methods it does not
  // implement with a 405 (see the Space group's note).
  refuseUnimplementedMethods(app, [
    {
      url: '/space/:spaceId/:collectionId/:resourceId/policy',
      targetName: 'Resource policy'
    },
    {
      url: '/space/:spaceId/:collectionId/:resourceId/meta',
      targetName: 'Resource metadata'
    },
    {
      url: '/space/:spaceId/:collectionId/:resourceId/chunks',
      targetName: 'Resource chunks'
    },
    {
      url: '/space/:spaceId/:collectionId/:resourceId/chunks/',
      targetName: 'Resource chunks'
    }
  ])
}

/**
 * Registers the WebKMS keystore and key routes (the `/kms` facet).
 * Installs the same hook chain as the WAS groups
 * except that the auth requirement is the strict `requireAuthHeaders`: every
 * webkms route, GETs included, is zcap-invoked -- the protocol has no public
 * reads. No slash-redirect variants either; the protocol's URLs are exact --
 * only these shapes are registered.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initKmsRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  installGroupHooks(app, {
    provisioningRoutes: ['/kms/keystores'],
    strictAuth: true
  })

  // Create Keystore
  app.post('/kms/keystores', KeystoreRequest.post)

  // List Keystores by controller (`?controller=<did>`)
  app.get('/kms/keystores', KeystoreRequest.list)

  // Get Keystore config
  app.get('/kms/keystores/:keystoreId', KeystoreRequest.get)

  // Update Keystore config
  app.post('/kms/keystores/:keystoreId', KeystoreRequest.update)

  // Generate Key (GenerateKeyOperation)
  app.post('/kms/keystores/:keystoreId/keys', KeyRequest.generate)

  // List Keys (fork extension: enumerate the keystore's public key
  // descriptions). Static `/keys` beats the parametric `/keys/:keyId` below,
  // so this never collides with the key-description GET.
  app.get('/kms/keystores/:keystoreId/keys', KeyRequest.list)

  // Key operation dispatch by envelope type (Sign / Verify / DeriveSecret /
  // WrapKey / UnwrapKey)
  app.post('/kms/keystores/:keystoreId/keys/:keyId', KeyRequest.operation)

  // Public key description
  app.get('/kms/keystores/:keystoreId/keys/:keyId', KeyRequest.get)

  // Revoke a delegated zcap (`:revocationId` = the URL-encoded id of the
  // capability being revoked, which is also the request body)
  app.post(
    '/kms/keystores/:keystoreId/zcaps/revocations/:revocationId',
    RevocationRequest.post
  )
}
