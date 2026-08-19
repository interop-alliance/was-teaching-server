/**
 * Local resolution of a self-hosted `did:webvh` Space controller.
 *
 * A controller of the form
 * `did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>` publishes its
 * history log as `did.jsonl` in that Collection of that Space on *this* server,
 * so the log is read straight out of storage -- never fetched over the network.
 * There is therefore no liveness, SSRF, or bootstrap surface. The read is the
 * server reading its own storage, so it happens regardless of the Collection's
 * read policy: a capability-gated (non-public) Collection's DID still resolves
 * for authorization while staying unreadable to anyone without a capability.
 *
 * The log's Space need not be the Space an invocation targets. The DID string
 * carries the log's own `spaceId`, and every read below is keyed off the parsed
 * location, so a Space controlled by a DID whose log lives elsewhere resolves
 * with no special casing.
 *
 * The log is **verified, not trusted**: writes to that Collection are
 * authorized by the Space controller, which after promotion is the very
 * document being resolved, so a compromised delegated write must not be able to
 * forge a controller document. The SCID pinned in the DID string plus full log
 * verification (hash chain, prerotation, update-key signatures) is what rules
 * that out, and both are done by `@interop/did-method-webvh` -- no resolver
 * logic grows here. Hosting a resolvable log under some Space's path confers no
 * authority on its own; a DID gains authority only by being referenced, as a
 * Space's stored controller or as a delegation's controller.
 *
 * Verified documents are memoized per storage backend (the same shape as the
 * Space Description cache), keyed by the log's location and invalidated by
 * writes that could change a log at that location.
 *
 * NOTE: the log is read through the control-plane `storage` (the default data
 * plane). Pointing a log Collection at a non-default data-plane backend is out
 * of scope; such a log would not be found here.
 */
import { text } from 'node:stream/consumers'
import { LruCache } from '@interop/lru-memoize'
import {
  defaultWebvhLogVerifier,
  readLogFromString,
  resolveDIDFromLog
} from '@interop/did-method-webvh'
import type { DIDDoc } from '@interop/did-method-webvh'
import {
  WEBVH_DOCUMENT_CACHE_MAX,
  WEBVH_DOCUMENT_CACHE_TTL
} from '../config.default.js'
import { parseSelfHostedWebvh, WEBVH_LOG_RESOURCE_ID } from './validateDid.js'
import type { StorageBackend } from '../types.js'

/**
 * What the resolver needs from the request layer: the storage backend the log
 * is read from, and this server's base URL (which the DID's embedded host must
 * match). Threaded through the verification path rather than held in module
 * state, so two backends in one process never resolve against each other.
 */
export interface WebvhResolverContext {
  storage: StorageBackend
  serverUrl: string
}

/**
 * One short-TTL memoization cache of verified controller documents per storage
 * backend, scoped via a WeakMap exactly like the Space Description cache: two
 * backends in one process (parallel test suites) never serve each other's
 * documents, and a cache is discarded with its backend.
 */
const documentCaches = new WeakMap<StorageBackend, LruCache>()

/**
 * Returns the (lazily created) resolved-document cache for a backend.
 * @param storage {StorageBackend}
 * @returns {LruCache}
 */
function documentCacheFor(storage: StorageBackend): LruCache {
  let cache = documentCaches.get(storage)
  if (!cache) {
    cache = new LruCache({
      max: WEBVH_DOCUMENT_CACHE_MAX,
      ttl: WEBVH_DOCUMENT_CACHE_TTL
    })
    documentCaches.set(storage, cache)
  }
  return cache
}

/**
 * Cache key: the log's location (Space plus Collection) followed by the DID.
 * The location prefix is what makes invalidation by log location possible; the
 * DID is part of the key because the same log resolves differently for a
 * different requested DID (a mismatched SCID must not be served a document
 * resolved for another one).
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.did {string}
 * @returns {string}
 */
function cacheKey({
  spaceId,
  collectionId,
  did
}: {
  spaceId: string
  collectionId: string
  did: string
}): string {
  return `${spaceId}|${collectionId}|${did}`
}

