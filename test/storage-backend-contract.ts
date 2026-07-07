/**
 * Parameterized StorageBackend contract suite: the storage-level invariants
 * every backend must satisfy (types.ts `StorageBackend` docs), run against
 * both the filesystem and Postgres backends so their semantics cannot drift.
 * Not a test file itself -- see storage-contract-filesystem.test.ts and
 * storage-contract-postgres.test.ts for the per-backend entry points.
 */
import { it, describe, beforeAll, afterAll, expect } from 'vitest'
import assert from 'node:assert'
import { Readable } from 'node:stream'
import { formatEtag } from '../src/lib/etag.js'
import {
  PreconditionFailedError,
  ResourceNotFoundError,
  QuotaExceededError,
  CountQuotaExceededError,
  PayloadTooLargeError,
  InvalidCursorError,
  KeystoreStateConflictError,
  KeyIdConflictError,
  DuplicateRevocationError
} from '../src/errors.js'
import type {
  StorageBackend,
  StoredBackendRecord,
  KeystoreConfig,
  KmsKeyRecord,
  RevocationRecord,
  ResourceInput,
  IDID
} from '../src/types.js'

/** A backend instance plus its teardown, as produced by the suite factory. */
export interface BackendHarness {
  backend: StorageBackend
  cleanup(): Promise<void>
}

/** Per-backend capabilities the shared suite adapts its assertions to. */
export interface ContractOptions {
  /** suite display name (e.g. 'FileSystemBackend') */
  name: string
  /**
   * Builds a fresh, empty backend. `capacityBytes` / `maxUploadBytes` configure
   * the byte quotas; `maxSpacesPerController` / `maxCollectionsPerSpace` /
   * `maxResourcesPerSpace` configure the count quotas for the count-quota block.
   */
  makeBackend(options?: {
    capacityBytes?: number
    maxUploadBytes?: number
    maxSpacesPerController?: number
    maxCollectionsPerSpace?: number
    maxResourcesPerSpace?: number
  }): Promise<BackendHarness>
  /**
   * True when the backend enforces the per-Space quota as a HARD limit under
   * concurrency (transactional accounting). The filesystem backend's
   * documented soft limit skips the concurrent-writer block.
   */
  hardQuota: boolean
  /**
   * True when `reportUsage().usageBytes` is exactly the stored content bytes
   * (the Postgres counter); the filesystem's `du` includes file/block
   * overhead, so its figure is only asserted loosely.
   */
  exactUsage: boolean
}

/** Reads a Readable fully into a string. */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function jsonInput(data: unknown): ResourceInput {
  return { kind: 'json', contentType: 'application/json', data }
}

function binaryInput(
  bytes: Buffer,
  options: { contentType?: string; declaredBytes?: number } = {}
): ResourceInput {
  return {
    kind: 'binary',
    contentType: options.contentType ?? 'application/octet-stream',
    stream: Readable.from(bytes),
    ...(options.declaredBytes !== undefined && {
      declaredBytes: options.declaredBytes
    })
  }
}

const CONTROLLER = 'did:key:z6MkContractSuiteController' as IDID

async function provisionSpace(
  backend: StorageBackend,
  spaceId: string,
  collectionId = 'col'
): Promise<void> {
  await backend.writeSpace({
    spaceId,
    spaceDescription: {
      id: spaceId,
      type: ['Space'],
      name: `Space ${spaceId}`,
      controller: CONTROLLER
    }
  })
  await backend.writeCollection({
    spaceId,
    collectionId,
    collectionDescription: {
      id: collectionId,
      type: ['Collection'],
      name: `Collection ${collectionId}`
    }
  })
}

function keystoreConfig(
  keystoreId: string,
  overrides: Partial<KeystoreConfig> = {}
): KeystoreConfig {
  return {
    id: `https://kms.example/kms/keystores/${keystoreId}`,
    controller: CONTROLLER,
    sequence: 0,
    kmsModule: 'local-v1',
    ...overrides
  }
}

function keyRecord(keystoreId: string, localId: string): KmsKeyRecord {
  const now = new Date().toISOString()
  return {
    keystoreId,
    localId,
    meta: { created: now, updated: now },
    key: {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      id: `https://kms.example/kms/keystores/${keystoreId}/keys/${localId}`,
      type: 'Ed25519VerificationKey2020',
      publicKeyMultibase: 'z6MkfExample',
      privateKeyMultibase: 'zSecretExample'
    }
  }
}

function revocationRecord({
  capabilityId,
  delegator,
  expires
}: {
  capabilityId: string
  delegator: string
  expires?: string
}): RevocationRecord {
  return {
    capability: { id: capabilityId, ...(expires && { expires }) },
    meta: {
      delegator,
      rootTarget: 'https://kms.example/kms/keystores/ks',
      created: new Date().toISOString(),
      ...(expires && { expires })
    }
  }
}

/**
 * Registers the shared StorageBackend contract suite for one backend.
 * @param options {ContractOptions}
 */
