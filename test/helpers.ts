import { ZcapClient } from '@interop/ezcap'
import { WasClient } from '@interop/was-client'
import { decodeSecretKeySeed } from '@digitalcredentials/bnid'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import type { ISigner } from '@interop/data-integrity-core'

export const fixtures = {
  alice: {
    secret: {
      adminKeySeedBytes: decodeSecretKeySeed({
        secretKeySeed: 'z1Air2KcEdUpJnJ9m61WFRUFgtC3LHrmGCpwFAkZ7rbbohX'
      })
    }
  },
  aliceDelegatedApp: {
    secret: {
      adminKeySeedBytes: decodeSecretKeySeed({
        secretKeySeed: 'z1AeeM8yN1D3cM56LsPmr3fFKuyv7MC4tdRkeiujMkyRy2u'
      })
    }
  },
  bob: {
    secret: {
      adminKeySeedBytes: decodeSecretKeySeed({
        secretKeySeed: 'z1AmpBeBetWxKMBpAcHsztGogaUki1LXWANSzTd5CiYoikA'
      })
    }
  },
  bobDelegatedApp: {
    secret: {
      adminKeySeedBytes: decodeSecretKeySeed({
        secretKeySeed: 'z1AfgF2HQvQaaAhod3KEYUHwY5epGtP5QmbEMKtMFf8XcYk'
      })
    }
  }
}

// const didKeyDriver = didKey.driver()
// didKeyDriver.use({
//   multibaseMultikeyHeader: 'z6Mk',
//   fromMultibase: Ed25519VerificationKey.from
// });
export function client({ signer }: { signer: ISigner }): ZcapClient {
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
 * @param options.serverUrl {string}
 * @returns {WasClient}
 */
export function wasClient({
  signer,
  serverUrl
}: {
  signer: ISigner
  serverUrl: string
}): WasClient {
  return new WasClient({ serverUrl, zcapClient: client({ signer }) })
}

/**
 * Builds the test identities (Alice, her delegated app, and Bob), each carrying
 * a high-level `WasClient` bound to the suite's `serverUrl`. Suites drive the
 * server through these `was` clients rather than raw `ZcapClient.request()`.
 *
 * @param options {object}
 * @param options.serverUrl {string}   the suite's in-process server URL; also
 *   the zcap invocationTarget base, so it must match the injected app's URL
 * @returns {Promise<object>}
 */
export async function zcapClients({ serverUrl }: { serverUrl: string }) {
  // Set up Alice's root / admin key pair and client
  const aliceAdminKeyPair = await Ed25519VerificationKey.generate({
    seed: fixtures.alice.secret.adminKeySeedBytes
  })
  const aliceRootDid = `did:key:${aliceAdminKeyPair.fingerprint()}`
  aliceAdminKeyPair.id = `${aliceRootDid}#${aliceAdminKeyPair.fingerprint()}`
  const aliceRootSigner = aliceAdminKeyPair.signer()

  // Set up a key pair for Alice's delegated app
  const aliceDelegatedAppKeyPair = await Ed25519VerificationKey.generate({
    seed: fixtures.aliceDelegatedApp.secret.adminKeySeedBytes
  })
  const aliceDelegatedAppDid = `did:key:${aliceDelegatedAppKeyPair.fingerprint()}`
  aliceDelegatedAppKeyPair.id = `${aliceDelegatedAppDid}#${aliceDelegatedAppKeyPair.fingerprint()}`
  const aliceDelegatedAppSigner = aliceDelegatedAppKeyPair.signer()

  // Set up Bob's root / admin key pair and client
  const bobAdminKeyPair = await Ed25519VerificationKey.generate({
    seed: fixtures.bob.secret.adminKeySeedBytes
  })
  const bobRootDid = `did:key:${bobAdminKeyPair.fingerprint()}`
  bobAdminKeyPair.id = `${bobRootDid}#${bobAdminKeyPair.fingerprint()}`
  const bobRootSigner = bobAdminKeyPair.signer()

  return {
    alice: {
      // did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD
      did: aliceRootDid,
      was: wasClient({ signer: aliceRootSigner, serverUrl }),
      space1: {
        id: '426e7db8-26b5-4fdc-8068-9dcb948fd291'
      },
      space2: {
        id: '6b5be748-5f39-4936-a895-409e393c399c'
      }
    },
    aliceDelegatedApp: {
      // did:key:z6MksgunmKuHjE2GvC3DYLBC3p7i1QkMRyhWxT4rNNnKxZar
      did: aliceDelegatedAppDid,
      was: wasClient({ signer: aliceDelegatedAppSigner, serverUrl })
    },
    bob: {
      // did:key:z6MkgpJp9jpAsqFCKqKMvHsAL5VEnkcd8FhhZdwnX33BFDgs
      did: bobRootDid,
      was: wasClient({ signer: bobRootSigner, serverUrl }),
      space2: {
        id: '94f03216-5ab4-4723-853c-cf837c171323'
      }
    }
  }
}
