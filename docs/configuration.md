# Configuration guide

## Getting started

Copy `config.json.example` to `config.json` and `.env.example` to `.env`; substitute real values only in your local, untracked files. The example includes optional advanced settings and sample feeds that must be replaced.

A minimal one-channel configuration for a Discord webhook:

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

Put `DISCORD_WEBHOOK_MAIN=https://discord.com/api/webhooks/...` in your local `.env`; do not put credentials in public docs or commits. Feed URLs above are examples only.

`TimeChecker` is the channel polling interval in minutes; `RequestSend` limits how many entries are sent in a batch. `Settings.MaxConcurrentChannels` is 1 by default and accepts 1–8. Changing concurrency requires a worker restart.

Telegram settings use the root `Telegram` defaults and optional per-channel overrides, with `BotToken`, `ChatID` and `MessageThreadID` for forum topics. See the full `config.json.example` for options.

## Validation and safe testing

```sh
npm ci
npm run check-config
node main.js --dry-run --once
node main.js --once
```

Dry-run suppresses provider delivery and live cache persistence. The normal `--once` performs real delivery, so test only with an intended destination. Worker and dashboard are separate processes (`npm start` and `npm run dashboard`).

## Network and Scrapling

`network.outboundPolicy`: `unrestricted` (default) or `public-only`. The stricter mode blocks local/private endpoints, redirects, custom proxies and Scrapling fallback. `network.maxResponseBytes` sets an optional managed-HTTP byte cap; unset means legacy behavior. See `docs/outbound-security-contract.md` and `docs/network-control.md`.

Scrapling is optional and requires a pinned Python/browser environment: `npm run scrapling:install`, then `npm run scrapling:check`. Standard RSS/Atom/JSON feeds do not require Chromium.

## Migrating existing files

Back up the existing `config.json`, `.env`, `cache.json` and `cache.feeds.json` first. Use `npm run config:migrate` with the options in `docs/config-migration.md`; review changes before applying. Do not replace a deployed config with the example or run two workers against the same cache.

For dashboard/API configuration schema details, see `docs/config-schema-v2.md`, `docs/channel-config-compatibility.md` and `docs/dashboard-api-cleanup.md`.
