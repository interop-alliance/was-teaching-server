/**
 * WebKMS zcap revocation + delegation policy tests (Vitest):
 * POST `/kms/keystores/:keystoreId/zcaps/revocations/:revocationId` and the
 * chain-inspection / policy gates it feeds. Happy paths drive `@interop/webkms-client`'s
 * `KmsClient.revokeCapability` (the client IS the conformance suite for the
 * webkms wire contract); negative assertions use raw `@interop/ezcap`
 * invocations, per the house pattern of the other `/kms` suites.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  KmsClient,
  KeystoreAgent,
  type AsymmetricKey
} from '@interop/webkms-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { kmsRevocationsPath } from '../src/lib/paths.js'
import {
  client,
  requestError,
  rootZcap as makeRootZcap,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('WebKMS zcap revocations (/kms/keystores/:keystoreId/zcaps/revocations)', () => {
  let fastify: FastifyInstance,
    backend: FileSystemBackend,
    serverUrl: string,
    keystoresUrl: string,
    keystoreId: string,
    keystoreLocalId: string,
    keystoreAgent: KeystoreAgent,
    kmsClient: KmsClient,
    dataDir: string,
    alice: any,
    aliceDelegatedApp: any,
    bob: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    backend = new FileSystemBackend({ dataDir })
    ;({ fastify, serverUrl } = await startTestServer({ backend }))
    keystoresUrl = `${serverUrl}/kms/keystores`
    ;({ alice, aliceDelegatedApp, bob } = await zcapClients({ serverUrl }))

    const config = await KmsClient.createKeystore({
      url: keystoresUrl,
      config: { sequence: 0, controller: alice.did },
      invocationSigner: alice.signer
    })
    keystoreId = config.id!
    keystoreLocalId = keystoreId.slice(keystoreId.lastIndexOf('/') + 1)
    kmsClient = new KmsClient({ keystoreId })
    keystoreAgent = new KeystoreAgent({
      capabilityAgent: { getSigner: () => alice.signer } as any,
      keystoreId,
      kmsClient
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  // The root capability for a target URL, controlled by Alice (this suite's
  // keystore controller). Delegates to the shared builder.
  const rootZcap = (target: string) =>
    makeRootZcap({ target, controller: alice.did })

  /**
   * The revocation submission URL for a capability id (keyed by the
   * keystore's LOCAL id), built by the shared path builder -- so these tests
   * pin `kmsRevocationsPath` against the live route.
   */
  function revocationUrl(
    capabilityId: string,
    keystore = keystoreLocalId
  ): string {
    return new URL(
      kmsRevocationsPath({ keystoreId: keystore, revocationId: capabilityId }),
      serverUrl
    ).toString()
  }

  /**
   * Delegates an action on `target` (the keystore, or a key under it) from
   * the keystore's root capability.
   */
  async function delegate({
    target,
    controller = aliceDelegatedApp.did,
    allowedActions = ['sign'],
    delegationSigner = alice.signer,
    parent = rootZcap(keystoreId) as any,
    expires
  }: {
    target: string
    controller?: string
    allowedActions?: string[]
    delegationSigner?: any
    parent?: any
    expires?: Date
  }) {
    return client({ signer: delegationSigner }).delegate({
      capability: parent,
      invocationTarget: target,
      controller,
      allowedActions,
      expires
    })
  }

  /** Invokes a SignOperation on `keyUrl` under `zcap`, signed by `signer`. */
  async function signOp({
    keyUrl,
    signer,
    zcap
  }: {
    keyUrl: string
    signer: any
    zcap: any
  }) {
    return client({ signer }).request({
      url: keyUrl,
      method: 'POST',
      action: 'sign',
      capability: zcap,
      json: {
        type: 'SignOperation',
        invocationTarget: keyUrl,
        verifyData: Buffer.from('data to sign').toString('base64url')
      }
    })
  }

  async function generateKey(
    options: Record<string, unknown> = {}
  ): Promise<AsymmetricKey> {
    return (await keystoreAgent.generateKey({
      type: 'asymmetric',
      ...options
    })) as AsymmetricKey
  }

  describe('revoking (KmsClient.revokeCapability)', () => {
    it('the delegator revokes; the delegee loses access', async () => {
      const key = await generateKey()
      const zcap = await delegate({ target: key.kmsId! })
      const before = await signOp({
        keyUrl: key.kmsId!,
        signer: aliceDelegatedApp.signer,
        zcap
      })
      assert.equal(before.status, 200)

      // 204; the client resolves with no value and throws on anything else.
      await kmsClient.revokeCapability({
        capabilityToRevoke: zcap,
        invocationSigner: alice.signer
      })

      const err = await requestError(
        signOp({ keyUrl: key.kmsId!, signer: aliceDelegatedApp.signer, zcap })
      )
      assert.equal(err.status, 404)

      // The controller's own (root) access is untouched: root zcaps cannot
      // be revoked, and no revocation applies to a chain of just the root.
      const data = new TextEncoder().encode('still signing')
      assert.ok((await key.sign({ data })) instanceof Uint8Array)
    })

    it('a delegee revokes its own zcap (dual-root rule)', async () => {
      const key = await generateKey()
      const zcap = await delegate({ target: key.kmsId! })

      // The app is not the keystore controller; it qualifies purely as a
      // controller in the to-be-revoked zcap's chain.
      await kmsClient.revokeCapability({
        capabilityToRevoke: zcap,
        invocationSigner: aliceDelegatedApp.signer
      })

      const err = await requestError(
        signOp({ keyUrl: key.kmsId!, signer: aliceDelegatedApp.signer, zcap })
      )
      assert.equal(err.status, 404)
    })

    it('a non-participant cannot revoke (masked 404)', async () => {
      const key = await generateKey()
      const zcap = await delegate({ target: key.kmsId! })

      // Bob is neither the keystore controller nor in the zcap's chain; his
      // invocation of the revocation URL's root capability does not verify.
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: revocationUrl(zcap.id),
          method: 'POST',
          action: 'write',
          capability: rootZcap(revocationUrl(zcap.id)),
          json: zcap
        })
      )
      assert.equal(err.status, 404)

      // The capability still works: nothing was stored.
      const response = await signOp({
        keyUrl: key.kmsId!,
        signer: aliceDelegatedApp.signer,
        zcap
      })
      assert.equal(response.status, 200)
    })

    it('resubmitting a stored revocation is the 400 invalid-delegation', async () => {
      const key = await generateKey()
      const zcap = await delegate({ target: key.kmsId! })
      await kmsClient.revokeCapability({
        capabilityToRevoke: zcap,
        invocationSigner: alice.signer
      })

      // The second submission passes authorization, then trips the
      // post-authorization store check -- the chain contains a revoked
      // capability (ezcap-express parity); the 409 duplicate is reserved for
      // a write race at the store.
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: revocationUrl(zcap.id),
          method: 'POST',
          action: 'write',
          capability: rootZcap(keystoreId),
          json: zcap
        })
      )
      assert.equal(err.status, 400)
    })

    it('a root capability cannot be revoked (400)', async () => {
      const root = rootZcap(keystoreId)
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: revocationUrl(root.id),
          method: 'POST',
          action: 'write',
          capability: rootZcap(keystoreId),
          json: root
        })
      )
      assert.equal(err.status, 400)
    })

    it('the capability id must match the revocation URL (400)', async () => {
      const key = await generateKey()
      const zcap = await delegate({ target: key.kmsId! })
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: revocationUrl('urn:uuid:some-other-capability'),
          method: 'POST',
          action: 'write',
          capability: rootZcap(keystoreId),
          json: zcap
        })
      )
      assert.equal(err.status, 400)
    })

    it("a chain rooted in another keystore can't be revoked here (400)", async () => {
      // Alice's second keystore; a zcap delegated from *its* root.
      const otherConfig = await KmsClient.createKeystore({
        url: keystoresUrl,
        config: { sequence: 0, controller: alice.did },
        invocationSigner: alice.signer
      })
      const foreignZcap = await delegate({
        target: otherConfig.id!,
        parent: rootZcap(otherConfig.id!)
      })

      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: revocationUrl(foreignZcap.id),
          method: 'POST',
          action: 'write',
          capability: rootZcap(keystoreId),
          json: foreignZcap
        })
      )
      assert.equal(err.status, 400)
    })

    it('an unknown keystore is masked (404)', async () => {
      const key = await generateKey()
      const zcap = await delegate({ target: key.kmsId! })
      const unknownKeystore = `${keystoresUrl}/z1111unknown`
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: revocationUrl(zcap.id, 'z1111unknown'),
          method: 'POST',
          action: 'write',
          capability: rootZcap(unknownKeystore),
          json: zcap
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('revocation gates every keystore-rooted route', () => {
    it('revoking a mid-chain delegation kills the whole sub-chain', async () => {
      const key = await generateKey()
      // root -> zcapA (app) -> zcapB (bob)
      const zcapA = await delegate({ target: keystoreId })
      const zcapB = await delegate({
        target: keystoreId,
        controller: bob.did,
        delegationSigner: aliceDelegatedApp.signer,
        parent: zcapA
      })
      const before = await signOp({
        keyUrl: key.kmsId!,
        signer: bob.signer,
        zcap: zcapB
      })
      assert.equal(before.status, 200)

      await kmsClient.revokeCapability({
        capabilityToRevoke: zcapA,
        invocationSigner: alice.signer
      })

      // Bob's leaf fails -- its chain contains the revoked zcapA -- and so
      // does the app's direct use of zcapA.
      const leafErr = await requestError(
        signOp({ keyUrl: key.kmsId!, signer: bob.signer, zcap: zcapB })
      )
      assert.equal(leafErr.status, 404)
      const midErr = await requestError(
        signOp({
          keyUrl: key.kmsId!,
          signer: aliceDelegatedApp.signer,
          zcap: zcapA
        })
      )
      assert.equal(midErr.status, 404)
    })

    it('a revoked read delegation blocks the keystore config route', async () => {
      const zcap = await delegate({
        target: keystoreId,
        allowedActions: ['read']
      })
      const before = await client({ signer: aliceDelegatedApp.signer }).request(
        {
          url: keystoreId,
          method: 'GET',
          action: 'read',
          capability: zcap
        }
      )
      assert.equal(before.status, 200)

      // Self-revocation by the delegee.
      await kmsClient.revokeCapability({
        capabilityToRevoke: zcap,
        invocationSigner: aliceDelegatedApp.signer
      })

      const err = await requestError(
        client({ signer: aliceDelegatedApp.signer }).request({
          url: keystoreId,
          method: 'GET',
          action: 'read',
          capability: zcap
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('delegation policy', () => {
    it('a delegation beyond the 90-day max TTL is rejected (404)', async () => {
      const key = await generateKey()
      const zcap = await delegate({
        target: key.kmsId!,
        expires: new Date(Date.now() + 91 * 24 * 60 * 60 * 1000)
      })
      const err = await requestError(
        signOp({ keyUrl: key.kmsId!, signer: aliceDelegatedApp.signer, zcap })
      )
      assert.equal(err.status, 404)
    })

    it('per-key maxCapabilityChainLength of 1 means controller-only', async () => {
      const key = await generateKey({ maxCapabilityChainLength: 1 })
      // Root invocation: dereferenced chain length 1 -- allowed.
      const data = new TextEncoder().encode('root only')
      assert.ok((await key.sign({ data })) instanceof Uint8Array)

      // Any delegated invocation (chain length 2) exceeds the bound.
      const zcap = await delegate({ target: key.kmsId! })
      const err = await requestError(
        signOp({ keyUrl: key.kmsId!, signer: aliceDelegatedApp.signer, zcap })
      )
      assert.equal(err.status, 404)
    })

    it('per-key maxCapabilityChainLength of 2 admits one delegation, not two', async () => {
      const key = await generateKey({ maxCapabilityChainLength: 2 })
      const zcapA = await delegate({ target: keystoreId })
      const direct = await signOp({
        keyUrl: key.kmsId!,
        signer: aliceDelegatedApp.signer,
        zcap: zcapA
      })
      assert.equal(direct.status, 200)

      const zcapB = await delegate({
        target: keystoreId,
        controller: bob.did,
        delegationSigner: aliceDelegatedApp.signer,
        parent: zcapA
      })
      const err = await requestError(
        signOp({ keyUrl: key.kmsId!, signer: bob.signer, zcap: zcapB })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('revocation store (backend contract)', () => {
    it('duplicate inserts conflict; expired records are pruned on read', async () => {
      const summary = {
        capabilityId: 'urn:uuid:test-capability',
        delegator: alice.did
      }
      const record = {
        capability: { id: summary.capabilityId },
        meta: {
          delegator: summary.delegator,
          rootTarget: keystoreId,
          created: new Date().toISOString(),
          expires: new Date(Date.now() + 60_000).toISOString()
        }
      }
      await backend.insertRevocation({
        scope: { keystoreId: keystoreLocalId },
        record
      })
      assert.equal(
        await backend.isRevoked({
          scope: { keystoreId: keystoreLocalId },
          capabilities: [summary]
        }),
        true
      )
      // Insert-once: the same `(delegator, capabilityId)` conflicts (409).
      const err = await requestError(
        backend.insertRevocation({
          scope: { keystoreId: keystoreLocalId },
          record
        })
      )
      assert.equal(err.statusCode, 409)

      // A record past its GC horizon reads as not revoked and is pruned (the
      // capability itself has expired by then).
      const expired = {
        capability: { id: 'urn:uuid:expired-capability' },
        meta: {
          delegator: alice.did,
          rootTarget: keystoreId,
          created: new Date(Date.now() - 120_000).toISOString(),
          expires: new Date(Date.now() - 60_000).toISOString()
        }
      }
      await backend.insertRevocation({
        scope: { keystoreId: keystoreLocalId },
        record: expired
      })
      const expiredSummary = {
        capabilityId: expired.capability.id,
        delegator: alice.did
      }
      assert.equal(
        await backend.isRevoked({
          scope: { keystoreId: keystoreLocalId },
          capabilities: [expiredSummary]
        }),
        false
      )
      // Pruned: a re-insert of the same pair no longer conflicts.
      await backend.insertRevocation({
        scope: { keystoreId: keystoreLocalId },
        record: expired
      })
    })
  })
})
