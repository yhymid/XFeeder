# Current XFeeder architecture

> Historical baseline: this document records an earlier X3-01 audit of `3.0-dev` at `c521cd8`; references below to version `2.2.0` describe that older snapshot, **not the active `3.0-alpha` branch**. For the current design and `3.0.0-alpha.0` development state, see [`ARCHITECTURE.md`](../ARCHITECTURE.md) and [`README.md`](../README.md).

Documentation-only X3-01 audit, restored by C3-06 on 2026-10-15 after the
corrective pass. This describes `3.0-dev` at `c521cd8`, not a proposed 3.0 architecture.
The package still reports 2.2.0. The local release tag is `2.2` (`6ef45c9`);
there is no local `v2.2.0` tag. No release history was rewritten.

## Main flow

```text
Scheduler -> Channel Runner -> Feed Fetch / Source Parser
          -> Network Service (HTTP or gated Scrapling)
          -> Parser -> Normalized current entry shape -> Dedup/cache
          -> Discord / Telegram delivery (through Network Service)
          -> Persist successful destination state
```

The current entry is a plain object, not a new domain entity: parsers generally
supply `title`, `link`, `guid`, `contentSnippet`, `isoDate`, `enclosure`, `author`
and `categories`, with source-specific optional fields. `normalize.js` derives
identity and cache buckets; there is no independent versioned Entry schema yet.

## Boot and configuration

`main.js` installs terminal logging, parses CLI/environment switches and calls
`createApp()` in `src/app/bootstrap.js`. Bootstrap constructs the cache store,
channel task registry, feed pipeline and channel runner, configures the shared
Network Service and optionally starts the queue and runtime reporter.
`--once` runs one sequential pass; `--check-config` validates without starting
the queue; `--dry-run` suppresses delivery and persistent cache changes, but can
still fetch feeds. `--debug-expert` enables detailed sanitized diagnostics.

`src/config-loader.js` reads the chosen JSON file and its adjacent `.env`.
Process environment overrides `.env`. Only whole-string `${NAME}` references
are substituted recursively; missing values become empty strings. Network
configuration is validated here. `src/core/channel-config.js` collects supported
channel groups, normalizes inherited settings and identifies delivery targets.
Both array and object group forms remain supported. Compatibility details are
recorded in `config-loader-compatibility.md` and `channel-config-compatibility.md`.

Configuration is refreshed before queue work and every second by the network
runtime reporter. Bootstrap compares the resolved configuration digest before
applying changes; failed reloads are reported without replacing valid state.

## Scheduler and channel execution

`src/app/runtime.js` runs a round-robin, sequential channel queue using
`setTimeout`. The default delay between selections is 30 seconds. Eligibility
uses `TimeChecker` and an in-memory map keyed by channel cache key. C3-04 adds
separate lastAttemptAt, lastSuccessAt and nextRunAt fields. Both failed and
successful attempts advance scheduling; consecutive failures back off by 1x,
2x, 4x and at most 8x the base interval, capped at one hour unless the base itself
is longer. Retry-After is a minimum deadline; success resets failure state.
See `scheduler-safety.md`. A slow feed,
delivery retry or bandwidth wait delays later channels. There is no persistent
job queue, catch-up scheduler or distributed coordination; last-check times
reset on process restart. The channel list is refreshed during operation.

`src/app/channel-tasks.js` coalesces concurrent work for the same key and tracks
running, waiting, completed, failed and cancelled states. An AbortController per
active channel and `src/network/context.js` (AsyncLocalStorage) carry cancellation
and waiting/failure reporting through fetching and delivery.
`src/app/channel-runner.js` filters pending entries, applies limits and dispatches
each supported destination independently.

## Feed pipeline and parsers

`src/core/feed-pipeline.js` calls `src/parsers/downloader.js` with saved ETag and
Last-Modified validators. A 304 replays cached items, allowing delivery to targets
which have not yet received them. Some ordinary fetch failures also replay the
previous snapshot. Unresolved challenge/interstitial pages are rejected before
parsing, snapshot updates or delivery state creation; they do not replay entries.
`src/core/blocked-page.js` is the shared challenge/error detector.

