# Changelog

Releases are cut by hand when enough has changed. Each release on GitHub uses the matching
section below as its description.

## 3.0 Beta - Unreleased

XFeeder is written in Rust now: one binary (`xfeeder`, `xfeeder dashboard`), no Node.js,
npm or JavaScript anywhere. `config.json` (2.x and schema v2), `.env`, `cache.json` and the
feed state are read as before, so an existing installation switches over in place.

### Added
- `Scrapling.ReuseClearance` (temporary, off by default): after a browser passes a
  Cloudflare check, the site's cookies (`cf_clearance`) and the browser's User-Agent are
  kept in `clearance.json` (0600, git-ignored) and the next checks try plain HTTP with
  them first. Measured on boop.pl from the VPS: 0.04 s with the saved clearance against
  26 s through the browser; the cookie was still accepted after 10 minutes and is issued
  for 365 days. A rejected clearance is deleted and the browser path runs as before;
  `false` restores the previous behaviour exactly.
- Feed profiles `news`, `games` and `dev` (`profiles/`): real production feeds with saved
  samples. `cargo test` parses every sample and compares the result field by field with
  the saved expectations, so a fix for one site cannot silently change another;
  `xfeeder preview --profile NAME` checks the same feeds live.
- `xfeeder preview <URL>…`: shows what XFeeder reads from a feed (title, author, date,
  image, link, text, hints such as "image: 3/10 entries") and how long download, parsing
  and the image check take, through the same path as the worker (Scrapling, solver,
  proxy from `config.json`) and without sending or saving anything. `--bench N` repeats
  the fetch and prints min/median/p95/max per stage; `--json` for scripts.
- Delivery history written by 2.x is reused (2.x and 3.0 compute the channel cache key
  differently; the existing key wins), so nothing is re-posted after the switch.
- First check of a feed no longer replays it: when a destination has no history for a feed
  (new feed, new channel, or a channel whose key changed after editing `Webhook`, `Thread`
  or feeds), the current entries are marked as seen and only the newest `FirstRunSend`
  (default 0) are sent.
- Channel `Filters`: `Include`/`Exclude` (text or `/regex/`), `Fields`, `CaseSensitive`,
  `MaxAgeHours` (also in `ChannelDefaults`).
- Feed autodiscovery: a web page URL is replaced by the feed it advertises
  (`<link rel="alternate">`, RSS > Atom > JSON Feed); history is kept under the found URL.
- Optional `Solver` for FlareSolverr-compatible services (FlareSolverr, Byparr, TRAWL), per
  feed or automatically on 403/503/challenge pages.
- Telegram: entries with an image are sent with `sendPhoto` (caption up to 1024 characters),
  with `sendMessage` as fallback; `SendPhoto: false` turns it off.
- Scrapling `PerUrlConfig["URL"].fallback: true`: plain HTTP first, the browser only when the
  site blocks it (`enabled: true` still uses the browser every time). Measured on the VPS
  with gry-wideo.pl, which no longer blocks plain requests:

  ```text
  ┌──────────────────────────────────────┬───────────┐
  │ gry-wideo.pl/rss                     │ per check │
  ├──────────────────────────────────────┼───────────┤
  │ Browser (stealthy-fetch, wait 8 s)   │ 10.5 s    │
  ├──────────────────────────────────────┼───────────┤
  │ Plain HTTP (XFeeder dry run)         │ 0.88 s    │
  └──────────────────────────────────────┴───────────┘
  ```

