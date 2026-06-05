/**
 * Storage composition helper: builds the default StorageBackend used by the
 * server when no backend is injected.
 *
 * This module only supplies the default backend for production / `start.ts`,
 * where `createApp()` is called without an explicit backend.
 * The active backend is injected into the Fastify instance via
 * `createApp({ backend })` (see server.ts) and read in handlers as
 * `request.server.storage`.
 *
 * The StorageBackend contract — including its invariants (getters resolve falsy
 * for not-found, writes are upserts, deletes are idempotent) — is documented on
 * the interface in src/types.ts.
 */
import path from 'node:path'
import { FileSystemBackend } from './backends/filesystem.js'
import type { StorageBackend } from './types.js'

/**
 * Builds the default filesystem-backed storage, rooted at the project `data/`
 * directory. Used by `createApp()` when no backend is injected (production).
 * @returns {StorageBackend}
 */
export function defaultBackend(): StorageBackend {
  return new FileSystemBackend({
    dataDir: path.join(import.meta.dirname, '..', 'data')
  })
}
