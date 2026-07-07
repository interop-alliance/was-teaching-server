/**
 * Library entry point: the surface a downstream composition consumes when this
 * package is used as a dependency rather than run standalone. Exports the
 * `fastifyWas` protocol plugin, the community-edition `createApp()`
 * composition, the
 * storage pieces a custom backend needs (the `StorageBackend` contract types,
 * the reference `FileSystemBackend`, and `defaultBackend()`), and the typed
 * protocol errors a backend or composition throws and handles.
 *
 * Importing anything from here also loads the Fastify module augmentation in
 * types.ts (`FastifyInstance.serverUrl` / `.storage`, `FastifyRequest.zcap`),
 * so consumers get the decorated instance typed for free.
 */
export { fastifyWas, type FastifyWasOptions } from './plugin.js'
export { createApp } from './server.js'
export { defaultBackend } from './storage.js'
export { FileSystemBackend } from './backends/filesystem.js'
export { PostgresBackend } from './backends/postgres.js'
export { onboardingTokenAuthorizer } from './provisioning.js'
export type * from './types.js'
export * from './errors.js'
