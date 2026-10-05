/**
 * The service description (spec "Service Description"): the server-wide JSON
 * document naming the specification versions this server speaks, its Spaces
 * Repository URL, and the optional sections it implements. It lists five
 * entries: the core specification, whose entry also carries the store's origin
 * id (`lib/originId.ts`); the zCap authorization profile, whose entry
 * carries the signature algorithms and delegation cryptosuites this server
 * verifies; the Encrypted Collections profile, whose entry claims the chunk
 * endpoints and names the two optional affordances of that profile this server
 * serves; the client annex profile, whose entry claims the client-annex
 * delegation clause and carries `version` alone; and the replication
 * specification, whose entry claims the `replicas` registration, the pull
 * loop and the apply path, and carries `version` alone too. It is served unauthenticated at
 * `/service`, and every response the server sends links to it with a
 * `Link: <...>; rel="service"` header, which is how a client finds it from any
 * URL it holds. The document has no auth hooks; it depends on `serverUrl`, the
 * configuration the plugin was registered with, the active backend's
 * `originId`, and one storage read: whether the server's own history log lists
 * its export-signing key (`lib/serverIdentity.ts`), which decides the
 * `instance` member's `serverDid`. The origin id sits on the core entry rather
 * than on `instance` because a replication peer may gate on it, and the spec
 * forbids a client gating on `instance`.
 */
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  AUTHZ_PROFILE_IDENTIFIER,
  AUTHZ_PROFILE_URL,
  AUTHZ_PROFILE_VERSION,
  CLIENT_ANNEX_IDENTIFIER,
  CLIENT_ANNEX_VERSION,
  ENCRYPTED_COLLECTIONS_IDENTIFIER,
  ENCRYPTED_COLLECTIONS_URL,
  ENCRYPTED_COLLECTIONS_VERSION,
  PACKAGE_INSTANCE,
  REPLICATION_IDENTIFIER,
  REPLICATION_VERSION,
  SERVER_VERSION,
  SERVICE_DESCRIPTION_MAX_AGE,
  SERVICE_LINK_RELATION,
  SPEC_IDENTIFIER,
  SPEC_VERSION
} from './config.default.js'
import { serviceDescriptionPath, spacesPath } from './lib/paths.js'
import { resolveServerDid } from './lib/serverIdentity.js'
import type {
  AuthzProfileVersionEntry,
  PwsVersionEntry,
  EncryptedCollectionsVersionEntry,
  ServiceDescription,
  ServiceDescriptionVersionEntry
} from './types.js'
import { notModifiedReply } from './requests/notModified.js'
import {
  delegationProofCryptosuites,
  INVOCATION_SIGNATURE_ALGORITHMS
} from './zcap.js'

/**
 * The optional sections of the core specification this server implements, as
 * `features` tokens. No configuration switch this server offers disables one
 * of them, so the list is the same for every deployment. Guarantees every
 * backend provides -- conditional writes, key epochs -- are baseline
 * requirements rather than tokens, and the affordances of the Encrypted
 * Collections profile belong to {@link ENCRYPTED_COLLECTIONS_FEATURES}.
 */
export const SERVICE_FEATURES = [
  'listing',
  'collection-management',
  'space-management',
  'linksets',
  'policy',
  'metadata',
  'export',
  'backends',
  'query',
  'quotas',
  'changes-query'
]

/**
 * The optional affordances of the Encrypted Collections profile this server
 * serves, as the `features` tokens of that profile's version entry (profile
 * "Feature tokens"). The chunk endpoints are not among them: listing the entry
 * at all is the claim that they are served.
 *
 * - `blinded-index-query`: the `blinded-index` query profile over a
 *   Collection's blinded tokens, with the `unique` constraint enforced.
 * - `governed-history-logs`: the `meta/log` sub-resource, with the Collection's
 *   served `encryption` member derived from the log's head entry.
 */
export const ENCRYPTED_COLLECTIONS_FEATURES = [
  'blinded-index-query',
  'governed-history-logs'
]

/**
 * The absolute URL of the service description for a server base URL.
 * @param serverUrl {string}
 * @returns {string}
 */
export function serviceDescriptionUrl(serverUrl: string): string {
  return new URL(serviceDescriptionPath(), serverUrl).toString()
}

/**
 * Builds the service description for a server base URL. Every URL in it is
 * absolute, built from `serverUrl`.
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.originId {string}   the store's origin id, carried on the
 *   core specification's entry
 * @param options.discloseVersion {boolean}   include `instance.version`
 * @param [options.identity] {object}   the instance's identity members
 *   (`exportSigningKey`, `serverDid`); absent members are left out
 * @returns {ServiceDescription}
 */
