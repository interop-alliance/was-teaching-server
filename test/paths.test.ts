/**
 * Unit tests for the relative URL path builders (`src/lib/paths.ts`), the single
 * source of truth for the server's path templates. These pin the canonical
 * member vs container (trailing-slash) forms and the auxiliary
 * (`policy` / `linkset` / `export` / `import`) shapes against the routes in
 * routes.ts, so drift between a handler's `targetPath` and its registered route
 * is caught here rather than as a 404 at verification time.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import {
  absoluteCollectionUrl,
  absoluteSpaceUrl,
  spacesPath,
  spacePath,
  spaceMetaPath,
  exportPath,
  importPath,
  collectionPath,
  resourcePath,
  policyPath,
  metaPath,
  collectionMetaPath,
  backendsPath,
  quotasPath,
  linksetPath,
  registeredBackendPath,
  replicasPath,
  replicaPath,
  replicaStatusPath,
  collectionLogPath,
  chunkPath,
  chunksContainerPath,
  backendPath,
  quotaPath,
  queryPath,
  spaceRevocationsPath
} from '../src/lib/paths.js'

describe('spacesPath', () => {
  it('builds the repository container path (trailing slash)', () => {
    assert.equal(spacesPath(), '/spaces/')
  })
})

describe('spacePath', () => {
  it('builds the canonical container URL (trailing slash)', () => {
    assert.equal(spacePath({ spaceId: 's1' }), '/space/s1/')
  })
})

describe('absoluteSpaceUrl', () => {
  it('builds the canonical container URL on the server', () => {
    assert.equal(
      absoluteSpaceUrl({ spaceId: 's1', serverUrl: 'http://localhost:3002' }),
      'http://localhost:3002/space/s1/'
    )
  })

  it('is the same URL when the base URL ends in a slash', () => {
    assert.equal(
      absoluteSpaceUrl({ spaceId: 's1', serverUrl: 'http://localhost:3002/' }),
      'http://localhost:3002/space/s1/'
    )
  })
})

describe('absoluteCollectionUrl', () => {
  it('is the same canonical URL whether or not the base URL ends in a slash', () => {
    for (const serverUrl of [
      'http://localhost:3002',
      'http://localhost:3002/'
    ]) {
      assert.equal(
        absoluteCollectionUrl({
          spaceId: 's1',
          collectionId: 'c1',
          serverUrl
        }),
        'http://localhost:3002/space/s1/c1/'
      )
    }
  })
})

describe('spaceMetaPath', () => {
  it('builds the Space Metadata path', () => {
    assert.equal(spaceMetaPath({ spaceId: 's1' }), '/space/s1/meta')
  })
})

describe('exportPath / importPath', () => {
  it('builds the Export Space action path', () => {
    assert.equal(exportPath({ spaceId: 's1' }), '/space/s1/export')
  })

  it('builds the Import Space action path', () => {
    assert.equal(importPath({ spaceId: 's1' }), '/space/s1/import')
  })
})

describe('collectionPath', () => {
  it('builds the canonical container URL (trailing slash)', () => {
    assert.equal(
      collectionPath({ spaceId: 's1', collectionId: 'c1' }),
      '/space/s1/c1/'
    )
  })
})

describe('resourcePath', () => {
  it('builds the resource member path', () => {
    assert.equal(
      resourcePath({ spaceId: 's1', collectionId: 'c1', resourceId: 'r1' }),
      '/space/s1/c1/r1'
    )
  })
})

describe('policyPath', () => {
  it('resolves to the Space level with only a spaceId', () => {
    assert.equal(policyPath({ spaceId: 's1' }), '/space/s1/policy')
  })

  it('resolves to the Collection level with a collectionId', () => {
    assert.equal(
      policyPath({ spaceId: 's1', collectionId: 'c1' }),
      '/space/s1/c1/policy'
    )
  })

  it('resolves to the Resource level with collectionId + resourceId', () => {
    assert.equal(
      policyPath({ spaceId: 's1', collectionId: 'c1', resourceId: 'r1' }),
      '/space/s1/c1/r1/policy'
    )
  })
})

describe('collectionMetaPath', () => {
  it('builds the collection metadata path', () => {
    assert.equal(
      collectionMetaPath({ spaceId: 's1', collectionId: 'c1' }),
      '/space/s1/c1/meta'
    )
  })
})

describe('metaPath', () => {
  it('builds the resource metadata path', () => {
    assert.equal(
      metaPath({ spaceId: 's1', collectionId: 'c1', resourceId: 'r1' }),
      '/space/s1/c1/r1/meta'
    )
  })
})

describe('backendsPath', () => {
  it('builds the space backends list path', () => {
    assert.equal(backendsPath({ spaceId: 's1' }), '/space/s1/backends')
  })
})

describe('quotasPath', () => {
  it('builds the space quota report path', () => {
    assert.equal(quotasPath({ spaceId: 's1' }), '/space/s1/quotas')
  })
})

describe('linksetPath', () => {
  it('anchors on the Space with only a spaceId', () => {
    assert.equal(linksetPath({ spaceId: 's1' }), '/space/s1/linkset')
  })

  it('anchors on the Collection with a collectionId', () => {
    assert.equal(
      linksetPath({ spaceId: 's1', collectionId: 'c1' }),
      '/space/s1/c1/linkset'
    )
  })
})

describe('sub-resource builders', () => {
  const ids = { spaceId: 's1', collectionId: 'c1', resourceId: 'r1' }

  it('extends the no-slash Space prefix', () => {
    assert.equal(
      registeredBackendPath({ spaceId: 's1', backendId: 'b1' }),
      '/space/s1/backends/b1'
    )
    assert.equal(replicasPath({ spaceId: 's1' }), '/space/s1/replicas')
    assert.equal(
      replicaPath({ spaceId: 's1', replicaId: 'p1' }),
      '/space/s1/replicas/p1'
    )
    assert.equal(
      replicaStatusPath({ spaceId: 's1', replicaId: 'p1' }),
      '/space/s1/replicas/p1/status'
    )
    assert.equal(
      spaceRevocationsPath({ spaceId: 's1', revocationId: 'urn:z' }),
      '/space/s1/zcaps/revocations/urn%3Az'
    )
  })

  it('extends the no-slash Collection prefix', () => {
    assert.equal(collectionLogPath(ids), '/space/s1/c1/meta/log')
    assert.equal(backendPath(ids), '/space/s1/c1/backend')
    assert.equal(quotaPath(ids), '/space/s1/c1/quota')
    assert.equal(queryPath(ids), '/space/s1/c1/query')
    assert.equal(
      chunkPath({ ...ids, chunkIndex: 2 }),
      '/space/s1/c1/r1/chunks/2'
    )
    assert.equal(chunksContainerPath(ids), '/space/s1/c1/r1/chunks/')
  })
})
