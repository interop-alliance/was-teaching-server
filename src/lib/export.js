import path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import tar from 'tar-stream'
import { getSpaceDescription } from '../storage.js'
import { UBC_MANIFEST_URL, SPACE_URL, COLLECTION_URL, RESOURCE_URL } from '../../config.default.js'
import { SpaceNotFoundError } from '../errors.js'

export async function exportSpace ({ spaceId }) {
  const spaceDescription = await getSpaceDescription({ spaceId })
  if (!spaceDescription) {
    throw new SpaceNotFoundError({ requestName: 'Export Space' })
  }

  const sourceSpaceDir = path.join(import.meta.dirname, '..', '..', 'data', 'spaces', spaceId)

  const spaceEntries = await readdir(sourceSpaceDir, { withFileTypes: true })

  const collectionEntriesByDir = {}
  for (const entry of spaceEntries) {
    if (!entry.isDirectory()) continue
    const entries = await readdir(path.join(sourceSpaceDir, entry.name), { withFileTypes: true })
    collectionEntriesByDir[entry.name] = entries.filter(e => e.isFile())
  }

  const lines = [
    'ubc-version: 0.1',
    'contents:',
    '  manifest.yml:',
    `    url: "${UBC_MANIFEST_URL}"`,
    '  space:',
    `    url: "${SPACE_URL}"`,
    '    contents:',
    `      ${spaceId}:`,
    `        url: "${SPACE_URL}"`,
    '        contents:',
  ]

  for (const entry of spaceEntries) {
    if (!entry.isDirectory()) {
      // loose files (e.g. .space.*.json) — no url, no colon
      lines.push(`          ${entry.name}`)
      continue
    }

    lines.push(`          ${entry.name}:`)
    lines.push('            contents:')

    for (const file of collectionEntriesByDir[entry.name]) {
      lines.push(`              ${file.name}:`)
      if (file.name.startsWith('.collection.')) {
        lines.push(`                url: "${COLLECTION_URL}"`)
      } else if (file.name.startsWith('r.')) {
        lines.push(`                url: "${RESOURCE_URL}"`)
      }
    }
  }

  const pack = tar.pack()

  pack.entry({ name: 'manifest.yml' }, lines.join('\n') + '\n')
  pack.entry({ name: 'space/', type: 'directory' })
  pack.entry({ name: `space/${spaceId}/`, type: 'directory' })

  for (const entry of spaceEntries) {
    const entryTarget = `space/${spaceId}/${entry.name}`

    if (entry.isDirectory()) {
      pack.entry({ name: `${entryTarget}/`, type: 'directory' })
      for (const file of collectionEntriesByDir[entry.name]) {
        const bytes = await readFile(path.join(sourceSpaceDir, entry.name, file.name))
        pack.entry({ name: `${entryTarget}/${file.name}` }, bytes)
      }
    } else if (entry.isFile()) {
      const bytes = await readFile(path.join(sourceSpaceDir, entry.name))
      pack.entry({ name: entryTarget }, bytes)
    }
  }

  pack.finalize()
  return pack
}