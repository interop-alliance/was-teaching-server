import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { zcapClients } from './helpers.js'

const serverUrl = process.env.SERVER_URL || 'http://localhost:3002'

const { alice } = await zcapClients()

console.log('Using server:', serverUrl)

// 1) Create a new space
const createSpaceResponse = await alice.rootClient.request({
  url: new URL('/spaces/', serverUrl).toString(),
  method: 'POST',
  action: 'POST',
  json: {
    name: 'Export test space',
    controller: alice.did
  }
})

const spaceId = createSpaceResponse.data.id
console.log('Created space:', spaceId)

// 2) Add credentials collection
await alice.rootClient.request({
  url: new URL(`/space/${spaceId}/`, serverUrl).toString(),
  method: 'POST',
  action: 'POST',
  json: {
    id: 'credentials',
    name: 'Verifiable Credentials'
  }
})
console.log('Added collection: credentials')

// 3) Add one credential resource
const resourceId = randomUUID()
await alice.rootClient.request({
  url: new URL(`/space/${spaceId}/credentials/${resourceId}`, serverUrl).toString(),
  method: 'PUT',
  action: 'PUT',
  json: {
    id: resourceId,
    type: ['VerifiableCredential'],
    issuer: 'did:example:issuer',
    credentialSubject: {
      id: 'did:example:holder'
    }
  }
})
console.log('Added resource:', resourceId)

// 4) Export tarball
const exportResponse = await alice.rootClient.request({
  url: new URL(`/space/${spaceId}/export`, serverUrl).toString(),
  method: 'POST',
  action: 'POST',
  headers: {
    accept: 'application/x-tar'
  }
})

const tarBuffer = Buffer.from(await exportResponse.arrayBuffer())
const outputFile = `space-export-${spaceId}.tar`
await writeFile(outputFile, tarBuffer)

console.log('Export status:', exportResponse.status)
console.log('Saved tarball:', outputFile)
