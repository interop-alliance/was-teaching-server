/**
 * Unit tests for the self-hosted `did:webvh` resolution cache and its
 * invalidation gate (`resolveWebvhController` /
 * `invalidateResolvedWebvhDid`), driven directly against a `FileSystemBackend`
 * rather than through HTTP.
 *
 * Cache entries are keyed by the log's location (Space plus Collection) and the
 * DID, so what is pinned here is the scoping of the gate: a Resource write that
 * is not `did.jsonl` invalidates nothing, a Collection-scoped invalidation drops
 * only that Collection's entries, and a Space-scoped one drops them all.
 *
 * The observation trick: after a document is cached, the stored log is
 * overwritten with garbage *behind the resolver's back* (a direct backend
 * write, which runs none of the request-layer invalidation). A resolve that
 * still succeeds was served from the cache; one that throws re-read the log.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createDID,
  logToJsonlString,
  signerFromExternalKey
} from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import {
  invalidateResolvedWebvhDid,
  resolveWebvhController
} from '../src/lib/webvhController.js'

/**
 * The base URL the DIDs under test are anchored at. No server listens on it:
 * resolution is a storage read, so the host only has to match the DID string.
 */
const serverUrl = 'http://localhost:9999'

describe('did:webvh resolution cache invalidation', () => {
  let dataDir: string, storage: FileSystemBackend, spaceId: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    storage = new FileSystemBackend({ dataDir })
    spaceId = randomUUID()
    await storage.writeSpace({
      spaceId,
      spaceDescription: {
        id: spaceId,
        type: ['Space'],
        controller: 'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD'
      }
    })
  })
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  /**
   * Writes a Resource straight to the backend, bypassing the request layer (and
   * therefore its invalidation calls).
   *
   * @param options {object}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.text {string}   the Resource body
   * @returns {Promise<void>}
   */
  async function writeText({
    collectionId,
    resourceId,
    text
  }: {
    collectionId: string
    resourceId: string
    text: string
  }): Promise<void> {
    await storage.writeResource({
      spaceId,
      collectionId,
      resourceId,
      input: {
        kind: 'binary',
        contentType: 'text/plain',
        stream: Readable.from([Buffer.from(text)])
      }
    })
  }

  /**
   * Mints a `did:webvh` anchored in `collectionId` of the suite's Space, creates
   * that Collection, and publishes the DID's history log into it.
   *
   * @param options {object}
   * @param options.collectionId {string}
   * @returns {Promise<{ did: string, jsonl: string }>}
   */
  async function publishDid({
    collectionId
  }: {
    collectionId: string
  }): Promise<{ did: string; jsonl: string }> {
    const updateKeyPair = await Ed25519VerificationKey.generate()
    updateKeyPair.id =
      `did:key:${updateKeyPair.publicKeyMultibase}` +
      `#${updateKeyPair.publicKeyMultibase}`
    const logSigner = signerFromExternalKey({
      publicKeyMultibase: updateKeyPair.publicKeyMultibase!,
      sign: async ({ data }: { data: Uint8Array }) =>
        await updateKeyPair.signer().sign({ data })
    })
    const clientKeyPair = await Ed25519VerificationKey.generate()
    const created = await createDID({
      address: `${serverUrl}/space/${spaceId}/${collectionId}`,
      signer: logSigner,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: [
        {
          type: 'Multikey',
          publicKeyMultibase: clientKeyPair.publicKeyMultibase!,
          purpose: ['authentication', 'capabilityInvocation']
        }
      ]
    })
    await storage.writeCollection({
      spaceId,
      collectionId,
      collectionDescription: {
        id: collectionId,
        type: ['Collection'],
        name: collectionId
      }
    })
    const jsonl = logToJsonlString(created.log)
    await writeText({ collectionId, resourceId: 'did.jsonl', text: jsonl })
    return { did: created.did, jsonl }
  }

  /**
   * Whether `did` currently resolves against whatever log is in storage (or the
   * cache).
   *
   * @param did {string}
   * @returns {Promise<boolean>}
   */
  async function resolves(did: string): Promise<boolean> {
    try {
      await resolveWebvhController({ storage, serverUrl, did })
      return true
    } catch {
      return false
    }
  }

  /** A published DID, its Collection, and the log text that resolves it. */
  interface PublishedDid {
    did: string
    jsonl: string
    collectionId: string
  }

  let first: PublishedDid, second: PublishedDid

  beforeAll(async () => {
    first = {
      collectionId: 'clientAnnex-0',
      ...(await publishDid({ collectionId: 'clientAnnex-0' }))
    }
    second = {
      collectionId: 'clientAnnex-1',
      ...(await publishDid({ collectionId: 'clientAnnex-1' }))
    }
  })

  /**
   * Puts a DID's cache entry into the state every test below starts from:
   * cached from a valid log, with the stored log then corrupted behind the
   * resolver's back. A subsequent resolve therefore succeeds iff the entry is
   * still cached. Re-warmed per test rather than once, so the cache TTL never
   * decides an assertion.
   *
   * @param entry {PublishedDid}
   * @returns {Promise<void>}
   */
  async function warm(entry: PublishedDid): Promise<void> {
    const { collectionId } = entry
    await writeText({
      collectionId,
      resourceId: 'did.jsonl',
      text: entry.jsonl
    })
    invalidateResolvedWebvhDid({ storage, spaceId, collectionId })
    assert.equal(await resolves(entry.did), true)
    await writeText({
      collectionId,
      resourceId: 'did.jsonl',
      text: 'not a history log'
    })
  }

  it('serves the cached document until something invalidates it', async () => {
    await warm(first)
    assert.equal(await resolves(first.did), true)
  })

  it('a write of a Resource other than did.jsonl invalidates nothing', async () => {
    await warm(first)
    invalidateResolvedWebvhDid({
      storage,
      spaceId,
      collectionId: first.collectionId,
      resourceId: 'some-other-resource'
    })
    assert.equal(await resolves(first.did), true)
  })

  it('a Collection-scoped invalidation drops only that Collection', async () => {
    await warm(first)
    await warm(second)
    invalidateResolvedWebvhDid({
      storage,
      spaceId,
      collectionId: first.collectionId
    })
    // The corrupted log is re-read for the invalidated Collection...
    assert.equal(await resolves(first.did), false)
    // ...while the other Collection's document is still cached.
    assert.equal(await resolves(second.did), true)
  })

  it('a did.jsonl write invalidates, scoped to the written Collection', async () => {
    await warm(first)
    await warm(second)
    invalidateResolvedWebvhDid({
      storage,
      spaceId,
      collectionId: first.collectionId,
      resourceId: 'did.jsonl'
    })
    assert.equal(await resolves(first.did), false)
    assert.equal(await resolves(second.did), true)
  })

  it('omitting the collectionId drops every entry in the Space', async () => {
    await warm(first)
    await warm(second)
    invalidateResolvedWebvhDid({ storage, spaceId })
    assert.equal(await resolves(first.did), false)
    assert.equal(await resolves(second.did), false)
  })

  it('an invalidation for another Space leaves this Space cached', async () => {
    await warm(first)
    invalidateResolvedWebvhDid({ storage, spaceId: randomUUID() })
    assert.equal(await resolves(first.did), true)
  })
})
