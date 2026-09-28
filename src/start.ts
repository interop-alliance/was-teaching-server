/**
 * Entry point: refuses a stale build via assertFreshBuild() (a dist/ whose
 * stamped version no longer matches package.json), loads and validates the env
 * config surface via loadConfigFromEnv() (fail-fast on a missing SERVER_URL or
 * any malformed value), builds the app via createApp() and starts listening.
 * `SIGTERM` and `SIGINT` close the server gracefully, so its `onClose` hooks
 * run.
 */
import type { FastifyInstance } from 'fastify'
import { createApp } from './server.js'
import { PostgresBackend } from './backends/postgres.js'
import {
  assertFreshBuild,
  loadConfigFromEnv,
  loopbackPortMismatch
} from './config.default.js'

/**
 * How long a graceful shutdown waits for in-flight requests and `onClose`
 * hooks before the process exits anyway.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000

/**
 * Makes an uncaught exception or unhandled rejection loud: logs it through the
 * Fastify logger at `fatal` and exits with code 1. Either one means a defect
 * left the process in an unknown state, so it is not kept running, and the
 * log line is what tells a restart apart from a clean one.
 * @param fastify {import('fastify').FastifyInstance}
 * @returns {void}
 */
function installProcessFaultHandlers(fastify: FastifyInstance): void {
  process.on('uncaughtException', err => {
    fastify.log.fatal({ err }, 'Uncaught exception; exiting')
    process.exit(1)
  })
  process.on('unhandledRejection', reason => {
    fastify.log.fatal({ err: reason }, 'Unhandled promise rejection; exiting')
    process.exit(1)
  })
}

/**
 * Closes the server on `SIGTERM` or `SIGINT`: `fastify.close()` stops
 * accepting connections, waits for in-flight requests, and runs the `onClose`
 * hooks (the Postgres pool drain, the CORS proxy's agents). The process then
 * exits on its own once nothing holds the event loop open. A close still
 * pending after {@link SHUTDOWN_DRAIN_TIMEOUT_MS}, or a second signal, exits
 * with code 1. A handle still open at that deadline after a successful close
 * exits with code 0.
 * @param fastify {import('fastify').FastifyInstance}
 * @returns {void}
 */
function installShutdownHandlers(fastify: FastifyInstance): void {
  let closing = false
  function shutdown(signal: NodeJS.Signals): void {
    if (closing) {
      fastify.log.warn({ signal }, 'Second shutdown signal; exiting now')
      process.exit(1)
    }
    closing = true
    fastify.log.info({ signal }, 'Shutdown signal received; closing server')
    let closed = false
    const timer = setTimeout(() => {
      if (closed) {
        // The close finished, but a handle it did not release still holds
        // the event loop open.
        fastify.log.warn('Open handles outlived the server close; exiting')
        process.exit(0)
      }
      fastify.log.error(
        { timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
        'Graceful shutdown timed out; exiting'
      )
      process.exit(1)
    }, SHUTDOWN_DRAIN_TIMEOUT_MS)
    // The timer alone must not keep a drained process alive.
    timer.unref()
    fastify.close().then(
      () => {
        closed = true
        fastify.log.info('Server closed')
      },
      err => {
        fastify.log.error({ err }, 'Graceful shutdown failed')
        process.exit(1)
      }
    )
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

/**
 * Loads the validated env config, builds the app via createApp(), and starts
 * listening. On startup failure it writes the error to stderr, closes whatever
 * was built, and sets exit code 1. The process then exits once stderr drains,
 * since `process.exit()` could drop a message written to a pipe.
 * @returns {Promise<void>}
 */
export async function startServer(): Promise<void> {
  let fastify: FastifyInstance | undefined
  try {
    assertFreshBuild()
    const config = loadConfigFromEnv()
    // Backend selection: presence of DATABASE_URL selects the Postgres
    // backend; otherwise createApp falls back to the default filesystem
    // backend (rooted at WAS_DATA_DIR, else data/). An injected backend
    // carries its own quota configuration, so the per-Space/per-upload limits
    // are passed to it directly rather than through the createApp options.
    const backend = config.databaseUrl
      ? new PostgresBackend({
          connectionString: config.databaseUrl,
          capacityBytes: config.storageLimitPerSpace,
          maxUploadBytes: config.maxUploadBytes,
          maxSpacesPerController: config.maxSpacesPerController,
          maxCollectionsPerSpace: config.maxCollectionsPerSpace,
          maxResourcesPerSpace: config.maxResourcesPerSpace
        })
      : undefined
    fastify = createApp({
      serverUrl: config.serverUrl,
      ...(backend && { backend }),
      ...(config.dataDir !== undefined && { dataDir: config.dataDir }),
      storageLimitPerSpace: config.storageLimitPerSpace,
      maxUploadBytes: config.maxUploadBytes,
      maxSpacesPerController: config.maxSpacesPerController,
      maxCollectionsPerSpace: config.maxCollectionsPerSpace,
      maxResourcesPerSpace: config.maxResourcesPerSpace,
      enabledBackendProviders: config.enabledBackendProviders,
      kmsRecordKek: config.kmsRecordKek,
      onboardingToken: config.onboardingToken,
      discloseVersion: config.discloseVersion
    })
    // Warn (once, at startup, where the Fastify logger now exists) about limits
    // left implicitly unbounded. These warnings live only here so library and
    // test compositions of createApp() stay silent; an explicit `unlimited`
    // (Infinity) or a finite value is a deliberate choice and warns nothing.
    if (config.storageLimitPerSpace === undefined) {
      fastify.log.warn(
        'No per-Space storage quota configured; Spaces may grow without ' +
          'bound. Set STORAGE_LIMIT_PER_SPACE (bytes), or ' +
          'STORAGE_LIMIT_PER_SPACE=unlimited to acknowledge.'
      )
    }
    if (config.maxUploadBytes === Infinity) {
      fastify.log.warn(
        'Per-upload size cap disabled (MAX_UPLOAD_BYTES=unlimited); a single ' +
          'upload may consume unbounded memory on buffered write paths.'
      )
    }
    const serverUrlPort = loopbackPortMismatch({
      serverUrl: config.serverUrl,
      port: config.port
    })
    if (serverUrlPort !== undefined) {
      fastify.log.warn(
        { serverUrl: config.serverUrl, port: config.port },
        `SERVER_URL is a loopback URL on port ${serverUrlPort}, but the ` +
          `server listens on PORT ${config.port}. ZCap invocation targets ` +
          'embed the SERVER_URL port, so requests sent to the listening ' +
          'port will not match any capability.'
      )
    }
    installProcessFaultHandlers(fastify)
    installShutdownHandlers(fastify)
    await fastify.listen({ port: config.port, host: config.host })
  } catch (err) {
    console.error('Server startup failed:', err)
    process.exitCode = 1
    // Release what startup already opened (a Postgres pool, a bound socket),
    // or it would hold the event loop open and the process would never exit.
    await fastify?.close().catch(() => {})
  }
}

startServer()
