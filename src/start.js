import { createApp } from './server.js'

export async function startServer () {
  try {
    const fastify = createApp()
    await fastify.listen({ port: 3002 })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

startServer()
