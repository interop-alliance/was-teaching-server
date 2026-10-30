/**
 * Unit tests for the List Collection wire body (`src/lib/collectionListing.ts`).
 * The served `type` is the one `GET .../meta` serves, whatever order a record
 * reached the store in: the live write path only stores `['Collection']`, but
 * an imported or replicated Metadata object keeps the order it arrived in.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import { collectionResourcesList } from '../src/lib/collectionListing.js'
import type { CollectionMetadata } from '../src/types.js'

describe('collectionResourcesList', () => {
  const page = { totalItems: 0, items: [], hasMore: false, pageSize: 10 }
  const ids = { spaceId: 's1', collectionId: 'c1' }

  it('serves a multi-valued stored type sorted', () => {
    const stored = ['Collection', 'Archive']
    const collectionMetadata = {
      id: 'c1',
      type: stored
    } as CollectionMetadata
    const listing = collectionResourcesList({
      ...ids,
      ...page,
      collectionMetadata
    })
    assert.deepEqual(listing.type, ['Archive', 'Collection'])
    assert.deepEqual(stored, ['Collection', 'Archive'])
  })

  it('falls back to the base type with no Metadata object', () => {
    assert.deepEqual(collectionResourcesList({ ...ids, ...page }).type, [
      'Collection'
    ])
  })
})
