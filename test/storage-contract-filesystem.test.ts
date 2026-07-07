/**
 * Runs the shared StorageBackend contract suite against the filesystem
 * backend (each harness over a private temp dir).
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { describeStorageBackendContract } from './storage-backend-contract.js'

describeStorageBackendContract({
  name: 'FileSystemBackend',
  async makeBackend({
    capacityBytes,
    maxUploadBytes,
    maxSpacesPerController,
    maxCollectionsPerSpace,
    maxResourcesPerSpace
  } = {}) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-contract-fs-'))
    const backend = new FileSystemBackend({
      dataDir,
      capacityBytes,
      maxUploadBytes,
      maxSpacesPerController,
      maxCollectionsPerSpace,
      maxResourcesPerSpace
    })
    return {
      backend,
      async cleanup() {
        await rm(dataDir, { recursive: true, force: true })
      }
    }
  },
  // The filesystem quota is a documented soft limit under concurrency, and
  // its `du` measurement includes block/file overhead.
  hardQuota: false,
  exactUsage: false
})
