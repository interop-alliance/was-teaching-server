# 0001: Generalized self-hosted did:webvh parsing

- Status: accepted
- Date: 2026-08-19
- Driving work: the public-computer posture redesign for the browser
  wallet (per-visit transient clients in a disposable companion
  did:webvh). The companion's log lives in an ordinary collection, not
  the account Space's `id` collection, so the server's self-hosted
  did:webvh handling had to stop assuming that one collection.
- Affects: was-teaching-server (`parseSelfHostedWebvh`, the log
  reader, `resolveWebvhController` and its cache invalidation,
  ARCHITECTURE.md's authorization notes).

## Context

The did:webvh method's DID-to-URL mapping is generic:
`did:webvh:<scid>:<host>:space:<spaceId>:<collection>` maps to that
collection's `did.jsonl`. The server's restriction to the literal `id`
segment lived only in its own authorization-side parser and log
reader -- implementation conservatism, not protocol. The companion
architecture needs the server to resolve DIDs whose logs live in
per-generation collections, including collections in a Space other
than the one an invocation targets, and including capability-gated
(private) collections.

## Decision

The server accepts a self-hosted did:webvh whose log lives in ANY
collection whose name round-trips the DID path encoding;
non-round-tripping names are refused by the parser. Four caveats are
part of the decision, not follow-ups:

1. Resolvability grants nothing. A DID acquires authority only by
   being referenced -- as a Space controller, a delegation controller,
   or the account document's companion pointer. This is what makes the
   widening safe.
2. Write-granted third parties can mint resolvable DIDs under a user's
   Space path. That is authorization-inert by caveat 1; path-hosting
   is not endorsement (recorded in ARCHITECTURE.md).
3. The resolution-cache invalidation gate moves from the `id`
   collection to `did.jsonl`-in-any-collection, and needs a cost
   bound: the widened gate is a cheap-write, expensive-verify
   amplification lever (an app holding an ordinary collection grant
   could PUT a `did.jsonl` per request and churn the memoized resolve
   into a full log verification each time). Invalidate only
   collections a pointer names, or rate-limit re-verification.
4. A capability-gated collection's DID still resolves for
   authorization: the server reads its own storage regardless of read
   ACLs, and no third party ever needs to resolve a companion DID.

One implementation check is owed before companion work builds on this:
resolving a Space whose did:webvh controller's log lives in a
DIFFERENT Space. The DID string embeds the log's own Space id, so the
location is derivable, but no code path is known to exercise it.

## Rejected Alternatives

- Keeping the `id`-only restriction: blocks the delegated-clients
  companion architecture outright, for a constraint the method itself
  never imposed.
- A second verifier class accepting roster-style verified resource
  logs as authorization inputs: this is the reason the companion is
  another did:webvh at all -- the server reuses its existing verifier
  verbatim instead of growing a new one.

## Consequences

- The server's did:webvh surface widens: any clean-named collection
  can host a resolvable DID, and operators should expect
  user-path-hosted DIDs that mean nothing.
- Without the caveat-3 cost bound, the invalidation gate is an
  amplification vector; the bound is part of shipping this, not an
  optimization.
- Wallets may rely on companion DIDs in private collections resolving
  for authorization without any public read access.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. Observed abuse of the widened surface (resolution-churn load or
   hosted-DID spam) that the caveat-3 bound does not contain.
2. The WAS spec homes self-hosted did:webvh resolution normatively,
   superseding this server-local contract.

If revisited, narrow by reference (which collections a document
points at), not by reinstating a magic collection name.
