import path from 'node:path'
import { mkdir, stat as fsStat} from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import jsonfs from 'fs-json-store'
import { glob } from 'glob'
import { StorageError } from './errors.js'
import mime, { contentType } from 'mime-types'
import { isJson } from './isJson.js'

const { Store: MetadataJsonStore } = jsonfs

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

export function fileNameFor({ resourceId, contentType }) {
  const encodedType = encodeURIComponent(contentType)
  const extension = mime.extension(contentType) || 'blob'
  return `r.${resourceId}.${encodedType}.${extension}`
}

/**
 * Create a non-JSON resource
 *
 * @param spaceId
 * @param collectionId
 * @param resourceId
 * @param request
 * @returns {Promise<void>}
 */
export async function writeResource({ spaceId, collectionId, resourceId, request }) {
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)
  const requestContentType = request.headers['content-type']

  let dataContentType, filename, filePath
  if (isJson({ contentType: requestContentType })) {
    const filename = fileNameFor({ resourceId, contentType: requestContentType })
    const resourceJsonStore = new MetadataJsonStore({ file: path.join(collectionDir, filename) })
    console.log('Creating JSON resource')
    return await resourceJsonStore.write(request.body)
  } else if (requestContentType.startsWith('multipart')) {
    const data = request.file()
    dataContentType = data.mimetype // multipart encoded files have their own type
    filename = fileNameFor({ resourceId, contentType: dataContentType })
    filePath = path.join(collectionDir, filename)

    console.log('Writing multipart file, uploaded filename:', data.filename)
    await pipeline(data.file, fs.createWriteStream(filePath))
  } else {
    filename = fileNameFor({ resourceId, contentType: requestContentType })
    filePath = path.join(collectionDir, filename)

    console.log('Writing non-multipart blob')
    await pipeline(request.body, fs.createWriteStream(filePath))
  }
}

export async function findFile ({ collectionDir, resourceId }) {
  const [ filePath ] = await glob(path.join(collectionDir, `r.${resourceId}*`))
  return filePath
}

export async function openFileStream ({ filePath }) {
  try {
    const resourceStream = fs.createReadStream(filePath)
    return new Promise((resolve, reject) => {
      resourceStream
        .on('error', error => {
          reject(new Error(`Error creating a read stream: ${error}`))
        })
        .on('open', () => {
          console.info(`GET -- Reading ${filePath}`)
          resolve(resourceStream)
        })
    })
  } catch (e) {
    console.warn(`GET -- error reading ${filePath}: ${error.message}`)
  }
}

export async function getResource ({ spaceId, collectionId, resourceId, contentType }) {
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)

  let filename, filePath, storedResourceType
  if (contentType) {
    filename = fileNameFor({ resourceId, contentType })
    filePath = path.join(collectionDir, filename)
    storedResourceType = contentType
  } else {
    filePath = await findFile({ collectionDir, resourceId })
    storedResourceType = mime.lookup(filePath)
  }

  let resourceStream
  // First, try to see if resource exists for the requested content type directly
  try {
    await fsStat(filePath)
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new ResourceNotFoundError({ requestName: 'Get Resource' })
    }
    throw e
  }

  // File exists, return a stream on it
  return { resourceStream: await openFileStream({ filePath }), storedResourceType }
}
