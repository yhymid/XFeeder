# X3-18 — Retry, backoff and Retry-After contracts

## Research and policy choices

XFeeder has multiple intentionally different retry policies. A common helper
must not treat a feed GET and a webhook POST as equivalent: a timed-out POST
may already have been accepted by its recipient. The existing verified rules
are preserved rather than introducing a generic HTTP retry interceptor.

References:
- HTTP `Retry-After` field (RFC 9110 section 10.2.3):
  https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3
- Discord rate limits (HTTP 429 response):
  https://discord.com/developers/docs/topics/rate-limits

## Implementation

`src/network/retry-policy.js` contains the original GET helpers from
`src/client.js`: case-insensitive header lookup, `Retry-After` parsing,
retryable transient status/error selection and exponential backoff with
Network Friendly Mode jitter. The original public
`require("./src/client").getRetryAfterMs` export is maintained for the
scheduler and existing callers, referencing the same function.

The existing Discord webhook 429 delay calculator moved from
`src/message.js` into `getDiscordRetryDelayMs` in the same shared module.
Discord keeps its provider-specific precedence and historical units:
response body `retry_after` seconds, then `x-ratelimit-reset-after`
seconds, then its legacy numeric `Retry-After` handling, then bounded
exponential fallback. Its attempts remain capped locally in
`src/message.js`. A 5xx webhook delivery is still not replayed;
`src/telegram.js` remains one-shot and returns the same provider errors.

## Behavior and invariants

- GET retry statuses: 408, 425, 429, 500, 502, 503, 504; network codes:
  `ECONNABORTED`, `ECONNRESET`, `EAI_AGAIN`, `EHOSTUNREACH`,
  `ENETUNREACH`, `EPIPE`, `ETIMEDOUT`, `ERR_NETWORK`.
- GET attempts default to 3, hard maximum 5, with base delay 500 ms and
  exponential cap 8000 ms. A valid HTTP `Retry-After` on 429/503 is a
  minimum, **not truncated by the backoff cap**. HTTP-date and fractional
  seconds stay supported.
- Deadline/cancellation aborts never retry and interrupt network waits.
  Network Service still owns slot and bandwidth accounting per attempt.
- Discord's provider-specific Retry-After logic is intentionally distinct
  from generic HTTP-date handling; changing its legacy interpretation needs
  separate review and tests.
- Scheduler retry and minimum `TimeChecker` intervals stay as before;
  `getRetryAfterMs` continues to supply its minimum retry deadline.
- Every successful destination persists immediately. A failed/uncertain
  webhook or Telegram POST must not be considered delivered or auto-replayed.
- No new dependency, config field, state/cache migration, Network Service
  reset or transport change.

## Regression

`tests/retry-policy.test.js` covers helper equivalence, GET status/code
classification, cancellation/deadline behavior, bounded backoff and
Retry-After minimums, and Discord body/header/legacy units. Pre-existing
`tests/network-http.test.js`, `tests/network-integration.test.js`,
`tests/delivery-discord.test.js` and `tests/delivery-telegram.test.js`
continue to test real loopback sockets, retries, cancellations and provider
send counts. Scrapling browser smoke remains part of CI.
