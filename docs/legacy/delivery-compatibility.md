# Delivery compatibility — X3-06

X3-06 protects Discord/Telegram delivery semantics on `3.0-dev`. It adds provider
and delivery-state regressions and fixes one dry-run defect exposed by those tests.
The configuration/cache formats, dependencies, Node minimum and package version
are unchanged. No later numbered task is implemented.

## Dry-run correction

Previously, dry-run skipped provider requests and disk saves but still inserted
delivered identifiers into the live in-memory channel cache. It could also create
destination buckets and migrate legacy buckets there. Three regressions failed
before the correction: fresh, existing and legacy state.

`src/app/channel-runner.js` now clones the current channel's delivery bucket for
simulation. Simulated successes and legacy migration remain local to that pass;
the original cache object is returned unchanged. This preserves duplicate filtering
inside a simulated pass without suppressing a later real delivery. Normal delivery
continues to save each provider success immediately.

The tests compare both in-memory state and persisted bytes, run two simulations
followed by real delivery, and exercise RSS and Discord sources together. They
verify no provider, live bucket creation or cache save is called during simulation.
This guarantee concerns **delivery state**: fetching is injected in these tests,
so they do not claim all feed snapshots or runtime metrics remain unchanged.

## Regression boundaries

| Test file | Coverage |
| --- | --- |
| `tests/delivery-state.test.js` | Both partial-success directions for RSS and Discord sources; persisted success followed by reload/retry; duplicate identity within/across passes; partially delivered entries under `RequestSend`; pending provider response; cancellation and dry-run isolation |
| `tests/delivery-discord.test.js` | Components V2 payloads, safe media/link handling, bounded text, terminal 4xx, 429 delay precedence and retry budget, 429 followed by 503, request/retry cancellation and Network shutdown |
| `tests/delivery-telegram.test.js` | Escaped/bounded HTML, safe links, invalid configuration before HTTP, successful result, API failure at HTTP 200, HTTP 4xx/5xx/429, connection failure and cancellation with Network admission cleanup |

Provider tests use real loopback HTTP and the Network adapter. Telegram's endpoint
is redirected to the local fixture; no real Discord/Telegram request is sent.
Tests of selected Discord backoff values skip only the elapsed wait, while separate
tests cancel the actual retry wait. State tests use a temporary real cache file,
injected providers and a delay replacement that retains cancellation checks.
Existing network, channel runner and X3-04 `RequestSend` tests remain in the suite.

## Delivery guarantees and retained limits

- A new delivered identifier is saved only after that provider's promise succeeds.
  A failed or in-flight provider does not gain a delivered identifier. Successful
  destinations stay complete after cache reload and are skipped on the next pass.
- Successful same-batch duplicate identities are skipped before another send;
  later passes also skip them. Identity still prefers normalized link over GUID.
  Unkeyed entries and provider acceptance followed by connection loss do not gain
  an exactly-once guarantee from these tests.
- `RequestSend` selects pending entries per source, not per destination. A partially
  delivered entry consumes one slot and is sent only to its pending destinations.
  Duplicate entries can still consume selection slots before in-pass filtering.
- Cancellation propagates without counting as provider failure; a success already
  saved for another destination is retained. Cancellation after remote acceptance
  can still be ambiguous.
- Ordinary failed processing may create empty destination arrays. Legacy migration
  copies identifiers already treated as delivered; neither is a new provider success.
- Discord retries only 429 inside one send call, up to three retries after the first
  attempt. Other tested 4xx/5xx statuses fail without immediate retry. Its current
  delay precedence is body `retry_after`, `x-ratelimit-reset-after`, numeric
  `Retry-After`, then exponential backoff, bounded to 500–15000 ms. Numeric
  `Retry-After` values of at least 100 are treated as milliseconds; HTTP-date values
  fall back to backoff. The upper bound can undercut a longer provider hint.
- Telegram performs one POST per call and wraps non-cancellation HTTP errors in a
  plain Error, losing structured status/retry metadata. Failed destinations remain
  pending for a later channel pass; no new retry policy is introduced here.

Research references:
[Discord webhooks](https://docs.discord.com/developers/resources/webhook),
[Discord rate limits](https://docs.discord.com/developers/topics/rate-limits), and
[Telegram Bot API](https://core.telegram.org/bots/api).
These references inform the fixtures; tests characterize current behavior rather
than claiming complete provider API conformance.

## Validation — 2026-10-13

- New tests: 52 (15 state, 21 Discord, 16 Telegram), all passed on Node 26.11.1 and
  minimum Node 20.18.1; 0 failed, 0 skipped on both versions.
- Full `npm test` on Node 26.11.1: 339 passed, 0 failed, 0 skipped.
- `node main.js --check-config --config tests/fixtures/config/channel-groups.json`:
  4 channels, zero warnings; no provider access.
- Syntax checks and `git diff --check`: passed.

Changed files: the three test files listed above, `src/app/channel-runner.js` and
this document. The only production change isolates dry-run delivery state.

Deferred: X3-07 dashboard API/security tests, structured provider errors, revised
retry policy and stronger delivery guarantees. This task adds none of those.
