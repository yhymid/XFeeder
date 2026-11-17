# XFeeder

RSS / Atom / JSON Feed / YouTube / Discord-channel monitor that delivers new
entries to **Discord webhooks** (Components V2) and **Telegram**, with an
optional local web dashboard.

> **3.0 is a Rust rewrite.** Earlier releases (2.x and the 3.0 JavaScript
> alpha) ran on Node.js. This branch is a single Rust binary that keeps the
> same `config.json`, `.env`, `cache.json` and dashboard UI, so an existing
> installation can be switched over in place (see
> [Migrating from Node.js](#migrating-from-nodejs)).

## Features

- Feed formats: RSS 2.0, Atom, YouTube Atom, JSON Feed / JSON APIs, HTML
  fallback; conditional requests (`ETag` / `Last-Modified`).
- Destinations: Discord webhooks (optionally into a forum post/thread via
  `Thread`) and Telegram bots. Delivery history is tracked **per destination**,
  so a failed Telegram send never causes a duplicate Discord post.
- Discord channel as a *source* (read with a user token, relayed to a webhook
  or Telegram).
- Per-channel interval (`TimeChecker`, minutes) and burst limit (`RequestSend`).
- Per-channel failure backoff, per-feed circuit breaker, `Retry-After` support,
  Discord 429 handling; POSTs are never blindly retried.
- Crash-safe state: atomic writes (`fsync` + rename); corrupt files are
  quarantined instead of overwritten; the worker refuses to deliver when state
  cannot be saved.
- Optional [Scrapling](scrapling/README.md) browser fallback for sites that
  block plain HTTP clients, and an optional FlareSolverr-compatible `Solver`
  (FlareSolverr, Byparr, TRAWL).
- A web page URL works too: the feed it advertises with
  `<link rel="alternate" type="application/rss+xml">` (or Atom/JSON Feed) is
  used.
- Dashboard (`xfeeder dashboard`): config/secrets editor, channels, network
  limits, live activity and metrics, start/stop of a dashboard-managed worker.

## Build

Requires Rust **1.88+** (edition 2024).

```sh
cargo build --release
# binary: target/release/xfeeder
```

The dashboard UI (`dashboard/public`) and the Scrapling worker script are
embedded into the binary; nothing else has to be copied next to it.

## Quick start

```sh
cp config.json.example config.json
cp .env.example .env          # webhook URLs / tokens go here
./xfeeder --check-config      # validate and print a summary
./xfeeder --dry-run --once    # fetch everything, post nothing, save nothing
./xfeeder                     # run the scheduler
```

Run it from the directory that holds `config.json`, or pass `--config` /
`--cache`.

### Command line

```
xfeeder [run] [--dry-run] [--once] [--check-config] [--debug-expert]
              [--config PATH] [--cache PATH]
xfeeder dashboard [--data-dir DIR]
xfeeder --version | --help
```

| Option | Meaning |
|---|---|
| `--dry-run` | Fetch and log what would be sent; no posts, no cache writes. |
| `--once` | One pass over every channel, then exit (**posts for real** unless combined with `--dry-run`). |
| `--check-config` | Load and validate the config, print a summary, exit. |
| `--debug-expert` | Detailed diagnostics (secrets are redacted). |

`XFEEDER_DRY_RUN=1`, `XFEEDER_RUN_ONCE=1` and `XFEEDER_DEBUG_EXPERT=1` work too,
from the environment or from `.env`.

## Configuration

`config.json` keeps the 2.x format. Values such as `"${DISCORD_WEBHOOK_MAIN}"`
are resolved from the process environment or from `.env` next to the config.

```json
{
  "Settings": { "Logs": true, "MaxConcurrentChannels": 1 },
  "channels": {
    "Webhook": "${DISCORD_WEBHOOK_MAIN}",
    "Thread": "123456789012345678",
    "RSS": ["https://example.com/feed.xml"],
    "TimeChecker": 30,
    "RequestSend": 5
  }
}
```

- Channel groups are top-level keys starting with `channels` (`channels`,
  `channels2`, …); each holds one channel object or an array of them.
- A `Telegram` object inside a channel (`Enabled`, `BotToken`, `ChatID`,
  optional `MessageThreadID`) adds a second destination; a top-level `Telegram`
  section supplies defaults. Entries with an image are sent as a photo with the
  text as caption when it fits Telegram's 1024-character limit; if Telegram
  cannot load the image, the text is sent alone. `"SendPhoto": false` turns
  this off.
- `Solver` (top level, optional) points to a service with the FlareSolverr
  `/v1` API:

  ```json
  "Solver": {
    "Url": "http://127.0.0.1:8191",
    "Feeds": ["https://example.com/feed"],
    "Auto": false,
    "OnStatus": [403, 503],
    "MaxTimeoutMs": 60000
  }
  ```

  URLs in `Feeds` are always fetched through it; with `"Auto": true` any feed
  is retried through it after a status from `OnStatus` or a challenge page.
  The page returned by the solver is used directly (browser XML/JSON viewer
  markup is removed). It is disabled by `network.outboundPolicy:
  "public-only"` and shares the browser cooldown of the circuit breaker.
  Check that the sites you use it for allow automated access.
- `FirstRunSend` (channel, `ChannelDefaults` or `Settings`; default 0): when
  a feed is checked for the first time for a destination, its existing
  entries are only recorded as seen and just the newest `FirstRunSend` are
  posted. This also applies after editing a channel's `Webhook`, `Thread` or
  feed list, because that changes the channel's cache key.
- `Filters` (channel or `ChannelDefaults`) limits what gets posted:

  ```json
  "Filters": {
    "Include": ["patch notes", "/\\bv\\d+\\.\\d+/"],
    "Exclude": ["sponsored"],
    "Fields": ["title", "contentSnippet", "categories"],
    "CaseSensitive": false,
    "MaxAgeHours": 72
  }
  ```

  Patterns are substrings, or regular expressions when written as `/…/`. An
  entry is posted when it matches any `Include` pattern (or `Include` is
  empty), no `Exclude` pattern, and is not older than `MaxAgeHours` (undated
  entries are kept). `Fields` may be `title`, `contentSnippet`, `content`,
  `categories`, `author`, `link`, `guid`.
- `Settings.MaxConcurrentChannels` (1–8, default 1) lets different channels run
  in parallel; one channel never overlaps itself.
- `network` (optional) sets the bandwidth profile, concurrency and timeouts; it
  can be edited from the dashboard.
- `schemaVersion: 2` configs are accepted as well.
- Unsupported sections (e.g. the old `Workshop` plugins) only produce a warning.

`config.json` and `.env` are re-read automatically; changes apply on the next
scheduler tick without a restart.

## Dashboard

```sh
XFEEDER_DASHBOARD_PASSWORD='…' ./xfeeder dashboard --data-dir /path/to/xfeeder
```

Listens on `127.0.0.1:3000` by default (`XFEEDER_DASHBOARD_HOST`,
`XFEEDER_DASHBOARD_PORT`; both may also be set in `.env`). Binding to a
non-loopback address, or setting `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` (the exact
`https://host` origin when behind a reverse proxy), requires a password. Host
and Origin headers are checked on every request.

The dashboard reads the worker's telemetry files
(`config.json.network-runtime.json`, `config.json.activity-runtime.json`,
refreshed every 2 s). It can only stop workers it started itself; a
systemd-managed worker is controlled with systemd.

## Running under systemd

Example units are in [`deploy/systemd`](deploy/systemd);
[`docs/deployment.md`](docs/deployment.md) describes building from source on a
server.

## Migrating from Node.js

Stop the Node worker, keep `config.json`, `.env` and `cache.json` where they
are, and start `xfeeder` in the same directory. Delivery history recorded by
2.x is reused: 2.x and 3.0 derive the per-channel cache key slightly
differently, and the binary uses whichever key already exists in `cache.json`,
so nothing is re-posted. `node_modules`, `package.json` and `main.js` are no
longer needed. Details: [`docs/migration-from-node.md`](docs/migration-from-node.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Migration from Node.js](docs/migration-from-node.md)
- [Scrapling fallback](scrapling/README.md)
- [Roadmap](docs/roadmap.md) — ideas taken from comparable projects
- [`docs/legacy/`](docs/legacy/README.md) — documents of the former JavaScript
  implementation (generated with GPT, kept for reference only).

## License

See [LICENSE](LICENSE).
