# Architecture (Rust, 3.0)

One binary, two modes: the **worker** (default) and the **dashboard**
(`xfeeder dashboard`). They never share memory; the dashboard edits files and
reads the worker's telemetry snapshots.

```
config.json + .env ──► config ──► app (scheduler) ──► feed pipeline ──► deliver
                                     │                  │  http / scrapling │  discord / telegram
                                     ▼                  ▼                   ▼
                                  telemetry          state (cache.feeds.json, cache.json)
                                     │
                                     ▼
              config.json.{network,activity}-runtime.json ◄── dashboard (axum)
```

## Modules (`src/`)

| Module | Responsibility |
|---|---|
| `main.rs` | CLI, Tokio runtime, signal handling, worker/dashboard entry points. |
| `config.rs` | `.env` parsing, `${VAR}` resolution, 2.x and schema-v2 configs, channel collection and validation, network settings, cache-key fingerprints (current and 2.x legacy). |
| `app.rs` | Channel runner (pending detection, per-destination buckets, burst limit, 500 ms send pacing, persist after every confirmed send) and the round-robin scheduler (30 s tick, per-channel interval, failure backoff, optional concurrency, graceful shutdown). |
| `feed.rs` | Feed pipeline: conditional download, fallbacks, parser chain, saved-snapshot replay on failure, per-feed circuit breaker. |
| `http.rs` | Shared `reqwest` client(s), GET retries with `Retry-After`, bandwidth shaping and concurrency permits, optional public-only outbound policy, byte/rate accounting. |
| `parsers.rs`, `xmltree.rs` | Feed parsers (YouTube, Atom, XML/RSS, JSON, API, regex RSS, HTML fallback) and an xml2js-compatible XML tree; blocked/challenge page detection. |
| `scrapling.rs` | Optional Python worker (`scrapling/browser_worker.py`, embedded) speaking line-delimited JSON; anti-bot signal analysis and mode selection. |
| `deliver.rs` | Discord Components V2 webhook payloads, 429 handling; Telegram HTML messages; Discord-channel source reader. |
| `state.rs` | JSON stores with atomic writes, corrupt-file quarantine and an "unsafe" latch; feed state (validators, snapshots, health). |
| `telemetry.rs` | Bounded, pseudonymised activity events and metrics, published every 2 s for the dashboard. |
| `dashboard.rs` | HTTP API + embedded UI (`dashboard/public`), password sessions, Host/Origin checks, `If-Match` revisions, worker control. |
| `text.rs`, `js.rs`, `diag.rs` | HTML/entity/date helpers and link normalisation, JavaScript-compatible value semantics, redacting logger. |

## Delivery identity and cache

`cache.json` layout (unchanged from 2.x):

```
{ "<channelCacheKey>": { "<feedUrl>::webhook": ["<id>", …], "<feedUrl>::telegram": [...] } }
```

- Entry id = normalised `link` (tracking parameters and fragment removed),
  else `guid`, else `hash:` + 20 hex chars of SHA-1 over title/date/author/snippet.
- Lists are newest-first and capped at 2000 per bucket.
- A legacy single bucket (`"<feedUrl>": [...]`) is migrated per destination on
  first use.
- Channel cache key = `<group>:<12 hex SHA-1>` of the channel definition. 2.x
  hashed a slightly different field set; the worker computes both and uses the
  2.x key when only that one exists in the cache.
- When a destination is permanently unreachable (deleted thread/webhook,
  revoked token, unknown chat) the rest of that channel run skips it; the next
  interval tries again with a single request.
- Only ids of **confirmed** sends are written, and the file is saved after
  each one, so a crash never loses delivery history or causes duplicates.

## Scheduling

- One channel is considered every 30 s, round robin.
- A channel runs when its `TimeChecker` interval has elapsed.
- After a run with errors the next run is delayed by `interval × 2^(n-1)`,
  capped at 8 intervals or 1 hour.
- `MaxConcurrentChannels > 1` runs different channels in parallel.
- On SIGTERM/SIGINT no new channel starts; running ones get
  `network.shutdownGraceMs` to finish, then are cancelled. A second signal
  cancels immediately.
- State is flushed before exit.

## Differences from the Node.js implementation

- Workshop plugins and the Docker image are not ported.
- The HTTP client retries `406`/`415` responses once with `Accept: */*`;
  some sites (e.g. gry-wideo.pl) reject the feed-specific Accept header.
- Healthy XML/JSON responses are not scanned for anti-bot body signatures,
  which avoids false positives on articles that mention "captcha" etc.
- The Scrapling `get` mode is handled by the persistent Python worker instead
  of spawning the Scrapling CLI.
