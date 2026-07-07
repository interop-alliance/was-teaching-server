/**
 * Entry point: loads and validates the env config surface via
 * loadConfigFromEnv() (fail-fast on a missing SERVER_URL or any malformed
 * value), builds the app via createApp() and starts listening.
 */
import type { FastifyInstance } from 'fastify'
import { createApp } from './server.js'
import { PostgresBackend } from './backends/postgres.js'
import { loadConfigFromEnv } from './config.default.js'

/**
 * Loads the validated env config, builds the app via createApp(), and starts
 * listening. Exits the process with code 1 on startup failure.
 * @returns {Promise<void>}
 */
export async function startServer(): Promise<void> {
  let fastify: FastifyInstance
  try {
    const config = loadConfigFromEnv()
    // Backend selection: presence of DATABASE_URL selects the Postgres
    // backend; otherwise createApp falls back to the default filesystem
    // backend (rooted at data/). An injected backend carries its own quota
    // configuration, so the per-Space/per-upload limits are passed to it
    // directly rather than through the createApp options.
    const backend = config.databaseUrl
      ? new PostgresBackend({
          connectionString: config.databaseUrl,
          capacityBytes: config.storageLimitPerSpace,
          maxUploadBytes: config.maxUploadBytes
        })
      : undefined
    fastify = createApp({
      serverUrl: config.serverUrl,
      ...(backend && { backend }),
      storageLimitPerSpace: config.storageLimitPerSpace,
      maxUploadBytes: config.maxUploadBytes,
      enabledBackendProviders: config.enabledBackendProviders,
      kmsRecordKek: config.kmsRecordKek,
      onboardingToken: config.onboardingToken
    })
    await fastify.listen({ port: config.port, host: '0.0.0.0' })
  } catch (err) {
    console.error('Server startup failed:', err)
    process.exit(1)
  }
}

startServer()
