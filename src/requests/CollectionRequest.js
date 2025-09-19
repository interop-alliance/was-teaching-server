import path from 'node:path'
import { FlexDocStore } from 'flex-docstore'
import { handleZcapVerify } from '../routes.js'
import { getSpace } from './SpaceRequest.js'
import { SpaceNotFoundError } from '../errors.js'
import { v4 as uuidv4 } from 'uuid'

export class CollectionRequest {

}

