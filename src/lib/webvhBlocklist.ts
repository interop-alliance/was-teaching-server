/**
 * The operator's blocklist of foreign `did:webvh` DIDs (env
 * `WAS_WEBVH_BLOCKLIST`, plugin option `webvhBlocklist`). Any `did:webvh` on
 * another host may invoke a delegated capability here, its log fetched from
 * that host (`lib/peerWebvh.ts`). A listed entry refuses that, before any
 * fetch: a host name blocks every DID on the host, and a full DID blocks that
 * DID alone. A refused DID gets the same masked `not-found` as any DID whose
 * chain did not verify.
 *
 * The list bounds the network path only. A DID whose log this server stores
 * (self-hosted, or copied here by a replica registration) never takes it.
 */
import { isCrossHostName, parseWebvhAddress } from './validateDid.js'

/**
 * A compiled blocklist: lower-case host names, and DIDs with their host
 * component in lower case.
 */
export interface WebvhBlocklist {
  hosts: ReadonlySet<string>
  dids: ReadonlySet<string>
}

/**
 * Compiles blocklist entries, refusing a malformed one. An entry is trimmed,
 * and an empty one is ignored. A host entry is compared case-insensitively,
 * so it is lowered here. It must be a DNS name with no port, the only host a
 * fetched `did:webvh` may name. A DID entry is a `did:webvh` of the shape
 * {@link parseWebvhAddress} admits once its host component is lowered.
 *
 * @param options {object}
 * @param options.entries {string[]}   the raw entries
 * @param options.source {string}   names the setting in an error, e.g.
 *   `WAS_WEBVH_BLOCKLIST`
 * @returns {WebvhBlocklist}
 * @throws {Error}   naming the first malformed entry
 */
export function compileWebvhBlocklist({
  entries,
  source
}: {
  entries: string[]
  source: string
}): WebvhBlocklist {
  const hosts = new Set<string>()
  const dids = new Set<string>()
  for (const raw of entries) {
    const entry = raw.trim()
    if (entry === '') {
      continue
    }
    if (entry.startsWith('did:')) {
      const segments = entry.split(':')
      if (segments.length >= 4) {
        segments[3] = segments[3]!.toLowerCase()
      }
      const did = segments.join(':')
      if (parseWebvhAddress(did) === undefined) {
        throw new Error(
          `${source} entry "${raw}" is not a did:webvh DID on a host with no ` +
            'port, with URL-safe path segments.'
        )
      }
      dids.add(did)
      continue
    }
    const host = entry.toLowerCase()
    if (!isCrossHostName(host)) {
      throw new Error(
        `${source} entry "${raw}" is neither a DNS host name with no port ` +
          'nor a did:webvh DID.'
      )
    }
    hosts.add(host)
  }
  return { hosts, dids }
}

/**
 * Whether a parsed foreign DID is blocked, by its host or by itself.
 * @param options {object}
 * @param options.blocklist {WebvhBlocklist}
 * @param options.did {string}   a DID that parsed as a cross-host `did:webvh`
 * @param options.host {string}   its host, in lower case
 * @returns {boolean}
 */
export function isBlockedWebvh({
  blocklist,
  did,
  host
}: {
  blocklist: WebvhBlocklist
  did: string
  host: string
}): boolean {
  return blocklist.hosts.has(host) || blocklist.dids.has(did)
}
