/**
 * The shape of a Resource's metadata sidecar (`.meta.<resourceId>.json`),
 * declared once for every consumer: the filesystem backend persists it on disk
 * verbatim, and the Postgres backend synthesizes the same document from its
 * rows on export (and reads it back on import), so archives stay
 * interchangeable between the two backends. A Collection has no sidecar: its
 * annotation members live in its one Collection Metadata file.
 */
import { isPlainObject } from './isPlainObject.js'
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
 * `generation` is the sidecar's random marker (see `newGeneration`), minted
 * when the sidecar is first written and kept for its whole life, tombstone and
 * re-create included. Together with `version` it forms the content's HTTP
 * `ETag` strong validator (see `formatEtag`). A sidecar removed outright
 * (a chunk delete, or the delete of the Collection or Space) takes its
 * generation with it, so a later record under the same id mints a new one and
 * its validators never coincide with the old record's.
 *
 * `version` is the per-Resource monotonic counter behind the content `ETag`:
 * it starts at 1 on first content write and increments on each subsequent
 * content write. Both it and `generation` are `undefined` only for a Resource
 * written before versioning existed (a legacy sidecar), which then has no
 * `ETag`.
 *
 * `metaVersion` is the independent monotonic counter for the `/meta`
 * sub-resource (spec V2 metadata versioning): it starts at 1 on first metadata
 * write and increments on each subsequent one, backing the `/meta` ETag. It is
 * kept separate from `version` so a metadata-only edit does not bump the content
 * ETag (preserving the content-ETag contract), and is `undefined` until the
 * first metadata write. A content write preserves it unchanged.
 *
 * `metaGeneration` is the metadata object's own generation marker, minted by
 * the first metadata write beside `metaVersion` and paired with it as the
 * `/meta` ETag. It is independent of the content `generation`: the metadata
 * object dies with a soft delete (the tombstone drops `custom`, `metaVersion`,
 * and this marker together), so a re-created Resource's first metadata write
 * starts a fresh generation at `metaVersion` 1 and a `/meta` ETag held from
 * before the delete can never match again. The content validator, by
 * contrast, continues through the tombstone.
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
 *
 * `feedPosition` is the Resource's position in its Collection's changes feed:
 * each content write, metadata write, soft delete, and import of the Resource
 * takes the Collection's next position. It is one server's fact about its own
 * feed, so it never replicates. Export strips it (`withoutSidecarMember`),
 * import ignores an archived one and assigns a fresh position, and the
 * Postgres backend keeps the same fact in a column instead.
 * A sidecar written before feed positions existed carries none, and its
 * Resource is absent from the feed until it is rewritten.
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
  generation?: string
  version?: number
  metaGeneration?: string
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
  // The client-declared writer-attribution label naming the writing agent
  // that produced the current revision (spec "Writer attribution"). Stored
  // opaquely, from the `Writer-Id` header on a content write or a delete, or
  // the top-level `writerId` member on an Update Resource Metadata request.
  // Declare-or-clear at every level (unlike `epoch`, which a metadata write
  // preserves on omission): a write that declares none clears the stored
  // label. On a tombstone this is the label the DELETE itself declared, not
  // the Resource's prior label. The server never verifies it, computes it,
  // or uses it in any authorization decision.
  writerId?: string
  deleted?: boolean
  contentType?: string
  feedPosition?: number
}

/**
 * Parses a Resource sidecar's bytes. Resolves `undefined` for bytes that are
 * not a JSON object.
 * @param bytes {Buffer}
 * @returns {MetaSidecar | undefined}
 */
export function parseSidecarBytes(bytes: Buffer): MetaSidecar | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  // The member types are not checked here: a reader takes each member it
  // uses on its own terms, as it does for a sidecar read off the disk.
  return isPlainObject(parsed) ? (parsed as unknown as MetaSidecar) : undefined
}

/**
 * Removes one member from a Resource sidecar's bytes. Bytes that do not parse
 * as a JSON object, or that carry no such member, are returned unchanged.
 * Export uses it to strip the server-local `feedPosition`, and import to
 * strip a `createdBy` the archive did not earn.
 * @param options {object}
 * @param options.bytes {Buffer}   the stored sidecar bytes
 * @param options.member {keyof MetaSidecar}
 * @returns {Buffer}
 */
export function withoutSidecarMember({
  bytes,
  member
}: {
  bytes: Buffer
  member: keyof MetaSidecar
}): Buffer {
  const sidecar = parseSidecarBytes(bytes)
  if (sidecar === undefined || !(member in sidecar)) {
    return bytes
  }
  const { [member]: _dropped, ...rest } = sidecar
  return Buffer.from(JSON.stringify(rest))
}