Downloaded content is reused by the parser HTTP facade instead of fetching the
same URL again. Bootstrap supplies parsers in this order: YouTube, Atom, XML,
JSON, API X, RSS, fallback. Later fallback parsing includes RSS item extraction
and rss-parser parsing of downloaded content. Scrapling-fetched HTML can be
parsed first using its configured selectors. Discord sources use their own
`src/parsers/discord.js` path through the channel runner.

`src/core/normalize.js` handles entry identity and destination-aware state.
Parser shape, ordering, deduplication and fetching boundaries are covered by
`feed-pipeline-compatibility.md` and the feed regression tests.

## HTTP and Network Service

`src/client.js` caches a proxy-configured Axios client and provides shared GET
and POST helpers. GET retries are bounded and account for transient failures,
429/Retry-After, cancellation and overall deadlines. Delivery uses separate
Axios calls with the same network adapter, not necessarily the cached client.

`src/network/http-adapter.js` wraps the Axios HTTP/1 transport and keeps Axios
redirect, proxy, status and decoding behavior. It controls admission, uploads,
setup/idle/deadline timeouts, response lifetime and cleanup. Native
IncomingMessage responses are decorated by `incoming-download.js`, which wraps
`push`, `_read` and `_destroy` and defers EOF until queued bytes are consumed.
Custom transport streams use `download-stream.js`. Both paths account for
bandwidth waits separately from server inactivity. X3-09 did not change these
transport modules: the 1/512-byte regression was malformed chunk framing from
the test server's `ServerResponse.cork()` on Node 22/24. Socket-level corking
preserves all 512 individual chunks and the unchanged trailer/timing assertions.

`src/network/service.js` owns the process-wide NetworkService singleton:
download/upload BandwidthControllers, HTTP/Scrapling concurrency gates, metrics,
active operations and shutdown signals. `bandwidth-controller.js` distributes
byte grants; `config.js` resolves Unlimited, presets and Custom settings.
Friendly Mode adjusts concurrency and heavy-task spacing. Unlimited remains
the backward-compatible default. Limits are shared inside one worker process,
not across separately launched workers or the entire host.

Upload pacing currently covers buffered initial bodies before dispatch. Streams,
multipart bodies and redirect replay are not fully shaped. Metrics count encoded
HTTP response bodies and request bodies handed to the transport, excluding
headers, TLS and redirect replay. Browser byte totals remain unavailable rather
than being reported as zero. These limitations are explicitly exposed by
`runtime-state.js`; this audit does not redesign them.

## Network initiators

| Boundary | Initiators / transport |
| --- | --- |
| Feed downloads and parser follow-up requests | `client.js`, `parsers/downloader.js`, parser HTTP facade; Axios through `networkAdapter` |
| Discord source | `parsers/discord.js`; bootstrap injects the managed HTTP client (the standalone parser has an Axios default) |
| Discord delivery | `message.js`; Axios with `networkAdapter`, bounded 429 retries |
| Telegram delivery | `telegram.js`; Bot API Axios POST with `networkAdapter`; failed delivery remains pending for a later pass |
| Scrapling | Python CLI/shell or persistent worker; Python HTTP libraries and Chromium make their own requests |
| Dashboard UI | Browser requests to the dashboard API; separate Node HTTP server serves UI/API |
| Installation only | `scripts/install-scrapling.cjs` invokes pip and browser installers; not part of normal feed scheduling |

## Scrapling and child processes

`src/extensions/Scrapling/index.js` owns a configurable Scrapling singleton.
Downloader fallback checks the existing policy, detector results, per-URL options
and anti-bot mode sequence. `resource-policy.js` resolves Resource Saving for
browser fetches. Native browser resource filtering is distinct from HTTP byte
shaping; Node does not intercept all Chromium traffic.

`detector.js` and `runtime-paths.js` probe Python/CLI installations, preferring
the managed `.venv`. `cli.js` and `shell.js` run commands through `runChild`.
`browser-worker.js` spawns `browser_worker.py`, exchanging JSON lines on
stdin/stdout. Python maintains browser sessions; a Node TaskGate serializes
requests and keeps waiting requests outside the synchronous Python protocol.
Python in turn launches the Playwright/Patchright driver and Chromium.

