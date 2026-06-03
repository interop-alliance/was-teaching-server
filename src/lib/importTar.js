import tar from 'tar-stream'
import YAML from 'yaml'

/**
 * @param {import('node:stream').Readable} tarStream
 * @returns {Promise<Map<string, { type: 'file' | 'directory', body?: Buffer }>>}
 */
export async function extractTarEntries (tarStream) {
  const entries = new Map()

  await new Promise((resolve, reject) => {
    const extract = tar.extract()

    extract.on('entry', (header, stream, next) => {
      if (header.type === 'directory') {
        entries.set(header.name, { type: 'directory' })
        stream.resume()
        next()
        return
      }

      const chunks = []
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
 * @param {Map<string, { type: string, body?: Buffer }>} entries
 * @returns {void}
 */
export function validateManifest (entries) {
  const manifestEntry = entries.get('manifest.yml')
  if (!manifestEntry?.body) {
    throw new Error('Archive is missing manifest.yml.')
  }

  let manifest
  try {
    manifest = YAML.parse(manifestEntry.body.toString('utf8'))
  } catch {
    throw new Error('Archive manifest.yml is not valid YAML.')
  }

  if (manifest['ubc-version'] !== '0.1') {
    throw new Error('Unsupported archive manifest version.')
  }

  if (!manifest.contents?.space) {
    throw new Error('Archive manifest does not describe a WAS space export.')
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
 * - space/<sourceSpaceId>/<collectionId>/
 * - space/<sourceSpaceId>/<collectionId>/.collection.<collectionId>.json
 * - space/<sourceSpaceId>/<collectionId>/r.<resourceId>.<encodedContentType>.<ext>
 *
 * The source space id in the path may differ from the import target; only
 * collection metadata and r.* resource files are merged into the destination.
 *
 * @param {Map<string, { type: string, body?: Buffer }>} entries
 * @returns {{
 *   collections: Array<{
 *     collectionId: string,
 *     collectionDescription: object,
 *     resources: Array<{ fileName: string, resourceId: string, body: Buffer }>
 *   }>
 * }}
 */
export function buildImportPlan (entries) {
  validateManifest(entries)

  let sourceSpaceId
  for (const name of entries.keys()) {
    const match = name.match(/^space\/([^/]+)\//)
    if (match) {
      sourceSpaceId = match[1]
      break
    }
  }
  if (!sourceSpaceId) {
    throw new Error('Archive does not contain space data.')
  }

  const prefix = `space/${sourceSpaceId}/`
  const collectionIds = new Set()
  for (const name of entries.keys()) {
    if (!name.startsWith(prefix)) {
      continue
    }
    const match = name.slice(prefix.length).match(/^([^/]+)\//)
    if (match) {
      collectionIds.add(match[1])
    }
  }

  const collections = [...collectionIds].sort().map(collectionId => {
    const collectionMetaKey = `${prefix}${collectionId}/.collection.${collectionId}.json`
    const metaEntry = entries.get(collectionMetaKey)
    const collectionDescription = metaEntry?.body
      ? JSON.parse(metaEntry.body.toString('utf8'))
      : { id: collectionId, type: ['Collection'], name: collectionId }

    const collectionPrefix = `${prefix}${collectionId}/`
    const resources = []
    for (const [entryName, entry] of entries) {
      if (!entryName.startsWith(collectionPrefix) || entry.type !== 'file') {
        continue
      }

      const fileName = entryName.slice(collectionPrefix.length)
      if (!fileName.startsWith('r.') || fileName.includes('/')) {
        continue
      }

      const parts = fileName.split('.')
      if (parts.length < 4) {
        continue
      }

      resources.push({
        fileName,
        resourceId: parts[1],
        body: entry.body
      })
    }

    return { collectionId, collectionDescription, resources }
  })

  return { collections }
}
