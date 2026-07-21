# Administrator's Guide

Operational guidance for deploying and running `was-teaching-server`. The
README's "Environment variables" table is the reference for every config
knob; this document covers the procedures that span more than one variable
or more than one restart.

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

Three env variables, parsed together at startup
(`parseKmsRecordKekRegistry` in `src/config.default.ts`):

| variable                 | role                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KMS_RECORD_KEK`         | A single AES-256 KEK in base58btc Multikey form. The single-KEK alias; mutually exclusive with `KMS_RECORD_KEKS`.                                                            |
| `KMS_RECORD_KEKS`        | A comma-separated list of KEKs (same encoding). Every entry is registered for decryption; the **first entry** wraps new records by default.                                  |
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
rollout should treat any change to these variables as "restart required,
watch the health check".

### Enabling encryption on an existing deployment

Set `KMS_RECORD_KEK` (or a one-entry `KMS_RECORD_KEKS`) and restart. From that
point, newly generated key records are envelope-encrypted before they reach
storage. (To mint the KEK value itself, see step 1 of the rotation runbook
below -- the same generation recipe applies.)

**Existing plaintext records are never rewritten by the server.** They stay
plaintext and readable forever (the deliberate pass-through upgrade path).
Enabling encryption on a deployment that already has keystores protects
*future* key material only; to re-wrap what is already on disk, stop the
server and run the offline re-encryption tool (see below).

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

   (If the deployment currently uses the `KMS_RECORD_KEK` single-var alias,
   move that value into the list as the second entry and unset the alias --
   setting both is a startup error.)

3. **Restart every instance.** If several server processes share one storage
   backend, roll the change to **all** of them: an instance still holding only
   the old config cannot decrypt records written by an instance already
   wrapping under the new KEK, and will 500 on reads of those keys.
4. **Verify**: the server starts (a config mistake fails startup), existing
   keystores still perform key operations (old records unwrap under the old
   KEK), and a newly generated key's stored record carries the new KEK's
   `kekId`.

Two rules to encode in your config management:

- **Never remove a KEK from the list while any record on disk was written
  under it.** Removal makes those records undecryptable (500 on use). To
  retire a KEK, first re-wrap every record under the current one with the
  offline re-encryption tool (see below); only a clean run (`0 failed`, and a
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
finish the exit, stop the server and run the re-encryption tool under this
same config (see below): with `KMS_RECORD_CURRENT_KEK=none` it decrypts every
encrypted record back to plaintext, after which no encrypted record remains
and the KEK variables can be dropped entirely.

### Offline re-encryption (`pnpm reencrypt-kms-records`)

`scripts/reencrypt-kms-records.ts` is the one-shot tool that rewrites the key
records already on disk to the currently configured at-rest form. It walks
every record under `<dataDir>/keystores/*/keys/`, decrypts each through the
configured KEK registry (plaintext records pass through), re-encrypts it under
the current KEK -- or leaves it plaintext when `KMS_RECORD_CURRENT_KEK=none`
-- and writes it back in place (an atomic, durable write-temp-and-rename from
the same helper module the server's own writes go through). Records already in
the target form are left untouched, so the tool is idempotent and safe to
re-run.

Use it in three situations:

1. **After enabling encryption** on a deployment that already has keystores:
   re-wraps the pre-existing plaintext records, which the server itself never
   rewrites.
2. **To retire a KEK after a rotation**: re-wraps records still under the old
   KEK so it can finally be removed from `KMS_RECORD_KEKS`.
3. **To finish the decrypt-only wind-down**: with
   `KMS_RECORD_CURRENT_KEK=none`, decrypts every record back to plaintext so
   the KEK variables can be dropped.

Two hard constraints:

- **Stop the server first.** Key records are create-only through the backend;
  the tool rewrites them in place and does not coordinate with a live process.
  A server running concurrently can race the rewrite or serve a key mid-swap.
- **Filesystem backend only.** The tool walks the on-disk keystore tree; it
  refuses to run (exit 2) when `DATABASE_URL` is set, because re-encryption
  for the Postgres backend is not implemented.

Run it with the **same KEK env variables the server runs with** -- it parses
them with the same startup code, so tool and server can never disagree about
which KEK is current. A typical retire-a-KEK sequence:

```bash
# 1. Stop the server.

# 2. Preview: what would be rewritten?
KMS_RECORD_KEKS=<newKek>,<oldKek> pnpm reencrypt-kms-records --dry-run

# 3. Rewrite for real (add --data-dir <path> if the data tree is not ./data).
KMS_RECORD_KEKS=<newKek>,<oldKek> pnpm reencrypt-kms-records

# 4. Verify: a second dry run must report every record "already under the
#    current KEK" and 0 failed.
KMS_RECORD_KEKS=<newKek>,<oldKek> pnpm reencrypt-kms-records --dry-run

# 5. Now (and only now) drop the old KEK and restart the server.
KMS_RECORD_KEK=<newKek>
```

The summary line reports, per record, whether it was newly encrypted,
re-wrapped, decrypted to plaintext, or already in the target form. A `FAILED`
record (usually one wrapped under a KEK missing from the registry -- add it
back to `KMS_RECORD_KEKS` and re-run) is left untouched and makes the tool
exit 1; never remove a KEK from the config while any run still reports
failures or rewrites.

Back up the data directory before the first real run. The rewrite is atomic
per record file, but a re-wrap replaces ciphertext the old KEK could decrypt
with ciphertext only the new KEK can -- a config mistake discovered late is
much easier to recover from with a backup.
