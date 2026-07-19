/**
 * Single source of truth for the server's relative URL path templates. The route
 * shapes registered in `routes.ts` (the `/spaces` repository, `/space/:spaceId`,
 * `/space/:spaceId/:collectionId`, the `policy` / `linkset` auxiliary resources,
 * and the `export` / `import` actions) are mirrored here as builder functions, so
 * handlers, the policy code, and the storage backends construct the same paths
 * from one place rather than re-deriving them inline (which risks drift from the
 * routes).
 *
 * Builders return the canonical, no-trailing-slash member form by default. The
 * spec assigns distinct meaning to a trailing slash -- it addresses the
 * container / "list-or-add-to" view of a member -- so the container builders take
 * an explicit `trailingSlash` option (or, for the always-container `/spaces/` and
 * `.../collections/`, bake the slash in) rather than leaving the slash to drift
 * across call sites. A leaf Resource has no children, so `resourcePath` has no
 * container form.
 */

/**
 * The SpacesRepository container (`/spaces/`) or one of its members
 * (`/spaces/:spaceId`). The member form is used for the `Location` header of a
 * newly created Space; the container form is the `POST`/`GET` target.
 * @param options {object}
 * @param [options.spaceId] {string}   when present, the repository member path;
 *   otherwise the (trailing-slash) container path
 * @returns {string}
 */
export function spacesPath({ spaceId }: { spaceId?: string } = {}): string {
  return spaceId !== undefined ? `/spaces/${spaceId}` : `/spaces/`
}

/**
 * `/space/:spaceId` (member) or `/space/:spaceId/` (container -- the
 * "add a Collection" / Space-as-container view) when `trailingSlash` is set.
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.trailingSlash] {boolean}   address the container form
 * @returns {string}
 */
export function spacePath({
  spaceId,
  trailingSlash = false
}: {
  spaceId: string
  trailingSlash?: boolean
}): string {
  return `/space/${spaceId}${trailingSlash ? '/' : ''}`
}

/**
 * `/space/:spaceId/collections/` -- the "List Collections" container path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function collectionsPath({ spaceId }: { spaceId: string }): string {
  return `${spacePath({ spaceId })}/collections/`
}

/**
 * `/space/:spaceId/export` -- the "Export Space" action path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function exportPath({ spaceId }: { spaceId: string }): string {
  return `${spacePath({ spaceId })}/export`
}

/**
 * `/space/:spaceId/import` -- the "Import Space" action path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function importPath({ spaceId }: { spaceId: string }): string {
  return `${spacePath({ spaceId })}/import`
}

/**
 * `/space/:spaceId/:collectionId` (member) or `/space/:spaceId/:collectionId/`
 * (container -- the "add a Resource" / "list items" view) when `trailingSlash`
 * is set.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.trailingSlash] {boolean}   address the container form
 * @returns {string}
 */
export function collectionPath({
  spaceId,
  collectionId,
  trailingSlash = false
}: {
  spaceId: string
  collectionId: string
  trailingSlash?: boolean
}): string {
  return `/space/${spaceId}/${collectionId}${trailingSlash ? '/' : ''}`
}

/**
 * `/space/:spaceId/:collectionId/:resourceId`
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {string}
 */
export function resourcePath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): string {
  return `/space/${spaceId}/${collectionId}/${resourceId}`
}

/**
 * The `policy` auxiliary resource path for whichever level the ids address:
 * Space (`spaceId`), Collection (`+ collectionId`), or Resource
 * (`+ collectionId + resourceId`).
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @returns {string}
 */
export function policyPath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId?: string
  resourceId?: string
}): string {
  if (collectionId !== undefined && resourceId !== undefined) {
    return `${resourcePath({ spaceId, collectionId, resourceId })}/policy`
  }
  if (collectionId !== undefined) {
    return `${collectionPath({ spaceId, collectionId })}/policy`
  }
  return `${spacePath({ spaceId })}/policy`
}

/**
 * `/space/:spaceId/backends` -- the "Space Backends Available" list path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function backendsPath({ spaceId }: { spaceId: string }): string {
  return `${spacePath({ spaceId })}/backends`
}

/**
 * `/space/:spaceId/backends/:backendId` -- a single registered `external`
 * backend record (the `POST` `Location` target, and the `PUT`/`DELETE` member
 * path). Distinct from {@link backendPath}, which is a Collection's *selected*
 * backend resource.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.backendId {string}
 * @returns {string}
 */
export function registeredBackendPath({
  spaceId,
  backendId
}: {
  spaceId: string
  backendId: string
}): string {
  return `${backendsPath({ spaceId })}/${backendId}`
}

/**
 * `/space/:spaceId/quotas` -- the Space Quota report path (spec "Quotas").
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function quotasPath({ spaceId }: { spaceId: string }): string {
  return `${spacePath({ spaceId })}/quotas`
}

/**
 * `/space/:spaceId/:collectionId/:resourceId/meta` -- the Resource Metadata
 * (reserved `meta` segment) path. Reserved only at the Resource level, so it
 * takes the full id triple.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {string}
 */
export function metaPath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): string {
  return `${resourcePath({ spaceId, collectionId, resourceId })}/meta`
}

/**
 * `/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex` -- a single
 * chunk of a chunked Resource (the `chunked-streams` feature). Chunks are
 * addressed under their parent Resource; like `meta`, the `chunks` segment
 * needs no reserved-id entry (it sits a level below any Resource route).
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.chunkIndex {number}   non-negative integer chunk position
 * @returns {string}
 */
