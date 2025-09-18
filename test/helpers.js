import { ZcapClient } from '@digitalcredentials/ezcap'
import { decodeSecretKeySeed } from 'bnid'
// import * as didKey from '@digitalcredentials/did-method-key'
import { Ed25519Signature2020 } from '@digitalcredentials/ed25519-signature-2020'
import { Ed25519VerificationKey2020 } from '@digitalcredentials/ed25519-verification-key-2020'

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
//   fromMultibase: Ed25519VerificationKey2020.from
// });

export async function zcapClients () {
  // Set up Alice's root / admin key pair and client
  const aliceAdminKeyPair = await Ed25519VerificationKey2020.generate({
    seed: fixtures.alice.secret.adminKeySeedBytes
  })
  const aliceRootDid = `did:key:${aliceAdminKeyPair.fingerprint()}`
  aliceAdminKeyPair.id = `${aliceRootDid}#${aliceAdminKeyPair.fingerprint()}`
  const aliceRootSigner = aliceAdminKeyPair.signer()
  const aliceRootClient = new ZcapClient({
    SuiteClass: Ed25519Signature2020, invocationSigner: aliceRootSigner
  })

  // Set up a key pair for Alice's delegated app
  const aliceDelegatedAppKeyPair = await Ed25519VerificationKey2020.generate({
    seed: fixtures.aliceDelegatedApp.secret.adminKeySeedBytes
  })
  const aliceDelegatedAppDid = `did:key:${aliceDelegatedAppKeyPair.fingerprint()}`
  aliceDelegatedAppKeyPair.id = `${aliceDelegatedAppDid}#${aliceDelegatedAppKeyPair.fingerprint()}`
  const aliceDelegatedAppSigner = aliceDelegatedAppKeyPair.signer()

  // Set up Bob's root / admin key pair and client
  const bobAdminKeyPair = await Ed25519VerificationKey2020.generate({
    seed: fixtures.bob.secret.adminKeySeedBytes
  })
  const bobRootDid = `did:key:${bobAdminKeyPair.fingerprint()}`
  bobAdminKeyPair.id = `${bobRootDid}#${bobAdminKeyPair.fingerprint()}`
  const bobRootSigner = bobAdminKeyPair.signer()
  const bobRootClient = new ZcapClient({
    SuiteClass: Ed25519Signature2020, invocationSigner: bobRootSigner
  })

  // Set up a key pair and signer for Bob's delegated app
  const bobDelegatedAppKeyPair = await Ed25519VerificationKey2020.generate({
    seed: fixtures.bobDelegatedApp.secret.adminKeySeedBytes
  })
  const bobDelegatedAppDid = `did:key:${bobDelegatedAppKeyPair.fingerprint()}`
  bobDelegatedAppKeyPair.id = `${bobDelegatedAppDid}#${bobDelegatedAppKeyPair.fingerprint()}`
  const bobDelegatedAppSigner = bobDelegatedAppKeyPair.signer()

  return {
    alice: {
      did: aliceRootDid,
      rootSigner: aliceRootSigner,
      rootClient: aliceRootClient,
      space1: {
        id: '426e7db8-26b5-4fdc-8068-9dcb948fd291'
      }
    },
    aliceDelegatedApp: {
      did: aliceDelegatedAppDid,
      signer: aliceDelegatedAppSigner
    },
    bob: {
      did: bobRootDid,
      rootSigner: bobRootSigner,
      rootClient: bobRootClient,
      space2: {
        id: '94f03216-5ab4-4723-853c-cf837c171323'
      }
    }
  }
}