/**
 * Drops cached controller documents whose history log a write could have
 * changed (or removed), so the next verification resolves the current log
 * rather than a stale document -- the `invalidateSpaceDescription` pattern.
 *
 * Invalidation is keyed by the log's location. A Resource-scoped write path
 * passes both the `collectionId` and the `resourceId` it wrote: any Resource
 * other than `did.jsonl` returns early, and otherwise only that Collection's
 * entries are dropped. A Collection-scoped path (delete Collection) passes the
 * `collectionId` alone. A Space-scoped path (delete Space, import) passes
 * neither and drops every entry anchored in the Space.
 *
 * Cost bound: entries exist only for DIDs that were actually resolved for
 * authorization, i.e. DIDs some Space's stored controller or some delegation's
 * controller names. Scoping invalidation to the written Collection therefore
 * means a `did.jsonl` PUT into a Collection hosting no referenced DID deletes
 * nothing and forces no re-verification. Widening the gate from one magic
 * Collection to `did.jsonl`-in-any-Collection is not, as a result, an
 * amplification lever an ordinary Collection grant can pull.
 *
 * A capability-gated (non-public) Collection is treated no differently: its DID
 * resolves for authorization because the server reads its own storage
 * regardless of read policy, so its cached documents need the same
 * invalidation.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}   the Collection that was written;
 *   when given, only that Collection's entries are invalidated
 * @param [options.resourceId] {string}   the Resource that was written; when
 *   given and not the history-log Resource, nothing is invalidated
 * @returns {void}
 */
