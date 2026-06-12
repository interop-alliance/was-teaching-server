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
  spacesPath,
  spacePath,
  collectionsPath,
  exportPath,
  importPath,
  collectionPath,
  resourcePath,
  policyPath,
  metaPath,
  backendsPath,
  quotasPath,
  linksetPath
} from '../src/lib/paths.js'

describe('spacesPath', () => {
  it('builds the repository container path (trailing slash) with no id', () => {
    assert.equal(spacesPath(), '/spaces/')
  })

  it('builds a repository member path (no trailing slash) with a spaceId', () => {
    assert.equal(spacesPath({ spaceId: 's1' }), '/spaces/s1')
  })
})

describe('spacePath', () => {
  it('builds the canonical member path by default', () => {
    assert.equal(spacePath({ spaceId: 's1' }), '/space/s1')
  })

  it('builds the container form when trailingSlash is set', () => {
    assert.equal(
      spacePath({ spaceId: 's1', trailingSlash: true }),
      '/space/s1/'
    )
  })
})

describe('collectionsPath', () => {
  it('builds the List Collections container path', () => {
    assert.equal(collectionsPath({ spaceId: 's1' }), '/space/s1/collections/')
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
  it('builds the canonical member path by default', () => {
    assert.equal(
      collectionPath({ spaceId: 's1', collectionId: 'c1' }),
      '/space/s1/c1'
    )
  })

  it('builds the container form when trailingSlash is set', () => {
    assert.equal(
      collectionPath({
        spaceId: 's1',
        collectionId: 'c1',
        trailingSlash: true
      }),
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
