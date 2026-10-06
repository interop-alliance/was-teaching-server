/**
 * Where the filesystem backend keeps a policy's changes-feed position. A
 * Collection's own policy and each Resource policy carry their position in
 * their own policy file, as `_feedPosition`. The Collection's feed counter
 * holds only the generation, the last position, and the positions of the
 * Collection Metadata object and the governing log, so its size does not
 * depend on how many policies the Collection holds. The position is
 * server-local: no policy read and no export archive carries it.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import path from 'node:path'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resourcePolicyFileName } from '@interop/space-archive'
import { extractTarEntries } from '../src/lib/importTar.js'
import {
  importedPolicy,
  normalizePolicyWrite
} from '../src/lib/policyRecord.js'
import type { FeedDocument } from '../src/types.js'
import {
  importArchive,
  openTempBackend,
  type TempFileSystemBackend
} from './helpers.js'

const spaceId = 'policy-feed-space'
const collectionId = 'notes'
const POLICY_COUNT = 40

describe('FileSystemBackend policy feed positions', () => {
  let backend: TempFileSystemBackend
  let collectionDir: string
  let counterPath: string

  beforeEach(async () => {
    backend = await openTempBackend({ prefix: 'was-policy-feed-' })
    collectionDir = path.join(backend.dataDir, 'spaces', spaceId, collectionId)
    counterPath = path.join(collectionDir, `.feed.${collectionId}.json`)
    await backend.writeSpace({
      spaceId,
      spaceMetadata: {
        id: spaceId,
        type: ['Space'],
        controller: 'did:key:test-controller'
      }
    })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: { id: collectionId, type: ['Collection'] }
    })
  })
  afterEach(async () => {
    await backend.close()
  })

  /**
   * Writes a JSON Resource.
   */
  async function writeDoc(resourceId: string, value: number): Promise<void> {
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId,
      input: {
        kind: 'json',
        contentType: 'application/json',
        data: { value }
      }
    })
  }

  /**
   * Writes `count` Resources, each followed by a `PublicCanRead` policy on
   * it, so each takes two feed positions: the Resource's, then its
   * policy's.
   */
  async function writeResourcePolicies(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      await writeDoc(`doc-${index}`, 0)
      await backend.writePolicy({
        spaceId,
        collectionId,
        resourceId: `doc-${index}`,
        policy: { type: 'PublicCanRead' }
      })
    }
  }

  /**
   * The parsed contents of a file in the Collection dir.
   */
  async function readCollectionFile(fileName: string): Promise<any> {
    return JSON.parse(
      await readFile(path.join(collectionDir, fileName), 'utf8')
    )
  }

  /**
   * The bytes and modification time of every policy file in the Collection
   * dir, keyed by file name.
   */
  async function policyFileSnapshot(): Promise<
    Map<string, { bytes: string; mtimeMs: number }>
  > {
    const snapshot = new Map<string, { bytes: string; mtimeMs: number }>()
    for (const name of await readdir(collectionDir)) {
      if (!name.endsWith('.policy.json') || name.startsWith('.meta.')) {
        continue
      }
      const filePath = path.join(collectionDir, name)
      snapshot.set(name, {
        bytes: await readFile(filePath, 'utf8'),
        mtimeMs: (await stat(filePath)).mtimeMs
      })
    }
    return snapshot
  }

  it('keeps the counter file independent of the policy count, and rewrites no policy file', async () => {
    await backend.writePolicy({
      spaceId,
      collectionId,
      policy: { type: 'PublicCanRead' }
    })
    await writeResourcePolicies(POLICY_COUNT)
    const before = await policyFileSnapshot()
    assert.equal(before.size, POLICY_COUNT + 1)

    // Every kind of feed-visible write that is not a policy write. The
    // deleted Resource carries no policy, since a delete tombstones one.
    await writeDoc('doc-0', 1)
    await backend.writeResourceMetadata({
      spaceId,
      collectionId,
      resourceId: 'doc-0',
      custom: { name: 'Renamed' }
    })
    await writeDoc('plain', 1)
    await backend.deleteResource({ spaceId, collectionId, resourceId: 'plain' })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: { id: collectionId, type: ['Collection'], name: 'N' }
    })
    await backend.writeCollectionLog({
      spaceId,
      collectionId,
      body: '{"state":{"scheme":"edv"},"parameters":{"method":"x"}}\n',
      ifNoneMatch: '*'
    })

    // The counter holds no per-policy state: its members are the same
    // whatever the policy count.
    const text = await readFile(counterPath, 'utf8')
    const counter = JSON.parse(text)
    // The policies, and the Resources they were written on.
    const policyWrites = POLICY_COUNT + 1 + POLICY_COUNT
    assert.deepEqual(counter, {
      generation: counter.generation,
      // The create, the policies, then six more writes.
      position: 1 + policyWrites + 6,
      records: {
        'collection-metadata': 1 + policyWrites + 5,
        log: 1 + policyWrites + 6
      }
    })
    assert.equal(typeof counter.generation, 'string')
    assert.ok(Buffer.byteLength(text) < 128, `counter is ${text}`)

    // No policy file was rewritten.
    assert.deepEqual(await policyFileSnapshot(), before)
  })

  it('stores a policy position in its own file, and serves it nowhere', async () => {
    await backend.writePolicy({
      spaceId,
      policy: { type: 'PublicCanRead' }
    })
    await backend.writePolicy({
      spaceId,
      collectionId,
      // A body's `_feedPosition` is not stored.
      policy: { type: 'PublicCanRead', _feedPosition: 999 }
    })
    await writeResourcePolicies(1)

    const spacePolicy = JSON.parse(
      await readFile(
        path.join(backend.dataDir, 'spaces', spaceId, '.space.policy.json'),
        'utf8'
      )
    )
    assert.equal('_feedPosition' in spacePolicy, false, 'a Space policy')
    assert.equal(
      (await readCollectionFile('.collection.policy.json'))._feedPosition,
      2
    )
    assert.equal(
      (await readCollectionFile(resourcePolicyFileName('doc-0')))._feedPosition,
      4
    )

    for (const resourceId of [undefined, 'doc-0']) {
      const policy = await backend.getPolicy({
        spaceId,
        collectionId,
        resourceId
      })
      assert.equal(policy?.type, 'PublicCanRead')
      assert.equal('_feedPosition' in policy!, false)
      const record = await backend.getPolicyRecord({
        spaceId,
        collectionId,
        resourceId
      })
      assert.equal(record?.deleted, false)
      assert.equal(
        '_feedPosition' in (record as { policy: object }).policy,
        false
      )
    }
  })

  it('carries one policy document per record at its latest position, tombstones included', async () => {
    // Position 2: the Collection's own policy.
    await backend.writePolicy({
      spaceId,
      collectionId,
      policy: { type: 'PublicCanRead' }
    })
    // Positions 3 to 8: three Resources, each followed by its policy.
    await writeResourcePolicies(3)
    // Position 9: doc-0's policy is rewritten.
    await backend.writePolicy({
      spaceId,
      collectionId,
      resourceId: 'doc-0',
      policy: { type: 'PublicCanRead' }
    })
    // Position 10: doc-1's policy is deleted, leaving a tombstone.
    await backend.deletePolicy({ spaceId, collectionId, resourceId: 'doc-1' })
    // Position 11: a Resource write, which no policy follows.
    await writeDoc('doc-2', 1)

    const page = await backend.changesSince!({
      spaceId,
      collectionId,
      limit: 100
    })
    const policies = page.documents
      .filter(
        (document): document is FeedDocument & { kind: 'policy' } =>
          document.kind === 'policy'
      )
      .map(({ resourceId, feedPosition, deleted }) => ({
        resourceId,
        feedPosition,
        deleted
      }))
    assert.deepEqual(policies, [
      { resourceId: undefined, feedPosition: 2, deleted: false },
      { resourceId: 'doc-2', feedPosition: 8, deleted: false },
      { resourceId: 'doc-0', feedPosition: 9, deleted: false },
      { resourceId: 'doc-1', feedPosition: 10, deleted: true }
    ])
    assert.equal(page.checkpoint, 11)

    // A reader past a policy's position does not see it again.
    const later = await backend.changesSince!({
      spaceId,
      collectionId,
      afterPosition: 8,
      limit: 100
    })
    assert.deepEqual(
      later.documents.map(document => document.feedPosition),
      [9, 10, 11]
    )
  })

  it('answers a caught-up poll without reading a policy file', async () => {
    await backend.writePolicy({
      spaceId,
      collectionId,
      policy: { type: 'PublicCanRead' }
    })
    await writeResourcePolicies(2)
    const { checkpoint } = await backend.changesSince!({
      spaceId,
      collectionId,
      limit: 100
    })
    assert.equal(checkpoint, 6)

    // A policy file that no longer parses fails any read of it.
    await writeFile(
      path.join(collectionDir, resourcePolicyFileName('doc-1')),
      '{'
    )
    await assert.rejects(
      backend.getPolicyRecord({ spaceId, collectionId, resourceId: 'doc-1' }),
      SyntaxError
    )

    // The feed leaves that one policy (position 6) out and still serves the
    // others, whether or not the reader is past them.
    for (const afterPosition of [undefined, 2]) {
      const page = await backend.changesSince!({
        spaceId,
        collectionId,
        afterPosition,
        limit: 100
      })
      assert.deepEqual(
        page.documents
          .map(document => document.feedPosition)
          .filter(position => position > 2),
        [3, 4, 5]
      )
    }

    // The caught-up poll reads the counter alone, so the bad file is not met.
    const caughtUp = await backend.changesSince!({
      spaceId,
      collectionId,
      afterPosition: checkpoint!,
      limit: 100
    })
    assert.deepEqual(caughtUp.documents, [])
    assert.equal(caughtUp.checkpoint, null)
    assert.equal(typeof caughtUp.feedGeneration, 'string')
  })

  it('exports policy files without their feed position', async () => {
    await backend.writePolicy({
      spaceId,
      collectionId,
      policy: { type: 'PublicCanRead' }
    })
    await writeResourcePolicies(2)
    await backend.deletePolicy({ spaceId, collectionId, resourceId: 'doc-1' })

    const entries = await extractTarEntries(
      await backend.exportSpace({ spaceId })
    )
    const policyEntries = [...entries].filter(([name]) =>
      /\/\.(collection|r\..+)\.policy\.json$/.test(name)
    )
    // The tombstone does not travel.
    assert.deepEqual(
      policyEntries.map(([name]) => path.basename(name)).sort(),
      ['.collection.policy.json', resourcePolicyFileName('doc-0')].sort()
    )
    for (const [name, entry] of policyEntries) {
      const archived = JSON.parse(entry.body!.toString('utf8'))
      assert.equal(typeof archived._generation, 'string', name)
      assert.equal('_feedPosition' in archived, false, name)
      // The stored bytes without the position, which was written last.
      const { _feedPosition, ...stored } = await readCollectionFile(
        path.basename(name)
      )
      assert.equal(entry.body!.toString('utf8'), JSON.stringify(stored))
    }
  })
})

