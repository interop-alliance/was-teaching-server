/**
 * The Import Space pre-write path: decodes an uploaded archive, builds its
 * merge plan, and judges its provenance, in one call. The handler runs it
 * once per request and hands the result to the backend's `importSpace`, so
 * no backend can build a plan without the provenance verdicts applied to it.
 */
import type { Readable } from 'node:stream'
import type { FastifyBaseLogger } from 'fastify'
import { buildImportPlan, extractTarEntries } from './importTar.js'
import type { ImportPlan } from './importTar.js'
import { applyImportProvenance } from './importProvenance.js'
import type { ImportStats } from '../types.js'

/**
 * Extracts the archive's entries, builds the merge plan from them, and judges
 * the archive's provenance over it (`applyImportProvenance`). The plan comes
 * back with every `createdBy` the archive did not earn removed, beside the
 * per-verdict counts a backend reports as `ImportStats.provenance`.
 *
 * @param options {object}
 * @param options.tarStream {Readable}   the uploaded archive
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<{ plan: ImportPlan, provenance: ImportStats['provenance'] }>}
 */
export async function prepareImportPlan({
  tarStream,
  logger
}: {
  tarStream: Readable
  logger: FastifyBaseLogger
}): Promise<{ plan: ImportPlan; provenance: ImportStats['provenance'] }> {
  const entries = await extractTarEntries(tarStream)
  return applyImportProvenance({
    entries,
    plan: buildImportPlan(entries),
    logger
  })
}
