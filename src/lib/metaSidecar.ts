/**
 * The shapes of the metadata sidecars -- a Resource's
 * (`.meta.<resourceId>.json`) and a Collection's
 * (`.collectionmeta.<collectionId>.json`) -- declared once for every consumer:
 * the filesystem backend persists them on disk verbatim, and the Postgres
 * backend synthesizes the same documents from its rows on export (and reads
 * them back on import), so archives stay interchangeable between the two
 * backends.
 */
import type { IDID, ResourceMetadataCustom } from '../types.js'

/**
 * The on-disk shape of a Resource's metadata sidecar (`.meta.<resourceId>.json`,
 * see `metaSidecarFileName`). Only the server-managed timestamps, the monotonic
 * `version`, and the user-writable `custom` object are persisted; `contentType`
 * / `size` are always derived from the stored representation, never duplicated
 * here.
 *
 * `createdBy` is the DID of whoever created the Resource (spec "Resource
 * Metadata Data Model"): an OPTIONAL server-managed property, absent when no
 * creator was recorded.
 *
 * `version` is the per-Resource monotonic counter that backs the HTTP `ETag`
 * strong validator (see `formatEtag`): it starts at 1 on first content write and
 * increments on each subsequent content write. It is `undefined` only for a
 * Resource written before versioning existed (a legacy sidecar), in which case
 * the backend treats the current version as 0.
 *
 * `metaVersion` is the independent monotonic counter for the `/meta`
 * sub-resource (spec V2 metadata versioning): it starts at 1 on first metadata
 * write and increments on each subsequent one, backing the `/meta` ETag. It is
 * kept separate from `version` so a metadata-only edit does not bump the content
 * ETag (preserving the content-ETag contract), and is `undefined` until the
 * first metadata write. A content write preserves it unchanged.
 *
 * `deleted` marks a **tombstone**: a soft delete that drops the content
 * representation but keeps the sidecar so the change feed (replication) still
 * surfaces it. A
 * tombstone has no `r.<id>...` content file, so it is invisible to every normal
 * read path (which gates on the content file via `#findFile`); only the
 * (future) change feed reads it. `contentType` records the representation's
 * last-known content-type, which the content filename no longer carries once it
 * is gone -- present only on a tombstone (a live Resource derives its
 * content-type from the filename).
 */
export interface MetaSidecar {
  createdAt: string
  updatedAt: string
  // DID of the Resource's creator, set from the invoker of the first content
  // write and thereafter preserved verbatim (as `createdAt` is), including
  // across a tombstone. Server-managed: never sourced from the request body,
  // and not reachable from the user-writable `custom`. Absent on a sidecar
  // written before `createdBy` was recorded, or by a caller with no invoker.
  createdBy?: IDID
  version?: number
  metaVersion?: number
  // On a plaintext Collection `custom` is `{ name, tags }`; on an encrypted
  // Collection it is the opaque encryption envelope (an arbitrary JSON object),
  // stored verbatim -- the server never decrypts it.
  custom?: ResourceMetadataCustom | Record<string, unknown>
  // The client-declared key epoch the current content was encrypted under (the
  // `key-epochs` feature). Stored opaquely: a content write sets it from the
  // `Key-Epoch` header (clearing it when absent -- the new ciphertext's
  // epoch is unknown), while a metadata write PRESERVES it unless the `/meta`
  // body supplies a new value. The server never computes or verifies it.
  epoch?: string
  deleted?: boolean
  contentType?: string
}

/**
 * The on-disk shape of a Collection's metadata sidecar
 * (`.collectionmeta.<collectionId>.json`, see `collectionMetaFileName`): the
 * server-managed timestamps of the metadata object itself, the monotonic
 * `metaVersion` backing its ETag, and the user-writable `custom` object.
 *
 * `createdAt` is stamped by the FIRST metadata write and `updatedAt` by the
 * latest one; both describe the metadata object, not the Collection (the
 * Collection's own creator is read from its description, where `createdBy`
 * lives, and is never duplicated here).
 *
 * `metaVersion` starts at 1 on the first metadata write and increments on each
 * subsequent one. It is independent of the Collection's `descriptionVersion`:
 * a description write never bumps it, and a metadata write never bumps the
 * description's.
 *
 * `custom` is `{ name, tags }` on a plaintext Collection and the opaque
 * encryption envelope on an encrypted one, stored verbatim either way.
 *
 * `epoch` is the client-declared key epoch the `custom` envelope was encrypted
 * under. Unlike the Resource sidecar's stamp -- which describes the content
 * write and so survives a metadata-only write -- this one describes the
 * envelope this very write replaces, so an update that omits it CLEARS it.
 */
export interface CollectionMetaSidecar {
  createdAt: string
  updatedAt: string
  metaVersion: number
  custom?: ResourceMetadataCustom | Record<string, unknown>
  epoch?: string
}
