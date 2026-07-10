/**
 * Unit tests for the tar import helpers (`src/lib/importTar.ts`): the manifest
 * validator, the merge-plan builder, and the tar entry extractor. These exercise
 * the archive-parsing logic directly -- without an HTTP round-trip or the
 * filesystem backend -- to cover the malformed-archive branches (which surface
 * to clients as `InvalidImportError`) and the id-traversal guards.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import YAML from 'yaml'
import * as tar from 'tar-stream'

import {
  validateManifest,
  buildImportPlan,
  extractTarEntries,
  type TarEntry
} from '../src/lib/importTar.js'
import {
  InvalidImportError,
  InvalidCollectionIdError,
  InvalidResourceIdError
} from '../src/errors.js'

/** Wraps a UTF-8 string as a `file` TarEntry. */
function fileEntry(body: string): TarEntry {
  return { type: 'file', body: Buffer.from(body, 'utf8') }
}

/** A minimal, valid UBC v0.1 manifest body (YAML). */
function validManifestYaml(): string {
  return YAML.stringify({
    'ubc-version': '0.1',
    contents: { space: { url: 'https://example/spec#spaces' } }
  })
}

describe('validateManifest', () => {
  it('accepts a well-formed UBC v0.1 manifest', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())]
    ])
    assert.doesNotThrow(() => validateManifest(entries))
  })

  it('throws InvalidImportError when manifest.yml is missing', () => {
    const entries = new Map<string, TarEntry>()
    let thrown: any
    try {
      validateManifest(entries)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof InvalidImportError)
    assert.equal(thrown.statusCode, 400)
    assert.match(thrown.detail, /missing manifest/i)
  })

  it('throws InvalidImportError (with cause) on invalid YAML', () => {
    const entries = new Map<string, TarEntry>([
      // Unterminated flow mapping -- YAML.parse throws.
      ['manifest.yml', fileEntry('ubc-version: "0.1"\ncontents: {')]
    ])
    let thrown: any
    try {
      validateManifest(entries)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof InvalidImportError)
    assert.match(thrown.detail, /not valid YAML/i)
    // The underlying parse error is preserved as the cause chain.
    assert.ok(thrown.cause instanceof Error)
  })

  it('throws InvalidImportError on an unsupported manifest version', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(YAML.stringify({ 'ubc-version': '0.2' }))]
    ])
    assert.throws(
      () => validateManifest(entries),
      (err: Error) =>
        err instanceof InvalidImportError && /Unsupported/i.test(err.message)
    )
  })

  it('throws InvalidImportError when contents.space is absent', () => {
    const entries = new Map<string, TarEntry>([
      [
        'manifest.yml',
        fileEntry(YAML.stringify({ 'ubc-version': '0.1', contents: {} }))
      ]
    ])
    assert.throws(
      () => validateManifest(entries),
      (err: Error) =>
        err instanceof InvalidImportError &&
        /does not describe a WAS space export/i.test(err.message)
    )
  })
})

