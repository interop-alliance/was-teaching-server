/**
 * The checks a replica registration passes before it is stored. The body
 * checks need nothing but the body and this server's URL, and a break of one
 * is `invalid-request-body` (400). The peer checks read the peer, and a break
 * of one is `replica-refused` (409): the registration is well formed, and the
 * state of the peer or of this server refuses it.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { ISigner } from '@interop/data-integrity-core'
import { readLogFromString } from '@interop/did-method-webvh'
import type { DIDDoc } from '@interop/did-method-webvh'

import {
  REPLICATION_IDENTIFIER,
  REPLICATION_VERSION,
  SPEC_IDENTIFIER
} from '../config.default.js'
import {
  InvalidRequestBodyError,
  PeerRequestError,
  ReplicaRefusedError
} from '../errors.js'
import { isPlainObject } from '../lib/isPlainObject.js'
import { mergeAppliedCollectionMetadata } from '../lib/replicaApply.js'
import {
  collectionMetaPath,
  resourcePath,
  spaceMetaPath,
  spacePath
} from '../lib/paths.js'
import type { ServerSigningKey } from '../lib/serverIdentity.js'
import { SERVER_SPACE_ID, keyRelationships } from '../lib/serverIdentity.js'
import { isSameTypeSet } from '../lib/spaceType.js'
import { loadSyncSigner } from '../lib/syncIdentity.js'
import {
  WEBVH_LOG_RESOURCE_ID,
  isValidController,
  parsePeerHostedWebvh
} from '../lib/validateDid.js'
import {
  isReplicaId,
  isUrlSafeSegment,
  spaceIdOfSpaceUrl
} from '../lib/validateId.js'
import { verifyWebvhLog } from '../lib/webvhController.js'
import { replicaMappingConflict } from '../lib/webvhLogLocation.js'
import { selectedCollectionIds } from './collectionSelection.js'
import type {
  CollectionMetadata,
  IDelegatedZcap,
  ReplicaRegistration,
  StorageBackend,
  StoredSpaceMetadata
} from '../types.js'
import { PeerClient } from './peerClient.js'
import type { PeerFetch } from './peerFetch.js'

/**
 * The actions a pull capability may carry. The loop only reads.
 */
const PULL_ACTIONS = new Set(['GET', 'HEAD'])

/**
 * An absolute URL for a path on the peer's server, resolved against the
 * peer Space URL.
 * @param options {object}
 * @param options.path {string}
 * @param options.fromSpace {string}   the peer Space URL
 * @returns {string}
 */
export function peerUrlOf({
  path,
  fromSpace
}: {
  path: string
  fromSpace: string
}): string {
  return new URL(path, fromSpace).toString()
}

/**
 * Parses a registration body into the record to store. Members this server
 * does not know are dropped.
 *
 * @param options {object}
 * @param options.body {unknown}   the request body
 * @param options.serverUrl {string}   this server's base URL
 * @param options.spaceId {string}   the local Space
 * @param options.requestName {string}
 * @returns {ReplicaRegistration}
 * @throws {InvalidRequestBodyError}
 */
