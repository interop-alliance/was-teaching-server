import { ZcapClient } from '@digitalcredentials/ezcap'
import { decodeSecretKeySeed } from 'bnid'
import { Ed25519Signature2020 } from '@digitalcredentials/ed25519-signature-2020'
import { Ed25519VerificationKey2020 } from '@digitalcredentials/ed25519-verification-key-2020'
import { v4 as uuidv4 } from 'uuid'

import { serverUrl, onboardingToken } from './config.js'

const secretKeySeeds = {
  alice: 'z1Air2KcEdUpJnJ9m61WFRUFgtC3LHrmGCpwFAkZ7rbbohX',
  aliceDelegatedApp: 'z1AeeM8yN1D3cM56LsPmr3fFKuyv7MC4tdRkeiujMkyRy2u',
  bob: 'z1AmpBeBetWxKMBpAcHsztGogaUki1LXWANSzTd5CiYoikA',
  bobDelegatedApp: 'z1AfgF2HQvQaaAhod3KEYUHwY5epGtP5QmbEMKtMFf8XcYk'
}

export function zcapClient ({ signer }) {
  return new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: signer,
    delegationSigner: signer
  })
}

export async function buildZcapClients () {
  const aliceKeyPair = await Ed25519VerificationKey2020.generate({
    seed: decodeSecretKeySeed({ secretKeySeed: secretKeySeeds.alice })
  })
  const aliceRootDid = `did:key:${aliceKeyPair.fingerprint()}`
  aliceKeyPair.id = `${aliceRootDid}#${aliceKeyPair.fingerprint()}`
  const aliceRootClient = zcapClient({ signer: aliceKeyPair.signer() })

  const aliceDelegatedAppKeyPair = await Ed25519VerificationKey2020.generate({
    seed: decodeSecretKeySeed({ secretKeySeed: secretKeySeeds.aliceDelegatedApp })
  })
  const aliceDelegatedAppDid = `did:key:${aliceDelegatedAppKeyPair.fingerprint()}`
  aliceDelegatedAppKeyPair.id = `${aliceDelegatedAppDid}#${aliceDelegatedAppKeyPair.fingerprint()}`

  const bobKeyPair = await Ed25519VerificationKey2020.generate({
    seed: decodeSecretKeySeed({ secretKeySeed: secretKeySeeds.bob })
  })
  const bobRootDid = `did:key:${bobKeyPair.fingerprint()}`
  bobKeyPair.id = `${bobRootDid}#${bobKeyPair.fingerprint()}`
  const bobRootClient = zcapClient({ signer: bobKeyPair.signer() })

  return {
    alice: {
      did: aliceRootDid,
      rootClient: aliceRootClient
    },
    aliceDelegatedApp: {
      did: aliceDelegatedAppDid,
      signer: aliceDelegatedAppKeyPair.signer()
    },
    bob: {
      did: bobRootDid,
      rootClient: bobRootClient
    }
  }
}

/**
 * Creates a space on the server using an onboarding token (if configured) or ZCap auth.
 * Returns a normalized response object for consistent assertion.
 *
 * @param options {object}
 * @param options.spaceDescription {object}
 * @param options.rootClient {object} ZCap client — used when no onboarding token is set
 * @returns {Promise<{status: number, headers: Headers, data: object}>}
 */
export async function createSpace ({ spaceDescription, rootClient }) {
  if (onboardingToken) {
    const response = await fetch(new URL('/spaces/', serverUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${onboardingToken}`
      },
      body: JSON.stringify(spaceDescription)
    })
    const data = await response.json()
    return { status: response.status, headers: response.headers, data }
  }
  const response = await rootClient.request({
    url: new URL('/spaces/', serverUrl).toString(),
    method: 'POST',
    json: spaceDescription
  })
  return { status: response.status, headers: response.headers, data: response.data }
}

export { serverUrl, onboardingToken, uuidv4 as generateId }
