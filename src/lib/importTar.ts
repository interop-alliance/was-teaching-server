import * as tar from 'tar-stream'
import YAML from 'yaml'
import type { Readable } from 'node:stream'
import { assertValidId } from './validateId.js'
import { parseResourceFileName } from './resourceFileName.js'
import { InvalidImportError } from '../errors.js'
import type { CollectionDescription, PolicyDocument } from '../types.js'

/** Suffix shared by the description / policy / metadata dot-files. */
const JSON_SUFFIX = '.json'
/** Prefix of a policy dot-file (`.policy.<id>.json`). */
const POLICY_PREFIX = '.policy.'
/** Prefix of a resource metadata sidecar (`.meta.<id>.json`). */
const META_PREFIX = '.meta.'

/**
 * If `fileName` is a dot-file with the given prefix and `.json` suffix, returns
 * the `<id>` between them; otherwise undefined. Uses slice (not split) so ids
 * containing dots (URL-safe `.` is allowed) round-trip correctly.
 * @param fileName {string}
 * @param prefix {string}
 * @returns {string | undefined}
 */
function dotFileId(fileName: string, prefix: string): string | undefined {
  if (!fileName.startsWith(prefix) || !fileName.endsWith(JSON_SUFFIX)) {
    return undefined
  }
  const id = fileName.slice(prefix.length, -JSON_SUFFIX.length)
  return id.length > 0 ? id : undefined
}

/**
 * If `fileName` is a policy dot-file (`.policy.<id>.json`), returns the `<id>`
 * it is keyed by; otherwise undefined.
 * @param fileName {string}
 * @returns {string | undefined}
 */
function policyFileId(fileName: string): string | undefined {
  return dotFileId(fileName, POLICY_PREFIX)
}

/**
 * If `fileName` is a metadata sidecar (`.meta.<resourceId>.json`), returns the
 * `<resourceId>` it is keyed by; otherwise undefined.
 * @param fileName {string}
 * @returns {string | undefined}
 */
export function metaSidecarFileId(fileName: string): string | undefined {
  return dotFileId(fileName, META_PREFIX)
}

/** One extracted archive entry, keyed by its archive path. */
export interface TarEntry {
  type: 'file' | 'directory'
  body?: Buffer
}

/** One resource staged for import by {@link buildImportPlan}. */
export interface ImportPlanResource {
  fileName: string
  resourceId: string
  body: Buffer
}

/** One collection (plus its resources and policies) staged for import. */
export interface ImportPlanCollection {
  collectionId: string
  collectionDescription: CollectionDescription
  /** Collection-level access-control policy, if the archive carries one. */
  collectionPolicy?: PolicyDocument
  resources: ImportPlanResource[]
  /** Resource-level policies, keyed by resourceId. */
  resourcePolicies: Map<string, PolicyDocument>
  /** Resource metadata sidecars (raw `.meta.<id>.json` bytes), keyed by resourceId. */
  resourceMetadata: Map<string, Buffer>
}

/** The merge plan produced by {@link buildImportPlan}. */
export interface ImportPlan {
  /** Space-level access-control policy, if the archive carries one. */
  spacePolicy?: PolicyDocument
  collections: ImportPlanCollection[]
}

/**
 * @param options {object}
 * @param options.tarStream {Readable}
 * @returns {Promise<Map<string, TarEntry>>}
 */
export async function extractTarEntries(
  tarStream: Readable
): Promise<Map<string, TarEntry>> {
  const entries = new Map<string, TarEntry>()

  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract()

    extract.on('entry', (header, stream, next) => {
      if (header.type === 'directory') {
        entries.set(header.name, { type: 'directory' })
        stream.resume()
        next()
        return
      }

      const chunks: Buffer[] = []
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.on('end', () => {
        entries.set(header.name, {
          type: 'file',
          body: Buffer.concat(chunks)
        })
        next()
      })
      stream.on('error', reject)
    })

    extract.on('finish', resolve)
    extract.on('error', reject)
    tarStream.on('error', reject)
    tarStream.pipe(extract)
  })

  return entries
}

/**
 * Validates that the archive carries a well-formed UBC v0.1 `manifest.yml`
 * describing a WAS space export. Throws on any problem.
 * @param entries {Map<string, TarEntry>}
 * @returns {void}
 */
export function validateManifest(entries: Map<string, TarEntry>): void {
  const manifestEntry = entries.get('manifest.yml')
  if (!manifestEntry?.body) {
    throw new InvalidImportError({
      message: 'Archive is missing manifest.yml.'
    })
  }

  let manifest
  try {
    manifest = YAML.parse(manifestEntry.body.toString('utf8'))
  } catch (err) {
    throw new InvalidImportError({
      message: 'Archive manifest.yml is not valid YAML.',
      cause: err as Error
    })
  }

  if (manifest['ubc-version'] !== '0.1') {
    throw new InvalidImportError({
      message: 'Unsupported archive manifest version.'
    })
  }

  if (!manifest.contents?.space) {
    throw new InvalidImportError({
      message: 'Archive manifest does not describe a WAS space export.'
    })
  }
}

