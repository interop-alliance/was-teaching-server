/**
 * The server's own identity: the export-signing key derived from
 * `WAS_SERVER_KEY_SEED`, the `server` Space that hosts the server's
 * `did:webvh` history log, and the check that ties the two together.
 *
 * The server holds no update key for its own DID. The admin named by
 * `WAS_ADMIN_DID` controls the `server` Space and writes the log
 * (`/space/server/id/did.jsonl`) through the ordinary front door, listing the
 * server's key as a verification method under `assertionMethod` only. The
 * server's part is to provision that Space at boot, advertise its key on
 * `/service` as `exportSigningKey`, and advertise the DID as `serverDid` once the
 * resolved current document lists the key. Until then it signs nothing.
 *
 * Resolution goes through the same self-hosted `did:webvh` resolver every
 * Space controller goes through (`webvhController.ts`), so the log gets the
 * fast-forward and verify-on-append rules and the document cache for free.
 */
import { text } from 'node:stream/consumers'
import type { FastifyBaseLogger } from 'fastify'
import { readLogFromString } from '@interop/did-method-webvh'
import type { DIDDoc } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import {
  CountQuotaExceededError,
  PreconditionFailedError,
  ProblemError
} from '../errors.js'
import { backendScoped } from './backendCache.js'
import { etagOf } from './etag.js'
import { resolveWebvhController } from './webvhController.js'
import {
  AUXILIARY_SPACE_TYPE,
  SERVER_INSTANCE_SPACE_TYPE,
  isServerInstanceSpace
} from './spaceType.js'
import { parseSelfHostedWebvh, WEBVH_LOG_RESOURCE_ID } from './validateDid.js'
import type { IDID, StorageBackend } from '../types.js'

/**
 * The Space that hosts the server's identity. Provisioned at boot with the
 * admin DID as its controller; the server itself never writes into it.
 */
export const SERVER_SPACE_ID = 'server'

/**
 * The Collection in {@link SERVER_SPACE_ID} whose `did.jsonl` is the server's
 * history log, so the DID is `did:webvh:<scid>:<host>:space:server:id`.
 */
export const SERVER_IDENTITY_COLLECTION_ID = 'id'

/**
 * The server's export-signing key pair plus the `did:key` it is advertised
 * as. Built once from the seed at registration.
 */
export interface ServerSigningKey {
  keyPair: Ed25519VerificationKey
  /** `did:key:` + the key's `publicKeyMultibase`, the `/service` member */
  exportSigningKey: string
}

/**
 * Derives the export-signing key pair from the 32-byte seed
 * (`WAS_SERVER_KEY_SEED`, decoded by the config layer).
 * @param options {object}
 * @param options.seed {Uint8Array}   the 32-byte Ed25519 seed
 * @returns {Promise<ServerSigningKey>}
 */
export async function createServerSigningKey({
  seed
}: {
  seed: Uint8Array
}): Promise<ServerSigningKey> {
  const keyPair = await Ed25519VerificationKey.generate({ seed })
  return { keyPair, exportSigningKey: `did:key:${keyPair.publicKeyMultibase}` }
}

/**
 * Provisions the `server` Space at boot, or checks the one already stored.
 *
 * An absent Space is created as a guarded write with `adminDid` as its
 * controller, typed `['AuxiliarySpace', 'ServerInstanceSpace', 'Space']`, so
 * List Spaces hides it and no client can claim the id afterwards. A stored
 * Space must carry that subtype and that controller; anything else means the
 * id was claimed before the admin DID was configured, or the admin DID
 * changed, and either is an operator decision, so registration fails naming
 * what was found. A create that loses a race against another instance
 * booting over the same storage re-reads and checks what the winner stored.
 * The create counts against `maxSpacesPerController` like any other, and a
 * refusal there is reported naming the setting, since the operator will not
 * otherwise connect a Space count quota to the admin DID.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.adminDid {string}   the `did:key` from `WAS_ADMIN_DID`
 * @returns {Promise<void>}
 */
