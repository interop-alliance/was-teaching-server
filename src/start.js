/**
 * Entry point: reads SERVER_URL / PORT from env, builds the app via
 * createApp() and starts listening.
 */
import { createApp } from './server.js'

/**
 * Reads SERVER_URL / PORT from env, builds the app via createApp(), and starts
 * listening. Exits the process with code 1 on startup failure.
 * @returns {Promise<void>}
 */
export async function startServer () {
  let fastify
  try {
    fastify = createApp({ serverUrl: process.env.SERVER_URL })
    await fastify.listen({ port: process.env.PORT ?? 3002, host: '0.0.0.0' })
  } catch (err) {
    console.error('Server startup failed:', err)
    process.exit(1)
  }
}

startServer()