`process-control.js` closes the process tree. On POSIX it snapshots descendants
using system `ps`, checks recorded start times before signalling, lets Python
attempt cleanup, then terminates remaining descendants with bounded escalation.
This includes Chromium's separate process group. Windows uses `taskkill /T`.
POSIX `ps` is a runtime requirement for Scrapling cleanup; the actual browser
shutdown regression was verified on Linux, not macOS or Windows.

## Delivery, cache and state

Discord webhook delivery is implemented in `src/message.js`; Telegram Bot API
delivery in `src/telegram.js`. The channel runner records success separately for
each destination. A successful target is not resent just because another target
failed. Failed delivery stays pending; dry-run uses cloned channel state and
does not send or persist simulated successes.

`src/core/cache-store.js` owns an in-memory JSON cache loaded from `cache.json`
(or `--cache`). It stores channel delivery buckets and `__xfeeder.feedSnapshots`
with validators/items. Saves write a temporary file and rename it. This is not a
database or a multi-writer store: multiple workers sharing the same cache are
not coordinated. Invalid/truncated cache blocks startup with CACHE_UNSAFE;
the original remains and a byte-identical, private `<cache>.corrupt-<sha256>`
copy is created. Restart stays blocked, including after deletion of the original
while quarantine remains. A failed reload locks the existing store against
reads/mutations/saves until a verified cache is restored. See `cache-recovery.md`
and `delivery-compatibility.md` before changing cache identities.

| Local file/state | Owner and lifetime |
| --- | --- |
| `config.json`, adjacent `.env` | User configuration/secrets; read by worker, editable through authorized dashboard APIs |
| `cache.json`, `<cache>.tmp`, `<cache>.corrupt-<sha256>` | Delivery and conditional-feed state, atomic save and private corruption quarantine |
| `<config>.network-runtime.json`, PID-specific `.tmp` | Worker telemetry; atomic publication, removed on orderly stop if owned by that worker |
| `debug/terminal.txt` | Terminal log shared by worker/dashboard logging and dashboard activity views |
| Scrapling `.venv`, browser installations/profiles and extraction temp files | Local installation/browser runtime; not source-controlled |
| Dashboard sessions, task state, bandwidth queues, browser sessions | In-memory state, lost at process restart |

## Metrics and dashboard communication

`src/network/metrics.js` accumulates traffic and rate-window metrics.
`runtime-state.js` publishes an allowlisted snapshot every two seconds and
reloads config every second. Snapshots include worker identity, timestamp and
configuration signature so the dashboard can distinguish unavailable, stale
or unapplied state.

`dashboard.js` launches `src/dashboard/server.js` as a separate process. It does
not spawn or control the worker through IPC. Communication uses configuration,
cache, terminal log and runtime snapshot files. `src/dashboard/network.js`
reads settings/runtime; network setting writes use revision checks and atomic
file replacement. Browser modules in `src/dashboard/public/` render operations,
channel configuration, activity and Network views and poll the API.

Dashboard authentication keeps at most 256 sessions in memory. Password login
attempts (including malformed bodies) have a constant-memory, ten-per-minute
limit per server with 429/Retry-After. Host is checked against configured public
or bind/loopback authorities. Mutations require Origin; supplied Origins on reads
are checked too. A configured publicOrigin is the sole accepted Origin, otherwise
the server builds an explicit bind/loopback whitelist. Arbitrary Host and forwarded
headers cannot establish trust. Proxies must preserve the public Host or supply
an allowed backend authority. Public HTTPS origin enables Secure cookies.

Full-config and Network PUT require If-Match. State and env-write responses return
only `envStatus` (configured/missing); existing `.env` secrets never reach the UI.
The UI supports an explicitly confirmed write-only full replacement. Env writes
create an exclusive random temp file privately (0600 on POSIX), then rename it.
Raw configuration still reaches the authenticated editor, including inline
credentials if configured; environment references avoid that exposure. Env writes
have no merge/revision guard. See `dashboard-security-compatibility.md` and tests.

