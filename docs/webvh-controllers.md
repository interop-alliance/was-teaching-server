# did:webvh Controllers and Invokers

This document covers how the server accepts, resolves and verifies a `did:webvh`
as a Space controller, a delegator or the invoker of a capability. That includes
promotion of a Space to a self-hosted DID, the rule that keeps its history log
append-only, the resolver engaged on every verification path, and the one
bounded network fetch of a foreign DID's log.
[ARCHITECTURE.md](../ARCHITECTURE.md) holds the layer map and the glossary.

## Accepted controller shapes

The controller is the DID that owns a Space. Its Ed25519 key signs capability
invocations and is checked during ZCap verification. Three shapes are accepted:

- A `did:key`. It is the only shape a Space may be created with.
- A self-hosted `did:webvh`, which a Space may be updated to (see
  [Self-hosted DIDs](#self-hosted-dids)).
- A `did:webvh` hosted on a replication peer, which a Space may be updated to on
  a replica that holds a copy of its log. The rule that locates that copy is in
  [replication.md](replication.md).

A controller is distinct from the wallet repos' `clientId`. An enrolled client
appears here as a verification method inside the controller's document, not as
the controller itself.

Any other cross-host `did:webvh`, `did:web`, and every other method are refused
as a controller or a delegator. The one network exception is described in
[Foreign invokers resolved over the network](#foreign-invokers-resolved-over-the-network).

## Self-hosted DIDs

The second accepted controller shape lets a wallet carry one stable user
identity whose DID document lists a verification method per enrolled client. The
DID must be anchored on this server:

```
did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>
```

Its history log is the `did.jsonl` Resource in that Collection of that Space.
Any Collection may host one, as long as its name round-trips the DID path
encoding. WAS Collection ids are restricted to the RFC 3986 unreserved charset,
which needs no percent-encoding, so the rule is just that check. A final DID
segment carrying `%` or another reserved character is refused by the parser.

A `did:webvh` on a replication peer's host,
`did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>`, resolves the same way
from the local copy of its log, when exactly one replica registration maps it
there (see [replication.md](replication.md)). It may be a Space controller, a
keystore controller, a delegator, and a `createdBy`.

### Promotion

A Space is promoted to a self-hosted `did:webvh` by a `PUT` of its Space
Metadata object (at `meta`) with the new `controller`, still authorized by the
stored `did:key`. Creation stays `did:key`-only. The proposed controller must
resolve before it is stored, or the Space would be deadlocked.

## Resolution and verification

Resolution of a self-hosted DID is a local storage read, with no network fetch.
The log's Space need not be the Space an invocation targets. The DID string
carries the log's own `spaceId`, so a cross-Space controller resolves through
the same path as any other.

A capability-gated Collection works too. The server reads its own storage
regardless of read policy, so such a DID resolves for authorization while its
log stays unreadable without a capability.

The log is verified, not trusted. Verification is SCID pinning plus the full
hash-chain and update-key check, done by `@interop/did-method-webvh`. It matters
because after promotion the writes to that log are authorized by the very
document being resolved.

The server verifies a log against no witness proofs, on every path. A log that
declares witnesses does not verify here, self-hosted or not, and nothing fetches
`did-witness.json`.

## The current-key-set rule

Key validity is the current-key-set rule (profile
["Current-key-set rule"](https://w3c-ccg.github.io/wallet-attached-storage-spec/authz-profile/#current-key-set-rule)).
An invocation or delegation verifies if and only if its verification method is
in the currently resolved document, under the right verification relationship.

One piece of code carries that rule on both sides. `webvhVerifier` finds the
invocation key by membership in the flat `verificationMethod` array. It restates
`controller: <did>` on the method it reconstructs. That string sends jsigs'
`ControllerProofPurpose` to dereference the controller document through the
local webvh resolver driver (`webvhDidResolverDriver` / `dereferenceFragment`)
and read `capabilityInvocation` out of it. A root invocation and a delegation
proof are therefore relation-scoped identically, and a delegation-only method
cannot root-invoke.

Before promotion the Space controller is a `did:key`. It takes the `did:key`
branch of `createGetVerifier`, where no relation applies.

## The document cache

Resolved documents are cached, keyed by the log's location (Space plus
Collection). A write that could change a log at that location drops the entry.
Entries exist only for DIDs actually resolved for authorization. A `did.jsonl`
written into a Collection no reference names drops nothing and costs no
re-verification.

## Path-hosting is not endorsement

Anyone with a write grant on a user's Space can put a resolvable log under that
Space's path. That proves only that something wrote it there. A DID is
self-certified by its own SCID and log. It acquires authority only by being
referenced, as a Space's stored controller or by a capability delegated to it.
Where its log happens to live confers none.

## The log only grows

The log only grows at this server (`src/lib/webvhLogWrite.ts`).

- A `did.jsonl` in any Collection is written only by a fast-forward `PUT`. The
  stored bytes must be a prefix of the body, else 412. The write is pinned to
  the `ETag` of the log it checked.
- A `DELETE` of one is refused with 405 (`Allow: GET, HEAD, PUT`), before
  authorization.
- Every prefix of a valid log is a valid log with the same SCID. Without the
  rule, a subtree grant could restore a key a later entry retired, or leave the
  controller unresolvable.
- The resolver also records the head it last verified per DID (entry count and
  head `versionId`) and refuses a log that does not extend it. The record is in
  memory and survives cache invalidation. It is dropped only when the log's
  Collection or Space is deleted, so a restore that re-creates the Space can
  land an older log.
- A log goes away only with its Collection or Space. Deleting the Collection
  that holds a controller's log leaves every Space that DID controls with no
  resolvable controller, and there is no break-glass.
- An append must also verify. The whole body is verified as the history log of
  the DID the stored log's head names. A junk or tampered entry is refused as
  `invalid-request-body` (400) before it is stored.
- A stored `did.jsonl` that names no DID cannot be appended to. A create is not
  verified.

## The resolver on every path

Each verification engages the local `did:webvh` resolver, whatever the scope's
own controller is. That covers route invocations, both halves of a revocation
submission (the submitted chain and the submission's own invocation), create
consent, and List Spaces.

A delegated link may be signed by a self-hosted `did:webvh` method on a
`did:key` Space, the unlock-Space shape. Narrowing the resolver to the scope's
controller would leave such a grant live on every route yet unrevocable.

The resolver widens resolution only. It refuses any DID this server holds no log
for, and the chain still roots in the scope's root capability. A submitted chain
may root in the scope's root capability or in the root of any URL under it, the
same roots an invocation accepts. A grant delegated from a Collection's or a
Resource's own root is therefore revocable too.

List Spaces verifies against one candidate controller at most. That is the
signer of a root invocation, or the signer of a delegated chain's base
delegation, read off the header before any signature work. A listing grant roots
in the `/spaces/` root capability, which no revocation route accepts. It carries
no revocation scope, and its `expires` bounds it.

For the root and delegated invocation forms, see ARCHITECTURE.md's ZCap
Structure section. For the chain inspectors that run after verification, see
[client-annex-clause.md](client-annex-clause.md).

## Foreign invokers resolved over the network

One bounded exception reaches the network. Any `did:webvh` on another host whose
log this server does not store may invoke a delegated capability on the WAS
routes. That covers a peer server's DID,
`did:webvh:<scid>:<host>:space:server:id`, and a service's or an agent's DID,
under any path or none. It applies in `authorize()` and `fetchSpaceAndVerify()`.

The HTTP-signature verifier resolves the signing key before it reads the
capability, so a fetch made there would answer any host a request names.
`handleZcapVerify` therefore runs a pre-pass first (`peerInvokerGrant`). It
verifies the embedded delegation chain to the Space controller with local-only
resolution, through the same roots and chain inspectors the invocation applies.
It also requires the invoked capability's sole `controller` to equal the DID. It
gives no grant to a DID that is on the operator's blocklist, nor to one whose
log this server stores, since that DID resolves from storage (see
[replication.md](replication.md)). Only then does the verification that follows
fetch that one DID's log.

A foreign DID with no stored log may invoke. It may not delegate or be a
controller, since every link of the chain must be signed by a key this server
resolves without a fetch. A root invocation by a foreign DID never fetches.
`/kms`, revocation submission, create consent and List Spaces stay local-only.
Every refusal is the plain masked `not-found`.

### The peer log resolver

`src/lib/peerWebvh.ts` is the one network resolution of a foreign `did:webvh`:
any DID on another host whose log this server does not store, with any path or
none. It covers a peer server's own DID,
`did:webvh:<scid>:<host>:space:server:id`, and a service's or an agent's DID. It
resolves one only as the invoker of a delegated capability on the WAS routes.

- The log is fetched from the URL the did:webvh method maps the DID to
  (`https://<host>/<path>/did.jsonl`, or `https://<host>/.well-known/did.jsonl`
  for a host-only DID), by `getFileUrl` of `@interop/did-method-webvh`.
- A DID whose host carries a port, or is an IP address, is refused.
- The log is verified like any log (see
  [Resolution and verification](#resolution-and-verification)).
- The log must extend the last head verified for the DID, so a host cannot serve
  an older prefix to restore a retired key.
- A verified document is cached per DID in an LRU for a TTL, then fetched and
  verified again.
- A signature that names a key the cached document lacks forces one fetch per
  DID per interval.
- A failure is remembered briefly, so a failing host is not asked on every
  request.
- A first-contact fetch is one for a DID with no verified head here. Those are
  counted per host over a window and refused past a limit. A refresh of a DID
  that already verified does not draw on that window, so other DIDs on its host
  cannot starve it.
- Each of the two kinds also has its own limit on fetches in flight, and a fetch
  past it is refused, not queued.
- The body is size-bounded and the fetch has a timeout. The `PEER_WEBVH_*`
  constants in `config.default.ts` set these bounds.

The default fetcher, `fetchPeerLog`, speaks `https` only, on the default port,
follows no redirect, and connects only to the public addresses it checked after
DNS. `lib/outboundAddress.ts` holds those address checks, the pinned lookup and
the size-bounded body reader, shared with the CORS proxy.

`peerLogFetcher` is a plugin and `createApp` option that replaces the fetcher in
tests, since the host bound keeps a real fetch out of the suite. No environment
variable reaches the fetcher.

The resolver is one per app, decorated as `peerWebvh`, and `mayFetch` tells it
whether a DID may be fetched at all.

## The blocklist

The operator's blocklist (`lib/webvhBlocklist.ts`) reaches the network resolver.
`WAS_WEBVH_BLOCKLIST` and the `webvhBlocklist` plugin option take
comma-separated entries. An entry is a host name, which blocks every DID on that
host, or a full `did:webvh` DID. A blocked DID is refused before any fetch with
the masked `not-found`. A malformed entry refuses startup.

The blocklist covers the network path only. A DID whose log this server stores
never takes that path.
