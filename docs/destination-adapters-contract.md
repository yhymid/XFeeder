# X3-16 — Destination adapter contract

XFeeder's delivery destinations now share a tiny adapter registry:
`src/core/destination-adapters.js:createDestinationAdapters`. The adapters
delegate directly to the existing Discord webhook and Telegram senders.
No new transport, retry policy, payload schema, delivery identity or
third-party dependency was introduced.

## Adapters

| Kind | Arguments forwarded to existing sender |
| --- | --- |
| `webhook` | `sendMessage(webhookUrl, threadId, rawEntry)` |
| `telegram` | `sendTelegramMessage(telegramConfig, rawEntry)` |

Both adapters retain the *original* entry object (see X3-14's
`NormalizedEntry.raw`). Registry descriptors are frozen and created per
channel-runner instance, not global shared state. A missing injected sender
fails only when its destination is attempted; webhook-only operation does not
require a Telegram sender.

`channel-runner` still selects destinations from the same target config and
stores success under the same per-source `::webhook`/`::telegram` buckets.
The generic dispatch keeps the existing checks: cancellation propagates;
non-cancel provider failure is recorded for that destination and left pending;
a successful destination is written and persisted immediately; the
configured send delay and `RequestSend` order are preserved. Dry-run
never invokes provider senders or writes delivery state.

## Guarantees and non-goals

- Discord Components V2 request construction and its bounded 429 retries
  stay in `src/message.js`.
- Telegram HTML escaping, API response validation and failure semantics
  stay in `src/telegram.js`.
- Network Service, bandwidth pacing, rate limit handling and errors retain
  existing behavior.
- Legacy source-only buckets, destination-aware dedup, partial success and
  304 snapshot replay are unchanged.
- This registry is not evidence of support for other delivery platforms.
  Future destinations need explicit configuration, descriptors and tests.

`tests/destination-adapters.test.js` covers argument identity, returned
provider result, unmodified propagated errors and optional sender isolation.
The pre-existing `tests/delivery-state.test.js` continues to exercise
real channel-runner delivery ordering, destination isolation,
cancellation, persistence, duplicate prevention, legacy state and dry-run.