export function parseReplicaRegistration({
  body,
  serverUrl,
  spaceId,
  requestName
}: {
  body: unknown
  serverUrl: string
  spaceId: string
  requestName: string
}): ReplicaRegistration {
  const refuse = (detail: string, pointer: string): never => {
    throw new InvalidRequestBodyError({ requestName, detail, pointer })
  }
  if (!isPlainObject(body)) {
    return refuse('The registration must be a JSON object.', '#')
  }
  const { id, fromSpace, toSpace, capability, collections, role } = body

  if (typeof id !== 'string' || !isReplicaId(id)) {
    return refuse(
      'The registration "id" must be a URL-safe string that does not end in ".state".',
      '#/id'
    )
  }
  if (spaceIdOfSpaceUrl(fromSpace) === undefined) {
    return refuse(
      'The registration "fromSpace" must be the peer Space\'s canonical URL, ' +
        'ending in a slash.',
      '#/fromSpace'
    )
  }
  const localSpaceUrl = new URL(
    spacePath({ spaceId, trailingSlash: true }),
    serverUrl
  ).toString()
  if (toSpace !== localSpaceUrl) {
    return refuse(
      `The registration "toSpace" must be this Space's canonical URL, "${localSpaceUrl}".`,
      '#/toSpace'
    )
  }
  if (role !== 'source') {
    return refuse('The registration "role" must be "source".', '#/role')
  }

  let selected: Array<{ id: string }> | undefined
  if (collections !== undefined) {
    if (!Array.isArray(collections)) {
      return refuse(
        'The registration "collections" must be an array of { id } objects.',
        '#/collections'
      )
    }
    selected = collections.map((item, index) => {
      if (
        !isPlainObject(item) ||
        typeof item.id !== 'string' ||
        !isUrlSafeSegment(item.id)
      ) {
        return refuse(
          'Each "collections" item must be an object with a URL-safe string "id".',
          `#/collections/${index}`
        )
      }
      return { id: item.id }
    })
  }

  if (!isPlainObject(capability)) {
    return refuse(
      'The registration "capability" must be a delegated capability.',
      '#/capability'
    )
  }
  const pull = capability as unknown as IDelegatedZcap
  if (
    typeof pull.id !== 'string' ||
    typeof pull.parentCapability !== 'string'
  ) {
    return refuse(
      'The registration "capability" must be a delegated capability, with ' +
        'an "id" and a "parentCapability".',
      '#/capability'
    )
  }
  if (pull.invocationTarget !== fromSpace) {
    return refuse(
      'The capability "invocationTarget" must equal "fromSpace".',
      '#/capability/invocationTarget'
    )
  }
  const proofs = [pull.proof].flat()
  const chainRoot = proofs[0]?.capabilityChain?.[0]
  if (
    chainRoot !== `urn:zcap:root:${encodeURIComponent(fromSpace as string)}`
  ) {
    return refuse(
      "The capability's chain must start at the peer Space's root capability.",
      '#/capability/proof/capabilityChain'
    )
  }
  const actions = [pull.allowedAction ?? []].flat()
  if (
    actions.length === 0 ||
    !actions.every(action => PULL_ACTIONS.has(action))
  ) {
    return refuse(
      'The capability "allowedAction" must be present and within ["GET", "HEAD"].',
      '#/capability/allowedAction'
    )
  }

  return {
    id,
    fromSpace: fromSpace as string,
    toSpace: localSpaceUrl,
    capability: pull,
    ...(selected !== undefined && { collections: selected }),
    role
  }
}

/**
 * The members of a served Collection Metadata object a replica stores: the
 * object without the members a server derives at response time. On a
 * Collection under log governance the served `encryption` and `revisions` are
 * derived from the log, which replicates as its own record, so both are left
 * out.
 * @param served {Record<string, unknown>}   a peer's `GET .../meta` body
 * @returns {CollectionMetadata}
 */
export function storedProjectionOfCollection(
  served: Record<string, unknown>
): CollectionMetadata {
  const { url: _url, linkset: _linkset, ...rest } = served
  const governed =
    isPlainObject(rest.encryption) && isPlainObject(rest.encryption.history)
  if (governed) {
    const { encryption: _encryption, revisions: _revisions, ...stored } = rest
    return stored as unknown as CollectionMetadata
  }
  return rest as unknown as CollectionMetadata
}