export function buildServiceDescription({
  serverUrl,
  originId,
  discloseVersion,
  identity = {}
}: {
  serverUrl: string
  originId: string
  discloseVersion: boolean
  identity?: Pick<
    NonNullable<ServiceDescription['instance']>,
    'exportSigningKey' | 'serverDid'
  >
}): ServiceDescription {
  return {
    url: serviceDescriptionUrl(serverUrl),
    specs: {
      [SPEC_IDENTIFIER]: [
        {
          version: SPEC_VERSION,
          spaces: new URL(spacesPath(), serverUrl).toString(),
          features: SERVICE_FEATURES,
          originId
        } satisfies PwsVersionEntry
      ],
      [AUTHZ_PROFILE_IDENTIFIER]: [
        {
          version: AUTHZ_PROFILE_VERSION,
          url: AUTHZ_PROFILE_URL,
          signatureAlgorithms: INVOCATION_SIGNATURE_ALGORITHMS,
          zcapCryptosuites: delegationProofCryptosuites()
        } satisfies AuthzProfileVersionEntry
      ],
      [ENCRYPTED_COLLECTIONS_IDENTIFIER]: [
        {
          version: ENCRYPTED_COLLECTIONS_VERSION,
          url: ENCRYPTED_COLLECTIONS_URL,
          features: ENCRYPTED_COLLECTIONS_FEATURES
        } satisfies EncryptedCollectionsVersionEntry
      ],
      // A conformance claim with nothing further to advertise, so the entry
      // carries `version` alone.
      [CLIENT_ANNEX_IDENTIFIER]: [
        {
          version: CLIENT_ANNEX_VERSION
        } satisfies ServiceDescriptionVersionEntry
      ],
      // Listing the entry is the claim that replication is served. A peer's
      // registration check reads it, beside `originId` on the core entry.
      [REPLICATION_IDENTIFIER]: [
        {
          version: REPLICATION_VERSION
        } satisfies ServiceDescriptionVersionEntry
      ]
    },
    instance: {
      name: PACKAGE_INSTANCE.name,
      ...(discloseVersion && { version: SERVER_VERSION }),
      source: PACKAGE_INSTANCE.source,
      homepage: PACKAGE_INSTANCE.homepage,
      ...(identity.exportSigningKey !== undefined && {
        exportSigningKey: identity.exportSigningKey
      }),
      ...(identity.serverDid !== undefined && {
        serverDid: identity.serverDid
      })
    }
  }
}

/**
 * Adds the global `onSend` hook that puts the `service` link on every response:
 * successes, errors from any error handler, 404s for unmatched routes,
 * redirects, and CORS preflights alike. The hook appends to a `Link` header a
 * handler already set rather than replacing it. It must be called on the root
 * instance (or inside a `fastify-plugin`-wrapped plugin) so the hook reaches
 * every route and the not-found handler.
 * @param fastify {FastifyInstance}
 * @returns {void}
 */
export function addServiceLinkHook(fastify: FastifyInstance): void {
  // The link is a function of `serverUrl` alone, so it is rebuilt only when
  // that changes (the test helpers reassign it after `listen()`).
  let linkFor: string | undefined
  let serviceLink = ''
  fastify.addHook('onSend', async (request, reply, payload) => {
    const { serverUrl } = request.server
    if (linkFor !== serverUrl) {
      linkFor = serverUrl
      serviceLink =
        `<${serviceDescriptionUrl(serverUrl)}>; ` +
        `rel="${SERVICE_LINK_RELATION}"`
    }
    const existing = reply.getHeader('link')
    if (existing === undefined) {
      reply.header('link', serviceLink)
    } else {
      const links = Array.isArray(existing) ? existing : [String(existing)]
      reply.header('link', [...links, serviceLink].join(', '))
    }
    return payload
  })
}

/**
 * Registers `GET /service` (and Fastify's implicit bodyless `HEAD`). The
 * serialized document and its `ETag` are computed once per `serverUrl` and
 * server DID, since the document changes with nothing else: the store's origin
 * id is fixed for the backend's life. The DID is read per request through the
 * cached resolver, because the admin writes the server's history log after
 * boot.
 * @param fastify {FastifyInstance}
 * @param options {object}
 * @param options.discloseVersion {boolean}   include `instance.version`
 * @returns {Promise<void>}
 */
export async function initServiceDescriptionRoutes(
  fastify: FastifyInstance,
  { discloseVersion }: { discloseVersion: boolean }
): Promise<void> {
  let cached:
    | {
        serverUrl: string
        did: string | undefined
        body: string
        etag: string
      }
    | undefined

  fastify.get(
    serviceDescriptionPath(),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { serverUrl, serverSigningKey, storage } = request.server
      const did =
        serverSigningKey === undefined
          ? undefined
          : await resolveServerDid({
              storage,
              serverUrl,
              signingKey: serverSigningKey,
              logger: request.log
            })
      if (
        cached === undefined ||
        cached.serverUrl !== serverUrl ||
        cached.did !== did
      ) {
        const body = JSON.stringify(
          buildServiceDescription({
            serverUrl,
            originId: storage.originId,
            discloseVersion,
            identity: {
              exportSigningKey: serverSigningKey?.exportSigningKey,
              serverDid: did
            }
          })
        )
        const digest = createHash('sha256').update(body).digest('base64url')
        cached = { serverUrl, did, body, etag: `"${digest}"` }
      }
      reply.header(
        'cache-control',
        `public, max-age=${SERVICE_DESCRIPTION_MAX_AGE}`
      )
      return (
        notModifiedReply({ request, reply, etag: cached.etag }) ??
        reply
          .status(200)
          .header('etag', cached.etag)
          .type('application/json')
          .send(cached.body)
      )
    }
  )
}
