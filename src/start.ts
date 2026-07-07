/**
 * Entry point: reads SERVER_URL / PORT from env, builds the app via
 * createApp() and starts listening.
 */
import type { FastifyInstance } from 'fastify'
import { createApp } from './server.js'
import { PostgresBackend } from './backends/postgres.js'
import {
  parseStorageLimit,
  parseMaxUploadBytes,
  parseEnabledBackends,
  parseKmsRecordKek,
  parseOnboardingToken
} from './config.default.js'

/**
 * Reads SERVER_URL / PORT from env, builds the app via createApp(), and starts
 * listening. Exits the process with code 1 on startup failure.
 * @returns {Promise<void>}
 */
export async function startServer(): Promise<void> {
  let fastify: FastifyInstance
  try {
    const capacityBytes = parseStorageLimit(process.env.STORAGE_LIMIT_PER_SPACE)
    const maxUploadBytes = parseMaxUploadBytes(process.env.MAX_UPLOAD_BYTES)
    // Backend selection: presence of DATABASE_URL selects the Postgres
    // backend; otherwise createApp falls back to the default filesystem
    // backend (rooted at data/). An injected backend carries its own quota
    // configuration, so the per-Space/per-upload limits are passed to it
    // directly rather than through the createApp options.
    const databaseUrl = process.env.DATABASE_URL
    const backend = databaseUrl
      ? new PostgresBackend({
          connectionString: databaseUrl,
          capacityBytes,
          maxUploadBytes
        })
      : undefined
    fastify = createApp({
      serverUrl: process.env.SERVER_URL,
      ...(backend && { backend }),
      storageLimitPerSpace: capacityBytes,
      maxUploadBytes,
      enabledBackendProviders: parseEnabledBackends(
        process.env.WAS_ENABLED_BACKENDS
      ),
      kmsRecordKek: parseKmsRecordKek(process.env.KMS_RECORD_KEK),
      onboardingToken: parseOnboardingToken(process.env.WAS_ONBOARDING_TOKEN)
    })
    await fastify.listen({
      port: Number(process.env.PORT ?? 3002),
      host: '0.0.0.0'
    })
  } catch (err) {
    console.error('Server startup failed:', err)
    process.exit(1)
  }
}

startServer()