/**
 * Runs the peer checks of a registration and resolves the signer its pull
 * loop will use. Nothing is stored here.
 *
 * - The local Space is not the `server` Space.
 * - This server has a sync signer, and the capability is delegated to its
 *   DID.
 * - The peer's service description lists the replication specification at
 *   the version this server speaks and an `originId` that is not this
 *   server's.
 * - The peer Space, read through the capability, has the local Space's
 *   `type` set, and either the local Space's `controller` or a `did:webvh`
 *   hosted in the peer Space whose current document lists the local
 *   `did:key` controller under `capabilityInvocation`.
 * - Each Collection the registration pulls that both sides hold agrees on
 *   the immutable members (`encryption`, `revisions.resolution`,
 *   `revisions.immutable`).
 *
 * @param options {object}
 * @param options.record {ReplicaRegistration}   the parsed registration
 * @param options.spaceId {string}   the local Space
 * @param options.spaceMetadata {StoredSpaceMetadata}   its Metadata object
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}
 * @param [options.signingKey] {ServerSigningKey}
 * @param options.peerFetch {PeerFetch}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<void>}
 * @throws {ReplicaRefusedError}
 */
export async function assertReplicaAcceptable({
  record,
  spaceId,
  spaceMetadata,
  storage,
  serverUrl,
  signingKey,
  peerFetch,
  logger
}: {
  record: ReplicaRegistration
  spaceId: string
  spaceMetadata: StoredSpaceMetadata
  storage: StorageBackend
  serverUrl: string
  signingKey: ServerSigningKey | undefined
  peerFetch: PeerFetch
  logger: FastifyBaseLogger
}): Promise<void> {
  if (spaceId === SERVER_SPACE_ID) {
    throw new ReplicaRefusedError({
      detail: 'The "server" Space is not replicated.',
      pointer: '#/toSpace'
    })
  }
  const conflict = await replicaMappingConflict({
    storage,
    spaceId,
    record,
    localController: spaceMetadata.controller
  })
  if (conflict !== undefined) {
    throw new ReplicaRefusedError({
      detail:
        `Space "${conflict}" on this server already replicates the peer ` +
        'Space, with a Collection this registration would pull too. A ' +
        'did:webvh hosted in a Collection two local Spaces replicate ' +
        'resolves from neither copy.'
    })
  }
  const sync = await loadSyncSigner({ storage, serverUrl, signingKey, logger })
  if ('refusal' in sync) {
    throw new ReplicaRefusedError({
      detail: `This server cannot replicate. ${sync.reason}`,
      pointer: '#/toSpace'
    })
  }
  if (record.capability.controller !== sync.serverDid) {
    throw new ReplicaRefusedError({
      detail:
        "The capability must be delegated to this server's DID, " +
        `"${sync.serverDid}".`,
      pointer: '#/capability/controller'
    })
  }

  const peer = new PeerClient({
    peerFetch,
    signer: sync.signer as ISigner,
    capability: record.capability
  })
  try {
    await assertPeerServes({ peer, record, storage })
    await assertPeerSpaceMatches({ peer, record, spaceMetadata, serverUrl })
    await assertImmutableMembersMatch({ peer, record, spaceId, storage })
  } catch (err) {
    if (err instanceof PeerRequestError) {
      throw new ReplicaRefusedError({
        detail: `The peer could not be read. ${err.message}`
      })
    }
    throw err
  }
}

/**
 * The peer's service description must list the replication specification at
 * this server's version, and an origin id that is not this server's.
 * @param options {object}
 * @param options.peer {PeerClient}
 * @param options.record {ReplicaRegistration}
 * @param options.storage {StorageBackend}
 * @returns {Promise<void>}
 */
async function assertPeerServes({
  peer,
  record,
  storage
}: {
  peer: PeerClient
  record: ReplicaRegistration
  storage: StorageBackend
}): Promise<void> {
  const { json } = await peer.readJson({
    url: peerUrlOf({ path: '/service', fromSpace: record.fromSpace }),
    expect: [200],
    signed: false
  })
  const specs = isPlainObject(json.specs) ? json.specs : {}
  const entriesOf = (identifier: string): Record<string, unknown>[] => {
    const entries = specs[identifier]
    return Array.isArray(entries) ? entries.filter(isPlainObject) : []
  }
  if (
    !entriesOf(REPLICATION_IDENTIFIER).some(
      entry => entry.version === REPLICATION_VERSION
    )
  ) {
    throw new ReplicaRefusedError({
      detail:
        'The peer does not list the replication specification ' +
        `("${REPLICATION_IDENTIFIER}") at version ${REPLICATION_VERSION}.`
    })
  }
  const originId = entriesOf(SPEC_IDENTIFIER)
    .map(entry => entry.originId)
    .find(value => typeof value === 'string')
  if (originId === undefined) {
    throw new ReplicaRefusedError({
      detail: 'The peer advertises no "originId".'
    })
  }
  if (originId === storage.originId) {
    throw new ReplicaRefusedError({
      detail:
        `The peer carries this server's own origin id ("${originId}"). ` +
        'Two servers that replicate need different origin ids.'
    })
  }
}

