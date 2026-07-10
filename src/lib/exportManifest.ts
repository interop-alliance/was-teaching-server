/**
 * Backend-agnostic builder for the Space-export `manifest.yml` document (UBC
 * v0.1, FEP-6fcd). Both storage backends synthesize the same archive layout --
 * `space/<spaceId>/...` entries in the filesystem backend's on-disk file-name
 * dialect -- so an archive exported from one backend imports into the other;
 * this module is the single home for the manifest that describes it.
 */
import {
  UBC_MANIFEST_URL,
  SPACE_URL,
  COLLECTION_URL,
  RESOURCE_URL,
  POLICY_URL,
  META_URL
} from '../config.default.js'

/**
 * One top-level entry of the Space being exported, in archive order: a
 * Space-level file (`files` absent) or a Collection directory with its ordered
 * file names.
 */
export interface ExportSpaceEntry {
  name: string
  /** present for a Collection directory: its file names, in archive order */
  files?: string[]
}

/**
 * Classifies one Collection-dir file name into its manifest entry: the known
 * dot-file kinds and resource representations get a documenting `url`, anything
 * else is listed by bare name.
 * @param fileName {string}
 * @returns {unknown}
 */
function collectionManifestEntry(fileName: string): unknown {
  if (fileName.startsWith('.collection.')) {
    return { [fileName]: { url: COLLECTION_URL } }
  }
  if (fileName.startsWith('.policy.')) {
    return { [fileName]: { url: POLICY_URL } }
  }
  if (fileName.startsWith('.meta.')) {
    return { [fileName]: { url: META_URL } }
  }
  if (fileName.startsWith('r.')) {
    return { [fileName]: { url: RESOURCE_URL } }
  }
  return fileName
}

/**
 * Builds the UBC v0.1 manifest object for a Space export. The caller supplies
 * the archive's top-level entries in the order they will be packed (Space-level
 * files interleaved with Collection directories); the manifest mirrors that
 * order.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.entries {ExportSpaceEntry[]}   ordered top-level entries
 * @param [options.revocationFiles] {string[]}   ordered file names of the
 *   archive's Space-scoped zcap revocation records (`revocations/` entries);
 *   omitted from the manifest when the Space has none
 * @returns {object}   the manifest document (serialize with `YAML.stringify`)
 */
export function buildExportManifest({
  spaceId,
  entries,
  revocationFiles = []
}: {
  spaceId: string
  entries: ExportSpaceEntry[]
  revocationFiles?: string[]
}): object {
  const spaceContents: unknown[] = []
  for (const entry of entries) {
    if (entry.files === undefined) {
      // top-level files in space (e.g. .space.<spaceId>.json)
      spaceContents.push(entry.name)
      continue
    }
    spaceContents.push({
      [entry.name]: {
        contents: entry.files.map(collectionManifestEntry)
      }
    })
  }

  return {
    'ubc-version': '0.1',
    contents: {
      'manifest.yml': { url: UBC_MANIFEST_URL },
      ...(revocationFiles.length > 0 && {
        revocations: { contents: [...revocationFiles] }
      }),
      space: {
        url: SPACE_URL,
        contents: {
          [spaceId]: {
            url: SPACE_URL,
            contents: spaceContents
          }
        }
      }
    }
  }
}