export async function provisionServerSpace({
  storage,
  adminDid
}: {
  storage: StorageBackend
  adminDid: IDID
}): Promise<void> {
  let stored = await storage.getSpaceMetadata({ spaceId: SERVER_SPACE_ID })
  if (stored === undefined) {
    try {
      await storage.writeSpace({
        spaceId: SERVER_SPACE_ID,
        spaceMetadata: {
          id: SERVER_SPACE_ID,
          type: [AUXILIARY_SPACE_TYPE, SERVER_INSTANCE_SPACE_TYPE, 'Space'],
          controller: adminDid
        },
        ifNoneMatch: '*'
      })
      return
    } catch (err) {
      if (err instanceof CountQuotaExceededError) {
        throw new Error(
          `Cannot provision the Space "${SERVER_SPACE_ID}" for WAS_ADMIN_DID ` +
            `"${adminDid}": ${err.detail} Raise the limit, or use an admin ` +
            'DID that controls fewer Spaces.',
          { cause: err }
        )
      }
      if (!(err instanceof PreconditionFailedError)) {
        throw err
      }
      // Another instance created it first; check what it stored.
      stored = await storage.getSpaceMetadata({ spaceId: SERVER_SPACE_ID })
      if (stored === undefined) {
        throw err
      }
    }
  }
  if (!isServerInstanceSpace(stored)) {
    throw new Error(
      `The Space "${SERVER_SPACE_ID}" exists but is not typed ` +
        `"${SERVER_INSTANCE_SPACE_TYPE}"; it was created before WAS_ADMIN_DID ` +
        'was configured. Delete it, or unset WAS_ADMIN_DID.'
    )
  }
  if (stored.controller !== adminDid) {
    throw new Error(
      `WAS_ADMIN_DID is "${adminDid}" but the Space "${SERVER_SPACE_ID}" is ` +
        `controlled by "${stored.controller}". Update the Space's controller ` +
        'through the ordinary Update Space write, or restore WAS_ADMIN_DID.'
    )
  }
}

/**
 * The last outcome of {@link resolveServerDid} per backend, keyed on the
 * validator of the log it was read from: `logEtag` is the log Resource's
 * `ETag`, or `undefined` when there was no log. Any write to the log changes
 * the validator, so a hit is exactly a read of the same bytes; a miss re-reads
 * and re-warns, so each operator problem is logged once per log version
 * rather than once per `/service` request.
 */
const serverDidMemo = backendScoped<{
  entry?: { logEtag: string | undefined; did: string | undefined }
}>(() => ({}))

/**
 * Resolves the server's DID from the stored log and checks that the resolved
 * current document lists the export-signing key under `assertionMethod` and
 * under no other relationship. Returns the DID string when it does, and
 * `undefined` otherwise: the log is absent, does not parse, names a DID not
 * hosted at `server/id` of this server, fails verification, or lists the key
 * wrongly. The reason is logged at `warn`, since each is an operator matter.
 *
 * Read per `/service` request. The outcome is memoized per backend on the
 * log Resource's `ETag` ({@link serverDidMemo}), so a request costs one
 * metadata read of the log while the log stands still, and the log is parsed
 * and the document resolved only when it has changed.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}
 * @param options.signingKey {ServerSigningKey}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<string | undefined>}
 */
export async function resolveServerDid({
  storage,
  serverUrl,
  signingKey,
  logger
}: {
  storage: StorageBackend
  serverUrl: string
  signingKey: ServerSigningKey
  logger: FastifyBaseLogger
}): Promise<string | undefined> {
  const memo = serverDidMemo.for(storage)
  const metadata = await storage.getResourceMetadata({
    spaceId: SERVER_SPACE_ID,
    collectionId: SERVER_IDENTITY_COLLECTION_ID,
    resourceId: WEBVH_LOG_RESOURCE_ID
  })
  if (metadata === undefined) {
    memo.entry = { logEtag: undefined, did: undefined }
    return undefined
  }
  const logEtag = etagOf(metadata)
  if (
    logEtag !== undefined &&
    memo.entry !== undefined &&
    memo.entry.logEtag === logEtag
  ) {
    return memo.entry.did
  }
  const did = await resolveServerDidUncached({
    storage,
    serverUrl,
    signingKey,
    logger
  })
  // A log with no validator cannot be told apart from its next version, so
  // its outcome is not memoized.
  if (logEtag !== undefined) {
    memo.entry = { logEtag, did }
  }
  return did
}

/**
 * The uncached body of {@link resolveServerDid}: reads and checks the stored
 * log as it stands now.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}
 * @param options.signingKey {ServerSigningKey}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<string | undefined>}
 */