export function describeStorageBackendContract(options: ContractOptions): void {
  const { name, makeBackend, hardQuota, exactUsage } = options

  describe(`StorageBackend contract: ${name}`, () => {
    describe('absent-target getters and idempotent deletes', () => {
      let harness: BackendHarness
      beforeAll(async () => {
        harness = await makeBackend()
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('getters resolve falsy (never throw) on absent targets', async () => {
        const { backend } = harness
        assert.equal(
          await backend.getSpaceDescription({ spaceId: 'nope' }),
          undefined
        )
        assert.equal(
          await backend.getCollectionDescription({
            spaceId: 'nope',
            collectionId: 'nope'
          }),
          undefined
        )
        assert.equal(
          await backend.getResourceMetadata({
            spaceId: 'nope',
            collectionId: 'nope',
            resourceId: 'nope'
          }),
          undefined
        )
        assert.equal(await backend.getPolicy({ spaceId: 'nope' }), undefined)
        assert.equal(
          await backend.getBackend({ spaceId: 'nope', backendId: 'nope' }),
          undefined
        )
        assert.equal(
          await backend.getKeystore({ keystoreId: 'nope' }),
          undefined
        )
        assert.equal(
          await backend.getKey({ keystoreId: 'nope', localId: 'nope' }),
          undefined
        )
      })

      it('getResource throws ResourceNotFoundError on an absent Resource', async () => {
        await expect(
          harness.backend.getResource({
            spaceId: 'nope',
            collectionId: 'nope',
            resourceId: 'nope'
          })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
      })

      it('listSpaces / listKeystoresByController resolve empty on an empty store', async () => {
        assert.deepEqual(await harness.backend.listSpaces(), [])
        assert.deepEqual(
          await harness.backend.listKeystoresByController({
            controller: CONTROLLER
          }),
          []
        )
      })

      it('deletes are idempotent on absent targets', async () => {
        const { backend } = harness
        await backend.deleteSpace({ spaceId: 'nope' })
        await backend.deleteCollection({ spaceId: 'nope', collectionId: 'x' })
        await backend.deleteResource({
          spaceId: 'nope',
          collectionId: 'x',
          resourceId: 'y'
        })
        await backend.deletePolicy({ spaceId: 'nope' })
        await backend.deleteBackend({ spaceId: 'nope', backendId: 'x' })
      })
    })

    describe('descriptions, upserts, listings', () => {
      let harness: BackendHarness
      beforeAll(async () => {
        harness = await makeBackend()
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('writeSpace is an upsert; listSpaces sorts by id', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-b')
        await provisionSpace(backend, 'space-a')
        await backend.writeSpace({
          spaceId: 'space-b',
          spaceDescription: {
            id: 'space-b',
            type: ['Space'],
            name: 'Renamed',
            controller: CONTROLLER
          }
        })
        const spaces = await backend.listSpaces()
        assert.deepEqual(
          spaces.map(space => space.id),
          ['space-a', 'space-b']
        )
        assert.equal(
          (await backend.getSpaceDescription({ spaceId: 'space-b' }))?.name,
          'Renamed'
        )
      })

      it('writeCollection upserts; listCollections sorts by id', async () => {
        const { backend } = harness
        await backend.writeCollection({
          spaceId: 'space-a',
          collectionId: 'zeta',
          collectionDescription: { id: 'zeta', type: ['Collection'], name: 'Z' }
        })
        const collections = await backend.listCollections({
          spaceId: 'space-a'
        })
        assert.deepEqual(
          collections.map(collection => collection.id),
          ['col', 'zeta']
        )
        assert.equal(collections[1]!.name, 'Z')
      })

      it('deleteSpace removes the Space and its contents', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-gone')
        await backend.writeResource({
          spaceId: 'space-gone',
          collectionId: 'col',
          resourceId: 'r1',
          input: jsonInput({ hello: 'world' })
        })
        await backend.deleteSpace({ spaceId: 'space-gone' })
        assert.equal(
          await backend.getSpaceDescription({ spaceId: 'space-gone' }),
          undefined
        )
        assert.equal(
          await backend.getResourceMetadata({
            spaceId: 'space-gone',
            collectionId: 'col',
            resourceId: 'r1'
          }),
          undefined
        )
      })
    })

    describe('resource round-trips and representation swap', () => {
      let harness: BackendHarness
      const spaceId = 'space-res'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('round-trips a JSON document byte-for-byte', async () => {
        const { backend } = harness
        const data = { a: 1, nested: { b: [1, 2, 3] } }
        const { version } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'doc',
          input: jsonInput(data)
        })
        assert.equal(version, 1)
        const result = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'doc'
        })
        assert.equal(result.storedResourceType, 'application/json')
        assert.equal(result.version, 1)
        assert.equal(
          await streamToString(result.resourceStream),
          JSON.stringify(data)
        )
      })

      it('round-trips a bare JSON primitive', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'primitive',
          input: jsonInput(null)
        })
        const result = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'primitive'
        })
        assert.equal(await streamToString(result.resourceStream), 'null')
      })

      it('round-trips a binary blob', async () => {
        const { backend } = harness
        const bytes = Buffer.from([0, 1, 2, 250, 251, 252])
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'blob',
          input: binaryInput(bytes)
        })
        const result = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'blob'
        })
        assert.equal(result.storedResourceType, 'application/octet-stream')
        const chunks: Buffer[] = []
        for await (const chunk of result.resourceStream) {
          chunks.push(Buffer.from(chunk))
        }
        assert.deepEqual(Buffer.concat(chunks), bytes)
      })

      it('a write under a new content-type replaces the single representation', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'swap',
          input: jsonInput({ was: 'json' })
        })
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'swap',
          input: binaryInput(Buffer.from('now text'), {
            contentType: 'text/plain'
          })
        })
        const result = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'swap'
        })
        assert.equal(result.storedResourceType, 'text/plain')
        assert.equal(result.version, 2)
        assert.equal(await streamToString(result.resourceStream), 'now text')
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'swap'
        })
        assert.equal(metadata?.contentType, 'text/plain')
      })

      it('getResourceMetadata reports contentType, size, timestamps, version', async () => {
        const { backend } = harness
        const data = { size: 'check' }
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'meta-check',
          input: jsonInput(data)
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'meta-check'
        })
        assert.ok(metadata)
        assert.equal(metadata.contentType, 'application/json')
        assert.equal(metadata.size, Buffer.byteLength(JSON.stringify(data)))
        assert.ok(metadata.createdAt)
        assert.ok(metadata.updatedAt)
        assert.equal(metadata.version, 1)
        assert.equal(metadata.metaVersion, undefined)
        assert.equal(metadata.custom, undefined)
      })
    })

    describe('version / metaVersion independence', () => {
      let harness: BackendHarness
      const spaceId = 'space-ver'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('content writes bump version; metadata writes bump only metaVersion', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          input: jsonInput({ v: 1 })
        })
        const meta1 = await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          custom: { name: 'First' }
        })
        assert.deepEqual(meta1, { metaVersion: 1 })

        const { version } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          input: jsonInput({ v: 2 })
        })
        assert.equal(version, 2)

        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'r'
        })
        // The content write preserved `custom` and the independent metaVersion.
        assert.equal(metadata?.metaVersion, 1)
        assert.equal(metadata?.version, 2)
        assert.deepEqual(metadata?.custom, { name: 'First' })

        const meta2 = await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          custom: { name: 'Second' }
        })
        assert.deepEqual(meta2, { metaVersion: 2 })
        const after = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'r'
        })
        // The metadata write did not bump the content version.
        assert.equal(after?.version, 2)
      })

      it('writeResourceMetadata resolves undefined for an absent Resource (no create)', async () => {
        assert.equal(
          await harness.backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'absent',
            custom: { name: 'x' }
          }),
          undefined
        )
      })

      it('an empty custom object clears the stored custom', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'clearable',
          input: jsonInput({})
        })
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'clearable',
          custom: { name: 'temp' }
        })
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'clearable',
          custom: {}
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'clearable'
        })
        assert.equal(metadata?.custom, undefined)
        assert.equal(metadata?.metaVersion, 2)
      })
    })

    describe('conditional-write preconditions', () => {
      let harness: BackendHarness
      const spaceId = 'space-cond'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('If-None-Match: * creates when absent, 412s when present', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'inm',
          input: jsonInput({ v: 1 }),
          ifNoneMatch: true
        })
        await expect(
          backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'inm',
            input: jsonInput({ v: 2 }),
            ifNoneMatch: true
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('If-Match matches the current ETag or 412s', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'im',
          input: jsonInput({ v: 1 })
        })
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'im',
          input: jsonInput({ v: 2 }),
          ifMatch: formatEtag(1)
        })
        await expect(
          backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'im',
            input: jsonInput({ v: 3 }),
            ifMatch: formatEtag(1)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('If-Match on an absent Resource 412s', async () => {
        await expect(
          harness.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'im-absent',
            input: jsonInput({}),
            ifMatch: formatEtag(1)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('conditional delete honors If-Match', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'del',
          input: jsonInput({ v: 1 })
        })
        await expect(
          backend.deleteResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'del',
            ifMatch: formatEtag(9)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'del',
          ifMatch: formatEtag(1)
        })
        await expect(
          backend.getResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'del'
          })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
      })

      it('a tombstone counts as absent, and the version continues through recreate', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tomb',
          input: jsonInput({ v: 1 })
        })
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tomb',
          input: jsonInput({ v: 2 })
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tomb'
        })
        // Tombstoned: If-Match cannot be satisfied ...
        await expect(
          backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'tomb',
            input: jsonInput({ v: 3 }),
            ifMatch: formatEtag(2)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        // ... while If-None-Match: * (create-if-absent) succeeds, and the
        // monotonic version continues past the tombstone's bump.
        const { version } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tomb',
          input: jsonInput({ v: 3 }),
          ifNoneMatch: true
        })
        assert.equal(version, 4)
      })

      it('metadata preconditions gate on metaVersion', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'mp',
          input: jsonInput({})
        })
        // If-None-Match: * -- only when no metadata has been written yet.
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'mp',
          custom: { name: 'a' },
          ifNoneMatch: true
        })
        await expect(
          backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'mp',
            custom: { name: 'b' },
            ifNoneMatch: true
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        await expect(
          backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'mp',
            custom: { name: 'b' },
            ifMatch: formatEtag(2)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        const result = await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'mp',
          custom: { name: 'b' },
          ifMatch: formatEtag(1)
        })
        assert.deepEqual(result, { metaVersion: 2 })
      })

      it('exactly one of N concurrent If-None-Match: * creators wins', async () => {
        // Create-if-absent must be atomic under concurrency: the filesystem
        // backend serializes on its per-Resource mutex, the Postgres backend
        // arbitrates on the primary key -- either way, one 201 and N-1 412s,
        // never a silent overwrite.
        const attempts = await Promise.allSettled(
          Array.from({ length: 8 }, (_, index) =>
            harness.backend.writeResource({
              spaceId,
              collectionId: 'col',
              resourceId: 'race-create',
              input: jsonInput({ writer: index }),
              ifNoneMatch: true
            })
          )
        )
        const winners = attempts.filter(
          attempt => attempt.status === 'fulfilled'
        )
        const losers = attempts.filter(
          attempt =>
            attempt.status === 'rejected' &&
            attempt.reason instanceof PreconditionFailedError
        )
        assert.equal(winners.length, 1)
        assert.equal(losers.length, attempts.length - 1)
        // The surviving representation is the winner's, at version 1.
        const metadata = await harness.backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'race-create'
        })
        assert.equal(metadata?.version, 1)
      })

      it('unconditional delete of a tombstone is a stable no-op', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'redelete',
          input: jsonInput({})
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'redelete'
        })
        const feed1 = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        const tomb1 = feed1.documents.find(
          document => document.resourceId === 'redelete'
        )
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'redelete'
        })
        const feed2 = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        const tomb2 = feed2.documents.find(
          document => document.resourceId === 'redelete'
        )
        assert.deepEqual(tomb2, tomb1)
      })
    })

    describe('pagination', () => {
      let harness: BackendHarness
      const spaceId = 'space-page'
      const ids = ['a1', 'a2', 'b1', 'b2', 'c1']
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
        for (const resourceId of ids) {
          await harness.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId,
            input: jsonInput({ id: resourceId })
          })
        }
        // A tombstone must be invisible to listings.
        await harness.backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'zz-deleted',
          input: jsonInput({})
        })
        await harness.backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'zz-deleted'
        })
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('pages in ascending id order with a cursor chain and totalItems', async () => {
        const { backend } = harness
        const page1 = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: 2
        })
        assert.equal(page1.totalItems, ids.length)
        assert.deepEqual(
          page1.items.map(item => item.id),
          ['a1', 'a2']
        )
        assert.ok(page1.next)

        const cursor1 = new URL(page1.next!, 'http://x').searchParams.get(
          'cursor'
        )!
        const page2 = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: 2,
          cursor: cursor1
        })
        assert.deepEqual(
          page2.items.map(item => item.id),
          ['b1', 'b2']
        )
        assert.ok(page2.next)

        const cursor2 = new URL(page2.next!, 'http://x').searchParams.get(
          'cursor'
        )!
        const page3 = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: 2,
          cursor: cursor2
        })
        assert.deepEqual(
          page3.items.map(item => item.id),
          ['c1']
        )
        assert.equal(page3.next, undefined)
      })

      it('a page that exactly fills the Collection has no trailing empty page', async () => {
        const page = await harness.backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: ids.length
        })
        assert.equal(page.items.length, ids.length)
        assert.equal(page.next, undefined)
      })

      it('rejects a malformed cursor with InvalidCursorError', async () => {
        await expect(
          harness.backend.listCollectionItems({
            spaceId,
            collectionId: 'col',
            cursor: '!!!not-base64url!!!'
          })
        ).rejects.toBeInstanceOf(InvalidCursorError)
      })

      it('surfaces custom.name in listings', async () => {
        const { backend } = harness
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'a1',
          custom: { name: 'Named Resource' }
        })
        const page = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: 1
        })
        assert.equal(page.items[0]!.name, 'Named Resource')
      })
    })

    describe('changes feed', () => {
      let harness: BackendHarness
      const spaceId = 'space-feed'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('orders by (updatedAt, resourceId), resumes from a checkpoint, and carries tombstones', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'one',
          input: jsonInput({ n: 1 })
        })
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'two',
          input: jsonInput({ n: 2 })
        })
        // Binary resources are excluded from the feed.
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'bin',
          input: binaryInput(Buffer.from('x'))
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'one'
        })

        const full = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        assert.deepEqual(
          full.documents.map(document => document.resourceId),
          ['two', 'one']
        )
        const [live, tombstone] = full.documents
        assert.equal(live!.deleted, false)
        assert.deepEqual(live!.data, { n: 2 })
        assert.equal(tombstone!.deleted, true)
        assert.equal(tombstone!.data, undefined)
        assert.equal(tombstone!.version, 2)
        assert.deepEqual(full.checkpoint, {
          id: tombstone!.resourceId,
          updatedAt: tombstone!.updatedAt
        })

        // Paged: limit 1, then resume from the returned checkpoint.
        const page1 = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 1
        })
        assert.equal(page1.documents.length, 1)
        const page2 = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          checkpoint: page1.checkpoint!,
          limit: 10
        })
        assert.deepEqual(
          page2.documents.map(document => document.resourceId),
          ['one']
        )

        // Nothing after the final checkpoint.
        const done = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          checkpoint: full.checkpoint!,
          limit: 10
        })
        assert.deepEqual(done.documents, [])
        assert.equal(done.checkpoint, null)
      })

      it('a metadata-only edit re-surfaces the Resource with custom, unchanged data/version', async () => {
        const { backend } = harness
        const before = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'two',
          custom: { name: 'Two' }
        })
        const after = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          checkpoint: before.checkpoint!,
          limit: 100
        })
        assert.deepEqual(
          after.documents.map(document => document.resourceId),
          ['two']
        )
        const doc = after.documents[0]!
        assert.equal(doc.version, 1)
        assert.equal(doc.metaVersion, 1)
        assert.deepEqual(doc.data, { n: 2 })
        assert.deepEqual(doc.custom, { name: 'Two' })
      })
    })

    describe('quotas and upload caps', () => {
      // Capacities are sized generously (hundreds of KB) so the filesystem
      // backend's `du` figure -- which includes description files and block
      // overhead -- stays negligible next to the resource bodies.
      it('rejects a write that would exceed capacity with QuotaExceededError (507)', async () => {
        const harness = await makeBackend({ capacityBytes: 200_000 })
        try {
          await provisionSpace(harness.backend, 'space-q')
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-q',
              collectionId: 'col',
              resourceId: 'big',
              input: binaryInput(Buffer.alloc(300_000))
            })
          ).rejects.toBeInstanceOf(QuotaExceededError)
        } finally {
          await harness.cleanup()
        }
      })

      it('rejects an oversize upload with PayloadTooLargeError (413)', async () => {
        const harness = await makeBackend({ maxUploadBytes: 64 })
        try {
          await provisionSpace(harness.backend, 'space-413')
          // Known-size JSON body over the cap.
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-413',
              collectionId: 'col',
              resourceId: 'json-big',
              input: jsonInput({ blob: 'x'.repeat(200) })
            })
          ).rejects.toBeInstanceOf(PayloadTooLargeError)
          // Declared-size binary over the cap.
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-413',
              collectionId: 'col',
              resourceId: 'declared-big',
              input: binaryInput(Buffer.alloc(128), { declaredBytes: 128 })
            })
          ).rejects.toBeInstanceOf(PayloadTooLargeError)
          // Undeclared-size stream over the cap (caught by the counting guard).
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-413',
              collectionId: 'col',
              resourceId: 'stream-big',
              input: binaryInput(Buffer.alloc(128))
            })
          ).rejects.toBeInstanceOf(PayloadTooLargeError)
          // A small write still succeeds.
          await harness.backend.writeResource({
            spaceId: 'space-413',
            collectionId: 'col',
            resourceId: 'small',
            input: binaryInput(Buffer.alloc(16))
          })
        } finally {
          await harness.cleanup()
        }
      })

      it('reports usage and derived state', async () => {
        const harness = await makeBackend({ capacityBytes: 1_000_000 })
        try {
          await provisionSpace(harness.backend, 'space-report')
          const body = Buffer.alloc(100_000)
          await harness.backend.writeResource({
            spaceId: 'space-report',
            collectionId: 'col',
            resourceId: 'r',
            input: binaryInput(body)
          })
          const usage = await harness.backend.reportUsage({
            spaceId: 'space-report',
            includeCollections: true
          })
          assert.equal(usage.state, 'ok')
          assert.deepEqual(usage.limit, {
            capacityBytes: 1_000_000,
            isUnlimited: false
          })
          if (exactUsage) {
            assert.equal(usage.usageBytes, body.length)
            assert.deepEqual(usage.usageByCollection, [
              { id: 'col', usageBytes: body.length }
            ])
          } else {
            // The filesystem figure comes from `du`, whose units and rounding
            // are platform-dependent (macOS BSD `du` reports 512-byte block
            // counts); only its presence and shape are asserted here.
            assert.ok(usage.usageBytes >= 0)
          }
        } finally {
          await harness.cleanup()
        }
      })

      it('a delete frees quota headroom', async () => {
        const harness = await makeBackend({ capacityBytes: 200_000 })
        // Sizes are declared up front: the filesystem's cumulative accounting
        // counts declared bytes between `du` re-measurements, while an
        // undeclared stream is only TTL-bounded (its documented soft spot).
        const body = () =>
          binaryInput(Buffer.alloc(150_000), { declaredBytes: 150_000 })
        try {
          await provisionSpace(harness.backend, 'space-free')
          await harness.backend.writeResource({
            spaceId: 'space-free',
            collectionId: 'col',
            resourceId: 'a',
            input: body()
          })
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-free',
              collectionId: 'col',
              resourceId: 'b',
              input: body()
            })
          ).rejects.toBeInstanceOf(QuotaExceededError)
          await harness.backend.deleteResource({
            spaceId: 'space-free',
            collectionId: 'col',
            resourceId: 'a'
          })
          await harness.backend.writeResource({
            spaceId: 'space-free',
            collectionId: 'col',
            resourceId: 'b',
            input: body()
          })
        } finally {
          await harness.cleanup()
        }
      })

      // The hard-limit-under-concurrency guarantee: N concurrent writers race
      // for headroom that only fits some of them; the accepted total must
      // never overshoot. Only the transactional (Postgres) accounting passes
      // this strictly -- the filesystem's documented soft limit skips it.
      it.runIf(hardQuota)(
        'enforces the quota as a hard limit under concurrent writers',
        async () => {
          const bodyBytes = 1000
          const capacityBytes = 3500 // fits 3 of 8 writers
          const harness = await makeBackend({ capacityBytes })
          try {
            await provisionSpace(harness.backend, 'space-race')
            const attempts = await Promise.allSettled(
              Array.from({ length: 8 }, (_, index) =>
                harness.backend.writeResource({
                  spaceId: 'space-race',
                  collectionId: 'col',
                  resourceId: `racer-${index}`,
                  input: binaryInput(Buffer.alloc(bodyBytes))
                })
              )
            )
            const accepted = attempts.filter(
              attempt => attempt.status === 'fulfilled'
            ).length
            const rejected = attempts.filter(
              attempt =>
                attempt.status === 'rejected' &&
                attempt.reason instanceof QuotaExceededError
            ).length
            assert.equal(accepted, 3)
            assert.equal(rejected, 5)
            const usage = await harness.backend.reportUsage({
              spaceId: 'space-race'
            })
            assert.equal(usage.usageBytes, accepted * bodyBytes)
          } finally {
            await harness.cleanup()
          }
        }
      )
    })

    describe('count quotas', () => {
      // Small caps (2-3) keep these fast; both backends enforce on the create
      // path only, reusing the `quota-exceeded` (507) problem type.
      function assertCountQuota(error: unknown): void {
        assert.ok(
          error instanceof CountQuotaExceededError,
          `expected CountQuotaExceededError, got ${error}`
        )
        assert.equal(error.statusCode, 507)
        assert.ok(error.type.endsWith('#quota-exceeded'))
      }

      it('rejects a Space create beyond maxSpacesPerController; a different controller is unaffected', async () => {
        const harness = await makeBackend({ maxSpacesPerController: 2 })
        const alice = 'did:key:z6MkCountAlice' as IDID
        const bob = 'did:key:z6MkCountBob' as IDID
        const writeSpace = (spaceId: string, controller: IDID) =>
          harness.backend.writeSpace({
            spaceId,
            spaceDescription: {
              id: spaceId,
              type: ['Space'],
              name: spaceId,
              controller
            }
          })
        try {
          await writeSpace('cq-a1', alice)
          await writeSpace('cq-a2', alice)
          let error: unknown
          try {
            await writeSpace('cq-a3', alice)
          } catch (err) {
            error = err
          }
          assertCountQuota(error)
          // Overwriting an existing Space's description still succeeds at the
          // limit (an update is not a create).
          await writeSpace('cq-a1', alice)
          // A different controller can still create.
          await writeSpace('cq-b1', bob)
        } finally {
          await harness.cleanup()
        }
      })

      it('rejects a Collection create beyond maxCollectionsPerSpace; overwriting an existing one still succeeds', async () => {
        const harness = await makeBackend({ maxCollectionsPerSpace: 2 })
        const writeCollection = (collectionId: string) =>
          harness.backend.writeCollection({
            spaceId: 'cq-cols',
            collectionId,
            collectionDescription: {
              id: collectionId,
              type: ['Collection'],
              name: collectionId
            }
          })
        try {
          // provisionSpace writes the Space plus one Collection ('col'); add
          // one more to reach the cap of 2.
          await provisionSpace(harness.backend, 'cq-cols')
          await writeCollection('col2')
          let error: unknown
          try {
            await writeCollection('col3')
          } catch (err) {
            error = err
          }
          assertCountQuota(error)
          // Overwriting an existing Collection description at the limit is fine.
          await writeCollection('col2')
        } finally {
          await harness.cleanup()
        }
      })

      it('rejects a Resource create beyond maxResourcesPerSpace; overwrite succeeds and a delete frees a slot', async () => {
        const harness = await makeBackend({ maxResourcesPerSpace: 2 })
        const writeResource = (resourceId: string) =>
          harness.backend.writeResource({
            spaceId: 'cq-res',
            collectionId: 'col',
            resourceId,
            input: jsonInput({ id: resourceId })
          })
        try {
          await provisionSpace(harness.backend, 'cq-res')
          await writeResource('r1')
          await writeResource('r2')
          let error: unknown
          try {
            await writeResource('r3')
          } catch (err) {
            error = err
          }
          assertCountQuota(error)
          // Overwriting an existing live Resource at the limit still succeeds.
          await writeResource('r1')
          // Deleting one frees a slot for a new create.
          await harness.backend.deleteResource({
            spaceId: 'cq-res',
            collectionId: 'col',
            resourceId: 'r1'
          })
          await writeResource('r3')
        } finally {
          await harness.cleanup()
        }
      })

      it('rejects an import that would create more Collections than maxCollectionsPerSpace allows', async () => {
        const source = await makeBackend()
        const target = await makeBackend({ maxCollectionsPerSpace: 2 })
        try {
          const spaceId = 'cq-imp-cols'
          // Source Space with three Collections (each carrying a Resource so
          // the Collection travels in the export).
          await provisionSpace(source.backend, spaceId) // 'col'
          for (const collectionId of ['c2', 'c3']) {
            await source.backend.writeCollection({
              spaceId,
              collectionId,
              collectionDescription: {
                id: collectionId,
                type: ['Collection'],
                name: collectionId
              }
            })
          }
          for (const collectionId of ['col', 'c2', 'c3']) {
            await source.backend.writeResource({
              spaceId,
              collectionId,
              resourceId: 'doc',
              input: jsonInput({ id: collectionId })
            })
          }
          const tarStream = await source.backend.exportSpace({ spaceId })
          // Target already holds 'col' (1 of 2). The import creates a second
          // Collection (reaching the cap) then a third, which exceeds it.
          await provisionSpace(target.backend, spaceId)
          let error: unknown
          try {
            await target.backend.importSpace({ spaceId, tarStream })
          } catch (err) {
            error = err
          }
          assertCountQuota(error)
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })

      it('rejects an import that would create more Resources than maxResourcesPerSpace allows', async () => {
        const source = await makeBackend()
        const target = await makeBackend({ maxResourcesPerSpace: 2 })
        try {
          const spaceId = 'cq-imp-res'
          await provisionSpace(source.backend, spaceId)
          for (const resourceId of ['r1', 'r2', 'r3']) {
            await source.backend.writeResource({
              spaceId,
              collectionId: 'col',
              resourceId,
              input: jsonInput({ id: resourceId })
            })
          }
          const tarStream = await source.backend.exportSpace({ spaceId })
          // Target starts with zero Resources; the third created Resource
          // exceeds the cap of 2.
          await provisionSpace(target.backend, spaceId)
          let error: unknown
          try {
            await target.backend.importSpace({ spaceId, tarStream })
          } catch (err) {
            error = err
          }
          assertCountQuota(error)
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })

      it('allows an import that only re-imports existing (skipped) items at the limit', async () => {
        const source = await makeBackend()
        const target = await makeBackend({
          maxCollectionsPerSpace: 1,
          maxResourcesPerSpace: 2
        })
        try {
          const spaceId = 'cq-imp-skip'
          await provisionSpace(source.backend, spaceId)
          for (const resourceId of ['r1', 'r2']) {
            await source.backend.writeResource({
              spaceId,
              collectionId: 'col',
              resourceId,
              input: jsonInput({ id: resourceId })
            })
          }
          const tarStream = await source.backend.exportSpace({ spaceId })
          // Target already holds the identical Space exactly at both caps (1
          // Collection, 2 live Resources); re-importing the same archive skips
          // every item, so no create is attempted and nothing is rejected.
          await provisionSpace(target.backend, spaceId)
          for (const resourceId of ['r1', 'r2']) {
            await target.backend.writeResource({
              spaceId,
              collectionId: 'col',
              resourceId,
              input: jsonInput({ id: resourceId })
            })
          }
          const stats = await target.backend.importSpace({ spaceId, tarStream })
          assert.equal(stats.collectionsCreated, 0)
          assert.equal(stats.collectionsSkipped, 1)
          assert.equal(stats.resourcesCreated, 0)
          assert.equal(stats.resourcesSkipped, 2)
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })

      it('the default-on limits (100/100/10000) do not trip normal writes', async () => {
        // A backend built with no count options still has the defaults active;
        // provisioning and a handful of writes must not be rejected.
        const harness = await makeBackend()
        try {
          await provisionSpace(harness.backend, 'cq-default')
          for (const resourceId of ['x1', 'x2', 'x3']) {
            await harness.backend.writeResource({
              spaceId: 'cq-default',
              collectionId: 'col',
              resourceId,
              input: jsonInput({ id: resourceId })
            })
          }
        } finally {
          await harness.cleanup()
        }
      })
    })

    describe('policies', () => {
      let harness: BackendHarness
      const spaceId = 'space-pol'
      const policy = { rules: [] } as unknown as Parameters<
        StorageBackend['writePolicy']
      >[0]['policy']
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('stores independent policies at all three levels', async () => {
        const { backend } = harness
        await backend.writePolicy({ spaceId, policy })
        await backend.writePolicy({ spaceId, collectionId: 'col', policy })
        await backend.writePolicy({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          policy
        })
        assert.ok(await backend.getPolicy({ spaceId }))
        assert.ok(await backend.getPolicy({ spaceId, collectionId: 'col' }))
        assert.ok(
          await backend.getPolicy({
            spaceId,
            collectionId: 'col',
            resourceId: 'r'
          })
        )
        await backend.deletePolicy({ spaceId, collectionId: 'col' })
        assert.equal(
          await backend.getPolicy({ spaceId, collectionId: 'col' }),
          undefined
        )
        // The other two levels are untouched.
        assert.ok(await backend.getPolicy({ spaceId }))
        assert.ok(
          await backend.getPolicy({
            spaceId,
            collectionId: 'col',
            resourceId: 'r'
          })
        )
      })
    })

    describe('registered external backends', () => {
      let harness: BackendHarness
      const spaceId = 'space-back'
      const record: StoredBackendRecord = {
        id: 'gdrive-1',
        name: 'Drive',
        managedBy: 'external',
        provider: 'gdrive',
        connection: {
          kind: 'oauth-token',
          accessToken: 'SECRET-TOKEN'
        } as unknown as StoredBackendRecord['connection']
      }
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('round-trips the full record via getBackend and sanitizes listings', async () => {
        const { backend } = harness
        await backend.writeBackend({
          spaceId,
          backendId: record.id,
          record
        })
        const stored = await backend.getBackend({
          spaceId,
          backendId: record.id
        })
        assert.deepEqual(stored, record)
        const listed = await backend.listBackends({ spaceId })
        assert.equal(listed.length, 1)
        assert.equal(listed[0]!.id, record.id)
        // The secret boundary: no raw connection material in the listing.
        assert.equal(JSON.stringify(listed).includes('SECRET-TOKEN'), false)
        await backend.deleteBackend({ spaceId, backendId: record.id })
        assert.equal(
          await backend.getBackend({ spaceId, backendId: record.id }),
          undefined
        )
      })
    })

    describe('WebKMS keystores, keys, revocations', () => {
      let harness: BackendHarness
      beforeAll(async () => {
        harness = await makeBackend()
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('updateKeystore gates on sequence and module immutability', async () => {
        const { backend } = harness
        await backend.writeKeystore({
          keystoreId: 'ks1',
          config: keystoreConfig('ks1')
        })
        // Happy path: sequence exactly previous + 1.
        await backend.updateKeystore({
          keystoreId: 'ks1',
          config: keystoreConfig('ks1', { sequence: 1 })
        })
        assert.equal(
          (await backend.getKeystore({ keystoreId: 'ks1' }))?.sequence,
          1
        )
        // Stale sequence.
        await expect(
          backend.updateKeystore({
            keystoreId: 'ks1',
            config: keystoreConfig('ks1', { sequence: 1 })
          })
        ).rejects.toBeInstanceOf(KeystoreStateConflictError)
        // Module change.
        await expect(
          backend.updateKeystore({
            keystoreId: 'ks1',
            config: keystoreConfig('ks1', {
              sequence: 2,
              kmsModule: 'other-module'
            })
          })
        ).rejects.toBeInstanceOf(KeystoreStateConflictError)
        // Missing keystore.
        await expect(
          backend.updateKeystore({
            keystoreId: 'missing',
            config: keystoreConfig('missing', { sequence: 1 })
          })
        ).rejects.toBeInstanceOf(KeystoreStateConflictError)
      })

      it('lists keystores by controller, sorted by local id', async () => {
        const { backend } = harness
        await backend.writeKeystore({
          keystoreId: 'ks3',
          config: keystoreConfig('ks3')
        })
        await backend.writeKeystore({
          keystoreId: 'ks2',
          config: keystoreConfig('ks2')
        })
        await backend.writeKeystore({
          keystoreId: 'other',
          config: keystoreConfig('other', {
            controller: 'did:key:z6MkSomeoneElse' as IDID
          })
        })
        const configs = await backend.listKeystoresByController({
          controller: CONTROLLER
        })
        assert.deepEqual(
          configs.map(config => config.id.split('/').pop()),
          ['ks1', 'ks2', 'ks3']
        )
      })

      it('insertKey is create-only (409 on duplicate) and round-trips the opaque record', async () => {
        const { backend } = harness
        const record = keyRecord('ks1', 'key1')
        await backend.insertKey({
          keystoreId: 'ks1',
          localId: 'key1',
          record
        })
        assert.deepEqual(
          await backend.getKey({ keystoreId: 'ks1', localId: 'key1' }),
          record
        )
        await expect(
          backend.insertKey({ keystoreId: 'ks1', localId: 'key1', record })
        ).rejects.toBeInstanceOf(KeyIdConflictError)
      })

      it('listKeys resolves empty for an empty keystore and sorts by local id', async () => {
        const { backend } = harness
        await backend.writeKeystore({
          keystoreId: 'ks-list',
          config: keystoreConfig('ks-list')
        })
        // No keys yet (nor any keys/ directory): an empty list, not a throw.
        assert.deepEqual(await backend.listKeys({ keystoreId: 'ks-list' }), [])
        // Insert out of order; listKeys returns them sorted by local id with
        // the opaque record round-tripped verbatim.
        const inserted = new Map<string, KmsKeyRecord>()
        for (const localId of ['key3', 'key1', 'key2']) {
          const record = keyRecord('ks-list', localId)
          inserted.set(localId, record)
          await backend.insertKey({ keystoreId: 'ks-list', localId, record })
        }
        const listed = await backend.listKeys({ keystoreId: 'ks-list' })
        assert.deepEqual(
          listed.map(entry => entry.localId),
          ['key1', 'key2', 'key3']
        )
        assert.deepEqual(listed[0]!.record, inserted.get('key1'))
      })

      it('listKeys on an unknown keystore resolves empty (no keys directory)', async () => {
        const { backend } = harness
        assert.deepEqual(await backend.listKeys({ keystoreId: 'nope' }), [])
      })

      it('insertRevocation is create-only and isRevoked consults unexpired records', async () => {
        const { backend } = harness
        const record = revocationRecord({
          capabilityId: 'urn:zcap:revoked-1',
          delegator: 'did:key:z6MkDelegator'
        })
        await backend.insertRevocation({ keystoreId: 'ks1', record })
        await expect(
          backend.insertRevocation({ keystoreId: 'ks1', record })
        ).rejects.toBeInstanceOf(DuplicateRevocationError)
        assert.equal(
          await backend.isRevoked({
            keystoreId: 'ks1',
            capabilities: [
              {
                capabilityId: 'urn:zcap:revoked-1',
                delegator: 'did:key:z6MkDelegator'
              }
            ]
          }),
          true
        )
        assert.equal(
          await backend.isRevoked({
            keystoreId: 'ks1',
            capabilities: [
              {
                capabilityId: 'urn:zcap:other',
                delegator: 'did:key:z6MkDelegator'
              }
            ]
          }),
          false
        )
      })

      it('an expired revocation counts as not revoked (pruned on the way through)', async () => {
        const { backend } = harness
        const expired = revocationRecord({
          capabilityId: 'urn:zcap:expired-1',
          delegator: 'did:key:z6MkDelegator',
          expires: new Date(Date.now() - 60_000).toISOString()
        })
        await backend.insertRevocation({ keystoreId: 'ks1', record: expired })
        assert.equal(
          await backend.isRevoked({
            keystoreId: 'ks1',
            capabilities: [
              {
                capabilityId: 'urn:zcap:expired-1',
                delegator: 'did:key:z6MkDelegator'
              }
            ]
          }),
          false
        )
      })

      it('deleteSpace leaves keystores untouched (sibling tree)', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-kms')
        await backend.deleteSpace({ spaceId: 'space-kms' })
        assert.ok(await backend.getKeystore({ keystoreId: 'ks1' }))
      })
    })

    describe('export / import round-trip', () => {
      it('round-trips a Space (descriptions, resources, policies, metadata, tombstones) within the backend', async () => {
        const source = await makeBackend()
        const target = await makeBackend()
        try {
          const spaceId = 'space-exp'
          await provisionSpace(source.backend, spaceId)
          await source.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc',
            input: jsonInput({ keep: true })
          })
          await source.backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc',
            custom: { name: 'Doc' }
          })
          await source.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'gone',
            input: jsonInput({ keep: false })
          })
          await source.backend.deleteResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'gone'
          })
          await source.backend.writePolicy({
            spaceId,
            policy: { space: true } as never
          })
          await source.backend.writePolicy({
            spaceId,
            collectionId: 'col',
            policy: { collection: true } as never
          })
          await source.backend.writePolicy({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc',
            policy: { resource: true } as never
          })
          // Backend registration records must NOT travel in an export.
          await source.backend.writeBackend({
            spaceId,
            backendId: 'ext',
            record: {
              id: 'ext',
              managedBy: 'external',
              provider: 'x',
              connection: { kind: 'token', secret: 'DO-NOT-EXPORT' } as never
            }
          })

          const tarStream = await source.backend.exportSpace({ spaceId })
          // Provision the destination Space (import merges into an existing
          // Space, as the request layer guarantees).
          await provisionSpace(target.backend, spaceId)
          await target.backend.deletePolicy({ spaceId })
          const stats = await target.backend.importSpace({
            spaceId,
            tarStream
          })
          assert.equal(stats.collectionsSkipped, 1) // 'col' pre-provisioned
          assert.equal(stats.resourcesCreated, 2) // doc + the tombstone
          assert.equal(stats.policiesCreated, 2) // space + resource policy
          assert.equal(stats.policiesSkipped, 1) // collection policy skipped

          const result = await target.backend.getResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc'
          })
          assert.equal(
            await streamToString(result.resourceStream),
            JSON.stringify({ keep: true })
          )
          const metadata = await target.backend.getResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc'
          })
          assert.deepEqual(metadata?.custom, { name: 'Doc' })

          // The tombstone carried over: invisible to reads, blocks
          // resurrection, and still replicates through the feed.
          await expect(
            target.backend.getResource({
              spaceId,
              collectionId: 'col',
              resourceId: 'gone'
            })
          ).rejects.toBeInstanceOf(ResourceNotFoundError)
          const feed = await target.backend.changesSince!({
            spaceId,
            collectionId: 'col',
            limit: 100
          })
          const tombstone = feed.documents.find(
            document => document.resourceId === 'gone'
          )
          assert.equal(tombstone?.deleted, true)

          // No secret-bearing backend record traveled.
          assert.equal(
            await target.backend.getBackend({ spaceId, backendId: 'ext' }),
            undefined
          )
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })
    })
  })
}
