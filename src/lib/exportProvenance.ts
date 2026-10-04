/**
 * Export provenance: the signed statements an export archive carries in its
 * `provenance.jsonl`, one per exported object, and the server's DID history
 * log snapshot it carries as `did.jsonl`, so the statements verify offline.
 *
 * A statement is a plain JSON object,
 * `{ id, type: 'StorageAttestation', createdBy, createdAt, updatedAt,
 * updatedAtCounter, originId, meta, digest, didLogVersionId }`, with one
 * `eddsa-jcs-2022` Data Integrity proof
 * (`proofPurpose` `assertionMethod`) by the export-signing key, named as
 * `{serverDid}#{publicKeyMultibase}`. `id` is the object's absolute URL on
 * this server. `digest` is the `Digest` header's multihash form (`mh=` plus a
 * base64url sha-256 multihash) over the Resource's content as archived; for a
 * chunked Resource it is the same form over the JCS serialization of its
 * chunk digests, in chunk index order. `updatedAt`, `updatedAtCounter` and
 * `originId` are the object's write stamp; a Resource's `meta` is its `/meta`
 * record's stamp and generation, present once metadata was written. A Space
 * or Collection Metadata statement carries no `meta` and no `digest`.
 * `didLogVersionId` names the log entry whose document lists the key, since
 * `proof.created` is not trustworthy.
 *
 * The signed bytes say nothing about the export itself: no export time and
 * no reference to the manifest. The proof carries no `created` either, and
 * Ed25519 signatures are deterministic, so the same statement signed at any
 * other time is the same bytes. That keeps a later write-time signature
 * interchangeable with an export-time one.
 *
 * Statements are built from the archive's own entry tree, after the backend
 * has built it and before it is packed, so both backends share this code and
 * every digest is over the very bytes the archive carries. The statements sit
 * ahead of the `space/` tree, so each Resource is read twice: once here to
 * digest it, once when it is packed. The export is not one transaction, so a
 * Resource written between the two reads leaves a statement that does not
 * match its archived bytes, and an importer drops that one attribution. A
 * backend may also build the tree before it reads any file, so an object
 * deleted after the tree was built is gone by the time it is digested here.
 * It gets no statement, and the export goes on.
 */
import { readLogFromString } from '@interop/did-method-webvh'
import type { DIDLog } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { EddsaJcs2022 } from '@interop/ed25519-signature/eddsa-jcs-2022'
import jsigs from '@interop/jsonld-signatures'
import { classifyCollectionFile } from '@interop/space-archive'
import type { ArchiveEntry, ArchiveFile } from '@interop/space-archive'
import type { FastifyBaseLogger } from 'fastify'
import type { StorageBackend } from '../types.js'
import { collectionMetaPath, resourcePath, spaceMetaPath } from './paths.js'
import {
  CLAIM_MEMBERS,
  chunkedDigest,
  fileBytes,
  fileDigest,
  serverFieldsOf,
  STORAGE_ATTESTATION_TYPE
} from './provenanceStatement.js'
import type { Claims } from './provenanceStatement.js'
import {
  readServerLog,
  resolveServerDid,
  signingKeyRelationshipProblem
} from './serverIdentity.js'
import type { ServerSigningKey } from './serverIdentity.js'
import { verifyWebvhLog } from './webvhController.js'

/**
 * What an export needs to sign its provenance: the server's DID, the log
 * snapshot the archive embeds (verbatim bytes) and its head `versionId`, and
 * the export-signing key named under the server DID.
 */
export interface ExportAttestor {
  /** the base URL the statements' `id`s are built on */
  serverUrl: string
  serverDid: string
  /** the log's bytes, exactly as the log Resource serves them */
  didLog: Uint8Array
  /** the `versionId` of the snapshot's head entry */
  didLogVersionId: string
  /** the signing key pair, its `id` `{serverDid}#{publicKeyMultibase}` */
  keyPair: Ed25519VerificationKey
}