## Synchronous I/O, secrets and shared services

Synchronous filesystem operations remain in config/dotenv loading; cache
load/save/rename, corruption hashing/quarantine and directory checks; terminal log setup/writes; dashboard config, environment,
cache and static-file reads/writes; network settings reads; runtime snapshot
validation/removal; and Scrapling CLI extraction-file read/cleanup. Scrapling
Python probing also uses synchronous child processes. Telemetry publication
uses asynchronous writes/rename. This is an inventory, not an async-I/O refactor.

Secret-loading boundaries are `config-loader.js`, dashboard environment/config
writes and dashboard authentication environment variables. Environment reads in
the server produce status flags only, while raw config editing remains available. Resolved proxy URLs,
webhooks, Telegram tokens and source/browser credentials flow to their respective
clients. `core/diagnostics.js` sanitizes expert diagnostics; terminal logging can
capture third-party output and remains private runtime data.

Shared process state includes NetworkService, cached Axios client, Scrapling
singleton, persistent browser worker/queue, dotenv cache, diagnostic flags and
terminal logging hooks. Application cache/task registries are per application
instance; dashboard session maps are per server. Multiple applications in one
process therefore still share network/browser services.

## Shutdown and compatibility constraints

`main.js` routes SIGINT/SIGTERM and fatal errors to idempotent app shutdown.
Bootstrap stops scheduling/telemetry, closes network admission and waits for
the configured grace period, aborts remaining channel work, closes browser
sessions, bounds task cleanup, waits for telemetry cleanup and saves cache
unless dry-run/persistence policy forbids it. The network service cancels gates,
bandwidth waits and active operations. Browser-tree completion must be awaited,
not inferred from the Python parent's exit.

The main coupling/risk points remain the scheduler's shared-client Retry-After
helper, process-wide network/browser services, channel-runner ownership of both
normalization and delivery/cache updates, synchronous file I/O, and the dashboard's
shared-file interface. Browser cleanup depends on POSIX ps (or Windows taskkill),
and the global login limit can temporarily delay legitimate login under abuse.
No concurrent scheduling, durable queue, cross-process cache lock or StateStore
has been introduced by this corrective pass.

Future tasks must retain current config aliases/defaults, conditional fetch
semantics, destination-aware cache, retry/cancellation behavior, throttle-aware
timeouts, Friendly Mode, Resource Saving, dashboard security and metrics, once,
dry-run, check-config and expert diagnostics. Changes to configuration/cache
formats require migration and regression fixtures before removal. Current
limitations (serial scheduling, synchronous I/O, process-local globals, shared
files and partial upload/browser accounting) are constraints to inspect, not
permission to redesign them in this task.

## Validation and deferred work

X3-09 isolation first restored the `55bdc45` dependency baseline: Node 22/24
still failed the chunked fixture (382/383), excluding the dependency update as
its cause. Fixture/shutdown repairs passed 383/383 on Node 22.23.3, 24.21.0 and
26.11.1 and Scrapling 7/7 before the separately authorized Axios/Undici security
update. That update passed the same matrix and npm audit reported zero findings.
C3-03 added dashboard regressions (387 tests), C3-04 scheduler regressions (391),
and C3-05 cache protection regressions (398). None skips or weakens the original
512-byte assertion. C3-03 also passed the actual Chromium dashboard acceptance
script, including write-only env replacement. Final corrective-pass validation
passed 398/398 on each of Node 22/24/26 (zero failures/skips), real Scrapling
smoke 7/7, fixture check-config on all three versions, actionlint and npm audit
with zero vulnerabilities. These are local runs of CI steps,
not a claim that GitHub Actions has run remotely.

The current workflow tests Node 22/24/26. `engines` remains unchanged at
`>=20.18.1`; Node 20 is not validated by this CI matrix. Recommendation: make
Node 22 the minimum in a separately approved policy change, rather than claim
untested Node 20 support. This document itself does not alter runtime policy.

This document changes no production architecture. X3-10 remains unstarted.
Remaining dependency modernization belongs to its later task; macOS/Windows
real-browser validation and the operational limitations above remain explicit
follow-up work, not completed features.
