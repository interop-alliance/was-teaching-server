/**
 * Space-scoped zcap revocation tests (Vitest):
 * POST `/space/:spaceId/zcaps/revocations/:revocationId`, the WAS-route
 * sibling of the `/kms` revocation endpoint. A capability delegated from a
 * Space's root capability is revoked here, and is rejected from then on
 * wherever a Space-rooted chain is verified -- the write routes
 * (`fetchSpaceAndVerify`) and the capability leg of the read routes
 * (`authorize`).
 *
 * Invocations are raw `@interop/ezcap` requests: the wire contract for
 * revocation is not (yet) part of the high-level `@interop/was-client`
 * surface, and the negative cases need to shape the invocation by hand --
 * the same house pattern as the `/kms` revocation suite.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { spaceRevocationsPath } from '../src/lib/paths.js'
import {
  client,
  requestError,
  rootZcap as makeRootZcap,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Space zcap revocations (/space/:spaceId/zcaps/revocations)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    aliceDelegatedApp: any,
    bob: any

  // Fresh ids per run so re-runs against a dirty data dir cannot collide.
  const spaceId = randomUUID()
  const otherSpaceId = randomUUID()
  const collectionId = 'credentials'

  let spaceUrl: string
  let otherSpaceUrl: string
  let collectionUrl: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, aliceDelegatedApp, bob } = await zcapClients({ serverUrl }))

    spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
    otherSpaceUrl = new URL(`/space/${otherSpaceId}`, serverUrl).toString()
    collectionUrl = new URL(
      `/space/${spaceId}/${collectionId}`,
      serverUrl
    ).toString()

    for (const id of [spaceId, otherSpaceId]) {
      const space = alice.was.space(id)
      await space.configure({ name: 'Revocation Space', controller: alice.did })
      await space
        .collection(collectionId)
        .configure({ name: 'Credentials', force: true })
    }
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  // The root capability for a target URL, controlled by Alice (this suite's
  // Space controller). Delegates to the shared builder.
  const rootZcap = (target: string) =>
    makeRootZcap({ target, controller: alice.did })

  /**
   * The revocation submission URL for a capability id, built by the shared
   * path builder -- so these tests pin `spaceRevocationsPath` against the
   * live route.
   */
  function revocationUrl(capabilityId: string, space = spaceId): string {
    return new URL(
      spaceRevocationsPath({ spaceId: space, revocationId: capabilityId }),
      serverUrl
    ).toString()
  }

  /**
   * Delegates read/write on a Collection from its Space's root capability --
   * the "session key" shape a controller hands an app.
   */
  async function delegate({
    target = collectionUrl,
    root = spaceUrl,
    controller = aliceDelegatedApp.did,
    allowedActions = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE']
  }: {
    target?: string
    root?: string
    controller?: string
    allowedActions?: string[]
  } = {}) {
    return client({ signer: alice.signer }).delegate({
      capability: `urn:zcap:root:${encodeURIComponent(root)}`,
      invocationTarget: target,
      controller,
      allowedActions,
      expires: new Date(Date.now() + 60 * 60 * 1000)
    })
  }

  /** Submits a revocation, invoking `capability` as `signer`. */
  async function revoke({
    capabilityToRevoke,
    signer,
    capability,
    url
  }: {
    capabilityToRevoke: any
    signer: any
    capability: any
    url?: string
  }) {
    return client({ signer }).request({
      url: url ?? revocationUrl(capabilityToRevoke.id),
      method: 'POST',
      action: 'POST',
      capability,
      json: capabilityToRevoke
    })
  }

  /** Reads a Resource under `zcap` -- the access a revocation withdraws. */
  async function readDoc({ zcap, signer }: { zcap: any; signer: any }) {
    return client({ signer }).request({
      url: `${collectionUrl}/doc-1`,
      method: 'GET',
      action: 'GET',
      capability: zcap
    })
  }

  beforeAll(async () => {
    await alice.was.space(spaceId).collection(collectionId).put('doc-1', {
      hello: 'world'
    })
  })

  describe('revoking a Space-rooted capability', () => {
    it('the delegator revokes; the delegee loses access', async () => {
      const zcap = await delegate()
      const before = await readDoc({ zcap, signer: aliceDelegatedApp.signer })
      assert.equal(before.status, 200)

      const response = await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })
      assert.equal(response.status, 204)

      const err = await requestError(
        readDoc({ zcap, signer: aliceDelegatedApp.signer })
      )
      assert.equal(err.status, 404)

      // The controller's own (root) access is untouched: root zcaps cannot be
      // revoked, and no revocation applies to a chain of just the root.
      const doc = await alice.was
        .space(spaceId)
        .collection(collectionId)
        .get('doc-1')
      assert.deepStrictEqual(doc, { hello: 'world' })
    })

    it('a revoked capability cannot write either (fetchSpaceAndVerify)', async () => {
      const zcap = await delegate()
      await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })

      const err = await requestError(
        client({ signer: aliceDelegatedApp.signer }).write({
          url: `${collectionUrl}/doc-2`,
          capability: zcap,
          json: { escape: true }
        })
      )
      assert.equal(err.status, 404)
      // ...and the write did not land.
      const doc = await alice.was
        .space(spaceId)
        .collection(collectionId)
        .get('doc-2')
      assert.equal(doc, null)
    })

    it('a delegee revokes its own zcap (dual-root rule)', async () => {
      const zcap = await delegate()

      // The app is not the Space controller; it qualifies purely as a
      // controller in the to-be-revoked zcap's chain, so it invokes the
      // revocation URL's own root capability.
      const response = await revoke({
        capabilityToRevoke: zcap,
        signer: aliceDelegatedApp.signer,
        capability: rootZcap(revocationUrl(zcap.id))
      })
      assert.equal(response.status, 204)

      const err = await requestError(
        readDoc({ zcap, signer: aliceDelegatedApp.signer })
      )
      assert.equal(err.status, 404)
    })

    it('revocation withdraws only what the capability granted (permissive policy)', async () => {
      // A revoked capability falls through to the target's access-control
      // policy, which can only broaden access. Read access a PublicCanRead
      // policy already grants everyone therefore survives the revocation --
      // what is withdrawn is the capability, not the policy's grant.
      const publicCollectionId = 'public-notices'
      const publicCollection = alice.was
        .space(spaceId)
        .collection(publicCollectionId)
      await publicCollection.configure({ name: 'Notices', force: true })
      await publicCollection.put('notice-1', { open: true })
      await publicCollection.setPublic()

      const publicUrl = new URL(
        `/space/${spaceId}/${publicCollectionId}`,
        serverUrl
      ).toString()
      const zcap = await delegate({ target: publicUrl })
      await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })

      // Reading with the revoked capability still succeeds -- via the policy,
      // not the capability. Writing, which no policy grants, does not.
      const response = await client({
        signer: aliceDelegatedApp.signer
      }).request({
        url: `${publicUrl}/notice-1`,
        method: 'GET',
        action: 'GET',
        capability: zcap
      })
      assert.equal(response.status, 200)

      const err = await requestError(
        client({ signer: aliceDelegatedApp.signer }).write({
          url: `${publicUrl}/notice-2`,
          capability: zcap,
          json: { sneaky: true }
        })
      )
      assert.equal(err.status, 404)
    })

    it('a non-participant cannot revoke (masked 404)', async () => {
      const zcap = await delegate()

      // Bob is neither the Space controller nor in the zcap's chain.
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: bob.signer,
          capability: rootZcap(revocationUrl(zcap.id))
        })
      )
      assert.equal(err.status, 404)

      // The capability still works: nothing was stored.
      const response = await readDoc({
        zcap,
        signer: aliceDelegatedApp.signer
      })
      assert.equal(response.status, 200)
    })

    it('a non-participant resubmitting an already-revoked capability gets the same masked 404 (no revocation-state oracle)', async () => {
      const zcap = await delegate()
      await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })

      // Bob is unauthorized either way; the store must be consulted only
      // after authorization, so his answer is the masked 404 whether or not
      // the capability is already revoked (a 400 here would disclose
      // revocation state).
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: bob.signer,
          capability: rootZcap(revocationUrl(zcap.id))
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('rejected submissions', () => {
    it('resubmitting a stored revocation is the 400 invalid-delegation', async () => {
      const zcap = await delegate()
      await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })

      // The second submission passes authorization, then trips the
      // post-authorization store check -- the chain contains a revoked
      // capability; the 409 duplicate is reserved for a write race at the
      // store.
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: alice.signer,
          capability: rootZcap(spaceUrl)
        })
      )
      assert.equal(err.status, 400)
    })

    it('a root capability cannot be revoked (400)', async () => {
      const root = rootZcap(spaceUrl)
      const err = await requestError(
        revoke({
          capabilityToRevoke: root,
          signer: alice.signer,
          capability: rootZcap(spaceUrl)
        })
      )
      assert.equal(err.status, 400)
    })

    it('the capability id must match the revocation URL (400)', async () => {
      const zcap = await delegate()
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: alice.signer,
          capability: rootZcap(spaceUrl),
          url: revocationUrl('urn:uuid:some-other-capability')
        })
      )
      assert.equal(err.status, 400)
    })

    it("a chain rooted in another Space can't be revoked here (400)", async () => {
      // A zcap delegated from a *different* Space's root capability, submitted
      // to this Space's revocation endpoint.
      const foreignZcap = await delegate({
        target: otherSpaceUrl,
        root: otherSpaceUrl
      })
      const err = await requestError(
        revoke({
          capabilityToRevoke: foreignZcap,
          signer: alice.signer,
          capability: rootZcap(spaceUrl),
          url: revocationUrl(foreignZcap.id)
        })
      )
      assert.equal(err.status, 400)

      // Revoked at its own Space, it stops working there -- scoping cuts both
      // ways.
      const response = await revoke({
        capabilityToRevoke: foreignZcap,
        signer: alice.signer,
        capability: rootZcap(otherSpaceUrl),
        url: revocationUrl(foreignZcap.id, otherSpaceId)
      })
      assert.equal(response.status, 204)
    })

    it('an unknown Space is a masked 404', async () => {
      const zcap = await delegate()
      const unknownSpaceId = randomUUID()
      const unknownSpaceUrl = new URL(
        `/space/${unknownSpaceId}`,
        serverUrl
      ).toString()
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: alice.signer,
          capability: rootZcap(unknownSpaceUrl),
          url: revocationUrl(zcap.id, unknownSpaceId)
        })
      )
      assert.equal(err.status, 404)
    })
  })
})