- 24/7 diagnostics (`Settings.Diagnostics` or `XFEEDER_DIAGNOSTICS=1`): every event and log
  line, without tokens or webhook URLs, in `diagnostics/events-YYYY-MM-DD.txt`, and a latency
  report every 15 minutes in `diagnostics/summary-YYYY-MM-DD.md`: publication → Discord per
  channel and stage, every HTTP request (queue, time to first byte, body, cache headers,
  Discord rate-limit headers, server clock), feed freshness and publishing rate, Discord 429
  waits, scheduler lateness, memory and CPU of XFeeder and the browser, anomalies (future
  dates, duplicate or missing ids, clock skew, panics) and hints. Writing runs on its own
  thread and never blocks the worker. First three days on production (10 channels, 32
  feeds, `TimeChecker` 60 min):

  ```text
  ┌──────────────────────────────┬────────────┬────────────┬────────────┐
  │ Publication → Discord        │ 2026-11-17 │ 2026-11-18 │ 2026-11-19 │
  ├──────────────────────────────┼────────────┼────────────┼────────────┤
  │ Median                       │ 33.4 min   │ 39.8 min   │ 28.1 min   │
  ├──────────────────────────────┼────────────┼────────────┼────────────┤
  │ 90th percentile              │ 54.9 min   │ 59.3 min   │ 55.7 min   │
  ├──────────────────────────────┼────────────┼────────────┼────────────┤
  │ Posts sent                   │ 170        │ 213        │ 197        │
  ├──────────────────────────────┼────────────┼────────────┼────────────┤
  │ Failed sends / Discord 429   │ 0 / 0      │ 0 / 0      │ 0 / 0      │
  └──────────────────────────────┴────────────┴────────────┴────────────┘
  ```

  Where the time went on 2026-11-19 (197 posts):

  ```text
  ┌──────────────────────────────────────────┬──────────┬──────────┐
  │ Stage                                    │  Median  │  90th    │
  ├──────────────────────────────────────────┼──────────┼──────────┤
  │ Waiting for the next check (TimeChecker) │ 27.9 min │ 55.7 min │
  ├──────────────────────────────────────────┼──────────┼──────────┤
  │ Inside XFeeder (fetched → sent)          │ 3.8 s    │ 10.9 s   │
  ├──────────────────────────────────────────┼──────────┼──────────┤
  │ Discord webhook request                  │ 0.74 s   │ 1.8 s    │
  ├──────────────────────────────────────────┼──────────┼──────────┤
  │ Slowest feed: boop.pl (browser)          │ 26.3 s   │ 34.6 s   │
  └──────────────────────────────────────────┴──────────┴──────────┘
  ```

  Almost the whole delay is the polling interval, not XFeeder; XFeeder itself used 35 MB
  of memory and 1.5 % CPU on average, with no leak over three days.
- Dashboard rewritten as server-rendered HTML in Rust: plain forms, no JavaScript
  (CSP `default-src 'none'`). Overview with worker control and metrics, channels
  (add/edit/duplicate/delete with filters), activity, diagnostics reports, settings
  (general, diagnostics, network, `.env` secrets; values are never shown) and the raw
  config editor. Every save is checked against the revision it was opened with; CRLF line
  endings are kept. The JSON API is unchanged.
- Discord webhook sends log the created message and channel id.

### Changed
- Scheduler: due channels start at once, one after another (up to
  `MaxConcurrentChannels`), instead of one channel per 30-second tick. With 10 channels a
  due channel could wait up to 5 minutes; a full pass of all 10 now takes about 7 s.
- A shorter `TimeChecker` after a config reload applies to checks that are already
  planned (last check + new interval); before, the next check still waited for the old
  interval.
- Feed bodies in ISO-8859-2/windows-1250 (and any WHATWG encoding) are decoded from the
  `Content-Type` charset or the document's own declaration; valid UTF-8 stays UTF-8. 2.x
  garbled Polish characters.
- A destination that is gone or forbidden (Discord 401/403/404 or Unknown
  Channel/Webhook, Missing Access, locked thread; Telegram 401/403, chat not found) is
  skipped for the rest of the run instead of failing once per pending entry.
- HTTP: one retry with `Accept: */*` on 406/415; healthy XML/JSON responses are not
  scanned for anti-bot text (articles that mention "captcha" were treated as blocks).
- Scrapling: works with Scrapling 0.4.15 and 0.5.x, runs `get` in the persistent Python
  worker, passes `solve_cloudflare` and the other stealth options, keeps page resources
  for a Cloudflare solve (the Turnstile widget needs them) and uses one browser session
  at a time.
- `XFEEDER_*` flags and dashboard settings are also read from `.env`.
- Sharper images. Each site in production was checked to see how it builds its posts:

  ```
  ┌──────────────────────┬──────────────────────────┬──────────────────────────────┐
  │ Source               │ Image the feed gives     │ Image sent now               │
  ├──────────────────────┼──────────────────────────┼──────────────────────────────┤
  │ GitHub commits       │ avatar 30×30             │ avatar 460 px, as thumbnail  │
  │ lowcygier.pl (WP)    │ thumbnail 224×224        │ original 800×800             │
  │ YouTube              │ hqdefault 480×360        │ maxresdefault 1280×720       │
  │ Steam news (CS2)     │ none in 9 of 10 posts    │ game header 460×215          │
  │ gry-wideo, onet,     │ 1200–2400 px             │ unchanged                    │
  │ boop, SteamDB        │                          │                              │
  └──────────────────────┴──────────────────────────┴──────────────────────────────┘
  ```

  The larger image is checked with a 1 KB ranged request before sending; when it does
  not exist (some YouTube videos have no `maxresdefault`), the feed's own image is used.
  Avatars appear small next to the text (Section + Thumbnail) instead of as a large
  pixelated picture, and are not sent to Telegram as photos.
