# Deploying on Fly.io

This repo ships a production `Dockerfile`, an example Fly.io configuration, and
a deploy workflow for it. The image is generic. Every setting comes from the
environment at run time.

## Same origin or cross origin

Decide this first, because it sets `SERVER_URL`, which is permanent.
Space URLs, ZCap invocation targets, and the did:webvh DIDs this server hosts
all derive from it. Switching later strands every existing account.

### Cross origin

The server gets an origin of its own, such as `https://storage.example.com`, and
wallets call it through CORS. The server allows any origin
(`Access-Control-Allow-Origin: *`), so any number of wallets and apps can share
it on equal terms. Its welcome page at `/` stays reachable, and it deploys on
its own schedule.

The cost is preflights. A signed WAS request carries `Authorization`,
`Capability-Invocation` and `Digest` headers, and a browser sends a CORS
preflight before any request with those headers. The server marks its preflight
answers cacheable for a day. Browsers cache them per URL, though, and cap the
lifetime (Chrome at two hours). A wallet signup touches many distinct URLs, so
most of its requests still wait one extra round trip. The farther the browser is
from the server, the more that costs.

### Same origin

A wallet app proxies the server's routes from its own origin, and `SERVER_URL`
is the wallet's origin. The wallet's requests then need no preflight. The server
can also run with no public address, as the Fly.io example below does.
Freewallet's image works this way, with the route list in its
`deploy/nginx.conf.template`.

This setup has costs of its own:

- The routes must not collide. The server's routes all sit at the root
  (`/spaces`, `/space/*`, `/kms/*`, and so on), so the wallet's client-side
  routes must stay clear of them. The usual overlap is `/`. The wallet takes it,
  and the server's welcome page is not reachable.
- The server's identity is tied to the wallet's domain. Moving the wallet to a
  new domain means a new `SERVER_URL`, and so a new server identity.
- Only one wallet gets the benefit. Other wallets and apps still reach the
  server cross origin, at the wallet's domain.
- Stored content runs on the wallet's origin. The server serves a Resource with
  the content type it was written with. A Resource stored as `text/html` and
  opened in a browser is a page on the wallet's origin, and its scripts can read
  the wallet's local storage, key material included. Anyone who can write a
  Resource in any Collection can plant one. The server sets no headers against
  this, so the proxy has to add them on the server's routes, for example
  `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.

### Choosing

Same origin suits a server run for one wallet, where signup latency matters
most. Cross origin suits a server shared by several wallets or apps, or one
whose domain should outlive any one wallet. The Fly.io example below is same
origin. The proxy rules below apply either way, to whatever sits in front of the
server.

## Files

| File                           | Purpose                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `Dockerfile`                   | Two-stage build: compiles `dist/`, then installs production dependencies only.   |
| `.dockerignore`                | Keeps `data/`, `node_modules/`, `.git` and local files out of the build context. |
| `fly.toml`                     | Example Fly.io app with placeholder values. See "Example: Fly.io" below.         |
| `.github/workflows/deploy.yml` | Deploys to Fly.io when a GitHub release is published, or by hand.                |

## What a reverse proxy in front of the server must do

1. Pass the `Host` header through unchanged. HTTP Signatures cover `host`, and
   the server verifies the signature over the headers it receives. A proxy that
   rewrites `Host` to its upstream's name breaks every signed request.
2. Leave paths alone. The signature also covers `(request-target)`, and the
   server does not run under a sub-path (`SERVER_URL` refuses one). So no prefix
   stripping and no rewrites.
3. Set `SERVER_URL` to the origin the browser sees, not the server's internal
   name. ZCap invocation targets are built from it and matched against it.
4. Do not compress responses. When nginx gzips a response, it turns a strong
   `ETag` into a weak one, and conditional writes (`If-Match`) need the strong
   one.
5. Let the server enforce the upload size. It applies `MAX_UPLOAD_BYTES` itself,
   so the proxy should accept bodies at least that large.

## Configuration

The README's Environment Variables table lists every setting. `SERVER_URL` is
the one that is required. Keep secrets such as `WAS_ONBOARDING_TOKEN`,
`KMS_RECORD_KEK` and `DATABASE_URL` in the platform's secret store rather than
in the repo. Leaving `STORAGE_LIMIT_PER_SPACE` unset makes startup log a warning
until you set a quota or `unlimited`.

Changing `SERVER_URL` gives the server a new identity. Space URLs, ZCap
invocation targets, and the did:webvh DIDs this server hosts all derive from it.
Moving the server to another host does not carry existing accounts over.

The image runs `node dist/start.js` as root and logs JSON to stdout. Root is
there because platform volumes often mount owned by root. Where the data
directory can belong to an unprivileged user, add a `USER` line.

## Storage

### Filesystem backend

Data lives under `WAS_DATA_DIR`, which must be a persistent volume. A platform
that wipes a container's disk on restart loses the data, so use Postgres there.
The filesystem backend serializes writes inside one process, so run exactly one
server process. A deploy then stops it and starts the new one, which means a
short outage.

### Postgres backend

Setting `DATABASE_URL` selects the Postgres backend. The server applies its
schema migrations at startup. Put the database in the same region as the server.
A signup makes many sequential requests, each with several queries, so a distant
database adds up the same way the preflights did.

Postgres makes the server stateless on disk. Conditional writes and quota
accounting use row locks, advisory locks, and transactions, and the server's
caches have short TTLs so several processes can share one database. That allows
a deploy that starts the new process and waits for its health check before
stopping the old one.

One piece of state is still held in process memory. The ephemeral exchanges
under `/workflows/ephemeral/exchanges` live in an in-process cache
(`src/exchanges.ts`). With two processes behind a load balancer, a request can
reach one that never saw the exchange. Keep one process until the exchanges move
to storage.

`MAX_UPLOAD_BYTES=unlimited` is refused by the Postgres backend at startup.

## Checking a deployment

`/health` reports the version and build time from `dist/build-info.json`. The
image is built without `.git`, so the commit reads `null`.

## Running the image locally

```sh
docker build -t was-teaching-server .
docker run --rm -p 3002:3002 \
  -e SERVER_URL=http://localhost:3002 \
  -e WAS_DATA_DIR=/data -v was-data:/data \
  was-teaching-server
