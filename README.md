# XFeeder 2.2.0

A lightweight RSS/Atom/JSON feed reader that delivers entries to Discord webhooks and Telegram, with a dashboard for editing `config.json` and `.env`.

## Features

- `--dry-run` and `--once` for controlled local runs.
- `--check-config` to validate channel settings before deployment.
- `--debug-expert` to show detailed, secret-redacted processing diagnostics.
- The Settings section can enable Expert Debug through `Settings.DebugExpert`; the worker applies it when it reloads the saved config.
- `Settings.Logs` saves worker terminal output, and Expert Debug also enables this capture. Logs are appended to `debug/terminal.txt`; dashboard terminal output is captured there too.
- The worker reloads `config.json` and `.env` during its polling cycles.
- The dashboard uses password authentication when bound to a non-loopback host.
- Delivery is cached per destination, so a failed Telegram request does not resend an entry to a Discord webhook that already accepted it.
- Telegram messages support HTML formatting, chat IDs or public channel names, and optional forum topic IDs.

## Quick start

Requires **Node.js 20.18.1 or newer**. This matches the minimum of the locked
Cheerio/Undici dependencies; the earlier `>=18` declaration was inaccurate.
The release is tested on Node 20.18.1 and Node 26.10.0. Install dependencies with
`npm ci` before running the commands below. Python/Chromium are optional and only
needed for Scrapling; see its [setup guide](src/extensions/Scrapling/readme.md).