async function resolveServerDidUncached({
  storage,
  serverUrl,
  signingKey,
  logger
}: {
  storage: StorageBackend
  serverUrl: string
  signingKey: ServerSigningKey
  logger: FastifyBaseLogger
}): Promise<string | undefined> {
  const did = await readHeadDid({ storage })
  if (did === undefined) {
    return undefined
  }
  const parsed = parseSelfHostedWebvh(did, { serverUrl })
  if (
    parsed === undefined ||
    parsed.spaceId !== SERVER_SPACE_ID ||
    parsed.collectionId !== SERVER_IDENTITY_COLLECTION_ID
  ) {
    logger.warn(
      { did },
      'The stored server history log names a DID not hosted at ' +
        `${SERVER_SPACE_ID}/${SERVER_IDENTITY_COLLECTION_ID} of this server; ` +
        'the server identity is not advertised.'
    )
    return undefined
  }
  let doc: DIDDoc
  try {
    doc = await resolveWebvhController({ storage, serverUrl, did })
  } catch (err) {
    logger.warn(
      { err, did },
      'The server history log does not verify; the server identity is not ' +
        'advertised.'
    )
    return undefined
  }
  const problem = signingKeyRelationshipProblem({
    doc,
    publicKeyMultibase: signingKey.keyPair.publicKeyMultibase
  })
  if (problem !== undefined) {
    logger.warn(
      { did, exportSigningKey: signingKey.exportSigningKey },
      `${problem} The server identity is not advertised.`
    )
    return undefined
  }
  return did
}

/**
 * Reads the DID the stored server log's head entry names, or `undefined` when
 * there is no log or it does not parse.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @returns {Promise<string | undefined>}
 */
async function readHeadDid({
  storage
}: {
  storage: StorageBackend
}): Promise<string | undefined> {
  let logText: string
  try {
    const { resourceStream } = await storage.getResource({
      spaceId: SERVER_SPACE_ID,
      collectionId: SERVER_IDENTITY_COLLECTION_ID,
      resourceId: WEBVH_LOG_RESOURCE_ID
    })
    logText = await text(resourceStream)
  } catch (err) {
    if (err instanceof ProblemError && err.statusCode === 404) {
      return undefined
    }
    throw err
  }
  try {
    const did = readLogFromString(logText).at(-1)?.state?.id
    return typeof did === 'string' ? did : undefined
  } catch {
    return undefined
  }
}

/**
 * Why the resolved document does not list the export-signing key the way the
 * server requires: under `assertionMethod`, and under no other relationship,
 * so the key can neither invoke a capability nor be read as a ladder or
 * transient annex method by the client-annex clause. Returns `undefined` when
 * the document lists it correctly.
 *
 * @param options {object}
 * @param options.doc {DIDDoc}   the resolved current document
 * @param options.publicKeyMultibase {string}   the server key's public key
 * @returns {string | undefined}
 */
export function signingKeyRelationshipProblem({
  doc,
  publicKeyMultibase
}: {
  doc: DIDDoc
  publicKeyMultibase: string
}): string | undefined {
  // Every method id the key is published under, not just the first: a second
  // method carrying the same key would otherwise slip past the check.
  const methodIds = new Set(
    (doc.verificationMethod ?? [])
      .filter(vm => vm.publicKeyMultibase === publicKeyMultibase)
      .map(vm => vm.id)
      .filter((id): id is string => typeof id === 'string')
  )
  const listedUnder = (
    [
      'authentication',
      'assertionMethod',
      'keyAgreement',
      'capabilityInvocation',
      'capabilityDelegation'
    ] as const
  ).filter(relationship =>
    referencesKey(doc[relationship], { methodIds, publicKeyMultibase })
  )
  if (methodIds.size === 0 && listedUnder.length === 0) {
    return 'The resolved server document lists no verification method for the export-signing key.'
  }
  if (!listedUnder.includes('assertionMethod')) {
    return 'The resolved server document does not list the export-signing key under "assertionMethod".'
  }
  const others = listedUnder.filter(
    relationship => relationship !== 'assertionMethod'
  )
  if (others.length > 0) {
    return (
      'The resolved server document lists the export-signing key under ' +
      `${others.map(name => `"${name}"`).join(', ')} as well as ` +
      '"assertionMethod"; it must hold "assertionMethod" alone.'
    )
  }
  return undefined
}

/**
 * Whether a verification relationship references the key: by one of its
 * method ids, or through an embedded method carrying the key itself.
 * @param relationship {unknown}   the document member
 * @param options {object}
 * @param options.methodIds {Set<string>}   ids of the methods carrying the key
 * @param options.publicKeyMultibase {string}   the key itself
 * @returns {boolean}
 */
function referencesKey(
  relationship: unknown,
  {
    methodIds,
    publicKeyMultibase
  }: { methodIds: Set<string>; publicKeyMultibase: string }
): boolean {
  if (!Array.isArray(relationship)) {
    return false
  }
  return relationship.some(entry => {
    if (typeof entry === 'string') {
      return methodIds.has(entry)
    }
    if (typeof entry !== 'object' || entry === null) {
      return false
    }
    return (
      methodIds.has(entry.id) || entry.publicKeyMultibase === publicKeyMultibase
    )
  })
}
