# Administrator's Guide

Operational guidance for deploying and running `was-teaching-server`. The
README's "Environment variables" table is the reference for every config knob;
this document covers the procedures that span more than one variable or more
than one restart.

## At-rest KMS key-record encryption

**Scope.** This layer encrypts the server's own WebKMS **key records** -- the
private key material behind `/kms`. It has nothing to do with encrypted
Collections, where encryption is client-side and the server stores opaque
ciphertext it cannot decrypt. The two layers share the words "KEK" and
"rotation" and nothing else.

**Threat model.** The KEK(s) live in process env and process memory. At-rest
encryption therefore defends against a **disk or database dump** (backups,
storage volumes, decommissioned drives) -- not against a compromised server
process, which holds both the KEKs and every decrypted record that passes
through it. Treat the KEK values with the same secret-manager hygiene as
`DATABASE_URL`. Moving the KEK out of the process (HSM / cloud KMS behind the
`recordKekLoader()` seam) is future work.

### Configuration surface

Three env variables, parsed together at startup (`parseKmsRecordKekRegistry` in
`src/config.default.ts`):

| variable                 | role                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KMS_RECORD_KEK`         | A single AES-256 KEK in base58btc Multikey form. The single-KEK alias; mutually exclusive with `KMS_RECORD_KEKS`.                                                           |
| `KMS_RECORD_KEKS`        | A comma-separated list of KEKs (same encoding). Every entry is registered for decryption; the **first entry** wraps new records by default.                                 |
| `KMS_RECORD_CURRENT_KEK` | Optional override of which registered KEK wraps new records: a `urn:kek:sha256:<hex>` id, a multibase KEK value, or the literal `none` (decrypt-only; see wind-down below). |

All three unset means key records are stored **plaintext** (the teaching
default). Every KEK is identified by an id derived from its raw key bytes
(`urn:kek:sha256:<hex>` -- `deriveKekId()`), and each encrypted record stores
the id of the KEK it was wrapped under, which is what makes rotation a config
change rather than a data migration.

**Misconfiguration fails the deploy, not the request path.** Setting both
`KMS_RECORD_KEK` and `KMS_RECORD_KEKS`, a duplicate list entry, a
`KMS_RECORD_CURRENT_KEK` that matches no registered KEK, a dangling
`KMS_RECORD_CURRENT_KEK` with no KEKs configured, or a malformed key value all
crash the process at startup, with the offending variable (and, for a list
entry, its 1-based position) named -- the secret value is never echoed. A
rollout should treat any change to these variables as "restart required, watch
the health check".

### Enabling encryption on an existing deployment

Set `KMS_RECORD_KEK` (or a one-entry `KMS_RECORD_KEKS`) and restart. From that
point, newly generated key records are envelope-encrypted before they reach
storage. (To mint the KEK value itself, see step 1 of the rotation runbook below
-- the same generation recipe applies.)

**Existing plaintext records are never rewritten by the server.** They stay
plaintext and readable forever (the deliberate pass-through upgrade path).
Enabling encryption on a deployment that already has keystores protects _future_
key material only; to re-wrap what is already on disk, stop the server and run
the offline re-encryption tool (see below).

### KEK rotation runbook

Goal: new key records wrap under a fresh KEK, while every record written under
the previous KEK keeps decrypting.

1. **Generate the new KEK**: 32 random bytes, encoded as a base58btc Multikey
   (`z...`) with the AES-256 header (`0xa2 0x01`) -- the same form the current
   KEK is in. The convenient way is `@interop/did-cli`:

   ```bash
   di key create --type aes256
   ```

   which prints the `secretKeyMultibase` value for the env var alongside its
   derived `urn:kek:sha256:` id (the form `KMS_RECORD_CURRENT_KEK` accepts).
   Without the CLI, the same recipe as a one-liner (run from this repo so
   `@digitalcredentials/bnid` resolves):

   ```bash
   node --input-type=module -e "
   import { randomBytes } from 'node:crypto'
   import { IdEncoder } from '@digitalcredentials/bnid'
   const bytes = Buffer.concat([Buffer.from([0xa2, 0x01]), randomBytes(32)])
   console.log(new IdEncoder({ encoding: 'base58', multibase: true }).encode(bytes))
   "
   ```

   Store the value in your secret manager.

2. **Prepend it to the list.** Change config to:

   ```
   KMS_RECORD_KEKS=<newKek>,<oldKek>
   ```

   (If the deployment currently uses the `KMS_RECORD_KEK` single-var alias, move
   that value into the list as the second entry and unset the alias -- setting
   both is a startup error.)

3. **Restart every instance.** If several server processes share one storage
   backend, roll the change to **all** of them: an instance still holding only
   the old config cannot decrypt records written by an instance already wrapping
   under the new KEK, and will 500 on reads of those keys.
4. **Verify**: the server starts (a config mistake fails startup), existing
   keystores still perform key operations (old records unwrap under the old
   KEK), and a newly generated key's stored record carries the new KEK's
   `kekId`.

Two rules to encode in your config management:

- **Never remove a KEK from the list while any record on disk was written under
  it.** Removal makes those records undecryptable (500 on use). To retire a KEK,
  first re-wrap every record under the current one with the offline
  re-encryption tool (see below); only a clean run (`0 failed`, and a
  `--dry-run` re-check reporting every record already current) makes dropping
  the old KEK from the list safe.
- **Order is meaningful.** The first entry is the write key. A config system
  that alphabetizes or otherwise reorders lists will silently change which KEK
  wraps new records. To make the choice explicit and order-proof, set
  `KMS_RECORD_CURRENT_KEK` to the intended KEK (by `urn:kek:sha256:` id, or by
  value) instead of relying on position.

### Decrypt-only wind-down

You cannot simply unset the KEK variables on a deployment that has encrypted
records -- they would stop decrypting. The graceful exit is:

```
KMS_RECORD_KEKS=<kek1>,<kek2>,...
KMS_RECORD_CURRENT_KEK=none
```

Every listed KEK stays registered for decryption, but new key records are
written plaintext. This is the posture for draining out of the feature. To
finish the exit, stop the server and run the re-encryption tool under this same
config (see below): with `KMS_RECORD_CURRENT_KEK=none` it decrypts every
encrypted record back to plaintext, after which no encrypted record remains and
the KEK variables can be dropped entirely.

### Offline re-encryption (`pnpm reencrypt-kms-records`)

`scripts/reencrypt-kms-records.ts` is the one-shot tool that rewrites the key
records already on disk to the currently configured at-rest form. It walks every
record under `<dataDir>/keystores/*/keys/`, decrypts each through the configured
KEK registry (plaintext records pass through), re-encrypts it under the current
KEK -- or leaves it plaintext when `KMS_RECORD_CURRENT_KEK=none` -- and writes
it back in place (an atomic, durable write-temp-and-rename from the same helper
module the server's own writes go through). Records already in the target form
are left untouched, so the tool is idempotent and safe to re-run.

Use it in three situations:

1. **After enabling encryption** on a deployment that already has keystores:
   re-wraps the pre-existing plaintext records, which the server itself never
   rewrites.
2. **To retire a KEK after a rotation**: re-wraps records still under the old
   KEK so it can finally be removed from `KMS_RECORD_KEKS`.
3. **To finish the decrypt-only wind-down**: with `KMS_RECORD_CURRENT_KEK=none`,
   decrypts every record back to plaintext so the KEK variables can be dropped.

Two hard constraints:

- **Stop the server first.** Key records are create-only through the backend;
  the tool rewrites them in place and does not coordinate with a live process. A
  server running concurrently can race the rewrite or serve a key mid-swap.
- **Filesystem backend only.** The tool walks the on-disk keystore tree; it
  refuses to run (exit 2) when `DATABASE_URL` is set, because re-encryption for
  the Postgres backend is not implemented.

Run it with the **same KEK env variables the server runs with** -- it parses
them with the same startup code, so tool and server can never disagree about
which KEK is current. A typical retire-a-KEK sequence:

```bash
# 1. Stop the server.

# 2. Preview: what would be rewritten?
KMS_RECORD_KEKS=<newKek>,<oldKek> pnpm reencrypt-kms-records --dry-run

# 3. Rewrite for real (the tool reads WAS_DATA_DIR; pass --data-dir <path>
#    if the data tree is somewhere else).
KMS_RECORD_KEKS=<newKek>,<oldKek> pnpm reencrypt-kms-records

# 4. Verify: a second dry run must report every record "already under the
#    current KEK" and 0 failed.
KMS_RECORD_KEKS=<newKek>,<oldKek> pnpm reencrypt-kms-records --dry-run

# 5. Now (and only now) drop the old KEK and restart the server.
KMS_RECORD_KEK=<newKek>
```

The summary line reports, per record, whether it was newly encrypted,
re-wrapped, decrypted to plaintext, or already in the target form. A `FAILED`
record (usually one wrapped under a KEK missing from the registry -- add it back
to `KMS_RECORD_KEKS` and re-run) is left untouched and makes the tool exit 1;
never remove a KEK from the config while any run still reports failures or
rewrites.

Back up the data directory before the first real run. The rewrite is atomic per
record file, but a re-wrap replaces ciphertext the old KEK could decrypt with
ciphertext only the new KEK can -- a config mistake discovered late is much
easier to recover from with a backup.

## Server identity

**Scope.** The server has an identity of its own, separate from every Space
controller: a `did:webvh` DID whose document lists the key the server will sign
export archives with. Both are published on `GET /service` under `instance`
(`exportSigningKey`, `serverDid`). Nothing is signed yet; this section covers
provisioning the identity so that signing can be switched on later.

**Two keys, two holders.** The server holds only a signing key, derived from
`WAS_SERVER_KEY_SEED`. The administrator holds the update key of the DID's
history log (their own `did:key`, named in `WAS_ADMIN_DID`). The server never
mints or extends its own log. So a compromised server can forge signatures until
the log is rotated, but cannot take the DID over, and a data wipe cannot lose
the update key because the server never had it.

**Where the log lives.** The DID is `did:webvh:{scid}:{host}:space:server:id`,
and its log is the `did.jsonl` Resource of the `id` Collection in the `server`
Space. The server provisions that Space at startup, controlled by
`WAS_ADMIN_DID`, typed `AuxiliarySpace` + `ServerInstanceSpace`, and hidden from
List Spaces. The admin writes the log there like any other client write, signed
by the admin key.

### Configuration surface

| variable              | role                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `WAS_SERVER_KEY_SEED` | 32-byte Ed25519 seed in bnid's secret-key-seed encoding (`z1A...`). Unset: no signing key, and `/service` carries no `exportSigningKey`. |
| `WAS_ADMIN_DID`       | The admin's Ed25519 `did:key`. Unset: the `server` Space is not provisioned, and no client can be told apart as the admin.               |

Both are read at startup. A malformed seed, a seed of the wrong length, or a
`WAS_ADMIN_DID` that is not an Ed25519 `did:key` fails the deploy. So does a
stored `server` Space that is not typed `ServerInstanceSpace` (one written
before the id was reserved; delete it or unset the variable) or whose controller
is not `WAS_ADMIN_DID` (the admin DID changed; update the Space's controller
through Update Space, or restore the variable).

### Provisioning the identity

1. Generate the seed with `@interop/bnid`'s `generateSecretKeySeed()` (the
   encoding the test fixtures' seeds use). From this repo:

   ```bash
   node -e "import('@interop/bnid').then(async m=>console.log(await m.generateSecretKeySeed()))"
   ```

   Set it as `WAS_SERVER_KEY_SEED`, with the same secret hygiene as the KEK.
   Every machine of a deployment gets the same seed, so they share one key.

2. Set `WAS_ADMIN_DID` to the admin's `did:key` and restart. The log line
   `No server DID lists the export-signing key yet` is expected at this point.

3. Read the key: `GET /service`, member `instance.exportSigningKey`
   (`did:key:z6Mk...`). The `publicKeyMultibase` is the part after `did:key:`.

4. Build the genesis entry with `@interop/did-method-webvh`'s `createDID`:
   `address` `{SERVER_URL}/space/server/id`, `updateKeys` the admin key's
   `publicKeyMultibase`, `portable: true`, `vmIdFragment: 'multibase'`, and one
   verification method of type `Multikey` carrying the server key with
   `purpose: ['assertionMethod']` and nothing else. Any other relationship on
   that method withdraws the identity: the server refuses to advertise a key
   that could invoke or delegate.

5. Create the `id` Collection in the `server` Space and `PUT` the log to
   `/space/server/id/did.jsonl` as `text/jsonl`, signed by the admin key.

6. Confirm: `GET /service` now carries `instance.serverDid`. Keep a copy of the
   log; the admin's copy is the source of truth (below).

An admin script that performs steps 3 to 6 is planned; until it lands, the test
suite's `test/server-identity-api.test.ts` shows the calls.

### Rotating the seed

A new seed is a new key. Set the new `WAS_SERVER_KEY_SEED`, restart, read the
new `exportSigningKey`, append a log entry (`updateDID`) whose verification
methods list the new key under `assertionMethod` alone and drop the old one, and
`PUT` the whole log back. `/service` drops `serverDid` between the restart and
the append, and picks it up again once the new entry lands. Archives signed
under the old key keep verifying against the log epoch they name. A leaked seed
is handled the same way.

### Restoring the log after a data wipe

The log lives in the data dir and dies with it. The seed survives in the secret
store, so the key does not change. After the wipe the server re-provisions the
empty `server` Space at startup; the admin re-creates the `id` Collection and
`PUT`s the saved log back unchanged. Same SCID, same DID. Keeping the log out of
the wipe (`spaces/server` on the filesystem backend) is a convenience, not a
requirement. Losing both the log and the admin key means the DID cannot be
extended; the operator provisions a fresh identity, and old archives still
verify against the log snapshot they embed.

### Moving `SERVER_URL`

The DID string carries the host, so a log written for another host does not
resolve as this server's, and `/service` drops `serverDid` after the move. The
log was created with `portable: true`; the admin appends a domain-move entry
addressing `{NEW_SERVER_URL}/space/server/id` and `PUT`s it under the new host.
The SCID is unchanged. Re-minting a fresh identity instead is also fine, at the
cost of provenance continuity.