1. Copy `config.json.example` to `config.json` and `.env.example` to `.env`.
2. Create a Telegram bot with [@BotFather](https://t.me/BotFather), add it to the destination chat, and grant it permission to post. For a channel, make the bot an administrator.
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. A chat ID can be a numeric ID such as `-1001234567890` or a public channel name such as `@my_channel`.
4. Configure feeds and delivery destinations in `config.json`.
5. Validate the configuration and perform a run without posting:

```bash
npm run check-config
npm run start:dry-run
```

6. Start the worker and dashboard:

```bash
npm start
npm run dashboard
```

The dashboard listens on `127.0.0.1:3000` by default.

## Telegram configuration

The root `Telegram` object provides defaults for all channels. Channel-level `Telegram` fields override those defaults:

```json
{
  "Telegram": {
    "Enabled": true,
    "BotToken": "${TELEGRAM_BOT_TOKEN}",
    "ChatID": "${TELEGRAM_CHAT_ID}",
    "MessageThreadID": null,
    "DisableWebPagePreview": false,
    "TimeoutMs": 15000
  }
}
```

Set `MessageThreadID` to a forum topic ID to post into a specific topic. `DisableWebPagePreview` controls link previews. Each channel may override the chat, token, topic, preview behavior, timeout, or enabled state.

## Dashboard on a VPS

When the dashboard is reachable outside localhost:

1. Set `XFEEDER_DASHBOARD_PASSWORD` in the service environment.
2. Keep the dashboard behind a TLS reverse proxy.
3. Avoid exposing the dashboard port directly to the internet.

The dashboard health check is `GET /api/health`.

## Worker modes

```bash
node main.js
node main.js --once
node main.js --dry-run --once
node main.js --check-config
node main.js --dry-run --once --debug-expert
node main.js --config ./config.json --cache ./cache.json
```

## npm scripts

- `npm start` — run the worker
- `npm run start:once` — run one pass and exit
- `npm run start:dry-run` — fetch and process feeds without sending messages or saving cache changes
- `npm run start:expert-dry-run` — the same safe run with detailed diagnostic logs
- `npm run check-config` — validate configuration
- `npm run dashboard` — start the dashboard

Expert diagnostics report request status and timing, retry decisions, parser results, Scrapling fallback details, item counts, and simulated deliveries. They do not print feed response bodies, and mask common token, password, cookie, and webhook URL secrets.

## Operations dashboard

The dashboard is still a static, build-free UI: `npm run dashboard`. The sidebar
opens Overview, Channels, Activity, Settings and Advanced. Channels can be searched
by name or source URL and filtered by group, status and destination. Selecting a
channel opens its General, Sources, Delivery and Advanced settings. Array groups
keep their existing format; object groups support channel names. Merely opening
an editor does not rewrite shorthand channels, feed aliases or unknown fields.

Configuration changes stay in memory until **Save changes**. Environment changes
have a separate **Save .env** action in Advanced. Refresh, deletion and closing a
new-channel draft require confirmation when appropriate. Unapplied JSON drafts
remain available when navigating between views and prevent an ambiguous save.
The worker continues to reload the saved files on its next cycle.

**Test configuration** checks the current channel settings without fetching or
sending. Use `npm run start:dry-run` to exercise fetching and parsing on the host
without delivering messages or persisting cache changes.

### Activity and health

Enable **Settings → Expert diagnostics** to record structured worker events.
`GET /api/activity?limit=100` is protected by the dashboard's existing authentication.
It reads at most the final 2 MiB of `debug/terminal.txt` and analyzes at most 1,000
records; malformed or partial lines are ignored. Events expose a small allowlist
of sanitized metadata, with credentials, URL query strings, response bodies and
unstructured error messages excluded.

Deliveries and errors in the last 24 hours are **observations in this available
log window**, not guaranteed full-day totals. Activity displays its coverage and
refreshes every 30 seconds. No structured worker activity, failed telemetry reads,
or worker activity older than three minutes gives an Unknown live health status.
Configuration issues and observed failures are surfaced separately. Dry runs do
not count as deliveries or establish live worker health.

### HTTPS reverse proxy

Set the exact browser-facing origin in the dashboard **service environment**:

```bash
XFEEDER_DASHBOARD_PASSWORD='your-dashboard-password' \
XFEEDER_DASHBOARD_PUBLIC_ORIGIN='https://feeds.example.com' \
npm run dashboard
```

The origin must include the scheme and optional port, with no path or trailing
slash. Mutation requests must match this origin; arbitrary `X-Forwarded-Proto`
headers are not trusted. An HTTPS public origin adds `Secure` to session and
logout cookies, alongside `HttpOnly` and `SameSite=Strict`. Keep the backend bound
to loopback behind the TLS proxy. Changing these service variables requires
restarting the dashboard; editing the worker `.env` does not change dashboard auth.

### Tests

```bash
npm test
```

The Node test suite covers activity parsing, bounded reads, secret redaction,
config compatibility, Telegram inheritance, validation, auth, origin checks and
cookies. API writes use temporary fixture files, never the project's config.

The same command runs network regression and control tests: shared bandwidth,
HTTP/HTTPS streaming, proxying, retries, cancellation, channel scheduling, shutdown,
feed parsers, delivery and mocked Scrapling runtimes. It makes no Internet requests.
See the [original network baseline](docs/network-baseline.md) and the
[current configuration and test coverage](docs/network-control.md).

An optional browser suite checks desktop (1440 px), mobile (390 / 360 px), channel
workflows, save/refresh protection, independent environment saving and login.
Use an external Playwright installation and a local Chromium binary:

```bash
PLAYWRIGHT_MODULE=/path/to/playwright-core \
XFEEDER_BROWSER_PATH=/path/to/chromium \
npm run test:dashboard-browser
```

This suite also uses temporary fixtures. Screenshots go to the temporary
`xfeeder-screenshots` directory, or `XFEEDER_SCREENSHOT_DIR` when specified.
Neither Playwright nor a frontend build tool is a runtime dependency.

### Network Usage Control

Existing configurations default to unlimited download bandwidth and unchanged
concurrency. Add a root `network` object to select `potato` (10 Kbps), `low`
(2 Mbps), `medium` (10 Mbps), `high` (50 Mbps), `very-high` (100 Mbps),
`unlimited`, or `custom`:

```json
{
  "network": {
    "bandwidthProfile": "medium",
    "networkFriendlyMode": true
  }
}
```

The download budget is shared across managed HTTP requests in one process.
Friendly Mode defaults to two HTTP requests and one Scrapling job at a time.
Bandwidth waits do not count as server inactivity. Shutdown stops admission,
allows active transfers a bounded grace period, then cancels remaining work and
saves state. Configuration changes apply at runtime without rewriting user files.

**Settings → Network** offers presets, separate Custom download/upload values,
Friendly Mode and live worker status. Saves use configuration revisions to prevent
overwriting newer edits; the worker applies updates without a restart.

Custom upload paces supported JSON/Buffer bodies before sending, using a separate
global budget. Streaming, multipart and redirect replay uploads are not paced.
Python/Chromium traffic uses the Scrapling concurrency/resource policy and its byte
counts are unavailable. See [configuration and accounting](docs/network-control.md),
[troubleshooting](docs/network-troubleshooting.md), the [local benchmark](docs/network-benchmark.md),
and the [Adaptive Mode research decision](docs/network-adaptive-decision.md).

```bash
npm run benchmark:network
npm run benchmark:network -- --steady # longer buffered-transfer warmup/sample
PLAYWRIGHT_MODULE=/path/to/playwright-core \
XFEEDER_BROWSER_PATH=/path/to/chromium npm run test:network-browser
```

### Scrapling Resource Saving

Browser fetches default to native Scrapling resource saving. Set
`network.scraplingResourceSaving` to `false` globally, or add
`scraplingResourceSaving: false` to the exact URL in `Scrapling.PerUrlConfig`
for a page that needs stylesheets, media or WebSockets. Explicit native resource
options retain precedence; ad/domain blockers are not enabled automatically.

`network.networkFriendlyMode: true` allows one Scrapling job at a time.
`network.maxConcurrentScraplingRequests` is an optional positive integer override.
These settings do not impose a bandwidth limit on Python/Chromium traffic.
See [configuration, cancellation, compatibility and browser tests](docs/scrapling-resource-saving.md).

## Upgrading to 2.2.0

Keep your existing `config.json`, `.env` and cache when replacing application files.
An absent `network` section retains Unlimited with Friendly Mode off. Delivery destinations are Discord and Telegram. Unknown configuration sections
are preserved for review but reported as unsupported rather than executed. No 3.0 architecture changes are included.

Recognized challenge/error HTML is rejected before entry creation, even when
Scrapling is disabled. Browser fallback only runs when the configured policy allows
it; an unresolved challenge does not replay old entries or change delivery snapshots.
Ordinary feed entries discussing browser checks are not blocked by this document guard.

The archive contains source, fixtures, lockfiles and examples, not dependencies,
credentials, runtime state or browser binaries. See [release notes](RELEASE_NOTES_2.2.0.md)
and [validation/hygiene](docs/release-2.2.0-validation.md).
