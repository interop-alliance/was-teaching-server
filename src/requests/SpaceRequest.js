import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { FlexDocStore } from 'flex-docstore'
import { handleZcapVerify } from '../routes.js'
import { SpaceNotFoundError } from '../errors.js'
import { v4 as uuidv4 } from 'uuid'

export class SpaceRequest {
  /**
   * GET /space/:spaceId
   * Request handler for "Read Space" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async get (request, reply) {
    const { params: { spaceId }, url, method, headers } = request
    const { serverUrl } = this

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpace({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Get Space' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}`, serverUrl)).toString()
    const allowedAction = 'GET'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController, requestName: 'Get Space',
      specErrorSection: 'read-space-errors', reply })

    // zCap checks out, continue
    return reply.status(200).send(spaceDescription)
  }

  /**
   * POST /space/:spaceId/
   * Request handler for "Create Collection" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   */
  static async post (request, reply) {
    const { params: { spaceId }, url, method, headers, body } = request
    const { serverUrl } = this

    // Fetch the space by id, from storage. Needed for signature verification.
    const spaceDescription = await getSpace({ spaceId })
    if (!spaceDescription) {
      throw new SpaceNotFoundError({ requestName: 'Create Collection' })
    }
    const spaceController = spaceDescription.controller

    // Perform zCap signature verification (throws appropriate errors)
    const allowedTarget = (new URL(`/space/${spaceId}/`, serverUrl)).toString()
    const allowedAction = 'POST'
    await handleZcapVerify({ url, allowedTarget, allowedAction, method, headers,
      serverUrl, spaceController })

    // zCap checks out, continue
    // TODO: use a uuid v5 or another hash based id here instead
    // TODO: Protect against .space resource id collision
    const collectionId = body.id || uuidv4()
    const { name } = body
    const collectionDescription = { id: collectionId, type: ['Collection'], name }

    const collectionStorage = await ensureCollectionStorage({ spaceId, collectionId })
    await collectionStorage.put('.collection', collectionDescription)

    const createdUrl = (new URL(`/space/${spaceId}/${collectionId}`, serverUrl)).toString()
    reply.header('Location', createdUrl)
    return reply.status(201).send(collectionDescription)
  }
}

export async function getSpace ({ spaceId }) {
  const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')
  const spaceDir = path.join(spacesRepository, spaceId)
  const storage = FlexDocStore.using('files', { dir: spaceDir, extension: '.json' })

  return storage.get('.space')
}

export async function ensureCollectionStorage ({ spaceId, collectionId }) {
  // Create a directory for the incoming collection
  const spacesRepository = path.join(import.meta.dirname, '..', '..', 'data', 'spaces')
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
