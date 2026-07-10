import { ZcapClient } from '@interop/ezcap'
import { WasClient } from '@interop/was-client'
import type { Space } from '@interop/was-client'
import { decodeSecretKeySeed } from '@digitalcredentials/bnid'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import type { ISigner } from '@interop/data-integrity-core'
import { v4 as uuidv4 } from 'uuid'

import { serverUrl, onboardingToken } from './config.js'

const secretKeySeeds = {
  alice: 'z1Air2KcEdUpJnJ9m61WFRUFgtC3LHrmGCpwFAkZ7rbbohX',
  aliceDelegatedApp: 'z1AeeM8yN1D3cM56LsPmr3fFKuyv7MC4tdRkeiujMkyRy2u',
  bob: 'z1AmpBeBetWxKMBpAcHsztGogaUki1LXWANSzTd5CiYoikA',
  bobDelegatedApp: 'z1AfgF2HQvQaaAhod3KEYUHwY5epGtP5QmbEMKtMFf8XcYk'
}

export function zcapClient({ signer }: { signer: ISigner }): ZcapClient {
  return new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: signer,
    delegationSigner: signer
  })
}

/**
 * Builds a high-level WAS client wrapping a ZcapClient for the given signer.
 * The `serverUrl` is the base for both URL building and zcap invocationTargets.
 *
 * @param options {object}
 * @param options.signer {ISigner}
 * @returns {WasClient}
 */
export function wasClient({ signer }: { signer: ISigner }): WasClient {
  return new WasClient({ serverUrl, zcapClient: zcapClient({ signer }) })
}

export async function buildZcapClients() {
  const aliceKeyPair = await Ed25519VerificationKey.generate({
    seed: decodeSecretKeySeed({ secretKeySeed: secretKeySeeds.alice })
  })
  const aliceRootDid = `did:key:${aliceKeyPair.fingerprint()}`
  aliceKeyPair.id = `${aliceRootDid}#${aliceKeyPair.fingerprint()}`
  const aliceSigner = aliceKeyPair.signer()

  const aliceDelegatedAppKeyPair = await Ed25519VerificationKey.generate({
    seed: decodeSecretKeySeed({
      secretKeySeed: secretKeySeeds.aliceDelegatedApp
    })
  })
  const aliceDelegatedAppDid = `did:key:${aliceDelegatedAppKeyPair.fingerprint()}`
  aliceDelegatedAppKeyPair.id = `${aliceDelegatedAppDid}#${aliceDelegatedAppKeyPair.fingerprint()}`

  const bobKeyPair = await Ed25519VerificationKey.generate({
    seed: decodeSecretKeySeed({ secretKeySeed: secretKeySeeds.bob })
  })
  const bobRootDid = `did:key:${bobKeyPair.fingerprint()}`
  bobKeyPair.id = `${bobRootDid}#${bobKeyPair.fingerprint()}`
  const bobSigner = bobKeyPair.signer()

  return {
    alice: {
      did: aliceRootDid,
      // Low-level ZcapClient -- kept for raw request()/delegate() calls.
      rootClient: zcapClient({ signer: aliceSigner }),
      // High-level WAS client wrapping the same signer.
      was: wasClient({ signer: aliceSigner })
    },
    aliceDelegatedApp: {
      did: aliceDelegatedAppDid,
      signer: aliceDelegatedAppKeyPair.signer()
    },
    bob: {
      did: bobRootDid,
      rootClient: zcapClient({ signer: bobSigner }),
      was: wasClient({ signer: bobSigner })
    }
  }
}

/**
 * Creates a space on the server using an onboarding token (if configured) or
 * the WAS client. Returns a normalized response object for consistent
 * assertion.
 *
 * The ZCap path goes through `WasClient.request()` -- the client's signed
 * escape hatch -- so the conformance harness exercises the client while still
 * surfacing the raw status/headers/data the create-space assertions rely on.
 *
 * @param options {object}
 * @param options.spaceDescription {object}
 * @param options.rootClient {ZcapClient} ZCap client -- used when no onboarding
 *   token is set
 * @returns {Promise<{status: number, headers: Headers, data: any}>}
 */
export async function createSpace({
  spaceDescription,
  rootClient
}: {
  spaceDescription: object
  rootClient: ZcapClient
}): Promise<{ status: number; headers: Headers; data: any }> {
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
  const was = new WasClient({ serverUrl, zcapClient: rootClient })
  const response = await was.request({
    path: '/spaces/',
    method: 'POST',
    json: spaceDescription
  })
  return {
    status: response.status,
    headers: response.headers,
    data: response.data
  }
}

/**
 * Provisions a Space for the high-level `WasClient` suites: with an onboarding
 * token configured, creates it via the token path (a plain fetch with
 * `Authorization: Bearer`, the same wire form `createSpace` above uses) and
 * returns the client's lazy handle to the new id; otherwise delegates to the
 * client's own signed `createSpace`. This is what lets the client suites run
 * against a server that gates provisioning behind an onboarding token.
 *
 * @param options {object}
 * @param options.was {WasClient} the suite's high-level client
 * @param [options.name] {string} optional Space name
 * @returns {Promise<Space>}
 */
export async function provisionSpace({
  was,
  name
}: {
  was: WasClient
  name?: string
}): Promise<Space> {
  if (!onboardingToken) {
    return was.createSpace({ name })
  }
  const id = uuidv4()
  const response = await fetch(new URL('/spaces/', serverUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${onboardingToken}`
    },
    body: JSON.stringify({ id, name, controller: was.controllerDid })
  })
  if (response.status !== 201) {
    throw new Error(
      `Onboarding-token Create Space failed with status ${response.status}`
    )
  }
  return was.space(id)
}

/**
 * Strips a `createdBy` property from a Space/Collection description, if
 * present, before an exact-shape comparison. The spec makes `createdBy`
 * OPTIONAL ("a client MUST treat an absent `createdBy` as not recorded"), so a
 * conforming external server may legitimately omit it -- and one that records
 * it may report a creator this suite cannot predict. Either way the conformance
 * suite must not assert on it.
 *
 * @param value {unknown}
 * @returns {unknown}
 */
export function withoutCreatedBy(value: unknown): unknown {
  if (value && typeof value === 'object' && 'createdBy' in value) {
    const { createdBy: _createdBy, ...rest } = value as Record<string, unknown>
    return rest
  }
  return value
}

export { serverUrl, onboardingToken, uuidv4 as generateId }