export function chunkPath({
  spaceId,
  collectionId,
  resourceId,
  chunkIndex
}: {
  spaceId: string
  collectionId: string
  resourceId: string
  chunkIndex: number
}): string {
  return `${resourcePath({ spaceId, collectionId, resourceId })}/chunks/${chunkIndex}`
}

/**
 * `/space/:spaceId/:collectionId/:resourceId/chunks/` -- the chunk listing
 * (container) path of a chunked Resource. Always the trailing-slash container
 * form: a reader discovers the chunk count here before fetching `0..count-1`.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {string}
 */
export function chunksContainerPath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): string {
  return `${resourcePath({ spaceId, collectionId, resourceId })}/chunks/`
}

/**
 * `/space/:spaceId/:collectionId/backend` -- the "Collection Backend Selected"
 * resource path (reserved `backend` segment at the Resource level).
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function backendPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionPath({ spaceId, collectionId })}/backend`
}

/**
 * `/space/:spaceId/:collectionId/quota` -- the per-Collection storage quota
 * report path (reserved `quota` segment at the Resource level; spec "Quotas").
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function quotaPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionPath({ spaceId, collectionId })}/quota`
}

/**
 * `/space/:spaceId/:collectionId/query` -- the reserved `query` endpoint for a
 * Collection (spec "Collection-level reserved endpoints"). The WAS server serves
 * the replication change feed as the `changes` profile of this endpoint.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function queryPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionPath({ spaceId, collectionId })}/query`
}

/**
 * The `linkset` discovery resource path for a Space (`spaceId`) or Collection
 * (`+ collectionId`).
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @returns {string}
 */
export function linksetPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId?: string
}): string {
  const anchor =
    collectionId !== undefined
      ? collectionPath({ spaceId, collectionId })
      : spacePath({ spaceId })
  return `${anchor}/linkset`
}

/**
 * `/kms/keystores` -- the WebKMS keystores collection (create/list target; the
 * `/kms` facet) or one of its member keystores
 * (`/kms/keystores/:keystoreId`). Unlike the WAS builders there is no
 * trailing-slash container form: the webkms protocol
 * (`@interop/webkms-client`) posts to the bare collection path.
 * @param options {object}
 * @param [options.keystoreId] {string}   the keystore's server-generated local
 *   id; when present, the member path, otherwise the collection path
 * @returns {string}
 */
export function kmsKeystoresPath({
  keystoreId
}: { keystoreId?: string } = {}): string {
  return keystoreId !== undefined
    ? `/kms/keystores/${keystoreId}`
    : '/kms/keystores'
}

/**
 * `/kms/keystores/:keystoreId/keys` -- a keystore's keys collection (the
 * `GenerateKeyOperation` target) or one of its member keys
 * (`/kms/keystores/:keystoreId/keys/:keyId`, the key-operation / description
 * target). Like `kmsKeystoresPath`, no trailing-slash form exists: the webkms
 * protocol's URLs are exact.
 * @param options {object}
 * @param options.keystoreId {string}   the keystore's local id
 * @param [options.keyId] {string}   the key's server-generated local id; when
 *   present, the member path, otherwise the collection path
 * @returns {string}
 */
export function kmsKeysPath({
  keystoreId,
  keyId
}: {
  keystoreId: string
  keyId?: string
}): string {
  const keysPath = `${kmsKeystoresPath({ keystoreId })}/keys`
  return keyId !== undefined ? `${keysPath}/${keyId}` : keysPath
}

/**
 * `/kms/keystores/:keystoreId/zcaps/revocations/:revocationId` -- a keystore's
 * zcap revocation submission target (POST; the ezcap-express
 * `/zcaps/revocations/` convention). `revocationId` is the *to-be-revoked
 * capability's id*, URL-encoded into the single path segment the route
 * expects -- the same `encodeURIComponent` framing `@interop/webkms-client`'s
 * `revokeCapability` puts on the wire.
 * @param options {object}
 * @param options.keystoreId {string}   the keystore's local id
 * @param options.revocationId {string}   the to-be-revoked capability's id
 *   (raw, un-encoded)
 * @returns {string}
 */
export function kmsRevocationsPath({
  keystoreId,
  revocationId
}: {
  keystoreId: string
  revocationId: string
}): string {
  return (
    `${kmsKeystoresPath({ keystoreId })}/zcaps/revocations/` +
    encodeURIComponent(revocationId)
  )
}

/**
 * `/space/:spaceId/zcaps/revocations/:revocationId` -- a Space's zcap
 * revocation submission target (POST), the WAS-route sibling of
 * `kmsRevocationsPath` and the same ezcap-express `/zcaps/revocations/`
 * convention. `revocationId` is the *to-be-revoked capability's id*,
 * URL-encoded into the single path segment the route expects. The `zcaps`
 * segment sits four levels under `/space`, deeper than any Collection or
 * Resource route, so it shadows neither and needs no reserved-id entry.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.revocationId {string}   the to-be-revoked capability's id
 *   (raw, un-encoded)
 * @returns {string}
 */
export function spaceRevocationsPath({
  spaceId,
  revocationId
}: {
  spaceId: string
  revocationId: string
}): string {
  return (
    `${spacePath({ spaceId })}/zcaps/revocations/` +
    encodeURIComponent(revocationId)
  )
}