describe('buildImportPlan', () => {
  /** Builds a complete, valid space-export entries map for spaceId `S1`. */
  function validSpaceEntries(): Map<string, TarEntry> {
    const spacePolicy = { type: 'PublicCanRead' }
    const collectionPolicy = { type: 'PublicCanRead', scope: 'collection' }
    const resourcePolicy = { type: 'PublicCanRead', scope: 'resource' }
    return new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      ['space/', { type: 'directory' }],
      ['space/S1/', { type: 'directory' }],
      ['space/S1/.space.S1.json', fileEntry(JSON.stringify({ id: 'S1' }))],
      ['space/S1/.policy.S1.json', fileEntry(JSON.stringify(spacePolicy))],
      ['space/S1/colA/', { type: 'directory' }],
      [
        'space/S1/colA/.collection.colA.json',
        fileEntry(
          JSON.stringify({ id: 'colA', type: ['Collection'], name: 'A' })
        )
      ],
      [
        'space/S1/colA/.policy.colA.json',
        fileEntry(JSON.stringify(collectionPolicy))
      ],
      [
        'space/S1/colA/.policy.res1.json',
        fileEntry(JSON.stringify(resourcePolicy))
      ],
      [
        'space/S1/colA/.meta.res1.json',
        fileEntry(
          JSON.stringify({
            createdAt: '2026-06-10T09:12:00.000Z',
            updatedAt: '2026-06-12T13:25:00.000Z',
            custom: { name: 'Resource One' }
          })
        )
      ],
      [
        'space/S1/colA/r.res1.application%2Fjson.json',
        fileEntry(JSON.stringify({ hello: 'world' }))
      ],
      [
        'space/S1/colB/.collection.colB.json',
        fileEntry(
          JSON.stringify({ id: 'colB', type: ['Collection'], name: 'B' })
        )
      ]
    ])
  }

  it('builds a plan with sorted collections, policies, and resources', () => {
    const plan = buildImportPlan(validSpaceEntries())

    assert.deepStrictEqual(plan.spacePolicy, { type: 'PublicCanRead' })
    assert.deepStrictEqual(
      plan.collections.map(c => c.collectionId),
      ['colA', 'colB']
    )

    const [colA, colB] = plan.collections
    assert.equal(colA!.collectionDescription.name, 'A')
    assert.deepStrictEqual(colA!.collectionPolicy, {
      type: 'PublicCanRead',
      scope: 'collection'
    })
    assert.equal(colA!.resources.length, 1)
    assert.equal(colA!.resources[0]!.resourceId, 'res1')
    assert.equal(colA!.resources[0]!.fileName, 'r.res1.application%2Fjson.json')
    assert.deepStrictEqual(colA!.resourcePolicies.get('res1'), {
      type: 'PublicCanRead',
      scope: 'resource'
    })
    // The resource's metadata sidecar is carried as raw bytes, keyed by id.
    const metaBytes = colA!.resourceMetadata.get('res1')
    assert.ok(metaBytes, 'expected a metadata sidecar for res1')
    assert.deepStrictEqual(JSON.parse(metaBytes!.toString('utf8')), {
      createdAt: '2026-06-10T09:12:00.000Z',
      updatedAt: '2026-06-12T13:25:00.000Z',
      custom: { name: 'Resource One' }
    })

    // colB has only a description (no policy, no resources).
    assert.equal(colB!.resources.length, 0)
    assert.equal(colB!.collectionPolicy, undefined)
  })

  it('synthesizes a default Collection description when none is in the archive', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      ['space/S1/colA/r.res1.text%2Fplain.txt', fileEntry('hi')]
    ])
    const plan = buildImportPlan(entries)
    const [colA] = plan.collections
    assert.deepStrictEqual(colA!.collectionDescription, {
      id: 'colA',
      type: ['Collection'],
      name: 'colA'
    })
  })

  it('throws InvalidImportError when the archive has no space data', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: Error) =>
        err instanceof InvalidImportError &&
        /does not contain space data/i.test(err.message)
    )
  })

  it('rejects a path-traversal collection id parsed from the archive', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      ['space/S1/../evil/.collection.x.json', fileEntry('{}')]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: Error) => err instanceof InvalidCollectionIdError
    )
  })

  it('rejects a non-URL-safe resource id parsed from the archive', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      // resourceId "a*b" carries a glob metachar -> assertValidId rejects it.
      ['space/S1/colA/r.a*b.text%2Fplain.txt', fileEntry('hi')]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: Error) => err instanceof InvalidResourceIdError
    )
  })

  it('carries top-level revocation records into the plan (and none when absent)', () => {
    // An archive without a `revocations/` dir (e.g. from an older server)
    // plans an empty list.
    assert.deepStrictEqual(buildImportPlan(validSpaceEntries()).revocations, [])

    const record = {
      capability: { id: 'urn:zcap:delegated-1' },
      meta: {
        delegator: 'did:key:z6MkDelegator',
        rootTarget: 'https://was.example/space/S1',
        created: '2026-07-01T00:00:00.000Z'
      }
    }
    const entries = validSpaceEntries()
    entries.set('revocations/', { type: 'directory' })
    entries.set('revocations/abc123.json', fileEntry(JSON.stringify(record)))
    assert.deepStrictEqual(buildImportPlan(entries).revocations, [record])
  })

  it('throws InvalidImportError on a malformed revocation record', () => {
    const badJson = validSpaceEntries()
    badJson.set('revocations/broken.json', fileEntry('{not json'))
    assert.throws(
      () => buildImportPlan(badJson),
      (err: Error) =>
        err instanceof InvalidImportError && /not valid JSON/i.test(err.message)
    )

    // Parses, but lacks the `(capability.id, meta.delegator)` unique key.
    const badShape = validSpaceEntries()
    badShape.set(
      'revocations/keyless.json',
      fileEntry(JSON.stringify({ capability: {}, meta: {} }))
    )
    assert.throws(
      () => buildImportPlan(badShape),
      (err: Error) =>
        err instanceof InvalidImportError && /malformed/i.test(err.message)
    )
  })
})

describe('extractTarEntries', () => {
  it('round-trips files and directories from a tar stream', async () => {
    const pack = tar.pack()
    pack.entry({ name: 'manifest.yml' }, 'ubc-version: "0.1"')
    pack.entry({ name: 'space/', type: 'directory' })
    pack.entry({ name: 'space/S1/r.note.text%2Fplain.txt' }, 'hello')
    pack.finalize()

    const entries = await extractTarEntries(pack)

    assert.equal(entries.size, 3)
    assert.equal(entries.get('space/')!.type, 'directory')
    assert.equal(
      entries.get('manifest.yml')!.body!.toString('utf8'),
      'ubc-version: "0.1"'
    )
    assert.equal(
      entries.get('space/S1/r.note.text%2Fplain.txt')!.body!.toString('utf8'),
      'hello'
    )
  })
})
