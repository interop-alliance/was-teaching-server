/**
 * Seeds the payload matrix a perf run measures: a JSON credential, a 100 KiB
 * file and a 10 MiB file, in a public, a private plaintext and a private
 * encrypted Collection. Writes over signed HTTP through `@interop/was-client`
 * the way freewallet does, so the encrypted Collection carries a real key
 * epoch (with a blinded-index key) and its Resources are real EDV envelopes
 * and chunks. Needs only a running server, so it works over any backend.
 */
import { randomBytes } from 'node:crypto'

import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { WasClient } from '@interop/was-client'
import { spacesUrl } from '@interop/was-client/paths'
import type { Collection, JsonObject } from '@interop/was-client'
import {
  createEdvEncryption,
  ensureFirstEpoch,
  type RecipientPublicKey
} from '@interop/was-client/edv'
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'

import { startTestServer } from '../../src/testing.js'
import type { StorageBackend } from '../../src/types.js'

import {
  backendPool,
  collectionBackend,
  credential,
  largeFileBytes,
  matrixPayloads,
  matrixSpaceIds,
  retryOnNetworkFault,
  smallFileBytes,
  type EncryptedReadIds,
  type MatrixCategory,
  type MatrixPayload,
  type PoolMember
} from './perf-lib.js'

/**
 * Random bytes as a binary upload body.
 * @param bytes {number}
 * @returns {Blob}
 */
function randomFile(bytes: number): Blob {
  return new Blob([randomBytes(bytes)], { type: 'application/octet-stream' })
}

/**
 * Creates one Space holding, for each pool member, a Collection per matrix
 * category (`<category><suffix>`, on the member's backend): `public` with a
 * `PublicCanRead` policy, `plaintext`, and `encrypted` with an `edv`
 * descriptor and its key epoch[0], wrapped to `recipient`.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.spaceId {string}
 * @param options.recipient {RecipientPublicKey}
 * @param options.pool {PoolMember[]}
 * @returns {Promise<Array<Record<MatrixCategory, Collection>>>} each pool
 *   member's Collections, in pool order
 */
async function createCategoryCollections({
  was,
  spaceId,
  recipient,
  pool
}: {
  was: WasClient
  spaceId: string
  recipient: RecipientPublicKey
  pool: PoolMember[]
}): Promise<Array<Record<MatrixCategory, Collection>>> {
  const space = await retryOnNetworkFault({
    op: () => was.createSpace({ id: spaceId, name: spaceId })
  })
  const members: Array<Record<MatrixCategory, Collection>> = []
  for (const member of pool) {
    const { suffix } = member
    const backend = collectionBackend(member)
    const publicCollection = await retryOnNetworkFault({
      op: () => space.createCollection({ id: `public${suffix}`, ...backend })
    })
    await retryOnNetworkFault({ op: () => publicCollection.setPublic() })
    const plaintext = await retryOnNetworkFault({
      op: () => space.createCollection({ id: `plaintext${suffix}`, ...backend })
    })
    const encrypted = await retryOnNetworkFault({
      op: () =>
        space.createCollection({
          id: `encrypted${suffix}`,
          encryption: { scheme: 'edv' },
          ...backend
        })
    })
    await retryOnNetworkFault({
      op: () =>
        ensureFirstEpoch({
          collection: encrypted,
          recipients: [recipient],
          blindedIndex: true
        })
    })
    members.push({ public: publicCollection, plaintext, encrypted })
  }
  return members
}

/**
 * Fills the ballast Space with `binaryTotalMib` MiB of random binary data, as
 * plaintext files of at most 10 MiB each.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.binaryTotalMib {number}
 * @returns {Promise<void>}
 */
async function seedBallast({
  was,
  binaryTotalMib
}: {
  was: WasClient
  binaryTotalMib: number
}): Promise<void> {
  const space = await was.createSpace({
    id: matrixSpaceIds.ballast,
    name: matrixSpaceIds.ballast
  })
  const collection = await space.createCollection({ id: 'files' })
  let remaining = binaryTotalMib * 1024 * 1024
  for (let index = 0; remaining > 0; index++) {
    const bytes = Math.min(remaining, largeFileBytes)
    await collection.put(`file-${index}`, randomFile(bytes))
    remaining -= bytes
  }
}

