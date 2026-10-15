# X3-23 — Failure suppression / per-feed circuit breaker

## Goal

A consistently failing feed must not repeatedly trigger full HTTP retry and
expensive browser fallback on every channel rotation. The policy is
**per feed URL**, never global, so other sources and destinations continue.

This implements the circuit breaker and backoff concepts described in:

- https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker
- https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/

## Policy

| Observed state | Behaviour |
| --- | --- |
| Healthy (0 failures) | Existing HTTP, parsing and conditional GET behaviour |
| Degraded (1–2 consecutive failures) | Normal configured polling and HTTP retries |
| Paused (3+ failures, cooldown active) | Skip source fetch; do not open an HTTP or browser session |
| Failing (cooldown elapsed) | Permit one half-open recovery probe per feed; no overlapping probes |
| Healthy after recovery | Successful parse or HTTP 304 resets failures and cooldown |

After three failures the first poll cooldown is 5 minutes, doubling for
subsequent failed probes and capped at 6 hours. Timing is additionally
limited by each channel's existing TimeChecker. There is no permanent
auto-disable, source deletion or global lockout. No POST delivery is retried.

Two observed anti-bot/browser failures trigger a 30-minute **Scrapling-only**
cooldown. Normal HTTP requests remain possible whenever the ordinary poll
breaker allows them. With browser cooldown active, an explicitly forced
Scrapling-only source returns SCRAPLING_COOLDOWN rather than secretly
switching transport. Automatic browser fallback is also suppressed. A
successful ordinary fetch or HTTP 304 clears both failure streaks.

HTTP failures that previously replayed cached entries still can do so for
the *attempt that failed*. During a circuit cooldown, no cached entries
are replayed and no downstream destination POST is initiated.

## Durability, restart and API

The failure metadata is stored inside the existing separate feed domain
(cache.feeds.json), alongside the feed URL's ETag, Last-Modified and cached
items. Snapshot updates retain metadata; delivery history in cache.json
remains unchanged. All production changes await the existing atomic
asynchronous save and propagate CACHE_UNSAFE errors without starting more
delivery requests.

Core methods:

- feedCircuit.status(url) — Healthy / Degraded / Failing / Paused,
  failure streak, nextRetryAt, browser cooldown and probe state;
- feedCircuit.beforeFetch(url) / release(url, admission) — admission
  decision and at-most-one half-open recovery probe;
- feedCircuit.succeeded(url) / failed(url, detail) — durable updates;
- feedCircuit.retryNow(url) — clear the next poll and browser cooldown
  timestamps and permit another attempt, without silently erasing failure
  history. A new failure may produce a longer cooldown.

createApp exposes getFeedHealth(url) and retryFeedNow(url) for a future
authenticated dashboard control. No new dashboard mutation route or
public unauthenticated reset is introduced at this stage.

## Non-goals and caveats

- This is per-feed failure suppression, not a service-wide Discord/Telegram
  breaker. The original network HTTP GET retry and bounded backoff remain.
- A failure streak increments on a rejected/blocked network result, a thrown
  non-cancellation error, or a source which cannot produce entries. Success
  includes HTTP 304 even when the cached snapshot has no entries.
- An abrupt process crash during external HTTP cannot be perfectly
  classified. The metadata is best-effort but a confirmed update is
  durably stored before continuing.
- Concurrent channels may fetch healthy identical URLs independently; only
  half-open probe traffic is serialized.
- A retry-now call is a **core action**, not a scheduled background check;
  the next channel rotation performs the actual network fetch.
- A failing source does not permanently disable itself, and neither its
  cache contents nor successful destination IDs are discarded.

The primary regression suite is tests/feed-circuit.test.js. Earlier feed
pipeline, network retry, per-destination delivery, state migration and
shutdown tests remain in the full CI matrix.
