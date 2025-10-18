import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import fsjs from 'fs-json-store'
import { glob } from 'glob'
import { StorageError } from './errors.js'

const { Store: MetadataJsonStore } = fsjs

/**
 * Spaces
 */

export async function ensureSpaceStorageDir ({ spaceId }) {
  // Create a directory for the incoming space
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const spaceDir = path.join(spacesRepository, spaceId)
  try {
    await mkdir(spaceDir)
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.log(`Space "${spaceId}" already exists, overwriting."`)
    } else {
      throw new StorageError({ cause: err })
    }
  }
  return spaceDir
}

export async function createSpace({ spaceId, spaceDescription }) {
  const spaceDir = await ensureSpaceStorageDir({ spaceId })

  const filename = `.space.${spaceId}.json`
  const metaStore = new MetadataJsonStore({ file: path.join(spaceDir, filename) })

  return await metaStore.write(spaceDescription)
}

/**
 * @param spaceId {string}
 * @returns {Promise<object>} Returns the parsed JSON Space description object
 */
export async function getSpaceDescription ({ spaceId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const spaceDir = path.join(spacesRepository, spaceId)

  const filename = `.space.${spaceId}.json`
  const metaStore = new MetadataJsonStore({ file: path.join(spaceDir, filename) })
  return await metaStore.read()
}

/**
 * Collections
 */

export async function ensureCollectionDir ({ spaceId, collectionId }) {
  // Create a directory for the incoming collection
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)

  try {
    await mkdir(collectionDir)
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.log(`Collection "${collectionId}" already exists, overwriting."`)
    } else {
      console.log('Error creating directory', err)
      throw err // http 500
    }
  }
  return collectionDir
}

export async function createCollection ({ spaceId, collectionId, collectionDescription }) {
  const collectionDir = await ensureCollectionDir({ spaceId, collectionId })

  const filename = `.collection.${collectionId}.json`
  const metaStore = new MetadataJsonStore({ file: path.join(collectionDir, filename) })
  return await metaStore.write(collectionDescription)
}

export async function getCollectionDescription ({ spaceId, collectionId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)

  const filename = `.collection.${collectionId}.json`
  const metaStore = new MetadataJsonStore({ file: path.join(collectionDir, filename) })
  return await metaStore.read()
}

export async function listCollectionItems ({ spaceId, collectionId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)
  const dirPath = path.join(collectionDir, '*')
  let keys
  try {
    keys = (await glob(dirPath))
      .map(fullFilepath => path.basename(fullFilepath, '.json'))
  } catch (e) {
    console.error(e)
  }

  return {
    offset: 0,
    total_rows: keys.length,
    rows: keys.map(key => {
      return { id: key }
    })
  }
}

/**
 * Resource
 */

/**
 * @param spaceId {string}
 * @param collectionId {string}
 * @param resourceId {string}
 * @param resource {object}
 * @returns {Promise<void>}
 */
export async function createResource ({ spaceId, collectionId, resourceId, resource }) {
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)

  const filename = `${resourceId}.json`
  const resourceJsonStore = new MetadataJsonStore({ file: path.join(collectionDir, filename) })
  return await resourceJsonStore.write(resource)
}

export async function getResource ({ spaceId, collectionId, resourceId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)

  const filename = `${resourceId}.json`
  const resourceJsonStore = new MetadataJsonStore({ file: path.join(collectionDir, filename) })
  return await resourceJsonStore.read()
}
