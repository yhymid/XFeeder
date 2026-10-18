# XFeeder architecture (3.0 development)

XFeeder is a Node.js CommonJS modular monolith. Worker and dashboard are separate processes. The active development branch is `3.0-alpha` and its package version is `3.0.0-alpha.0`. `3.0-dev` is complete, `main` retains the stable 2.2 series, and beta/RC/stable 3.0 have not yet been released.

## Runtime flow

`main.js` parses CLI switches and calls `src/app/bootstrap.js`. The bootstrap loads config/env, initializes managed HTTP, StateStore, source/destination adapters, scheduling, telemetry and graceful shutdown.

1. `src/config-loader.js` resolves environment placeholders and validates runtime config. Legacy channel arrays/objects and the new config schema/migration tooling remain supported.
2. `src/app/runtime.js` runs the original sequential scheduler; `src/app/concurrent-scheduler.js` optionally overlaps distinct channels using `Settings.MaxConcurrentChannels` (1–8, default 1). `ChannelTasks` prevents overlapping work under the same key.
3. `src/core/source-adapters.js` registers existing YouTube, Atom, XML, JSON, API-X, RSS, fallback and Discord source parsers in priority order. `src/core/feed-pipeline.js` performs fetch, parser fallthrough and conditional 304 replay.
4. `src/network/http-client.js` uses the managed Axios adapter in `src/network/http-adapter.js`. Network Service owns deadlines, admission, proxy settings, bandwidth and cancellation. `src/network/retry-policy.js` preserves separate GET and Discord 429 retry rules. Optional `network.outboundPolicy=public-only` restricts outbound targets; the default is unrestricted for local-feed compatibility.
5. `src/core/normalized-entry.js` preserves legacy link-first identity and original payload. `src/core/destination-adapters.js` delegates to Discord webhook and Telegram sender implementations.
6. `src/core/state-store.js` separates delivery IDs (`cache.json`) from feed validators and snapshots (`cache.feeds.json`); transient runtime information stays in memory. Atomic queued async writes are awaited after destination success.
7. `src/core/event-bus.js` and `src/core/metrics-registry.js` produce bounded, sanitized events/metrics. `src/core/activity-runtime.js` and network-runtime telemetry publish private snapshots readable by the dashboard.
8. `src/dashboard/server.js` provides an authenticated UI/API, with health/liveness/readiness probes and secret-safe structured activity. The dashboard and worker must share the appropriate state/config directory.

## Safety invariants

- A confirmed destination is persisted before the next destination is attempted.
- An unsafe cache is fail-closed; never silently reset delivery state.
- GET retries do not imply automatic retries of ambiguously accepted POSTs.
- Parallel channels use one cache writer/process; running multiple worker processes on the same cache is unsupported.
- URLs, tokens, credentials and raw provider responses are not event/metrics dimensions.
- Dashboard behind public HTTPS needs `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` and a strong password.

## Further contracts

See `docs/scheduler-contract.md`, `docs/async-state-contract.md`, `docs/outbound-security-contract.md`, `docs/observability-events-metrics.md`, `docs/deployment-packaging.md` and `docs/config-migration.md`.

## Validation

`npm ci && npm test && npm run deps:check`, plus the CI Node 22/24/26 matrix and real Scrapling browser smoke. Unit tests mock external services; the complete release also requires a real deployment acceptance test.