/**
 * Loads what an export needs to sign its provenance, or says why it cannot.
 *
 * The server has an identity when `resolveServerDid` finds one (the same
 * check `/service` makes for `serverDid`). The log snapshot the archive will
 * embed is then read and checked on its own: its head names the same DID, it
 * verifies as that DID's log, and its document lists the export-signing key
 * as the method `{serverDid}#{publicKeyMultibase}`, under the relationships
 * `signingKeyRelationshipProblem` allows (`assertionMethod`, and optionally
 * `capabilityInvocation`).
 * The snapshot is what an importer verifies against, so a log appended between
 * the two reads is judged by the bytes that travel.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}
 * @param options.signingKey {ServerSigningKey}
 * @param options.logger {FastifyBaseLogger}   for `resolveServerDid`'s own
 *   once-per-log-version warnings
 * @returns {Promise<{ attestor: ExportAttestor } | { reason: string }>}
 */
export async function loadExportAttestor({
  storage,
  serverUrl,
  signingKey,
  logger
}: {
  storage: StorageBackend
  serverUrl: string
  signingKey: ServerSigningKey
  logger: FastifyBaseLogger
}): Promise<{ attestor: ExportAttestor } | { reason: string }> {
  const serverDid = await resolveServerDid({
    storage,
    serverUrl,
    signingKey,
    logger
  })
  if (serverDid === undefined) {
    return { reason: 'No server DID lists the export-signing key.' }
  }
  const didLog = await readServerLog({ storage })
  if (didLog === undefined) {
    return { reason: 'The server history log is gone.' }
  }
  let log: DIDLog
  try {
    log = readLogFromString(didLog.toString('utf8'))
  } catch {
    return { reason: 'The server history log snapshot does not parse.' }
  }
  const head = log.at(-1)
  if (head === undefined || head.state?.id !== serverDid) {
    return {
      reason: 'The server history log snapshot names another DID.'
    }
  }
  const { publicKeyMultibase } = signingKey.keyPair
  try {
    const { doc, deactivated } = await verifyWebvhLog({ did: serverDid, log })
    if (deactivated) {
      return { reason: 'The server DID has been deactivated.' }
    }
    const problem = signingKeyRelationshipProblem({ doc, publicKeyMultibase })
    if (problem !== undefined) {
      return { reason: problem }
    }
    const methodId = `${serverDid}#${publicKeyMultibase}`
    const listed = (doc.verificationMethod ?? []).some(
      method =>
        method.id === methodId &&
        method.publicKeyMultibase === publicKeyMultibase
    )
    if (!listed) {
      return {
        reason:
          `The server document lists the export-signing key under an id ` +
          `other than "${methodId}".`
      }
    }
    return {
      attestor: {
        serverUrl,
        serverDid,
        didLog,
        didLogVersionId: head.versionId,
        keyPair: new Ed25519VerificationKey({
          id: methodId,
          controller: serverDid,
          publicKeyMultibase,
          privateKeyMultibase: signingKey.keyPair.privateKeyMultibase
        })
      }
    }
  } catch (err) {
    return {
      reason: `The server history log snapshot does not verify: ${(err as Error).message}`
    }
  }
}

/**
 * Reads the server-managed members off one archived JSON dot-file: a Space or
 * Collection Metadata object or a Resource metadata sidecar. A file that is
 * gone yields `undefined`.
 * @param options {object}
 * @param options.file {ArchiveFile}
 * @returns {Promise<Claims | undefined>}
 */
async function archivedServerFields({
  file
}: {
  file: ArchiveFile
}): Promise<Claims | undefined> {
  const bytes = await fileBytes(file)
  return bytes === undefined ? undefined : serverFieldsOf({ bytes })
}

/**
 * The claims a statement carries, in `CLAIM_MEMBERS` order, each left out
 * when the archived object lacks it.
 * @param fields {Claims}
 * @returns {Claims}
 */
function claimsOf(fields: Claims): Claims {
  const claims: Record<string, unknown> = {}
  for (const member of CLAIM_MEMBERS) {
    if (fields[member] !== undefined) {
      claims[member] = fields[member]
    }
  }
  return claims as Claims
}

/**
 * Signs one statement with the attestor's key: one `eddsa-jcs-2022` proof,
 * `proofPurpose` `assertionMethod`, with no `created`. The proof is made
 * straight from the suite, not through `jsigs.sign`, which would add a
 * JSON-LD `@context` the statement does not carry.
 * @param options {object}
 * @param options.statement {Record<string, unknown>}
 * @param options.suite {EddsaJcs2022}
 * @returns {Promise<string>}   the signed statement as one JSON line
 */
