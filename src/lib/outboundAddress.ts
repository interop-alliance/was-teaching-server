/**
 * Address checks for an outbound request this server makes on a host a
 * request named: the CORS proxy's upstream fetch, and the fetch of a peer
 * server's `did:webvh` history log. Both refuse a host that resolves to a
 * private, loopback, link-local or otherwise non-public address (SSRF), and
 * both pin the connection to the addresses they checked, so a DNS answer that
 * changes between the check and the connection cannot reach an internal host.
 * Both also read the response through one size-bounded reader.
 */
import type { LookupFunction } from 'node:net'
import net from 'node:net'

/**
 * True for an IPv4 address in a private, loopback, link-local, or otherwise
 * non-public range -- the SSRF-sensitive destinations the proxy must refuse
 * (RFC 1918 private space, `127.0.0.0/8` loopback, `169.254.0.0/16` link-local
 * -- which covers the `169.254.169.254` cloud-metadata endpoint -- CGNAT, and
 * multicast/reserved). A syntactically invalid address is treated as blocked.
 * @param ip {string}
 * @returns {boolean}
 */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true
  }
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local (incl. cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (RFC 6598)
    (a === 192 && b === 0) || // 192.0.0.0/24 IETF protocol assignments
    a >= 224 // multicast / reserved
  )
}

/**
 * Expands an IPv6 address that has already passed `net.isIP` into its 16
 * bytes. Handles `::` compression, a trailing dotted-quad IPv4 part, and a
 * `%zone` suffix (dropped).
 * @param ip {string}
 * @returns {number[]}
 */
function expandIpv6(ip: string): number[] {
  let text = ip.toLowerCase().replace(/%.*$/, '')
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted[2]!.split('.').map(Number) as [
      number,
      number,
      number,
      number
    ]
    text =
      dotted[1]! +
      ((a << 8) | b).toString(16) +
      ':' +
      ((c << 8) | d).toString(16)
  }
  const [headText, tailText] = text.split('::') as [string, string | undefined]
  const head = headText ? headText.split(':') : []
  const tail = tailText ? tailText.split(':') : []
  const gap: string[] =
    tailText === undefined
      ? []
      : new Array(8 - head.length - tail.length).fill('0')
  return [...head, ...gap, ...tail].flatMap(group => {
    const value = parseInt(group, 16)
    return [value >> 8, value & 0xff]
  })
}

/**
 * True for an IPv6 address in a loopback, unspecified, unique-local (`fc00::/7`),
 * link-local (`fe80::/10`), multicast (`ff00::/8`), or local-use NAT64
 * (`64:ff9b:1::/48`, refused whole because where it carries the IPv4 address
 * depends on the operator's prefix length) range, or one that embeds an IPv4 address whose
 * IPv4 form is blocked: IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible
 * (`::/96`, which also covers `::` and `::1`), NAT64 (`64:ff9b::/96`), and 6to4
 * (`2002::/16`). The address is compared as bytes, so a hex-form embedded
 * address (`::ffff:7f00:1`, which the WHATWG URL parser produces from
 * `::ffff:127.0.0.1`) is caught like the dotted form.
 * @param ip {string}   an address that passed `net.isIP` as family 6
 * @returns {boolean}
 */
function isBlockedIpv6(ip: string): boolean {
  const bytes = expandIpv6(ip)
  const zeroThrough = (end: number) =>
    bytes.slice(0, end).every(byte => byte === 0)
  const embeddedIpv4 = (offset: number) =>
    isBlockedIpv4(bytes.slice(offset, offset + 4).join('.'))

  if (zeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return embeddedIpv4(12) // ::ffff:0:0/96 IPv4-mapped
  }
  if (zeroThrough(12)) {
    return embeddedIpv4(12) // ::/96 IPv4-compatible, incl. :: and ::1
  }
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every(byte => byte === 0)
  ) {
    return embeddedIpv4(12) // 64:ff9b::/96 NAT64
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return embeddedIpv4(2) // 2002::/16 6to4
  }
  return (
    (bytes[0] === 0x00 &&
      bytes[1] === 0x64 &&
      bytes[2] === 0xff &&
      bytes[3] === 0x9b &&
      bytes[4] === 0x00 &&
      bytes[5] === 0x01) || // 64:ff9b:1::/48 local-use NAT64
    (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) || // fe80::/10 link-local
    (bytes[0]! & 0xfe) === 0xfc || // fc00::/7 unique-local
    bytes[0] === 0xff // ff00::/8 multicast
  )
}

/**
 * True for an IP the proxy must not reach. Unparseable input is blocked
 * defensively.
 * @param ip {string}
 * @returns {boolean}
 */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) {
    return isBlockedIpv4(ip)
  }
  if (family === 6) {
    return isBlockedIpv6(ip)
  }
  return true
}

/**
 * Builds the undici `connect.lookup` function that pins each upstream socket to
 * the exact addresses a caller already validated, keyed by hostname.
 * The `fetch` still connects using the original hostname (so TLS certificate
 * validation and SNI keep working) but resolves it only via this map, so a
 * rebinding attacker cannot swap in a fresh, private address between validation
 * and connection. A hostname absent from the map is refused (defense in depth:
 * the agent must never resolve an unpinned host).
 * @param pins {Map<string, {address: string, family: number}[]>} validated
 *   addresses keyed by lower-cased hostname.
 * @returns {LookupFunction} an undici/`net`-compatible lookup callback.
 */
export function createPinnedLookup(
  pins: Map<string, { address: string; family: number }[]>
): LookupFunction {
  return function pinnedLookup(
    hostname: string,
    options: { all?: boolean },
    callback: (
      err: NodeJS.ErrnoException | null,
      addressOrAddresses?: string | { address: string; family: number }[],
      family?: number
    ) => void
  ): void {
    const entries = pins.get(hostname.toLowerCase())
    if (!entries || entries.length === 0) {
      callback(new Error(`Refusing to resolve unpinned host: ${hostname}`))
      return
    }
    if (options.all) {
      callback(null, entries)
      return
    }
    const first = entries[0]!
    callback(null, first.address, first.family)
  } as unknown as LookupFunction
}

/**
 * Reads a response body up to `maxBytes`, so an undeclared or misdeclared
 * oversized body is abandoned at the byte that crosses the limit and is not
 * buffered whole. The stream is cancelled when the limit is crossed.
 * @param options {object}
 * @param options.body {ReadableStream<Uint8Array> | null}
 * @param options.maxBytes {number}
 * @returns {Promise<Buffer | undefined>}   the body, or `undefined` when it
 *   is larger than `maxBytes`
 */
export async function readBodyBounded({
  body,
  maxBytes
}: {
  body: ReadableStream<Uint8Array> | null
  maxBytes: number
}): Promise<Buffer | undefined> {
  const chunks: Uint8Array[] = []
  if (body !== null) {
    const reader = body.getReader()
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {
          // best-effort -- the stream may already be closed or errored
        })
        return undefined
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks)
}
