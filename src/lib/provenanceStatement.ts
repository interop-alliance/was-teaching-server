/**
 * The provenance statement contract: what a statement attests and how its
 * members are computed from an archived object. Export provenance signs
 * statements built from these pieces, and import provenance judges statements
 * against them. The contract belongs to neither side, so it lives here. Both
 * sides read the server-managed members off an archived JSON dot-file the
 * same way, digest a file's bytes in the `Digest` header's `mh=` form, and
 * digest a chunked Resource as the JCS serialization of its chunk digests in
 * chunk index order.
 */
import { createHeaderValue } from '@interop/http-digest-header'
import { createSignCryptosuite } from '@interop/ed25519-signature/eddsa-jcs-2022'
import {
  classifyCollectionFile,
  parseChunkIndexSegment
} from '@interop/space-archive'
import type { ArchiveEntry, ArchiveFile } from '@interop/space-archive'

/**
 * The statement `type` every provenance statement carries.
 */
export const STORAGE_ATTESTATION_TYPE = 'StorageAttestation'

/**
 * The members a statement attests, as read off the archived object and keyed
 * by the statement's own member names: a Metadata object's version is its
 * `metaVersion`, a Resource's its `version`.
 */
export type Claims = {
  createdBy?: string
  createdAt?: string
  version?: number
  metaVersion?: number
}

/**
 * Every member of `Claims`, in the order a mismatch is reported.
 */
export const CLAIM_MEMBERS = [
  'createdBy',
  'createdAt',
  'version',
  'metaVersion'
] as const satisfies readonly (keyof Claims)[]

/**
 * The server-managed members a statement attests, read off one archived JSON
 * dot-file's bytes. A body that is not a JSON object yields no members, and a
 * member of the wrong type is left out. Export signs these members, and
 * import reads them back to check them against a statement.
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
export async function fileBytes(
  file: ArchiveFile
): Promise<Uint8Array | undefined> {
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
 * Export signs it, and import recomputes it over the chunk files it restores.
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
