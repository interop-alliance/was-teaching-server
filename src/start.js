import { createApp } from './server.js'

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
