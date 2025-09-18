import { ZcapClient } from '@digitalcredentials/ezcap'
import { decodeSecretKeySeed } from 'bnid'
// import * as didKey from '@digitalcredentials/did-method-key'
import { Ed25519Signature2020 } from '@digitalcredentials/ed25519-signature-2020'
import { Ed25519VerificationKey2020 } from '@digitalcredentials/ed25519-verification-key-2020'

export const adminDidSecretSeed = 'z1Air2KcEdUpJnJ9m61WFRUFgtC3LHrmGCpwFAkZ7rbbohX'
const seedBytes = decodeSecretKeySeed({ secretKeySeed: adminDidSecretSeed })

// const didKeyDriver = didKey.driver()
// didKeyDriver.use({
//   multibaseMultikeyHeader: 'z6Mk',
//   fromMultibase: Ed25519VerificationKey2020.from
// });

export async function zcapClient () {
  const verificationKeyPair = await Ed25519VerificationKey2020.generate({
    seed: seedBytes
  })

  const rootDid = `did:key:${verificationKeyPair.fingerprint()}`
  verificationKeyPair.id = `${rootDid}#${verificationKeyPair.fingerprint()}`
  const invocationSigner = verificationKeyPair.signer()

  const rootZcapClient = new ZcapClient({
    SuiteClass: Ed25519Signature2020, invocationSigner
  })

  return { rootZcapClient, rootDid, rootKeyPair: verificationKeyPair }
}