/**
 * The peer Space, read through the pull capability, must have the local
 * Space's `type` set and a controller the local Space's controller matches
 * (see {@link assertLocalControllerIsPeerKey}).
 * @param options {object}
 * @param options.peer {PeerClient}
 * @param options.record {ReplicaRegistration}
 * @param options.spaceMetadata {StoredSpaceMetadata}   the local object
 * @param options.serverUrl {string}   this server's base URL
 * @returns {Promise<void>}
 */
async function assertPeerSpaceMatches({
  peer,
  record,
  spaceMetadata,
  serverUrl
}: {
  peer: PeerClient
  record: ReplicaRegistration
  spaceMetadata: StoredSpaceMetadata
  serverUrl: string
}): Promise<void> {
  const peerSpaceId = spaceIdOfSpaceUrl(record.fromSpace)!
  const { json } = await peer.readJson({
    url: peerUrlOf({
      path: spaceMetaPath({ spaceId: peerSpaceId }),
      fromSpace: record.fromSpace
    }),
    expect: [200]
  })
  if (json.controller !== spaceMetadata.controller) {
    await assertLocalControllerIsPeerKey({
      peer,
      record,
      serverUrl,
      peerController: json.controller,
      localController: spaceMetadata.controller
    })
  }
  if (
    !Array.isArray(json.type) ||
    !isSameTypeSet({ left: json.type, right: spaceMetadata.type })
  ) {
    throw new ReplicaRefusedError({
      detail: 'The peer Space has another "type" set than this Space.'
    })
  }
}

/**
 * The second branch of the controller check, for a peer Space whose
 * controller differs from the local Space's. A wallet promotes its Space to
 * a `did:webvh` before the Space gains a replica, so the peer controller is
 * that DID while a new local Space is still under a `did:key`. The local
 * Space cannot be promoted first, since the DID resolves here only through
 * the registration. The registration is admitted when the local `did:key` is
 * a current key of the peer controller's document, listed under
 * `capabilityInvocation`, the relationship a controller invokes under. A
 * holder of a pull capability whose own key the document does not list still
 * cannot register another user's Space as a source.
 *
 * The DID must be hosted in the peer Space itself, where the registration
 * will make it resolvable here, and the registration must pull its log's
 * Collection, else the copy the promotion needs would never arrive. The log
 * is read through the pull capability and verified offline with no witness
 * proofs, as a replicated copy is. Nothing is fetched by DID.
 *
 * @param options {object}
 * @param options.peer {PeerClient}
 * @param options.record {ReplicaRegistration}
 * @param options.serverUrl {string}   this server's base URL
 * @param options.peerController {unknown}   the peer Space's `controller`
 * @param options.localController {string}   the local Space's `controller`
 * @returns {Promise<void>}
 * @throws {ReplicaRefusedError}
 */
