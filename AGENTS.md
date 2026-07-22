# Agent Guidelines

## Specification

This project is a reference implementation of the Wallet Attached Storage (WAS)
protocol and data model. The specification is a W3C CCG work item; its home is
<https://github.com/w3c-ccg/wallet-attached-storage-spec> (source:
[spec.md](https://github.com/w3c-ccg/wallet-attached-storage-spec/blob/main/spec.md);
rendered: <https://w3c-ccg.github.io/wallet-attached-storage-spec/>).

Spec-vs-implementation gap analyses: [server roadmap](./ROADMAP.md) (features
the spec defines that this server doesn't implement yet) and the
[client roadmap](https://github.com/interop-alliance/was-client/blob/main/ROADMAP.md)
(the same analysis for the companion `was-client` library, in its repo).

## Tech Stack

- TypeScript (strict, `target: ES2022`), compiled with `module`/
  `moduleResolution: NodeNext` — so import specifiers keep their `.js` extension
  even though the source files are `.ts` (e.g. `import './server.js'`)
- Node.js 24.x, with `pnpm` as package manager
- Fastify 5.x API framework
- Dev runs via `tsx` (`pnpm dev`, no build step); production builds with `tsc`
  to `dist/` (`pnpm build`, which also copies `src/views` → `dist/views`) and
  runs `node dist/start.js`
- Tooling: ESLint (flat config) + Prettier, Vitest for `test/`

## Architecture

The request-flow layer map, domain glossary (Space / Collection / Resource /
Controller), and ZCap authorization structure live in @ARCHITECTURE.md -- read
it before making changes.

**When adding an endpoint:** add the route in `routes.ts` and a handler method
on the matching `*Request` class. Always go through `request.server.storage` —
never import or instantiate a backend directly from a handler.

## Conventions

Code style, refactoring, JSDoc, comment, and error-handling conventions live in
@CONTRIBUTING.md -- follow them.

Repo-specific addition: throw the custom error classes defined in
`src/errors.ts` rather than generic `Error`.

## Roadmap & Task Conventions

All roadmap tracking lives in [ROADMAP.md](./ROADMAP.md): narrative context
(section preambles, gap analysis) plus structured work items. Never create a
parallel task list elsewhere (no `TODO.md`, no task lists in other docs).

Each work item follows this schema:

- A heading `### WAS-N: Title`, then a field block, then free prose context.
- Fields: `status` (`todo` / `in-progress` / `draft` / `done`), `priority`
  (`high` / `medium` / `low`), `labels` (comma-separated), optional `blocked-by`
  (other `WAS-N` ids), and an `acceptance:` checklist.
- `draft` marks items with no actionable done-state yet (spec-blocked or parking
  records); a draft states _why_ instead of acceptance criteria and must gain
  acceptance criteria when promoted to `todo`.

Rules:

- Item ids are permanent and never reused. A new item takes the next unused
  number, regardless of which section it lands in.
- Every non-draft item needs acceptance criteria before it may be moved to
  `in-progress`.
- Statuses are edited in place (change the `status:` field); acceptance
  checkboxes are ticked as they are met.
- Completed items are dropped from ROADMAP.md once shipped -- CHANGELOG.md is
  the permanent record of what landed (existing convention).
- Work discovered mid-implementation gets its own item immediately, noting
  `discovered-from: WAS-N` in its prose, plus a `blocked-by` link if it blocks
  anything.
- Reference item ids in commit messages and PR descriptions where relevant (e.g.
  `WAS-12: add SSE changes endpoint`).
- `blocked-by` links only express dependencies implied by the work itself; do
  not invent orderings.

## Test Suite

Two separate test directories serve different purposes:

- `test/` — integration tests that spin up a local Fastify server in-process;
  use these to test the implementation. Run with **Vitest** (`pnpm test-node`,
  i.e. `vitest run`); config in `vite.config.ts`.
- Protocol conformance tests live in their own package,
  `@interop/was-conformance-suite` (repo:
  `interop-alliance/was-conformance-suite`, local checkout at
  `~/code/Interop/was-conformance-suite`), installed here as a devDependency.
  Its `was-conformance` CLI runs against any WAS server by URL
  (`pnpm conformance <url>`; `TEST_SERVER_URL` / `TEST_ONBOARDING_TOKEN` env
  vars work as fallbacks). To run it against a freshly-spawned local server in
  one step, use `pnpm conformance:local` (see Conformance Test Usage below).

**Critical ZCap constraint**: ZCap capability `invocationTarget` URLs include
the full host and port. The server's `SERVER_URL` environment variable and the
URL the conformance CLI targets must be exactly identical strings — if they
differ (even just `localhost` vs `127.0.0.1`, or different ports), the
delegated-access tests will return 404. This is not a bug; it's how ZCap
URL-based capabilities work.

**Per-suite `dataDir`.** Each `test/` file injects its own storage backend into
`createApp({ backend })` — a `FileSystemBackend` over a private `mkdtemp` temp
dir — and removes it in `afterAll`. Suites therefore never share or leak the
gitignored `data/` directory, and parallel Vitest workers can't collide on the
filesystem. Each suite still self-provisions its Space/Collection in `beforeAll`
(its temp dir starts empty).

**Per-suite ephemeral port.** Suites boot their server with
`startTestServer({ backend })` from `test/helpers.ts`, never with a hardcoded
port: it listens on port `0` and returns the `serverUrl` the OS actually
assigned, so parallel Vitest workers can't collide on a port either. Because
ZCap `invocationTarget` URLs embed host and port, `serverUrl` is unknown until
`listen()` resolves — so build ZCap clients (and any URL derived from
`serverUrl`) _after_ the `startTestServer` call, not before. A suite that tears
its server down and boots a replacement over the same `dataDir` must pass the
returned `port` back in, so ids minted by the first server still resolve (see
`test/kms-record-encryption.test.ts`).

### Conformance Test Usage

```bash
# Local one-shot (recommended for local runs): spins up the server on a fixed
# local URL, waits for health, runs the was-conformance CLI against that same
# URL, and tears the server down — so the two URLs can't drift. Implemented by
# scripts/conformance-local.ts; override the port with PORT=...; arguments
# after -- are forwarded to the CLI.
pnpm conformance:local
pnpm conformance:local -- --grep chunk

# Against an already-running / external server. The server must be started with
# SERVER_URL matching the CLI's target URL exactly (ZCap invocationTarget URLs
# include host:port, so they must match).
pnpm conformance https://was.example.com

# With an onboarding token for servers that require one for POST /spaces/:
pnpm conformance https://was.example.com --token abc123

# TEST_SERVER_URL / TEST_ONBOARDING_TOKEN env vars still work as fallbacks.
```

Useful CLI options: `-s/--suite`, `-g/--grep`, `--include-optional` /
`--skip-optional`, `-r json`, `--timeout`, `--fail-fast`. Exit codes: `0`
conformant, `1` failures, `2` usage error / server unreachable.

## Logging

- Never use `console.*` in `src/` (the only exception is the bootstrap
  `console.error` in `start.ts`, before the Fastify logger exists). Log through
  Fastify's pino logger instead.
- In request-layer code (handlers, hooks, the error handler) use `request.log`.
- Backends and other non-request code take an injected logger typed as Fastify's
  `FastifyBaseLogger` (reuse that type — do not hand-roll a logger interface).
  `FileSystemBackend` exposes a `logger` property defaulting to a silent
  `pino({ level: 'silent' })`; `createApp()` wires `fastify.log` into the active
  backend, so anything reached via `request.server.storage` logs to the same
  place. New backends should follow the same pattern (`StorageBackend.logger`).
- Use pino's object-first call style, especially for errors:
  `logger.error({ err }, 'message')`, not `logger.error('message', err)`.
- Do not log inside error-class constructors. Let server-side faults surface to
  `handleError`, which logs 5xx (with the underlying `cause`) once via
  `request.log`; 4xx client errors are expected and not logged.
