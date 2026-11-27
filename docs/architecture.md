# Architecture (Rust, 3.0)

**English** · [Polski](architecture.pl.md)

One binary, two modes: the **worker** (default) and the **dashboard**
(`xfeeder dashboard`). They never share memory; the dashboard edits
`config.json`/`.env`, reads the worker's telemetry snapshots, `sent.json` and the
journal, and leaves requests for the worker in `requests/`.

```
config.json + .env ──► config ──► app (scheduler) ──► feed pipeline ──► deliver
                                     │                  │  http / scrapling │  discord / telegram
                                     ▼                  ▼                   ▼
                                  telemetry          state (cache.feeds.json, cache.json)
                                     │
                                     ▼
              config.json.{network,activity}-runtime.json ◄── dashboard (axum)
                                                                   │
              app (every 30 s tick) ◄── requests/*.json ◄──────────┘  Check now, Forget
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
| `solver.rs` | Optional FlareSolverr-compatible `/v1` client; unwraps browser XML/JSON viewer markup. |
| `filter.rs` | Channel `Filters` (include/exclude, regex, fields, max age). |
| `scrapling.rs` | Optional Python worker (`scrapling/browser_worker.py`, embedded) speaking line-delimited JSON; anti-bot signal analysis and mode selection. |
| `deliver.rs` | Discord Components V2 webhook payloads, 429 handling; Telegram HTML messages; Discord-channel source reader. |
| `state.rs` | JSON stores with atomic writes, corrupt-file quarantine and an "unsafe" latch; feed state (validators, snapshots, health). |
| `diagnostics.rs` | Optional always-on recorder: JSON-lines event files and a periodic Markdown latency report (`Settings.Diagnostics`). |
| `telemetry.rs` | Bounded, pseudonymised activity events and metrics, published every 2 s for the dashboard. |
| `dashboard.rs` | JSON API, password sessions, Host/Origin checks, `If-Match` revisions, worker control. |
| `dashboard/ui.rs` | Server-rendered HTML pages and form posts (no JavaScript; CSP `default-src 'none'`), revision-checked saves, SVG charts, journal reader, read-only Discord webhook check. |
| `dashboard/i18n.rs` | English → Polish translation of finished HTML (exact strings and patterns), chosen by the `xf_lang` cookie. |
| `requests.rs` | Dashboard → worker requests: one JSON file per request in `requests/`, applied by the scheduler on each tick (`Check`, `Forget`). |
| `adaptive.rs` | Optional per-feed check interval from entry dates (`Settings.AdaptivePolling`), never longer than `TimeChecker`. |
| `clearance.rs` | Temporary, optional reuse of a Cloudflare clearance cookie from the browser (`Scrapling.ReuseClearance`). |
| `github_api.rs` | GitHub REST API list endpoints as feeds; token only for api.github.com. |
| `sent.rs` | `sent.json`: message ids and entries of webhook posts, for later edits. |
| `steam_merge.rs` | One post per game update: a Steam announcement and its SteamDB build edit each other's post (`Settings.SteamMerge`). |
| `mojang.rs` | Minecraft Java and Bedrock patch notes from the launcher's JSON files; each entry keeps its own id. |
| `steam_events.rs` | Steam store events JSON as a feed; patch notes told apart from news by event type. |
| `steam_pics.rs` | `steampics://APPID`: builds, branches and change numbers from anonymous SteamCMD (`Settings.SteamPics`). |
| `preview.rs`, `rerender.rs` | `xfeeder preview` (what a feed gives, timings, benchmarks) and `xfeeder rerender` (rebuild sent posts). |
| `profile_tests.rs` | Snapshot tests on saved production feeds (`profiles/`). |
| `build.rs` (crate root) | Embeds the short git commit (`XFEEDER_GIT_COMMIT`) shown on the dashboard. |
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
- First sight: when a destination has no history for a feed (no
  `<feed>::<target>` bucket, or an empty one, and no legacy bucket), the
  current entries are written to the bucket as already seen, except the newest
  `FirstRunSend` (by date, among entries the filter accepts). Every listed
  entry is recorded, also those the filter hides.
- Editing a list channel changes its cache key. `__xfeeder.channelKeys` in
  `cache.json` keeps the key each slot (`<group>#<position>`) used last; when
  the new key has no history, the old bucket is moved to it (copied when
  another configured channel still uses the old key).
- `Filters` decide only what is pending: history decisions see every listed
  entry. Entries hidden by a filter on a later check are not recorded, so
  relaxing a filter can let them through.
- When a destination is permanently unreachable (deleted thread/webhook,
  revoked token, unknown chat) the rest of that channel run skips it; the next
  interval tries again with a single request.
