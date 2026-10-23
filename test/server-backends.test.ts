/**
 * The `ServerBackends` set: the fixed ids, the `default` alias and its
 * fallback, and the refusals at construction (no backend, two under one id,
 * a default naming no configured backend, origin ids that differ). Uses stub
 * backends, since only `describe()` and `originId` are read here; the plugin
 * refusals over real backends are in `plugin-options.test.ts`.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import { ServerBackends } from '../src/lib/serverBackends.js'
import type { StorageBackend } from '../src/types.js'

function stub({
  id,
  originId = 'zOrigin'
}: {
  id: string
  originId?: string
}): StorageBackend {
  return {
    originId,
    describe: () => ({
      id,
      name: `Stub ${id}`,
      managedBy: 'server',
      persistence: 'durable'
    })
  } as unknown as StorageBackend
}

describe('ServerBackends', () => {
  it('aliases `default` to the filesystem backend when unset', () => {
    const fs = stub({ id: 'fs' })
    const postgres = stub({ id: 'postgres' })
    const backends = new ServerBackends({ backends: [postgres, fs] })
    assert.equal(backends.defaultId, 'fs')
    // The default is served wrapped by the mirroring control plane.
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

  it('aliases `default` to the only configured backend when unset', () => {
    const postgres = stub({ id: 'postgres' })
    const backends = new ServerBackends({ backends: [postgres] })
    assert.equal(backends.defaultId, 'postgres')
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
    assert.deepStrictEqual(backends.others(), [fs])
  })

  it('refuses no backend, a duplicate id, a `default` id, and an unknown default', () => {
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
