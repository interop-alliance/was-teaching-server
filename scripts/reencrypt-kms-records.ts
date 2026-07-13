/**
 * Offline re-encryption tool for at-rest WebKMS key records.
 *
 * Walks every key record under `<dataDir>/keystores/<keystoreId>/keys/*.json`,
 * decrypts each through the configured KEK registry (plaintext records pass
 * through), re-encrypts it under the CURRENT KEK, and writes it back in place
 * (atomic write-temp-and-rename -- key records are otherwise immutable by
 * construction, so the tool bypasses the backend's create-only insert on
 * purpose). It closes the two gaps rotation alone cannot:
 *
 * - records written before encryption was enabled stay plaintext forever
 *   (the pass-through upgrade path) until this tool re-wraps them;
 * - records wrapped under a retired KEK keep that KEK pinned in the registry
 *   until this tool re-wraps them under the current one.
 *
 * With `KMS_RECORD_CURRENT_KEK=none` (the decrypt-only wind-down posture) the
 * tool runs in reverse: every encrypted record is decrypted and written back
 * plaintext, after which the KEK variables can be dropped entirely.
 *
 * Constraints:
 *
 * - **The server must be stopped.** The tool does not coordinate with a live
 *   process; a concurrent generate/read can observe or race the rewrite.
 * - **Filesystem backend only.** Walking every key record is not part of the
 *   `StorageBackend` interface; a `DATABASE_URL` (Postgres) deployment is
 *   refused at startup.
 *
 * KEK configuration comes from the same env surface as the server
 * (`KMS_RECORD_KEK` / `KMS_RECORD_KEKS` / `KMS_RECORD_CURRENT_KEK`), parsed by
 * the same code, so the tool can never disagree with the server about which
 * KEK is current or which KEKs can decrypt.
 *
 * Usage: pnpm reencrypt-kms-records [--dry-run] [--data-dir <path>]
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseKmsRecordKekRegistry } from '../src/config.default.js'
import { atomicWriteFile } from '../src/lib/atomicFile.js'
import {
  currentRecordKek,
  decryptKeyRecord,
  encryptKeyRecord,
  recordKekLoader
} from '../src/lib/kmsRecordCipher.js'
import type { KmsKeyRecord, RecordKek } from '../src/types.js'

const USAGE = `Usage: pnpm reencrypt-kms-records [--dry-run] [--data-dir <path>]

Re-wraps every stored WebKMS key record under the CURRENT record KEK
(KMS_RECORD_KEK / KMS_RECORD_KEKS / KMS_RECORD_CURRENT_KEK -- the same env
variables the server reads). With KMS_RECORD_CURRENT_KEK=none, decrypts every
record back to plaintext instead.

STOP THE SERVER FIRST. Filesystem backend only.

Options:
  --dry-run            report what would be rewritten without writing anything
  --data-dir <path>    the server data directory (default: <repo>/data)
  --help               show this message`

/** Per-record outcome counters for the end-of-run summary. */
interface RunSummary {
  rewrapped: number
  encrypted: number
  decrypted: number
  alreadyCurrent: number
  alreadyPlaintext: number
  failed: number
}

/**
 * Parses the CLI arguments. Exits (code 2) on an unknown flag or a missing
 * `--data-dir` value; exits 0 on `--help`.
 * @param argv {string[]}   `process.argv.slice(2)`
 * @returns {{ dryRun: boolean, dataDir: string }}
 */
function parseArgs(argv: string[]): { dryRun: boolean; dataDir: string } {
  let dryRun = false
  // The same default root the server's filesystem backend uses
  // (`defaultBackend()` in src/storage.ts): `data/` at the repo root.
  let dataDir = path.join(import.meta.dirname, '..', 'data')
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--data-dir') {
      const value = argv[++index]
      if (value === undefined) {
        console.error('--data-dir requires a path argument.\n\n' + USAGE)
        process.exit(2)
      }
      dataDir = value
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`Unknown argument "${arg}".\n\n` + USAGE)
      process.exit(2)
    }
  }
  return { dryRun, dataDir }
}

/**
 * The directory names under `root`, sorted; an absent `root` is an empty list.
 * @param root {string}
 * @returns {Promise<string[]>}
 */
async function subdirectories(root: string): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Rewrites one key record file to its target at-rest form: decrypt through the
 * registry (pass-through for plaintext), then re-encrypt under `current` (or
 * leave plaintext when `current` is undefined -- the wind-down posture).
 * Mutates `summary` with the outcome; a failure is reported (never thrown) so
 * the walk continues past a bad record.
 * @param options {object}
 * @param options.keyFile {string}   absolute path of the record file
 * @param options.label {string}   `<keystoreId>/keys/<localId>` for messages
 * @param options.current {RecordKek|undefined}   the KEK new records wrap under
 * @param options.kekLoader {(kekId: string) => RecordKek | undefined}
 * @param options.dryRun {boolean}
 * @param options.summary {RunSummary}
 * @returns {Promise<void>}
 */