- Only ids of **confirmed** sends are written, and the file is saved after
  each one, so a crash never loses delivery history or causes duplicates.

## Scheduling

- Due channels (their `TimeChecker` interval has elapsed) are started one
  after another in round-robin order; the scheduler sleeps 30 s only when no
  channel is due. 2.x considered one channel per 30 s tick, so a due channel
  could wait up to N × 30 s.
- After a run with errors the next run is delayed by `interval × 2^(n-1)`,
  capped at 8 intervals or 1 hour.
- With `Settings.AdaptivePolling` a channel wakes up for its earliest due feed
  and fetches only the feeds that are due.
- On each tick the worker applies waiting dashboard requests: *Check now*
  makes a channel due at once, *Forget* removes one id from a bucket (deferred
  while that channel is running) and saves `cache.json`.
- `MaxConcurrentChannels > 1` runs different channels in parallel.
- On SIGTERM/SIGINT no new channel starts; running ones get
  `network.shutdownGraceMs` to finish, then are cancelled. A second signal
  cancels immediately.
- State is flushed before exit.

## Changes compared with 2.x

- Workshop plugins and the Docker image are not ported.
- The HTTP client retries `406`/`415` responses once with `Accept: */*`;
  some sites (e.g. gry-wideo.pl) reject the feed-specific Accept header.
- Healthy XML/JSON responses are not scanned for anti-bot body signatures,
  which avoids false positives on articles that mention "captcha" etc.
- Response bodies are decoded with `encoding_rs` (BOM, valid UTF-8, header
  charset, document declaration); 2.x mapped ISO-8859-2/windows-1250 bytes
  one-to-one, garbling Polish characters.
- The Scrapling `get` mode is handled by the persistent Python worker instead
  of spawning the Scrapling CLI.

## How "never posts twice" works

Every entry gets an identity, the first of these that exists:

1. a key the source gives it (Steam builds, Minecraft patch notes);
2. its link, cleaned of `utm_*` and other tracking parameters and of `#…`, so
   `https://site.com/post?utm_source=rss` and `https://site.com/post` are the same entry;
3. its guid;
4. a hash of title, date, author and text, for entries with neither.

The identities already sent are kept per channel and per destination (Discord, Telegram) in
`cache.json`, up to 2000 per feed (entries the feed still lists are never dropped), and the file is rewritten right after each successful
send (written to a temporary file and renamed, so a crash never leaves it half written).
Only one worker can use a `cache.json` at a time.

Examples:

- **A new feed** with 50 old entries: the first check marks them all as seen and posts none,
  or only the newest `FirstRunSend` of them. The channel is not flooded.
- **An edited post** (new title or text, same link): not posted again.
- **A feed that lists two entries under one link** (kernel.org, release notes pages): each
  keeps its own identity (`link#guid`) from then on, so neither is posted again when the
  other one disappears.
- **A restart or a crash**: history is on disk, so after the restart only really new
  entries are sent.

Limits:

- A site that changes the links of its old entries (a new address scheme, a new domain)
  makes them new entries, unless their guids stay the same (onet, 24.11: 21 entries).
- History belongs to the feed URL: changing a feed's address starts a new history, and only
  the first-check rule (`FirstRunSend`) keeps the old entries from being posted.
- If the worker is killed in the moment between Discord accepting a post and the history
  being saved, that one post can come again.

## How sites behind Cloudflare are fetched

1. Every feed is first fetched with a plain request (a fraction of a second).
2. Only when the site answers 403/429/503 or with a challenge page ("Just a moment…"),
   XFeeder opens a real browser through [Scrapling](../scrapling/README.md) (Chromium with
   Patchright), which passes Cloudflare's check like a visitor would, or asks
   FlareSolverr. Feeds that never block never start a browser.
3. With `Scrapling.ReuseClearance`, the cookie the browser got is reused for plain
   requests until it expires.

Example from production: boop.pl takes about 26 s per check through the browser and 8–11 ms
when the cookie is reused; gry-wideo.pl stopped blocking, and with `"fallback": true` went
from 10.5 s back to 0.3 s on its own.

Limits:

- Scrapling must be installed next to XFeeder (or the `scrapling` Docker image used): about
  1.6 GB with Chromium, and a few hundred MB of memory while a browser runs.
- It passes Cloudflare's automatic check. A page that wants a person to solve a CAPTCHA,
  a firewall rule against your server's IP (403 without `cf-mitigated`), or other services
  (DataDome, Akamai) may still block.
- It is meant for public feeds that a browser can open; it does not log in or get around
  paywalls. Mind the site's terms.