describe('policy write and import bodies', () => {
  it('drop a `_feedPosition` the body carries', () => {
    assert.deepEqual(
      normalizePolicyWrite({ type: 'PublicCanRead', _feedPosition: 7 }),
      { type: 'PublicCanRead' }
    )
    const imported = importedPolicy({
      bytes: Buffer.from(
        JSON.stringify({
          type: 'PublicCanRead',
          _generation: 'zArchived',
          _feedPosition: 7
        })
      ),
      fileName: '.collection.policy.json'
    })
    assert.deepEqual(imported.policy, { type: 'PublicCanRead' })
  })

  it('an import assigns a fresh position in place of none archived', async () => {
    const backend = await openTempBackend({ prefix: 'was-policy-import-' })
    try {
      for (const id of ['source', 'target']) {
        await backend.writeSpace({
          spaceId: id,
          spaceMetadata: {
            id,
            type: ['Space'],
            controller: 'did:key:test-controller'
          }
        })
      }
      await backend.writeCollection({
        spaceId: 'source',
        collectionId,
        collectionMetadata: { id: collectionId, type: ['Collection'] }
      })
      await backend.writePolicy({
        spaceId: 'source',
        collectionId,
        policy: { type: 'PublicCanRead' }
      })
      await importArchive({
        backend,
        spaceId: 'target',
        tarStream: await backend.exportSpace({ spaceId: 'source' })
      })
      const stored = JSON.parse(
        await readFile(
          path.join(
            backend.dataDir,
            'spaces',
            'target',
            collectionId,
            '.collection.policy.json'
          ),
          'utf8'
        )
      )
      // The Collection's import took position 1, its policy position 2.
      assert.equal(stored._feedPosition, 2)
    } finally {
      await backend.close()
    }
  })
})