- Message text keeps paragraphs and list items (`• `) instead of one long line (Steam
  patch notes, FMHY changes, multi-line commits); invisible characters and Steam's
  `\[ ]` escapes are removed; a text that only repeats the title, or starts with the
  site name and the title (WordPress feeds), is trimmed.
- RSS `<author>` given as plain text is used as the author (Gitea feeds).
- GitHub cards: commit trailers (`Co-Authored-By`, `Signed-off-by`, `Claude-Session`…)
  are not shown; a commit whose e-mail is not linked to a GitHub account shows the name
  from the e-mail (`codex`, `release`) instead of "Anonymous"; long texts end at a whole
  word with `…`.
- Discord cards: the date is a Discord timestamp (`<t:…:f>`), shown in each reader's own
  time zone and language (was US format in the server's zone); feeds without an author
  (Steam, SteamDB, onet, boop) show the site (`🌐 steamdb.info`) instead of "Anonymous";
  "Czytaj więcej »", "Read more" and "The post … appeared first on …" are removed;
  YouTube Shorts use the vertical thumbnail (`oardefault`, 1080×1920) instead of a
  letterboxed 16:9 one.

### Fixed
- GitHub activity feeds (`github.com/<user>.atom`) showed one word per line (line
  breaks in the HTML source were kept; they are spaces outside `<pre>`) and no time
  (dates like `2026-11-19 12:58:18 UTC` were not parsed).
- Relative links in feeds (Gitea writes `/owner/repo/commit/…`) are made absolute, so
  "Open" works. The original link stays the delivery identity, so nothing is sent again
  (checked on all 220 entries of the 12 production sources).
- A feed returned after a solved challenge is accepted even though the headers still say
  `server: cloudflare` / `cf-mitigated`; a rejected challenge page is logged as a warning.
- A second browser session failed with "Sync API inside the asyncio loop".
- A valid but empty feed (e.g. a YouTube channel without videos) is no longer turned into
  a fake entry; 2.x posted the feed URL once per such feed.
- Dates with a wrong weekday name (`Mon, 02 Jan 2024`) are accepted.
- Diagnostics report: parse time no longer includes the download, browser memory is
  counted once (PSS instead of summed RSS: about 1.3 GB was reported for a few hundred
  MB), and "-0 ms" is no longer shown when Discord never rate-limited.

### Removed
- Node.js, npm and the JavaScript browser UI; Workshop plugins, Dockerfile/compose;
  Node-era documentation and test fixtures; the `include_dir` dependency.

## [2.2.0] - 2026-10-09

**XFeeder 2.2.0 — Final Big Tweaks Before 3.0**

### Network and reliability
- Added process-wide Network Usage Control with Potato (10 Kbps), Low (2 Mbps),
  Medium (10 Mbps), High (50 Mbps), Very High (100 Mbps), Unlimited and Custom presets.
- Added independent Custom download/upload budgets. Known buffered request bodies
  reserve upload credits before dispatch; streaming/multipart bodies and redirect
  replay are explicitly outside upload pacing. All managed HTTP consumers share
  download/concurrency policy. Unlimited remains the default for existing configs.
- Added opt-in Network Friendly Mode: bounded HTTP/browser concurrency, browser
  spacing and retry jitter. It is application throttling, not OS/router QoS.
- Added setup, idle and explicit total deadlines that distinguish network stalls
  from intentional bandwidth waits and downstream backpressure.
- Preserved conditional requests and per-destination delivery state. Bounded
  retries honor transient HTTP/network errors and Retry-After; cancellation stops waits.
- Added bounded graceful shutdown across channel work, queues, retry delays,
  HTTP streams and Scrapling child/browser processes.
- Fixed duplicate delivery-cache IDs introduced by recording successful sends
  both immediately and at batch completion. Successful sends now persist before
  the inter-message delay so shutdown retains completed delivery state.
- Added structured runtime network metrics with aggregated encoded HTTP body bytes,
  approximate rates and active/waiting work; browser byte totals remain unavailable.

### Scrapling and content safety
- Added `npm run scrapling:install` and `scrapling:check` for a locally generated
  virtualenv, pinned dependencies, Chromium installation and actual browser checks.
  Replaced shell-based detection with paired Python/CLI discovery and Windows paths;
  neither the virtualenv nor a third-party source checkout is shipped or required.
- Added native Scrapling Resource Saving (default on), per-URL overrides and shared
  browser admission policy. Pinned the tested Scrapling runtime to 0.4.15 and added
  reproducible Python requirements. Browser traffic is not shaped by the Node limiter.
- Reject recognized challenge/error/interstitial HTML (including One moment,
  Just a moment and Checking your browser) before entry parsing and delivery.
  Rejection works even with browser fallback disabled. Unresolved challenges neither
  replay cached entries nor replace validators/snapshots/delivery state.
- Respect disabled automatic/per-URL fallback; reject challenges returned by Scrapling
  itself and guard both HTML entry extractors. Added positive and negative fixtures.

### Dashboard, delivery and diagnostics
- Redesigned the dashboard into Overview, Channels, Settings, Advanced and Activity,
  including mobile layouts, independent saves, secret masking, dirty-state protection,
  revision conflicts and configuration validation.
- Added Network settings/API and a worker runtime bridge for applying changes without
  restart and displaying actual applied/offline status.
- Added Telegram Bot API delivery with HTML formatting, forum topics and channel
  overrides. Delivery destinations are Discord and Telegram.
- Retained generic config/retry/cache regression coverage; removed tests that only
  enforced retired integrations.
- Added Expert diagnostics and terminal capture with secret redaction; preserved
  dry-run, once, check-config and conditional-fetch behavior.
- Added explicit HTTPS reverse-proxy public origin support, Secure session/logout
  cookies and origin validation without trusting arbitrary forwarded headers.
  Validated login, Network updates and logout through a real local TLS proxy.

### Removed
- Removed legacy Matrix delivery support.
- Removed FreshRSS-specific compatibility/integration; standard RSS/Atom feeds remain supported through the generic feed pipeline.
- These removals are intentional scope decisions before 3.0, not accidental regressions.

### Release and tests
- Added a small runtime release asset with application/dashboard code, installation
  manifests, examples, an empty starter config and the MIT license. Development
  documentation, tests and commands are excluded; full source archives remain available.
- Audited tracked source and available Git history for credentials/runtime artifacts;
  strengthened ignore/archive guards and replaced the TLS fixture with an explicitly
  public test-only, non-CA certificate/key pair and documented its trust boundary.
- Extended regression coverage for network sharing, profiles, retries/429, timeout
  semantics, shutdown, dashboards, challenge pages and unsupported configuration warnings. Browser
  smoke suites cover real Scrapling resource policies and desktop/mobile workflows.
- Restored automatic discovery of every `tests/*.test.js`; removed a test's dependency
  on a private local config in favor of the distributed example.
- Updated package/lockfile/user-facing versions to 2.2.0. Corrected the runtime floor
  to Node 20.18.1, already required by locked Cheerio/Undici, rather than imposing Node 22.
- Hardened .gitignore for secrets, Python/Node environments, caches, runtime snapshots,
  debug logs, browser/test output and local benchmark/release artifacts. Retained the
  XFeeder Scrapling adapter, fixtures, example files and dependency lockfiles.
- Added a reproducible source archive builder and documented validation results,
  artifact contents and known measurement/upload/browser limitations.
- No XFeeder 3.0 tasks or automatic Adaptive Mode are implemented in this release.

## Earlier releases

[Core]
- Added safe run modes so you can test locally without posting anything live.
- Added a config check command to catch mistakes before deployment.
- Reloading now picks up changes from `.env` and `config.json` without restarting the worker.
- Message cache now tracks each destination separately, so one failed target does not cause duplicate posts in another target.

[Dashboard]
- Added password protection for the dashboard.
- Improved the edit flow for `.env` and `config.json` so routine changes are easier.
- Prevented unsafe public dashboard exposure unless a dashboard password is configured.

[Reliability]
- Fixed proxy handling for feed requests.
- Improved channel and delivery flow to be safer during partial failures.
- Added tests for config loading and channel execution behavior.

[Deployment]
- Added systemd examples for the worker and dashboard services.
- Added safer example environment and config files for public sharing.
- Cleaned the public repo so secrets, caches, local virtual environments, and temporary files stay out.