async function assertLocalControllerIsPeerKey({
  peer,
  record,
  serverUrl,
  peerController,
  localController
}: {
  peer: PeerClient
  record: ReplicaRegistration
  serverUrl: string
  peerController: unknown
  localController: string
}): Promise<void> {
  const refuse = (detail: string, pointer?: string): never => {
    throw new ReplicaRefusedError({
      detail: `The peer Space has another controller than this Space. ${detail}`,
      ...(pointer !== undefined && { pointer })
    })
  }
  const hosted = parsePeerHostedWebvh(peerController, { serverUrl })
  if (
    !isValidController(localController) ||
    hosted === undefined ||
    hosted.fromSpace !== record.fromSpace
  ) {
    return refuse(
      'A Space replicates between Spaces of one controller, or onto a ' +
        "Space under a did:key the peer Space's did:webvh controller lists."
    )
  }
  const selected = selectedCollectionIds({ record, localController })
  if (selected !== undefined && !selected.has(hosted.collectionId)) {
    return refuse(
      `The registration does not pull Collection "${hosted.collectionId}", ` +
        "which holds the peer controller's history log.",
      '#/collections'
    )
  }
  const { body } = await peer.read({
    url: peerUrlOf({
      path: resourcePath({
        spaceId: hosted.spaceId,
        collectionId: hosted.collectionId,
        resourceId: WEBVH_LOG_RESOURCE_ID
      }),
      fromSpace: record.fromSpace
    }),
    expect: [200]
  })
  let doc: DIDDoc
  try {
    const log = readLogFromString(body.toString('utf8'))
    const verified = await verifyWebvhLog({
      did: peerController as string,
      log
    })
    if (verified.deactivated) {
      throw new Error('the DID has been deactivated.')
    }
    doc = verified.doc
  } catch (err) {
    return refuse(
      "The peer controller's history log does not verify: " +
        (err as Error).message
    )
  }
  const publicKeyMultibase = localController.slice('did:key:'.length)
  const { listedUnder } = keyRelationships({ doc, publicKeyMultibase })
  if (!listedUnder.includes('capabilityInvocation')) {
    return refuse(
      "The peer controller's document does not list this Space's " +
        'controller under "capabilityInvocation".'
    )
  }
}

/**
 * Each Collection the registration pulls that both sides already hold must
 * agree on the immutable members. With no `collections` list, every local
 * Collection is checked.
 * @param options {object}
 * @param options.peer {PeerClient}
 * @param options.record {ReplicaRegistration}
 * @param options.spaceId {string}   the local Space
 * @param options.storage {StorageBackend}
 * @returns {Promise<void>}
 */
async function assertImmutableMembersMatch({
  peer,
  record,
  spaceId,
  storage
}: {
  peer: PeerClient
  record: ReplicaRegistration
  spaceId: string
  storage: StorageBackend
}): Promise<void> {
  const peerSpaceId = spaceIdOfSpaceUrl(record.fromSpace)!
  let collectionIds = record.collections?.map(({ id }) => id)
  if (collectionIds === undefined) {
    collectionIds = []
    let cursor: string | undefined
    do {
      const page = await storage.listCollections({ spaceId, cursor })
      collectionIds.push(...page.items.map(({ id }) => id))
      cursor =
        page.next === undefined
          ? undefined
          : (new URL(page.next, 'http://local').searchParams.get('cursor') ??
            undefined)
    } while (cursor !== undefined)
  }
  for (const [index, collectionId] of collectionIds.entries()) {
    const local = await storage.getCollectionMetadata({ spaceId, collectionId })
    if (local === undefined) {
      continue
    }
    const served = await peer.readJson({
      url: peerUrlOf({
        path: collectionMetaPath({ spaceId: peerSpaceId, collectionId }),
        fromSpace: record.fromSpace
      }),
      expect: [200, 404]
    })
    if (served.status === 404) {
      continue
    }
    const incoming = storedProjectionOfCollection(served.json)
    const forward = mergeAppliedCollectionMetadata({ held: local, incoming })
    const backward = mergeAppliedCollectionMetadata({
      held: incoming,
      incoming: local
    })
    const fork = [forward, backward].find(result => 'fork' in result)
    if (fork !== undefined && 'fork' in fork) {
      throw new ReplicaRefusedError({
        detail: `Collection "${collectionId}" differs from the peer's: ${fork.fork}`,
        pointer:
          record.collections === undefined
            ? '#/fromSpace'
            : `#/collections/${index}`
      })
    }
  }
}
