/**
 * Entry point: reads SERVER_URL / PORT from env, builds the app via
 * createApp() and starts listening.
 */
import type { FastifyInstance } from 'fastify'
import { createApp } from './server.js'
import { parseStorageLimit, parseMaxUploadBytes } from './config.default.js'

/**
 * Reads SERVER_URL / PORT from env, builds the app via createApp(), and starts
 * listening. Exits the process with code 1 on startup failure.
 * @returns {Promise<void>}
 */
export async function startServer(): Promise<void> {
  let fastify: FastifyInstance
  try {
    fastify = createApp({
      serverUrl: process.env.SERVER_URL,
      storageLimitPerSpace: parseStorageLimit(
        process.env.STORAGE_LIMIT_PER_SPACE
      ),
      maxUploadBytes: parseMaxUploadBytes(process.env.MAX_UPLOAD_BYTES)
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
