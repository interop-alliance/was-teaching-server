/**
 * Runs the shared StorageBackend contract suite against the filesystem
 * backend (each harness over a private temp dir).
 */
import { openTempBackend } from './helpers.js'
import { describeStorageBackendContract } from './storage-backend-contract.js'

describeStorageBackendContract({
  name: 'FileSystemBackend',
  async makeBackend({
    physicalClock,
    capacityBytes,
    maxUploadBytes,
    maxSpacesPerController,
    maxCollectionsPerSpace
  } = {}) {
    const backend = await openTempBackend({
      prefix: 'was-contract-fs-',
      physicalClock,
      capacityBytes,
      maxUploadBytes,
      maxSpacesPerController,
      maxCollectionsPerSpace
    })
    return {
      backend,
      async cleanup() {
        await backend.close()
      }
    }
  },
  // The filesystem quota is a documented soft limit under concurrency, and
  // its `du` measurement includes block/file overhead.
  hardQuota: false,
  exactUsage: false
})