export function invalidateResolvedWebvhDid({
  storage,
  spaceId,
  collectionId,
  resourceId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId?: string
  resourceId?: string
}): void {
  if (resourceId !== undefined && resourceId !== WEBVH_LOG_RESOURCE_ID) {
    return
  }
  // Only touch a cache that already exists for this backend.
  const cache = documentCaches.get(storage)
  if (!cache) {
    return
  }
  const prefix =
    collectionId !== undefined ? `${spaceId}|${collectionId}|` : `${spaceId}|`
  for (const key of [...cache.cache.keys()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}

/**
 * Reads a `<spaceId>/<collectionId>/did.jsonl` history log from storage.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<string>}   the raw JSON Lines log
 */
async function readLogText({
  storage,
  spaceId,
  collectionId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId: string
}): Promise<string> {
  const { resourceStream } = await storage.getResource({
    spaceId,
    collectionId,
    resourceId: WEBVH_LOG_RESOURCE_ID
  })
  return await text(resourceStream)
}

/**
 * Resolves and fully verifies a self-hosted `did:webvh` controller against its
 * locally stored history log, returning the verified DID document.
 *
 * Rejects with a plain `Error` (the caller decides the HTTP shape: a 400 at
 * promotion time, a failed verification during capability checking) when the
 * DID is not self-hosted, the log is absent or unparseable, verification fails,
 * the resolved document names a different DID, or the DID is deactivated.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.serverUrl {string}   this server's base URL
 * @param options.did {string}   the controller DID to resolve
 * @returns {Promise<DIDDoc>}   the verified controller document
 */
export async function resolveWebvhController({
  storage,
  serverUrl,
  did
}: WebvhResolverContext & { did: string }): Promise<DIDDoc> {
  const parsed = parseSelfHostedWebvh(did, { serverUrl })
  if (!parsed) {
    throw new Error(
      `"${did}" is not a did:webvh DID hosted by this server; only ` +
        'self-hosted did:webvh controllers are resolvable here.'
    )
  }
  const { scid, spaceId, collectionId } = parsed
  return await documentCacheFor(storage).memoize<DIDDoc>({
    key: cacheKey({ spaceId, collectionId, did }),
    fn: async () =>
      await resolveVerifiedDocument({
        storage,
        did,
        scid,
        spaceId,
        collectionId
      })
  })
}

/**
 * The uncached half of {@link resolveWebvhController}: read the log, verify it,
 * and check the resolved document against what was asked for.
 *
 * `scid` and `requestedDid` are passed explicitly because they are the
 * SCID-pinning knobs -- `resolveDIDFromLog` does not infer them from the log,
 * and without them a log that verifies internally could resolve to any DID.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.did {string}   the full controller DID
 * @param options.scid {string}   the SCID embedded in the DID
 * @param options.spaceId {string}   the Space the log is published in
 * @param options.collectionId {string}   the Collection the log is published in
 * @returns {Promise<DIDDoc>}
 */
async function resolveVerifiedDocument({
  storage,
  did,
  scid,
  spaceId,
  collectionId
}: {
  storage: StorageBackend
  did: string
  scid: string
  spaceId: string
  collectionId: string
}): Promise<DIDDoc> {
  let logText: string
  try {
    logText = await readLogText({ storage, spaceId, collectionId })
  } catch (err) {
    throw new Error(
      `No did:webvh history log is published at ` +
        `"${spaceId}/${collectionId}/${WEBVH_LOG_RESOURCE_ID}".`,
      { cause: err }
    )
  }

  let doc: DIDDoc | null
  let deactivated: boolean
  try {
    const log = readLogFromString(logText)
    const resolved = await resolveDIDFromLog(log, {
      verifier: defaultWebvhLogVerifier,
      scid,
      requestedDid: did
    })
    doc = resolved.doc
    deactivated = resolved.meta.deactivated
  } catch (err) {
    throw new Error(`Could not verify the history log for "${did}".`, {
      cause: err
    })
  }

  if (!doc) {
    throw new Error(`The history log for "${did}" resolved to no document.`)
  }
  if (deactivated) {
    throw new Error(`The DID "${did}" has been deactivated.`)
  }
  if (doc.id !== did) {
    throw new Error(
      `The history log resolved to "${doc.id}", not the requested "${did}".`
    )
  }
  return doc
}

/** JSON-LD context for `Multikey` verification methods. */
const MULTIKEY_CONTEXT = 'https://w3id.org/security/multikey/v1'

/**
 * Dereferences a `did#fragment` to its verification-method (or service) node
 * within a resolved DID document, attaching an appropriate JSON-LD `@context`.
 * Mirrors the library driver's own fragment dereferencing -- which cannot be
 * reused directly because that driver's `get()` fetches the log over the
 * network, the one thing this server never does.
 *
 * @param options {object}
 * @param options.doc {DIDDoc}   the resolved DID document
 * @param options.id {string}   the fully-qualified node id (`did#fragment`)
 * @returns {Record<string, unknown>}   the matched node, with an `@context`
 */
function dereferenceFragment({
  doc,
  id
}: {
  doc: DIDDoc
  id: string
}): Record<string, unknown> {
  const entries = [
    ...(doc.verificationMethod ?? []),
    ...(doc.service ?? [])
  ] as Array<Record<string, unknown>>
  const match = entries.find(entry => entry?.id === id)
  if (!match) {
    throw new Error(`DID document entity with id "${id}" not found.`)
  }
  const context = match.type === 'Multikey' ? MULTIKEY_CONTEXT : doc['@context']
  return { '@context': context, ...structuredClone(match) }
}

/**
 * Builds a did-io-shaped `{ method, get }` driver over the local resolver, for
 * registration on the document loader's DID resolver
 * (`securityLoader({ didResolver })`). A bare DID resolves to its verified
 * document; a `did#fragment` URL dereferences straight to that node -- which is
 * what lets the jsigs purpose check confirm a verification method is listed
 * under the controller document's `capabilityInvocation` /
 * `capabilityDelegation`.
 *
 * @param options {WebvhResolverContext}
 * @returns {{ method: string, get: (options: { did?: string, url?: string })
 *   => Promise<Record<string, unknown>> }}
 */
export function webvhDidResolverDriver({
  storage,
  serverUrl
}: WebvhResolverContext) {
  return {
    method: 'webvh',
    async get({
      did,
      url
    }: {
      did?: string
      url?: string
    }): Promise<Record<string, unknown>> {
      const didOrUrl = did ?? url
      if (!didOrUrl) {
        throw new TypeError('A DID or a URL is required to resolve.')
      }
      // Separate the bare DID from any `?query` or `#fragment`.
      const [didAuthority = ''] = didOrUrl.split(/[#?]/)
      const fragment = didOrUrl.includes('#')
        ? didOrUrl.slice(didOrUrl.indexOf('#') + 1)
        : undefined
      const doc = await resolveWebvhController({
        storage,
        serverUrl,
        did: didAuthority
      })
      if (fragment) {
        return dereferenceFragment({ doc, id: `${doc.id}#${fragment}` })
      }
      return doc as Record<string, unknown>
    }
  }
}
