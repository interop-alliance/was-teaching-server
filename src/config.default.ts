/**
 * Default configuration: spec and FEP documentation URLs referenced by the
 * home page, error responses, and space-export manifests.
 */
import fs from 'node:fs'
import path from 'node:path'

// package.json sits a level above both src/ (dev, via tsx) and dist/ (prod),
// so '../package.json' from import.meta.dirname resolves in either layout.
const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json')

/** Server version, read from package.json at startup. */
export const SERVER_VERSION = JSON.parse(
  fs.readFileSync(packageJsonPath, 'utf8')
).version as string

export const SPEC_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/'
export const UBC_MANIFEST_URL =
  'https://codeberg.org/fediverse/fep/src/branch/main/fep/6fcd/fep-6fcd.md#manifest-file'
export const SPACE_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/#spaces'
export const COLLECTION_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/#collection-data-model'
export const RESOURCE_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/#resource-data-model'
export const POLICY_URL =
  'https://digitalcredentials.github.io/wallet-attached-storage-spec/#policy'
