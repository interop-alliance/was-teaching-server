# 0003: One server key signs exports and sync invocations

- Status: accepted
- Date: 2026-10-02
- Driving work: the multi-primary Spaces design
  (`designs/WAS-96-multi-primary-spaces.md`, approved 2026-10-02). A replica
  pulls its peer's Space under a delegated capability, so the pulling server
  needs a signing identity a controller can delegate to, and the server already
  held one key for export provenance.
- Affects: was-teaching-server (`src/lib/serverIdentity.ts`'s `resolveServerDid`
  and the import statement check in `src/lib/importProvenance.ts`; the sync
  loop's invocation signer; the replica registration check;
  `docs/admin-guide.md`'s key-rotation runbook; ARCHITECTURE.md's Server
  identity entry). The replication specification's registration section, which
  says what the pull capability's `controller` is. freewallet's registration
  flow, which delegates the pull capability.

## Context

The server derives one Ed25519 key from `WAS_SERVER_KEY_SEED` and signs export
provenance statements with it as `{serverDid}#{publicKeyMultibase}`. The
server's `did:webvh` log is admin-custodied: the administrator holds the update
key, and `resolveServerDid` advertises the DID only when the log lists the
export key under `assertionMethod` and under no other relationship. That
exclusion was deliberate. A key under `capabilityInvocation` could root-invoke,
and one under `capabilityDelegation` alone would read as a ladder verification
method to the client-annex clause.

Replication adds a second role. The pulling server invokes a delegated read
capability on its peer, and the peer verifies that invocation against the
controller the capability names. The draft design derived a second key for this
(an HKDF sync key, advertised on `/service` as `syncInvocationKey`) and allowed
a `did:key` signing form until the admin listed the key in the log.

## Decision

The one seed key serves both roles.

- The admin lists the key in the server log under `assertionMethod` and
  `capabilityInvocation`. `resolveServerDid` and the import statement check
  require `assertionMethod`, permit `capabilityInvocation`, and still refuse
  `capabilityDelegation`, `authentication` and `keyAgreement`.
- The server signs pull invocations as `{serverDid}#{key}`, the same method it
  signs exports with.
- A controller delegates the pull capability to `serverDid`. A bare key is not
  an accepted grantee.
- There is no `did:key` signing form and no `/service` member for the key. The
  DID is the advertisement, as it is for export signing.
- Replication requires the server identity. A registration on a server with no
  advertised `serverDid`, or whose log does not list the key under
  `capabilityInvocation`, is refused naming that reason.

## Rejected Alternatives

- **A second, HKDF-derived sync key with a `syncInvocationKey` member on
  `/service`.** Two keys with two derivation labels, two advertisement paths and
  two rotation stories, for one holder (the server) and one seed. The separation
  bought no custody boundary, since both keys came from the same seed. It also
  left the key, rather than the DID, as what a wallet delegated to, so a
  rotation would have required re-delegation on every registration.
- **A `did:key` signing fallback before the log lists the key.** It made
  replication work on a server with no identity, which is the posture the design
  wants to refuse: a peer cannot tell such a server from any other holder of a
  `did:key`, and the admin-custodied log is what makes a sync key retirable from
  outside the server.

## Consequences

- Retiring a stolen sync key means rotating the seed, which rotates the export
  key too. The admin guide says so. Past export statements stay verifiable
  through the log's history, as they do today.
- The wallet learns no key. It delegates to `serverDid`, and the admin rotates
  the key inside the log without any re-delegation.
- A server with no identity cannot replicate, in either direction. Replication
  is an operator-provisioned feature, not a default.
- The `assertionMethod`-alone rule for the export key is relaxed by exactly one
  relationship. The other three exclusions, and their reasons, stand.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. A deployment needs the two roles' blast radius separated: an operator who
   must retire sync authority while keeping export signatures verifiable under
   an unchanged key, or the reverse.
2. The sync path needs key agreement (an encrypted channel or a server-to-server
   envelope), which an Ed25519 signing key does not provide. Add a
   `keyAgreement` key as a second key then, under its own relationship, rather
   than widening this one.

If revisited, add the second key beside this one and keep `serverDid` as the
delegation target, so existing registrations stay valid.
