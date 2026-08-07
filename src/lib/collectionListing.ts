/**
 * The List Collection wire body (spec "List Collection"), assembled in one
 * place. Both storage backends enumerate their own storage -- directory entries
 * plus `.meta` sidecars on the filesystem, a `resources` page query on Postgres
 * -- but the shape they hand back is contract, not backend detail: the
 * per-Resource item projection (including the encrypted-Collection name
 * suppression rule), the listing envelope and its defaults, and the `next`
 * continuation link. Backends map their entries/rows through these builders so
 * the two can not drift.
 *
 * The name-suppression rule deliberately lives HERE, at the backend layer,
 * rather than in the request layer: a direct backend caller must get the
 * suppressed shape too.
 */
import type {
  CollectionDescription,
  CollectionResourcesList,
  ResourceMetadataCustom,
  ResourceSummary
} from '../types.js'
import { collectionPath, resourcePath } from './paths.js'
import { nextPageUrl } from './pagination.js'

/**
 * Whether a Collection's listing must suppress per-item names. On an encrypted
 * Collection a Resource's `custom` is the opaque encryption envelope, so the
 * server cannot project a `name` out of it; the listing omits it (spec "List
 * Collection", encrypted-Collection note). (A bare `custom?.name` on a JWE
 * envelope already yields `undefined`; the explicit rule makes that a
 * guarantee rather than an accident of the envelope's shape.)
 * @param options {object}
 * @param [options.collectionDescription] {CollectionDescription}
 * @returns {boolean}
 */
export function suppressesItemNames({
  collectionDescription
}: {
  collectionDescription?: CollectionDescription
}): boolean {
  return collectionDescription?.encryption !== undefined
}

/**
 * Projects one stored Resource into its listing item. `custom` is the
 * Resource's user-writable metadata, whose `name` is surfaced (spec: updating
 * it updates the name shown in Collection listings) unless `encrypted` says the
 * Collection suppresses names (see `suppressesItemNames`). `epoch` is the
 * client-declared key epoch (the `key-epochs` feature), which rides each
 * listing item so a reader can pick the right epoch key without a `/meta` fetch
 * per Resource.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.contentType {string}
 * @param [options.custom] {ResourceMetadataCustom}   the stored `custom` metadata
 * @param [options.epoch] {string}   the declared key-epoch id
 * @param options.encrypted {boolean}   whether item names are suppressed
 * @returns {ResourceSummary}
 */
export function collectionListingItem({
  spaceId,
  collectionId,
  resourceId,
  contentType,
  custom,
  epoch,
  encrypted
}: {
  spaceId: string
  collectionId: string
  resourceId: string
  contentType: string
  custom?: ResourceMetadataCustom
  epoch?: string
  encrypted: boolean
}): ResourceSummary {
  const name = encrypted ? undefined : custom?.name
  return {
    id: resourceId,
    url: resourcePath({ spaceId, collectionId, resourceId }),
    contentType,
    ...(name !== undefined && { name }),
    ...(epoch !== undefined && { epoch })
  }
}

/**
 * Wraps a page of listing items in the List Collection envelope. `name` and
 * `type` fall back to the Collection's id and `['Collection']` when the
 * Collection Description carries none (or none was resolvable -- an external
 * backend serving a data plane does not hold the description). `totalItems` is
 * the count of the whole Collection, not of the page.
 *
 * The `next` continuation link is present if and only if a further page may
 * follow -- its absence is the authoritative end-of-list signal. It resumes
 * from the last item on this page, which is the keyset both backends page on
 * (ascending `resourceId`).
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.collectionDescription] {CollectionDescription}
 * @param options.totalItems {number}   the Collection's full count
 * @param options.items {ResourceSummary[]}   this page's items
 * @param options.hasMore {boolean}   whether a further page may follow
 * @param options.pageSize {number}   the resolved page size, baked into `next`
 * @returns {CollectionResourcesList}
 */
export function collectionResourcesList({
  spaceId,
  collectionId,
  collectionDescription,
  totalItems,
  items,
  hasMore,
  pageSize
}: {
  spaceId: string
  collectionId: string
  collectionDescription?: CollectionDescription
  totalItems: number
  items: ResourceSummary[]
  hasMore: boolean
  pageSize: number
}): CollectionResourcesList {
  const lastItem = items[items.length - 1]
  let next: string | undefined
  if (hasMore && lastItem !== undefined) {
    next = nextPageUrl({
      path: collectionPath({
        spaceId,
        collectionId,
        trailingSlash: true
      }),
      limit: pageSize,
      after: lastItem.id
    })
  }

  return {
    id: collectionId,
    url: collectionPath({ spaceId, collectionId }),
    name: collectionDescription?.name ?? collectionId,
    type: collectionDescription?.type || ['Collection'],
    totalItems,
    items,
    ...(next !== undefined && { next })
  }
}