async function signStatement({
  statement,
  suite
}: {
  statement: Record<string, unknown>
  suite: EddsaJcs2022
}): Promise<string> {
  const proof = await suite.createProof({
    document: { ...statement },
    purpose: new jsigs.purposes.AssertionProofPurpose(),
    proofSet: [],
    // JCS needs no document loader; any load attempt is a bug.
    documentLoader: async (url: string) => {
      throw new Error(`Unexpected document load: "${url}".`)
    }
  })
  return JSON.stringify({ ...statement, proof })
}

/**
 * Builds the archive's `provenance.jsonl` body from its entry tree: one
 * signed statement per exported object, in the order the manifest lists the
 * object's entry. The Space Metadata object is attested at its
 * `.space.<id>.json` entry, a Collection Metadata object at its
 * `.collection.<id>.json` entry, and a Resource at its representation file,
 * with the server-managed members read off its `.meta.<id>.json` sidecar. A
 * Resource with a chunk directory beside its representation gets the
 * composite chunk digest. A tombstone (a sidecar with no representation)
 * holds no content and gets no statement, and neither does an object whose
 * file, or one of whose chunks, was deleted after the tree was built.
 *
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.entries {ArchiveEntry[]}   the archive's top-level entries,
 *   in pack order, as handed to `packSpaceArchive`
 * @param options.attestor {ExportAttestor}
 * @returns {Promise<string>}   the JSON Lines body, one statement per line
 */
export async function attestArchiveEntries({
  spaceId,
  entries,
  attestor
}: {
  spaceId: string
  entries: ArchiveEntry[]
  attestor: ExportAttestor
}): Promise<string> {
  const suite = new EddsaJcs2022({
    signer: attestor.keyPair.signer(),
    // No `created`: the proof must not depend on when it was made.
    date: null
  })
  const urlOf = (path: string): string =>
    new URL(path, attestor.serverUrl).toString()
  const lines: string[] = []

  async function attest(statement: Record<string, unknown>): Promise<void> {
    lines.push(
      await signStatement({
        statement: {
          ...statement,
          didLogVersionId: attestor.didLogVersionId
        },
        suite
      })
    )
  }

  async function attestMetadata({
    id,
    file
  }: {
    id: string
    file: ArchiveFile
  }): Promise<void> {
    const fields = await archivedServerFields({ file })
    if (fields === undefined) {
      return
    }
    await attest({
      id,
      type: STORAGE_ATTESTATION_TYPE,
      ...claimsOf(fields)
    })
  }

  for (const entry of entries) {
    // A Space-level file other than the Space Metadata object gets no
    // statement. That includes a Collection tombstone, which holds no
    // content.
    if (!('files' in entry)) {
      if (classifyCollectionFile(entry.name).kind === 'spaceMetadata') {
        await attestMetadata({
          id: urlOf(spaceMetaPath({ spaceId })),
          file: entry
        })
      }
      continue
    }
    const collectionId = entry.name
    const sidecars = new Map<string, ArchiveFile>()
    const chunkDirs = new Map<string, ArchiveEntry[]>()
    for (const child of entry.files) {
      const kind = classifyCollectionFile(child.name)
      if ('files' in child) {
        if (kind.kind === 'chunkDirectory') {
          chunkDirs.set(kind.resourceId, child.files)
        }
      } else if (kind.kind === 'metaSidecar') {
        sidecars.set(kind.resourceId, child)
      }
    }
    for (const child of entry.files) {
      if ('files' in child) {
        continue
      }
      const kind = classifyCollectionFile(child.name)
      if (kind.kind === 'collectionMetadata') {
        await attestMetadata({
          id: urlOf(collectionMetaPath({ spaceId, collectionId })),
          file: child
        })
        continue
      }
      if (kind.kind !== 'representation') {
        continue
      }
      const { resourceId } = kind
      const chunkFiles = chunkDirs.get(resourceId)
      const digest =
        chunkFiles === undefined
          ? await fileDigest(child)
          : await chunkedDigest(chunkFiles)
      if (digest === undefined) {
        continue
      }
      const sidecar = sidecars.get(resourceId)
      const fields =
        sidecar === undefined
          ? undefined
          : await archivedServerFields({ file: sidecar })
      await attest({
        id: urlOf(resourcePath({ spaceId, collectionId, resourceId })),
        type: STORAGE_ATTESTATION_TYPE,
        ...claimsOf(fields ?? {}),
        digest
      })
    }
  }
  return lines.map(line => `${line}\n`).join('')
}
