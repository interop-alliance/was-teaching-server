/**
 * The pull loop's reads of a peer, on a fake transport: `readStream` bounds
 * the wait for each chunk, not the whole transfer.
 */
import { it, describe, beforeAll } from 'vitest'
import assert from 'node:assert'
import { text } from 'node:stream/consumers'

import { PeerClient } from '../src/sync/peerClient.js'
import type { PeerFetch } from '../src/sync/peerFetch.js'
import { zcapClients } from './helpers.js'

/**
 * A body that emits each chunk after its delay, then ends.
 */
function slowBody(steps: Array<{ delayMs: number; text: string }>) {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= steps.length) {
        controller.close()
        return
      }
      const step = steps[index++]!
      await new Promise(resolve => setTimeout(resolve, step.delayMs))
      controller.enqueue(encoder.encode(step.text))
    }
  })
}

describe('PeerClient.readStream', () => {
  let signer: any

  beforeAll(async () => {
    const { alice } = await zcapClients({ serverUrl: 'https://unused.example' })
    signer = alice.signer
  })

  function clientOver(steps: Array<{ delayMs: number; text: string }>) {
    const peerFetch: PeerFetch = async () => ({
      status: 200,
      headers: { get: () => null },
      body: slowBody(steps),
      release: () => {}
    })
    return new PeerClient({
      peerFetch,
      signer,
      capability:
        'urn:zcap:root:https%3A%2F%2Fpeer.example%2Fspace%2Fa%2F' as any
    })
  }

  it('reads a body whose total time exceeds the idle timeout', async () => {
    const client = clientOver([
      { delayMs: 40, text: 'one ' },
      { delayMs: 40, text: 'two ' },
      { delayMs: 40, text: 'three ' },
      { delayMs: 40, text: 'four' }
    ])
    const { stream, release } = await client.readStream({
      url: 'https://peer.example/space/a/c/r',
      idleTimeoutMs: 100
    })
    try {
      assert.equal(await text(stream), 'one two three four')
    } finally {
      release()
    }
  })

  it('errors the stream when the peer stalls past the idle timeout', async () => {
    const client = clientOver([
      { delayMs: 10, text: 'first' },
      { delayMs: 500, text: 'late' }
    ])
    const { stream, release } = await client.readStream({
      url: 'https://peer.example/space/a/c/r',
      idleTimeoutMs: 60
    })
    try {
      await assert.rejects(text(stream), /sent nothing for 60 ms/)
    } finally {
      release()
    }
  })
})
