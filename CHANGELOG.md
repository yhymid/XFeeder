# Changelog

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
