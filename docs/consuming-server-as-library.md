# Consuming the Server as a Library

Besides running standalone, this package can be consumed as a dependency: the
whole WAS protocol surface (the WAS route groups, the WebKMS `/kms` facet, the
auth/digest hook chains, zcap verification, and the error handler) is exposed as
a single registerable Fastify plugin, `fastifyWas`. A downstream server composes
its own Fastify instance -- its own persistence, security plugins, and
operational endpoints -- and registers `fastifyWas` to speak the exact same wire
protocol as the teaching server. (The rationale and the upstream/downstream
split are described in the production roadmap's "Two-codebase strategy"
section.)

## Install

```bash
pnpm add was-teaching-server    # or: npm install was-teaching-server
```

The package is ESM-only (`"type": "module"`) and requires Node.js >= 24. Only
the package root is importable (the `exports` map does not expose deep
`dist/...` paths).

## What the package exports

| Export                         | What it is                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `fastifyWas`                   | The WAS protocol surface as a Fastify plugin                                        |
| `FastifyWasOptions`            | The plugin's options type (see below)                                               |
| `createApp`                    | The teaching server's own composition, as a factory                                 |
| `FileSystemBackend`            | The reference persistence backend (JSON + blobs on disk)                            |
| `defaultBackend`               | Builds the `FileSystemBackend` the standalone server uses                           |
| `StorageBackend` (and friends) | The backend contract plus the rest of the domain types                              |
| `ProblemError` subclasses      | The typed protocol errors (`ResourceNotFoundError`, `PreconditionFailedError`, ...) |

Importing anything from the package also loads its Fastify module augmentation,
so `FastifyInstance.serverUrl` / `.storage` and `FastifyRequest.zcap` are typed
on the decorated instance for free.

## A minimal server

```ts
import path from 'node:path'
import Fastify from 'fastify'
import { fastifyWas, FileSystemBackend } from 'was-teaching-server'

const serverUrl = process.env.SERVER_URL ?? 'http://localhost:3002'

const fastify = Fastify({ logger: true })

fastify.register(fastifyWas, {
  serverUrl,
  backend: new FileSystemBackend({
    dataDir: path.join(import.meta.dirname, 'data')
  })
})

// The plugin leaves the server root to the composition (the teaching server
// serves its welcome page there); the conformance suite expects a 200 at `/`.
fastify.get('/', async () => {
  return { name: 'minimal-was-server' }
})

// The port must be the one in `serverUrl` -- see the warning below.
await fastify.listen({ port: 3002, host: '0.0.0.0' })
```

That is a complete WAS + WebKMS server: `POST /spaces/`, the Space / Collection
/ Resource routes, access-control policies, quotas, export/import, and the
`/kms` keystore facet all work, and the full conformance suite passes against it
(verified against exactly this composition).

Two things to get right:

- **`serverUrl` must exactly match the URL clients reach the server at.** ZCap
  capability `invocationTarget` URLs include the full host and port, and
  verification compares them as exact strings -- `localhost` vs `127.0.0.1`, or
  a mismatched port, makes every delegated invocation fail (as a masked `404`).
  This is a property of URL-based capabilities, not a bug.
- **Inject a backend rather than relying on the default.** When no `backend` is
  given, the plugin falls back to `defaultBackend()`, which roots its `data/`
  directory relative to the _installed package_ (i.e. inside `node_modules`) --
  fine for the standalone checkout, almost never what a consumer wants.
  Construct a `FileSystemBackend` with an explicit `dataDir` (plus
  `capacityBytes` / `maxUploadBytes` caps), or supply your own `StorageBackend`
  implementation.

## Plugin options (`FastifyWasOptions`)

| Option                    | Meaning                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `serverUrl`               | Base URL used to build and match zcap `invocationTarget`s (exact-match, see above)                              |
| `backend`                 | The `StorageBackend` to use; defaults to `defaultBackend()` (see the caveat above)                              |
| `storageLimitPerSpace`    | Per-Space byte quota, applied only to the default backend (an injected backend carries its own `capacityBytes`) |
| `maxUploadBytes`          | Per-upload byte cap, likewise only for the default backend; also bounds the multipart buffer                    |
| `providers`               | Provider-adapter registry for external (BYOS) Collection backends; defaults to empty                            |
| `enabledBackendProviders` | Allowlist of registrable backend `provider` names; `undefined` = permissive                                     |