async function reencryptRecordFile({
  keyFile,
  label,
  current,
  kekLoader,
  dryRun,
  summary
}: {
  keyFile: string
  label: string
  current: RecordKek | undefined
  kekLoader: (kekId: string) => RecordKek | undefined
  dryRun: boolean
  summary: RunSummary
}): Promise<void> {
  let record: KmsKeyRecord
  try {
    record = JSON.parse(
      await fs.promises.readFile(keyFile, 'utf8')
    ) as KmsKeyRecord
  } catch (err) {
    summary.failed += 1
    console.error(`FAILED  ${label}: unreadable record (${(err as Error).message})`)
    return
  }

  // Everything from shape inspection through the rewrite is guarded, so one
  // bad record (wrong-shaped JSON, an unregistered kekId, a write error)
  // counts as FAILED and the walk continues past it.
  try {
    const envelope = record.key.encrypted
    if (
      envelope !== undefined &&
      current !== undefined &&
      envelope.kekId === current.id
    ) {
      summary.alreadyCurrent += 1
      return
    }
    if (envelope === undefined && current === undefined) {
      summary.alreadyPlaintext += 1
      return
    }

    // A decrypt failure is typically an unregistered kekId: the record's KEK
    // is not in the env registry. Register the missing KEK and re-run.
    const decrypted = decryptKeyRecord({ record, kekLoader })

    let action: keyof RunSummary
    let rewritten: KmsKeyRecord
    if (current !== undefined) {
      rewritten = encryptKeyRecord({ record: decrypted, kek: current })
      action = envelope !== undefined ? 'rewrapped' : 'encrypted'
    } else {
      rewritten = decrypted
      action = 'decrypted'
    }

    if (!dryRun) {
      // Key records are create-only through the backend (`insertKey` is
      // exclusive-create); this offline rewrite replaces the file in place
      // with an atomic, durable write from the same audited helper module the
      // backend uses, and the same on-disk JSON formatting.
      await atomicWriteFile({
        filePath: keyFile,
        data: JSON.stringify(rewritten, null, 2)
      })
    }
    summary[action] += 1
    console.log(`${action}${dryRun ? ' (dry-run)' : ''}  ${label}`)
  } catch (err) {
    summary.failed += 1
    console.error(`FAILED  ${label}: ${(err as Error).message}`)
  }
}

/**
 * Walks the keystore tree and rewrites every key record, printing a summary.
 * @returns {Promise<void>}   exits 1 when any record failed
 */
async function main(): Promise<void> {
  const { dryRun, dataDir } = parseArgs(process.argv.slice(2))

  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL.trim() !== '') {
    console.error(
      'DATABASE_URL is set: this deployment uses the Postgres backend, but ' +
        'this tool only walks the filesystem key-record tree. ' +
        'Re-encryption for the Postgres backend is not implemented.'
    )
    process.exit(2)
  }

  const registry = parseKmsRecordKekRegistry({
    kek: process.env.KMS_RECORD_KEK,
    keks: process.env.KMS_RECORD_KEKS,
    currentKek: process.env.KMS_RECORD_CURRENT_KEK
  })
  if (registry === undefined) {
    console.error(
      'No record KEK is configured (KMS_RECORD_KEK / KMS_RECORD_KEKS are ' +
        'unset), so there is nothing to re-encrypt under and no KEK to ' +
        'decrypt with. Set the same KEK variables the server runs with.'
    )
    process.exit(2)
  }
  const current = currentRecordKek(registry)
  const kekLoader = recordKekLoader(registry)

  const keystoresDir = path.join(dataDir, 'keystores')
  console.log(
    `Re-encrypting key records under ${keystoresDir}\n` +
      `Target form: ${
        current !== undefined
          ? `encrypted under current KEK ${current.id}`
          : 'plaintext (KMS_RECORD_CURRENT_KEK=none)'
      }${dryRun ? '\nDry run: no files will be written.' : ''}\n` +
      'The server must be STOPPED while this runs.\n'
  )

  const summary: RunSummary = {
    rewrapped: 0,
    encrypted: 0,
    decrypted: 0,
    alreadyCurrent: 0,
    alreadyPlaintext: 0,
    failed: 0
  }

  for (const keystoreId of await subdirectories(keystoresDir)) {
    const keysDir = path.join(keystoresDir, keystoreId, 'keys')
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(keysDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue // keystore with no keys yet
      }
      throw err
    }
    const keyFiles = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
    for (const fileName of keyFiles) {
      await reencryptRecordFile({
        keyFile: path.join(keysDir, fileName),
        label: `${keystoreId}/keys/${fileName.slice(0, -'.json'.length)}`,
        current,
        kekLoader,
        dryRun,
        summary
      })
    }
  }

  const total =
    summary.rewrapped +
    summary.encrypted +
    summary.decrypted +
    summary.alreadyCurrent +
    summary.alreadyPlaintext +
    summary.failed
  console.log(
    `\n${total} record(s): ` +
      `${summary.encrypted} newly encrypted, ` +
      `${summary.rewrapped} re-wrapped under the current KEK, ` +
      `${summary.decrypted} decrypted to plaintext, ` +
      `${summary.alreadyCurrent} already under the current KEK, ` +
      `${summary.alreadyPlaintext} already plaintext, ` +
      `${summary.failed} failed.`
  )
  if (summary.failed > 0) {
    console.error(
      '\nSome records could not be rewritten (see FAILED lines above). ' +
        'They are left untouched; fix the cause (usually a missing KEK in ' +
        'KMS_RECORD_KEKS) and re-run -- the tool is idempotent.'
    )
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
