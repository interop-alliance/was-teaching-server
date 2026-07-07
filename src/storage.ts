/**
 * Storage composition helper: builds the default StorageBackend used by the
 * server when no backend is injected.
 *
 * This module only supplies the default backend for production / `start.ts`,
 * where `createApp()` is called without an explicit backend.
 * The active backend is injected into the Fastify instance via
 * `createApp({ backend })` (see plugin.ts) and read in handlers as
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
 * @param options {object}
 * @param [options.capacityBytes] {number}   per-Space storage limit in bytes
 *   (spec "Quotas"); `undefined` (or `Infinity`) means each Space is unlimited.
 * @param [options.maxUploadBytes] {number}   per-upload size cap in bytes (spec
 *   "Quotas", `maxUploadBytes`); `undefined` applies the backend's default-on
 *   cap, `Infinity` means no per-upload cap.
 * @param [options.maxSpacesPerController] {number}   max Spaces per controller
 *   (spec "Quotas"); `undefined` applies the backend's default-on limit,
 *   `Infinity` means no cap.
 * @param [options.maxCollectionsPerSpace] {number}   max Collections per Space
 *   (spec "Quotas"); `undefined` applies the backend's default-on limit,
 *   `Infinity` means no cap.
 * @param [options.maxResourcesPerSpace] {number}   max live Resources per Space
 *   (spec "Quotas"); `undefined` applies the backend's default-on limit,
 *   `Infinity` means no cap.
 * @returns {StorageBackend}
 */
export function defaultBackend({
  capacityBytes,
  maxUploadBytes,
  maxSpacesPerController,
  maxCollectionsPerSpace,
  maxResourcesPerSpace
}: {
  capacityBytes?: number
  maxUploadBytes?: number
  maxSpacesPerController?: number
  maxCollectionsPerSpace?: number
  maxResourcesPerSpace?: number
} = {}): StorageBackend {
  return new FileSystemBackend({
    dataDir: path.join(import.meta.dirname, '..', 'data'),
    capacityBytes,
    maxUploadBytes,
    maxSpacesPerController,
    maxCollectionsPerSpace,
    maxResourcesPerSpace
  })
}