/**
 * Build a merge plan from a WAS space export tarball.
 *
 * Expected archive layout (UBC v0.1, produced by exportSpace):
 * - manifest.yml
 * - space/
 * - space/<sourceSpaceId>/
 * - space/<sourceSpaceId>/.space.<sourceSpaceId>.json (space metadata; ignored on import)
 * - space/<sourceSpaceId>/.policy.<sourceSpaceId>.json (space-level policy)
 * - space/<sourceSpaceId>/<collectionId>/
 * - space/<sourceSpaceId>/<collectionId>/.collection.<collectionId>.json
 * - space/<sourceSpaceId>/<collectionId>/.policy.<collectionId>.json (collection policy)
 * - space/<sourceSpaceId>/<collectionId>/.policy.<resourceId>.json (resource policy)
 * - space/<sourceSpaceId>/<collectionId>/r.<resourceId>.<encodedContentType>.<ext>
 *
 * The source space id in the path may differ from the import target; collection
 * metadata, r.* resource files, and `.policy.*` policy files are merged into the
 * destination.
 *
 * @param entries {Map<string, TarEntry>}
 * @returns {ImportPlan}
 */
export function buildImportPlan(entries: Map<string, TarEntry>): ImportPlan {
  validateManifest(entries)

  let sourceSpaceId: string | undefined
  for (const name of entries.keys()) {
    const match = name.match(/^space\/([^/]+)\//)
    if (match) {
      sourceSpaceId = match[1]
      break
    }
  }
  if (!sourceSpaceId) {
    throw new InvalidImportError({
      message: 'Archive does not contain space data.'
    })
  }

  const prefix = `space/${sourceSpaceId}/`

  // Space-level policy (`.policy.<sourceSpaceId>.json` at the space root).
  const spacePolicyEntry = entries.get(`${prefix}.policy.${sourceSpaceId}.json`)
  const spacePolicy: PolicyDocument | undefined = spacePolicyEntry?.body
    ? JSON.parse(spacePolicyEntry.body.toString('utf8'))
    : undefined
  const collectionIds = new Set<string>()
  for (const name of entries.keys()) {
    if (!name.startsWith(prefix)) {
      continue
    }
    const match = name.slice(prefix.length).match(/^([^/]+)\//)
    if (match?.[1]) {
      // Reject a path-traversal / non-URL-safe id parsed from the archive
      // before it is used to build a destination path.
      assertValidId(match[1], {
        kind: 'collection',
        requestName: 'Import Space'
      })
      collectionIds.add(match[1])
    }
  }

  const collections = [...collectionIds].sort().map(collectionId => {
    const collectionMetaKey = `${prefix}${collectionId}/.collection.${collectionId}.json`
    const metaEntry = entries.get(collectionMetaKey)
    const collectionDescription: CollectionDescription = metaEntry?.body
      ? JSON.parse(metaEntry.body.toString('utf8'))
      : { id: collectionId, type: ['Collection'], name: collectionId }

    const collectionPrefix = `${prefix}${collectionId}/`
    const resources: ImportPlanResource[] = []
    let collectionPolicy: PolicyDocument | undefined
    const resourcePolicies = new Map<string, PolicyDocument>()
    const resourceMetadata = new Map<string, Buffer>()
    for (const [entryName, entry] of entries) {
      if (
        !entryName.startsWith(collectionPrefix) ||
        entry.type !== 'file' ||
        !entry.body
      ) {
        continue
      }

      const fileName = entryName.slice(collectionPrefix.length)
      if (fileName.includes('/')) {
        continue
      }

      // Policy dot-files: `.policy.<collectionId>.json` is the Collection policy;
      // `.policy.<resourceId>.json` is a Resource policy keyed by resource id.
      const policyId = policyFileId(fileName)
      if (policyId !== undefined) {
        const policy: PolicyDocument = JSON.parse(entry.body.toString('utf8'))
        if (policyId === collectionId) {
          collectionPolicy = policy
        } else {
          // Reject a path-traversal / non-URL-safe id parsed from the archive.
          assertValidId(policyId, {
            kind: 'resource',
            requestName: 'Import Space'
          })
          resourcePolicies.set(policyId, policy)
        }
        continue
      }

      // Metadata sidecar (`.meta.<resourceId>.json`): carried as raw bytes,
      // keyed by resourceId. Written alongside a newly-created resource
      // (preserving its timestamps and user-writable `custom`), or -- for a
      // tombstone, whose content file is gone -- on its own as an orphan sidecar
      // (see `importSpace`).
      const metaId = metaSidecarFileId(fileName)
      if (metaId !== undefined) {
        assertValidId(metaId, { kind: 'resource', requestName: 'Import Space' })
        resourceMetadata.set(metaId, entry.body)
        continue
      }

      if (!fileName.startsWith('r.')) {
        continue
      }

      const parts = fileName.split('.')
      if (parts.length < 4 || !parts[1]) {
        continue
      }

      // Decode the dot-escaped id segment (see `fileNameFor`) so a dotted id
      // (e.g. `index.html`) round-trips. The `fileName` is preserved verbatim
      // (the bytes are written under their stored name); only the parsed
      // `resourceId` -- used for dedup, sidecar, and policy keying -- is decoded.
      const { resourceId } = parseResourceFileName(fileName)

      // Reject a path-traversal / non-URL-safe resource id parsed from the
      // archive before its bytes are written to a destination path.
      assertValidId(resourceId, {
        kind: 'resource',
        requestName: 'Import Space'
      })

      resources.push({
        fileName,
        resourceId,
        body: entry.body
      })
    }

    return {
      collectionId,
      collectionDescription,
      collectionPolicy,
      resources,
      resourcePolicies,
      resourceMetadata
    }
  })

  return { spacePolicy, collections }
}