## What the plugin does (and does not) register

`fastifyWas` is wrapped with `fastify-plugin`, so what it installs lands on the
**root** Fastify instance:

- decorations: `serverUrl`, `storage` (the active backend, with its logger wired
  to `fastify.log`), `backendProviders`, `enabledBackendProviders`;
- `@fastify/cors` (`origin: '*'`, all methods -- WAS auth is signature-based,
  not cookie-based, so wide-open CORS is the protocol-appropriate setting; do
  **not** register `@fastify/cors` again yourself);
- `@fastify/multipart` (its `fileSize` limit follows the backend's
  `maxUploadBytes`);
- content-type parsers: `application/*+json` parsed as JSON, and a catch-all
  pass-through so arbitrary binary media types stream to storage;
- the route groups themselves, each in its own encapsulated context, so their
  auth/digest hooks and error handler do not apply to routes you add outside the
  plugin.

It deliberately does **not** register the teaching server's extras: the
static-assets route, the Handlebars welcome page, the `/health` probe, and the
`/api/cors` proxy are added by `createApp()`, not by the plugin. A downstream
composition brings its own equivalents (or uses `createApp` -- see next
section).

## The full teaching-server composition

If you want the standalone server's exact behavior (welcome page, `/health`,
CORS proxy included) inside your own process, use `createApp` -- it takes the
same options and passes them through to the plugin:

```ts
import { createApp } from 'was-teaching-server'

const fastify = createApp({ serverUrl: process.env.SERVER_URL })
await fastify.listen({ port: 3002, host: '0.0.0.0' })
```

## Composing a hardened server

The intended production pattern is: register your policy and ops plugins first,
then `fastifyWas` with your persistence choice injected. Nothing protocol-shaped
lives downstream; anything that changes wire behavior belongs upstream in this
package.

```ts
import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { fastifyWas } from 'was-teaching-server'
import { PostgresBackend } from './backends/postgres.js'

const fastify = Fastify({ logger: true })

fastify.register(helmet)
fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' })
// ... metrics, an onboarding/registration gate, an admin route group ...

fastify.register(fastifyWas, {
  serverUrl: process.env.SERVER_URL,
  backend: new PostgresBackend({ connectionString: process.env.DATABASE_URL })
})

fastify.get('/health', async (request, reply) => {
  return reply.send({ status: 'pass' })
})

await fastify.listen({ port: 3002, host: '0.0.0.0' })
```

## Implementing a custom backend

A custom persistence layer implements the `StorageBackend` interface (the
package's second contract, alongside the wire protocol). The contract and its
invariants are documented on the interface itself; the load-bearing ones:

- getters resolve falsy for not-found (they do not throw);
- writes are upserts; deletes are idempotent;
- throw the package's typed errors (`PreconditionFailedError`,
  `PayloadTooLargeError`, ...) so the request layer's error handler maps them to
  the spec's problem-details responses;
- expose a `logger` property typed as Fastify's `FastifyBaseLogger`, defaulting
  to a silent logger -- the plugin overwrites it with `fastify.log` at
  registration, so backend diagnostics flow to the server log.

```ts
import type { StorageBackend } from 'was-teaching-server'

export class PostgresBackend implements StorageBackend {
  // ...
}
```

## Verifying your composition

The conformance suite in this repository runs against any WAS server by URL and
is the definition of "speaks WAS." Point it at your composed server:

```bash
TEST_SERVER_URL=http://localhost:3002 pnpm conformance
```

`TEST_SERVER_URL` must be exactly the `serverUrl` the server was started with
(the same exact-match rule as above). If your server gates `POST /spaces/`
behind an onboarding token, pass `TEST_ONBOARDING_TOKEN`.
