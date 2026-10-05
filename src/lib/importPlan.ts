/**
 * The Import Space pre-write path: decodes an uploaded archive, builds its
 * merge plan, and judges its provenance, in one call. The handler runs it
 * once per request and hands the plan to the backend's `importSpace`, so no
 * backend can build a plan without the provenance verdicts applied to it. The
 * archive's revocation records come back beside the plan, as parsed. The
 * handler verifies and installs them after the plan is written
 * (`lib/importRevocations.ts`), so a backend never installs one.
 */
import type { Readable } from 'node:stream'
import type { FastifyBaseLogger } from 'fastify'
import {
  archivedRevocations,
  buildImportPlan,
  extractTarEntries
} from './importTar.js'
import type { ImportPlan } from './importTar.js'
import { applyImportProvenance } from './importProvenance.js'
import type { ImportStats, RevocationRecord } from '../types.js'

/**
 * Extracts the archive, builds its merge plan (`buildImportPlan`), and judges
 * its provenance against the plan (`applyImportProvenance`). The plan comes
 * back with every `createdBy` the archive did not earn removed, beside the
 * per-verdict counts a backend reports as `ImportStats.provenance`, and the
 * capabilities the archive's revocation records name.
 *
 * @param options {object}
 * @param options.tarStream {Readable}   the uploaded archive
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<{ plan: ImportPlan, provenance: ImportStats['provenance'],
 *   revocations: RevocationRecord['capability'][] }>}
 */
export async function prepareImportPlan({
  tarStream,
  logger
}: {
  tarStream: Readable
  logger: FastifyBaseLogger
}): Promise<{
  plan: ImportPlan
  provenance: ImportStats['provenance']
  revocations: RevocationRecord['capability'][]
}> {
  const entries = await extractTarEntries(tarStream)
  const judged = await applyImportProvenance({
    entries,
    plan: buildImportPlan(entries),
    logger
  })
  return { ...judged, revocations: archivedRevocations(entries) }
}
