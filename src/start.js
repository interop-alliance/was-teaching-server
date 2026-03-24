import { createApp } from './server.js'

export async function startServer () {
  try {
    const fastify = createApp()
    await fastify.listen({ port: process.env.PORT ?? 3002, host: '0.0.0.0' })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

startServer()