/**
 * Seeds the read and write Spaces (a Collection per category and pool member
 * in each), the read targets in each of the read Space's Collections, and,
 * when `binaryTotalMib` is above 0, the ballast.
 * @param options {object}
 * @param options.serverUrl {string}   the server's base URL
 * @param options.seed {Uint8Array}   the seed's identity, whose `did:key`
 *   controls the Spaces
 * @param [options.binaryTotalMib] {number}   0 (no ballast Space) by default
 * @param [options.payloads] {MatrixPayload[]}   the read targets to seed;
 *   every payload by default
 * @param [options.pool] {PoolMember[]}   the Collections per category each
 *   matrix test spreads its load over; one by default
 * @returns {Promise<EncryptedReadIds>} the encrypted read targets' EDV ids,
 *   by payload, for the seeded payloads only
 */
export async function seedMatrix({
  serverUrl,
  seed,
  binaryTotalMib = 0,
  payloads = matrixPayloads,
  pool = backendPool()
}: {
  serverUrl: string
  seed: Uint8Array
  binaryTotalMib?: number
  payloads?: readonly MatrixPayload[]
  pool?: PoolMember[]
}): Promise<EncryptedReadIds> {
  const signerKey = await Ed25519VerificationKey.generate({ seed })
  const generated = await X25519KeyAgreementKey2020.generate({
    controller: `did:key:${signerKey.fingerprint()}`
  })
  const recipient: RecipientPublicKey = {
    id: generated.id as string,
    type: generated.type,
    publicKeyMultibase: generated.publicKeyMultibase
  }
  const keyAgreementKey = generated as IKeyAgreementKey
  const keyResolver: IKeyResolver = async () => recipient
  const was = WasClient.fromSigner({
    serverUrl: spacesUrl({ baseUrl: serverUrl }),
    signer: signerKey.didKeySigner(),
    encryption: createEdvEncryption({
      resolveKeys: async () => ({ keyAgreementKey, keyResolver })
    })
  })

  const [first, ...rest] = await createCategoryCollections({
    was,
    spaceId: matrixSpaceIds.read,
    recipient,
    pool
  })
  await createCategoryCollections({
    was,
    spaceId: matrixSpaceIds.write,
    recipient,
    pool
  })

  const files: Record<MatrixPayload, JsonObject | Blob> = {
    json: credential('json') as JsonObject,
    small: randomFile(smallFileBytes),
    large: randomFile(largeFileBytes)
  }
  for (const member of [first!, ...rest]) {
    for (const collection of [member.public, member.plaintext]) {
      for (const payload of payloads) {
        await retryOnNetworkFault({
          op: () => collection.put(payload, files[payload])
        })
      }
    }
  }
  // Every member's encrypted Collection holds each file at the one EDV id the
  // first member minted, so a read test has one id to read from any member.
  const encryptedIds: EncryptedReadIds = {}
  for (const payload of payloads) {
    const { id } = await retryOnNetworkFault({
      op: () => first!.encrypted.add(files[payload])
    })
    for (const member of rest) {
      await retryOnNetworkFault({
        op: () => member.encrypted.put(id, files[payload])
      })
    }
    encryptedIds[payload] = id
  }

  if (binaryTotalMib > 0) {
    await seedBallast({ was, binaryTotalMib })
  }
  return encryptedIds
}

/**
 * Seeds the payload matrix (see `seedMatrix`) over signed HTTP through an
 * in-process server on `backend`, for a seed script that writes the rest of
 * its data straight through that backend. The server owns the backend from
 * the start: closing the server closes it, and a failed boot closes it before
 * rethrowing, so the caller must not use or close it afterward.
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.seed {Uint8Array}
 * @param [options.binaryTotalMib] {number}
 * @returns {Promise<EncryptedReadIds>} the encrypted read targets' EDV ids,
 *   by payload
 */
export async function seedMatrixInProcess({
  backend,
  seed,
  binaryTotalMib
}: {
  backend: StorageBackend
  seed: Uint8Array
  binaryTotalMib?: number
}): Promise<EncryptedReadIds> {
  const { fastify, serverUrl } = await startTestServer({ backend })
  try {
    return await seedMatrix({ serverUrl, seed, binaryTotalMib })
  } finally {
    await fastify.close()
  }
}
