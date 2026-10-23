/**
 * The `ServerBackends` set: the fixed ids, the `default` alias and its
 * fallback, the control plane and its fallback, the data-plane lookup, and
 * the refusals at construction (no backend, two under one id, a default or
 * a control plane naming no configured backend, origin ids that differ).
 * Uses stub backends, since only `describe()`, `originId` and, for the
 * lookup, `getCollectionMetadata` are read here; the plugin refusals over
 * real backends are in `plugin-options.test.ts`.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import { ServerBackends } from '../src/lib/serverBackends.js'
import type { StorageBackend } from '../src/types.js'

function stub({
  id,
  originId = 'zOrigin',
  collections = {}
}: {
  id: string
  originId?: string
  collections?: Record<string, { backend?: { id: string } }>
}): StorageBackend {
  return {
    originId,
    describe: () => ({
      id,
      name: `Stub ${id}`,
      managedBy: 'server',
      persistence: 'durable'
    }),
    getCollectionMetadata: async ({ collectionId }: { collectionId: string }) =>
      collections[collectionId]
  } as unknown as StorageBackend
}

describe('ServerBackends', () => {
  it('aliases `default` to the filesystem backend when unset', () => {
    const fs = stub({ id: 'fs' })
    const postgres = stub({ id: 'postgres' })
    const backends = new ServerBackends({
      backends: [postgres, fs],
      controlPlaneId: 'fs'
    })
    assert.equal(backends.defaultId, 'fs')
    // The control plane is served wrapped by the mirroring control plane.
    assert.equal(backends.controlPlaneId, 'fs')
    assert.equal(backends.controlPlane, backends.default)
    assert.notEqual(backends.default, fs)
    assert.equal(backends.default.describe().id, 'fs')
    assert.deepStrictEqual(
      backends.all().map(backend => backend.describe().id),
      ['fs', 'postgres']
    )
    assert.deepStrictEqual(backends.others(), [postgres])
    assert.equal(backends.resolve(undefined), backends.default)
    assert.equal(backends.resolve('default'), backends.default)
    assert.equal(backends.resolve('fs'), backends.default)
    assert.equal(backends.resolve('postgres'), postgres)
    assert.equal(backends.resolveOther('fs'), undefined)
    assert.equal(backends.resolveOther('postgres'), postgres)
    assert.equal(backends.resolve('gdrive-1'), undefined)
    assert.equal(backends.has('default'), true)
    assert.equal(backends.has('fs'), true)
    assert.equal(backends.has('gdrive-1'), false)
    assert.deepStrictEqual(
      backends.describeAll().map(entry => [entry.id, entry.name]),
      [
        ['default', 'Stub fs'],
        ['fs', 'Stub fs'],
        ['postgres', 'Stub postgres']
      ]
    )
  })

  it('puts the control plane on Postgres when configured, else on the filesystem backend', () => {
    const fs = stub({ id: 'fs' })
    const postgres = stub({ id: 'postgres' })
    const both = new ServerBackends({ backends: [fs, postgres] })
    assert.equal(both.defaultId, 'fs')
    assert.equal(both.controlPlaneId, 'postgres')
    assert.equal(both.default, fs)
    assert.deepStrictEqual(both.others(), [fs])
    const fsOnly = new ServerBackends({ backends: [stub({ id: 'fs' })] })
    assert.equal(fsOnly.controlPlaneId, 'fs')
    assert.equal(fsOnly.controlPlane, fsOnly.default)
  })

  it('aliases `default` to the only configured backend when unset', () => {
    const postgres = stub({ id: 'postgres' })
    const backends = new ServerBackends({ backends: [postgres] })
    assert.equal(backends.defaultId, 'postgres')
    assert.equal(backends.controlPlaneId, 'postgres')
    assert.deepStrictEqual(
      backends.describeAll().map(entry => entry.id),
      ['default', 'postgres']
    )
  })

  it('takes the configured default', () => {
    const fs = stub({ id: 'fs' })
    const postgres = stub({ id: 'postgres' })
    const backends = new ServerBackends({
      backends: [fs, postgres],
      defaultId: 'postgres'
    })
    assert.equal(backends.default.describe().id, 'postgres')
    assert.equal(backends.controlPlaneId, 'postgres')
    assert.deepStrictEqual(backends.others(), [fs])
  })

  it('takes a control plane apart from the default', () => {
    const fs = stub({ id: 'fs' })
    const postgres = stub({ id: 'postgres' })
    const backends = new ServerBackends({
      backends: [fs, postgres],
      controlPlaneId: 'postgres'
    })
    // `default` still aliases the filesystem backend, now unwrapped: it is a
    // data plane like any other backend beside the control plane.
    assert.equal(backends.defaultId, 'fs')
    assert.equal(backends.default, fs)
    assert.equal(backends.resolve(undefined), fs)
    assert.equal(backends.resolve('default'), fs)
    // The control plane is the wrapped Postgres backend.
    assert.equal(backends.controlPlaneId, 'postgres')
    assert.notEqual(backends.controlPlane, postgres)
    assert.equal(backends.controlPlane.describe().id, 'postgres')
    assert.equal(backends.resolve('postgres'), backends.controlPlane)
    // The copies go to every backend other than the control plane, the
    // default included.
    assert.deepStrictEqual(backends.others(), [fs])
    assert.equal(backends.resolveOther(undefined), fs)
    assert.equal(backends.resolveOther('default'), fs)
    assert.equal(backends.resolveOther('postgres'), undefined)
    assert.deepStrictEqual(
      backends.all().map(backend => backend.describe().id),
      ['postgres', 'fs']
    )
    assert.deepStrictEqual(
      backends.describeAll().map(entry => [entry.id, entry.name]),
      [
        ['default', 'Stub fs'],
        ['postgres', 'Stub postgres'],
        ['fs', 'Stub fs']
      ]
    )
  })

  it('finds the backend that serves a stored Collection', async () => {
    const fs = stub({ id: 'fs' })
    const postgres = stub({
      id: 'postgres',
      collections: {
        onDefault: {},
        onFs: { backend: { id: 'fs' } },
        onPostgres: { backend: { id: 'postgres' } },
        onExternal: { backend: { id: 'gdrive-1' } }
      }
    })
    const backends = new ServerBackends({
      backends: [fs, postgres],
      controlPlaneId: 'postgres'
    })
    const spaceId = 'S1'
    const of = (collectionId: string) =>
      backends.dataBackendOf({ spaceId, collectionId })
    assert.equal(await of('onDefault'), fs)
    assert.equal(await of('onFs'), fs)
    assert.equal(await of('onPostgres'), backends.controlPlane)
    // An external backend and an absent Collection read as the control
    // plane, which answers the read as it would without the lookup.
    assert.equal(await of('onExternal'), backends.controlPlane)
    assert.equal(await of('absent'), backends.controlPlane)
  })

  it('refuses no backend, a duplicate id, a `default` id, and an unknown default or control plane', () => {
    assert.throws(
      () => new ServerBackends({ backends: [] }),
      /No storage backend is configured/
    )
    assert.throws(
      () =>
        new ServerBackends({
          backends: [stub({ id: 'fs' }), stub({ id: 'fs' })]
        }),
      /Two storage backends carry the id "fs"/
    )
    assert.throws(
      () => new ServerBackends({ backends: [stub({ id: 'default' })] }),
      /may not describe itself as "default"/
    )
    assert.throws(
      () =>
        new ServerBackends({
          backends: [stub({ id: 'fs' })],
          defaultId: 'postgres'
        }),
      /WAS_DEFAULT_BACKEND names "postgres", which is not a configured/
    )
    assert.throws(
      () =>
        new ServerBackends({
          backends: [stub({ id: 'fs' })],
          controlPlaneId: 'postgres'
        }),
      /WAS_CONTROL_PLANE_BACKEND names "postgres", which is not a configured/
    )
  })

  it('refuses several backends with no filesystem one and no configured default', () => {
    assert.throws(
      () =>
        new ServerBackends({
          backends: [stub({ id: 'postgres' }), stub({ id: 'other' })]
        }),
      /WAS_DEFAULT_BACKEND is unset and no filesystem backend is configured/
    )
  })

  it('refuses backends whose origin ids differ', () => {
    assert.throws(
      () =>
        new ServerBackends({
          backends: [
            stub({ id: 'fs', originId: 'zOne' }),
            stub({ id: 'postgres', originId: 'zTwo' })
          ]
        }),
      /different origin ids \(zOne, zTwo\)\. Set WAS_ORIGIN_ID/
    )
  })
})
