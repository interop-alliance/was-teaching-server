import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { FlexDocStore } from 'flex-docstore'
import { StorageError } from './errors.js'

export async function ensureCollectionStorage ({ spaceId, collectionId }) {
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
  return FlexDocStore.using('files', { dir: collectionDir, collection: collectionId, extension: '.json' })
}

export async function ensureSpaceStorage ({ spaceId }) {
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
  return FlexDocStore.using('files', { dir: spaceDir, extension: '.json' })
}

export function getCollectionStorage ({ spaceId, collectionId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const collectionDir = path.join(spacesRepository, spaceId, collectionId)
  return FlexDocStore.using('files', { dir: collectionDir, collection: collectionId, extension: '.json' })
}

export async function getSpace ({ spaceId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', 'data', 'spaces')
  const spaceDir = path.join(spacesRepository, spaceId)
  const storage = FlexDocStore.using('files', { dir: spaceDir, extension: '.json' })

  return storage.get('.space')
}
