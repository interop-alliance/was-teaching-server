/**
 * Atomic, durable filesystem write helpers, shared by the filesystem backend so
 * every write goes through one audited path. A durable write must survive a
 * crash or power loss without leaving a torn (partially-written) or missing
 * file: bytes land in a temp file in the SAME directory, the file descriptor is
 * fsync'd before close, the temp is `rename`d (or hard-`link`ed) onto the final
 * path -- an atomic metadata operation -- and finally the containing directory
 * is fsync'd so the new directory entry itself is on stable storage.
 *
 * Pure and backend-agnostic (no backend imports). Temp files use a `.tmp-`
 * dot-prefix that no directory enumeration in the tree parses or filters on
 * (those match `r.`, `.meta.`, `.space.`, `.collection.`, `.policy.`,
 * `.backend.`, or a `.json` suffix), so a temp file transiently present during
 * a write is never mistaken for a Resource, sidecar, or config record.
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

const { open, rename, unlink, link } = fs.promises

/**
 * The temp path a write for `filePath` stages into: a `.tmp-<uuid>` dot-file in
 * the SAME directory as the target, so the final `rename` / `link` stays on one
 * filesystem (a cross-device move is not atomic).
 * @param filePath {string}   the final destination path
 * @returns {string}
 */
export function tempPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `.tmp-${randomUUID()}`)
}

/**
 * fsync a directory so a just-created/renamed entry within it is durable.
 * Swallows the errors platforms raise when a directory handle cannot be fsync'd
 * (e.g. Windows), but lets genuine failures propagate.
 * @param dirPath {string}
 * @returns {Promise<void>}
 */
export async function fsyncDirectory(dirPath: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await open(dirPath, 'r')
    await handle.sync()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Platforms that cannot fsync a directory handle report one of these; the
    // rename/link itself already succeeded, so treat directory fsync as a
    // best-effort durability step rather than a hard failure.
    if (
      code === 'EISDIR' ||
      code === 'EPERM' ||
      code === 'EBADF' ||
      code === 'ENOTSUP' ||
      code === 'EINVAL'
    ) {
      return
    }
    throw err
  } finally {
    await handle?.close()
  }
}

/**
 * Writes `data` to `tempPath` (exclusive create) and fsyncs the file descriptor
 * before closing, so the bytes are on stable storage before any rename/link
 * publishes the temp under a caller-visible name.
 * @param options {object}
 * @param options.tempPath {string}
 * @param options.data {string|Buffer}
 * @returns {Promise<void>}
 */
async function writeAndSyncTemp({
  tempPath,
  data
}: {
  tempPath: string
  data: string | Buffer
}): Promise<void> {
  const handle = await open(tempPath, 'wx')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Atomically and durably writes `data` to `filePath` (full replacement):
 * write + fsync a temp file, `rename` it onto `filePath`, then fsync the
 * directory. The final path never observes a partially-written file. On any
 * failure the temp file is cleaned up.
 * @param options {object}
 * @param options.filePath {string}
 * @param options.data {string|Buffer}
 * @returns {Promise<void>}
 */
export async function atomicWriteFile({
  filePath,
  data
}: {
  filePath: string
  data: string | Buffer
}): Promise<void> {
  const tempPath = tempPathFor(filePath)
  try {
    await writeAndSyncTemp({ tempPath, data })
    await rename(tempPath, filePath)
  } catch (err) {
    await unlink(tempPath).catch(() => {})
    throw err
  }
  await fsyncDirectory(path.dirname(filePath))
}

/**
 * Atomically and durably creates `filePath`, failing if it already exists --
 * the `wx`-style create-only semantics, preserved atomically: write + fsync a
 * temp file, then `fs.promises.link` it onto `filePath` (which rejects with
 * `EEXIST` when the target exists), unlink the temp, and fsync the directory.
 * An `EEXIST` propagates so callers can map it to their conflict errors; on any
 * failure the temp file is cleaned up while `filePath` is left untouched.
 * @param options {object}
 * @param options.filePath {string}
 * @param options.data {string|Buffer}
 * @returns {Promise<void>}
 */
export async function atomicCreateFile({
  filePath,
  data
}: {
  filePath: string
  data: string | Buffer
}): Promise<void> {
  const tempPath = tempPathFor(filePath)
  try {
    await writeAndSyncTemp({ tempPath, data })
    await link(tempPath, filePath)
  } catch (err) {
    // Only ever remove the temp file here, never `filePath`: on an EEXIST the
    // pre-existing target must survive intact.
    await unlink(tempPath).catch(() => {})
    throw err
  }
  await unlink(tempPath).catch(() => {})
  await fsyncDirectory(path.dirname(filePath))
}

/**
 * Commits a temp file a caller streamed into (see `tempPathFor`) onto its final
 * path durably: fsync the temp's bytes, `rename` it onto `filePath`, then fsync
 * the directory. The caller owns cleanup of the temp file on a streaming
 * failure (it never reaches here in that case).
 * @param options {object}
 * @param options.tempPath {string}
 * @param options.filePath {string}
 * @returns {Promise<void>}
 */
export async function commitTempFile({
  tempPath,
  filePath
}: {
  tempPath: string
  filePath: string
}): Promise<void> {
  const handle = await open(tempPath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tempPath, filePath)
  await fsyncDirectory(path.dirname(filePath))
}
