/**
 * Export provenance: the signed statements an export archive carries in its
 * `provenance.jsonl`, one per exported object, and the server's DID history
 * log snapshot it carries as `did.jsonl`, so the statements verify offline.
 *
 * A statement is a plain JSON object,
 * `{ id, type: 'StorageAttestation', createdBy, createdAt, version, digest,
 * didLogVersionId }`, with one `eddsa-jcs-2022` Data Integrity proof
 * (`proofPurpose` `assertionMethod`) by the export-signing key, named as
 * `{serverDid}#{publicKeyMultibase}`. `id` is the object's absolute URL on
 * this server. `digest` is the `Digest` header's multihash form (`mh=` plus a
 * base64url sha-256 multihash) over the Resource's content as archived; for a
 * chunked Resource it is the same form over the JCS serialization of its
 * chunk digests, in chunk index order. A Space or Collection Metadata
 * statement carries `metaVersion` in place of `version` and `digest`.
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
import { createHeaderValue } from '@interop/http-digest-header'
import { readLogFromString } from '@interop/did-method-webvh'
import type { DIDLog } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import {
  EddsaJcs2022,
  createSignCryptosuite
} from '@interop/ed25519-signature/eddsa-jcs-2022'
import jsigs from '@interop/jsonld-signatures'
import {
  classifyCollectionFile,
  parseChunkIndexSegment
} from '@interop/space-archive'
import type { ArchiveEntry, ArchiveFile } from '@interop/space-archive'
import type { FastifyBaseLogger } from 'fastify'
import type { StorageBackend } from '../types.js'
import { collectionMetaPath, resourcePath, spaceMetaPath } from './paths.js'
import {
  readServerLog,
  resolveServerDid,
  signingKeyRelationshipProblem
} from './serverIdentity.js'
import type { ServerSigningKey } from './serverIdentity.js'
import { verifyWebvhLog } from './webvhController.js'

/**
 * The statement `type` every provenance statement carries.
 */
export const STORAGE_ATTESTATION_TYPE = 'StorageAttestation'

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
 * under `assertionMethod` alone, as the method `{serverDid}#{publicKeyMultibase}`.
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
 * Collection Metadata object (whose version is its embedded `_version`) or a
 * Resource metadata sidecar (whose version is its `version`). A file that is
 * gone yields `undefined`.
 * @param options {object}
 * @param options.file {ArchiveFile}
 * @param options.versionMember {'_version' | 'version'}
 * @returns {Promise<{ createdBy?: string, createdAt?: string, version?: number } | undefined>}
 */
async function archivedServerFields({
  file,
  versionMember
}: {
  file: ArchiveFile
  versionMember: '_version' | 'version'
}): Promise<
  { createdBy?: string; createdAt?: string; version?: number } | undefined
> {
  const bytes = await fileBytes(file)
  return bytes === undefined
    ? undefined
    : serverFieldsOf({ bytes, versionMember })
}

/**
 * The server-managed members a statement attests, read off one archived JSON
 * dot-file's bytes. A body that is not a JSON object yields no members, and a
 * member of the wrong type is left out. Shared with import, which reads the
 * same members back to check them against a statement.
 * @param options {object}
 * @param options.bytes {Uint8Array}
 * @param options.versionMember {'_version' | 'version'}
 * @returns {{ createdBy?: string, createdAt?: string, version?: number }}
 */
export function serverFieldsOf({
  bytes,
  versionMember
}: {
  bytes: Uint8Array
  versionMember: '_version' | 'version'
}): { createdBy?: string; createdAt?: string; version?: number } {
  let body: unknown
  try {
    body = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return {}
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {}
  }
  const record = body as Record<string, unknown>
  const version = record[versionMember]
  return {
    ...(typeof record.createdBy === 'string' && {
      createdBy: record.createdBy
    }),
    ...(typeof record.createdAt === 'string' && {
      createdAt: record.createdAt
    }),
    ...(Number.isInteger(version) && { version: version as number })
  }
}

/**
 * An archive file's bytes, whether carried inline or read at call time.
 * Returns `undefined` when a file read at call time is gone (`ENOENT`): the
 * object was deleted after the backend built the entry tree.
 * @param file {ArchiveFile}
 * @returns {Promise<Uint8Array | undefined>}
 */
async function fileBytes(file: ArchiveFile): Promise<Uint8Array | undefined> {
  if ('bytes' in file) {
    return file.bytes
  }
  try {
    return await file.read()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw err
  }
}

/**
 * The `Digest` header's multihash form over one archive file's bytes, or
 * `undefined` when the file is gone.
 * @param file {ArchiveFile}
 * @returns {Promise<string | undefined>}
 */
export async function fileDigest(
  file: ArchiveFile
): Promise<string | undefined> {
  const bytes = await fileBytes(file)
  return bytes === undefined ? undefined : createHeaderValue({ data: bytes })
}

/**
 * The composite digest of a chunked Resource: each chunk representation's
 * digest, in chunk index order, serialized with JCS, and that serialization
 * digested in the same `mh=` form. A chunk directory's metadata sidecars are
 * not content and are skipped. Returns `undefined` when any chunk is gone.
 * Shared with import, which recomputes it over the chunk files it restores.
 * @param chunkFiles {ArchiveEntry[]}   the chunk directory's entries
 * @returns {Promise<string | undefined>}
 */
export async function chunkedDigest(
  chunkFiles: ArchiveEntry[]
): Promise<string | undefined> {
  const chunks: { index: number; file: ArchiveFile }[] = []
  for (const entry of chunkFiles) {
    if ('files' in entry) {
      continue
    }
    const kind = classifyCollectionFile(entry.name)
    if (kind.kind !== 'representation') {
      continue
    }
    const index = parseChunkIndexSegment(kind.resourceId)
    if (index !== undefined) {
      chunks.push({ index, file: entry })
    }
  }
  chunks.sort((left, right) => left.index - right.index)
  const digests: string[] = []
  for (const { file } of chunks) {
    const digest = await fileDigest(file)
    if (digest === undefined) {
      return undefined
    }
    digests.push(digest)
  }
  const serialized = await createSignCryptosuite().canonize(digests)
  return createHeaderValue({ data: serialized })
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
    const fields = await archivedServerFields({
      file,
      versionMember: '_version'
    })
    if (fields === undefined) {
      return
    }
    const { createdBy, createdAt, version } = fields
    await attest({
      id,
      type: STORAGE_ATTESTATION_TYPE,
      ...(createdBy !== undefined && { createdBy }),
      ...(createdAt !== undefined && { createdAt }),
      ...(version !== undefined && { metaVersion: version })
    })
  }

  for (const entry of entries) {
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
          : await archivedServerFields({
              file: sidecar,
              versionMember: 'version'
            })
      const { createdBy, createdAt, version } = fields ?? {}
      await attest({
        id: urlOf(resourcePath({ spaceId, collectionId, resourceId })),
        type: STORAGE_ATTESTATION_TYPE,
        ...(createdBy !== undefined && { createdBy }),
        ...(createdAt !== undefined && { createdAt }),
        ...(version !== undefined && { version }),
        digest
      })
    }
  }
  return lines.map(line => `${line}\n`).join('')
}
