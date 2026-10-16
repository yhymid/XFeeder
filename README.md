# XFeeder

**XFeeder 3.0.0-alpha.0 — hardware testing build** — a modular RSS, Atom, JSON Feed, YouTube and Discord-source monitor that delivers new entries to Discord webhooks and Telegram.

> **Alpha status:** This is an early 3.0 preview intended for installation and real-world testing on your own machine, **not production**. The tagged prerelease archive is available from GitHub Releases only after the clean-package CI gate passes. Back up your current config and state first.

XFeeder provides source adapters, destination-specific delivery history, rate limiting, an optional Scrapling browser fallback and a local operations dashboard. It supports an existing legacy configuration and gradual migration to the newer schema.

## Downloadable alpha build

For Linux/Arch/CachyOS, download the **runtime .tar.gz** from the [3.0.0-alpha.0 prerelease](https://github.com/yhymid/XFeeder/releases/tag/v3.0.0-alpha.0) once it is published. Extract it outside your existing installation, then follow the [Public Alpha Testing Guide](docs/alpha-testing.md). An Alpha release is generated only after CI tests and a separate unpacked-runtime smoke test pass.

## Quick start

Install Node.js (CI tests run on 22, 24 and 26) and run from a clean checkout:

```sh
npm ci
cp config.json.example config.json
cp .env.example .env
npm run deps:check
npm run check-config
npm run start:dry-run
```

Edit the copied files before running live: use your real feed URL, a valid destination and locally stored credentials. `npm run start:dry-run` checks feeds without posting or saving delivery cache changes.

Start the worker in one terminal and the dashboard in another:

```sh
npm start
npm run dashboard
```

The dashboard listens on `http://127.0.0.1:3000` by default. A live one-off delivery can be invoked with `npm run start:once`; **this command does post messages**, unlike dry-run.

## Example channel

A minimal Discord-webhook channel in `config.json`:

```json
{
  "Settings": { "MaxConcurrentChannels": 1 },
  "channels": {
    "updates": {
      "Webhook": "${DISCORD_WEBHOOK_MAIN}",
      "Feeds": ["https://example.com/rss"],
      "TimeChecker": 30,
      "RequestSend": 5
    }
  }
}
```

In the local, untracked `.env` set `DISCORD_WEBHOOK_MAIN` to your actual webhook. Replace `example.com` with a real feed URL. `TimeChecker` is minutes; `RequestSend` limits the per-channel batch. Telegram can be configured globally or as a channel override; see [Configuration](docs/configuration.md).

Channels run sequentially by default. `Settings.MaxConcurrentChannels` accepts 1–8 to enable bounded overlap **for different channels**; start with 2 only if needed. Only one XFeeder worker may use a particular cache directory.

## Dashboard and health

The dashboard provides Overview, Channels, Activity, Settings and Advanced. Changes require explicit saving. The authenticated Activity API uses bounded structured worker events and the metrics API reports fixed-dimension counters, gauges and durations.

- `GET /api/live`: dashboard HTTP liveness.
- `GET /api/ready`: worker readiness; returns 503 when not ready.
- `GET /api/health`: legacy dashboard health endpoint, not proof of worker readiness.

For remote use, keep the dashboard backend private, set a strong `XFEEDER_DASHBOARD_PASSWORD`, and place it behind HTTPS with an exact `XFEEDER_DASHBOARD_PUBLIC_ORIGIN`. See [Security](SECURITY.md).

## Sources, networking and optional Scrapling

Regular RSS, Atom and JSON feeds work without a browser. Scrapling can be installed separately:

```sh
npm run scrapling:install
npm run scrapling:check
```

This creates a local pinned Python/Chromium environment; it is not included in the default Docker image. See the [Scrapling guide](src/extensions/Scrapling/readme.md).

Network Service manages download/upload pacing, request deadlines, proxy configuration, cancellation and feed retry/backoff. `network.outboundPolicy` defaults to `unrestricted` to preserve local sources. When handling untrusted URLs, an optional `public-only` mode restricts private destinations, redirects and Scrapling fallback. `network.maxResponseBytes` can cap managed HTTP responses. See the [outbound security contract](docs/outbound-security-contract.md).

## State, backup and migration

Successful delivery IDs live in `cache.json`; feed snapshots and HTTP validators live in `cache.feeds.json`. Delivery state is written atomically and awaited before attempting the next destination. Cache corruption is fail-closed; do not delete old cache files to silence an error.

Back up both files and configuration before upgrading. Never overwrite your deployed configuration with the starter example. Use `npm run config:migrate` with the [migration guide](docs/config-migration.md) and review the output.

## Deployment

The repository includes an example [Docker Compose and systemd deployment](docs/deployment-packaging.md), an ignored local data directory and release packaging scripts. The default container intentionally excludes the Python browser runtime; enable it only with a separately verified environment. External access to the dashboard should go through TLS/SSH tunneling, not an unrestricted port.

## Testing and troubleshooting

```sh
npm test
npm run check-config
npm run deps:check
npm run start:dry-run
npm run test:scrapling-browser
```

The last command requires an installed browser runtime. CI tests Node 22/24/26, configuration/migration, auth, network behavior, delivery/cache safety and Scrapling smoke. Passing CI does not by itself constitute a tested production release.

For setup issues see [Troubleshooting](docs/troubleshooting.md), for implementation details [Architecture](ARCHITECTURE.md), and for changes [Contributing](CONTRIBUTING.md). Sensitive vulnerability reports belong in the private process described in [Security](SECURITY.md).
