/**
 * Atomic, durable filesystem write helpers, shared by the filesystem backend so
 * every write goes through one audited path. A durable write must survive a
 * crash or power loss without leaving a torn (partially-written) or missing
 * file: bytes land in a temp file in the SAME directory, the file descriptor is
 * fsync'd before close, the temp is `rename`d (or hard-`link`ed) onto the final
 * path -- an atomic metadata operation -- and finally the containing directory
 * is fsync'd so the new directory entry itself is on stable storage.
 *
 * Backend-agnostic (no backend imports). Temp files use a `.tmp-`
 * dot-prefix that no directory enumeration in the tree parses or filters on
 * (those match `r.`, `.r.`, `.meta.`, `.tombstone.`, `.space.`,
 * `.collection.`, `.backend.`, or a `.json` suffix), so a temp file transiently
 * present during a write is never mistaken for a Resource, sidecar, or config
 * record.
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { FastifyBaseLogger } from 'fastify'

const { open, rename, unlink, link, opendir, stat } = fs.promises

/**
 * The file-name prefix every staging temp file carries.
 */
export const TEMP_FILE_PREFIX = '.tmp-'

/**
 * The temp path a write for `filePath` stages into: a `.tmp-<uuid>` dot-file in
 * the SAME directory as the target, so the final `rename` / `link` stays on one
 * filesystem (a cross-device move is not atomic).
 * @param filePath {string}   the final destination path
 * @returns {string}
 */
export function tempPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `${TEMP_FILE_PREFIX}${randomUUID()}`)
}

/**
 * How long a staging temp file must have gone unmodified before
 * `sweepTempFiles` treats it as an orphan. A live write refreshes its temp
 * file's mtime as bytes arrive, so an hour of silence means no process is
 * writing it.
 */
export const TEMP_FILE_ORPHAN_AGE_MS = 60 * 60 * 1000

/**
 * Removes the stale staging temp files under `root`, at any depth unless
 * `recursive` is false. A write in
 * flight when the process is killed leaves its temp file behind. No listing
 * shows it, but it stays on disk and counts against the Space's `du`-based
 * quota. A temp file modified within the last `olderThanMs` is kept, since
 * another process sharing the directory (the old instance of a rolling
 * restart, or a dev server beside a test run) may still be writing it.
 *
 * Cleanup is best-effort. A directory that cannot be read, or a file that
 * cannot be removed, is logged and skipped rather than failing the sweep. The
 * tree is walked one directory at a time, so it is never listed whole in
 * memory. An absent `root` sweeps nothing.
 * @param options {object}
 * @param options.root {string}   the directory tree to sweep
 * @param options.logger {FastifyBaseLogger}   where skipped entries are logged
 * @param [options.olderThanMs] {number}   minimum age since last modification
 * @param [options.recursive] {boolean}   whether to descend into
 *   subdirectories (default true)
 * @returns {Promise<number>}   how many temp files were removed
 */
export async function sweepTempFiles({
  root,
  logger,
  olderThanMs = TEMP_FILE_ORPHAN_AGE_MS,
  recursive = true
}: {
  root: string
  logger: FastifyBaseLogger
  olderThanMs?: number
  recursive?: boolean
}): Promise<number> {
  const cutoff = Date.now() - olderThanMs
  let removed = 0
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop() as string
    try {
      for await (const entry of await opendir(dir)) {
        const entryPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (recursive) {
            pending.push(entryPath)
          }
        } else if (entry.isFile() && entry.name.startsWith(TEMP_FILE_PREFIX)) {
          removed += await removeIfStale({
            filePath: entryPath,
            cutoff,
            logger
          })
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, dir }, 'Temp file sweep skipped a directory')
      }
    }
  }
  return removed
}

/**
 * Removes one temp file if it was last modified before `cutoff`. A file that
 * vanished meanwhile (its write committed) counts as not removed; any other
 * failure is logged and skipped.
 * @param options {object}
 * @param options.filePath {string}
 * @param options.cutoff {number}   epoch ms; newer files are kept
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<number>}   1 if the file was removed, else 0
 */
async function removeIfStale({
  filePath,
  cutoff,
  logger
}: {
  filePath: string
  cutoff: number
  logger: FastifyBaseLogger
}): Promise<number> {
  try {
    if ((await stat(filePath)).mtimeMs >= cutoff) {
      return 0
    }
    await unlink(filePath)
    return 1
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err, filePath }, 'Temp file sweep could not remove a file')
    }
    return 0
  }
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