```

## Example: Fly.io

`fly.toml` and the deploy workflow run the server as a private Fly app behind a
wallet app on the same origin. The wallet app proxies the server's routes over
Flycast, a private address inside the Fly organization's network, so the server
app has no public IP. Each repo deploys its own app.

The values in `fly.toml` are placeholders: the app name `was-teaching-server`
and `SERVER_URL=https://wallet.example.com`. The workflow replaces them at
deploy time.

### First-time setup

Deploy the server app before the wallet app. nginx resolves the server's Flycast
name once at startup and fails to start if it does not resolve. With your own
app name and the wallet's domain:

```sh
fly apps create <app>
fly volumes create was_data --app <app> --region iad --size 1
fly secrets set --app <app> WAS_ONBOARDING_TOKEN=...   # optional
fly deploy --app <app> --env SERVER_URL=https://<domain> --no-public-ips
fly ips allocate-v6 --private --app <app>
```

Create the volume in the region `primary_region` names in `fly.toml`. A volume
cannot move regions later. `fly ips list --app <app>` should show only the
private (Flycast) address. Release any public address with `fly ips release`.
The wallet app then reaches the server at `<app>.flycast:80`.

A Fly volume belongs to one machine, which matches the filesystem backend's
one-process rule. Fly snapshots volumes daily. List the snapshots with
`fly volumes snapshots list <volume-id>`.

To switch to Postgres, create a cluster in the same region (Fly Managed Postgres
works) and run `fly secrets set --app <app> DATABASE_URL=postgres://...`. Then
remove the `[mounts]` section and `WAS_DATA_DIR` from `fly.toml` and deploy.
`[deploy] strategy = "bluegreen"` then gives deploys with no outage.

### Deploying from CI

`.github/workflows/deploy.yml` deploys when a GitHub release is published, and
from the Actions tab (`workflow_dispatch`). To set it up:

1. Create a deploy token scoped to the one app:
   `fly tokens create deploy --app <app>`.
2. In the GitHub repo settings, create an environment named `production`. Store
   the token there as the `FLY_API_TOKEN` secret.
3. On the same environment, add two variables: `FLY_APP` (the app name) and
   `SERVER_URL` (the public origin, such as `https://wallet.example.com`). The
   workflow fails before deploying if either is missing.
4. Limit the environment's deployment branches and tags to `main` and `v*`. A
   release event runs on its tag, so a `main`-only rule would block it.

The workflow never runs on pull requests, so a pull request from a fork cannot
read the token or the variables.

A deploy from a workstation needs the same two values, passed as in the
first-time setup above. A plain `fly deploy` would deploy the placeholders.
