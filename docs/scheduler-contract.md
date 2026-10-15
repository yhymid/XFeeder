# X3-20 — Scheduler runtime contract

## Scope and design

The existing **serial round-robin queue** remains the scheduler. This task
hardens its identity cursor, refresh recovery and timer admission; it does not
introduce parallel workers, durable job queues or additional request bursts.
Delivery-state persistence, per-target deduplication and the source/destination
adapter contracts remain unchanged.

## Channel identity across live reloads

Previously `currentIndex` alone controlled selection. If a user reordered
channels in `config.json` between two queue turns, the numeric offset could
repeat a recently visited channel and skip the channel that should have run
next. The cursor now tracks `nextChannelKey` (the **existing cache key**) in
addition to the legacy index. At each turn, after config refresh, the queue
selects that key's latest position. When it has been removed, it falls back
to the bounded positional cursor.

Schedule state remains keyed by the same channel cache key. Reordering does
not change prior `lastAttemptAt`, `lastSuccessAt`, `nextRunAt` or
`failures`; it cannot clear backoff, bypass `TimeChecker`, replay
previously delivered entries or alter per-destination cache history. The
`getState()` snapshot now includes the intended next key; it remains an
in-memory diagnostic snapshot, not a stored cursor.

## Timing and recovery

- The queue runs one channel at a time, schedules one timeout only after an
  attempt completes, and skips channels until `nextRunAt`. `TimeChecker`
  and previously verified retry/backoff/Retry-After semantics are retained
  from C3-04 (`docs/scheduler-safety.md`).
- `delayBetweenChannels` is a **programmatic** app option and must be a
  finite safe integer between 1 and 2,147,000,000 milliseconds. Rejecting
  zero/invalid values prevents an accidental busy `setTimeout(0)` loop.
  The default remains 30,000 ms. No new config.json field is added.
- A temporary exception from the `getChannels` provider during hot reload
  is sanitized and logged. The queue schedules the next normal polling turn
  instead of rejecting its asynchronous timer callback and dying silently.
  A failure to read the initial channel list still fails at startup.
- A channel execution error continues to affect only that channel's
  schedule. A failure to refresh config preserves the last valid channel
  list. Stop is idempotent and cancels pending timers; the existing task
  cancellation/shutdown lifecycle remains responsible for in-flight work.
- New/missing/reordered channels retain round-robin, sequential semantics.
  No starvation-free guarantee is claimed for adversarial configuration
  changes that reorder or remove channels on *every* turn.

## Regression and operational boundaries

`tests/scheduler-safety.test.js` covers live reorder by cache key,
deleted-next-channel fallback, invalid delay protection, a transient channel
list exception and repeated stop. Its earlier C3-04 tests cover retries,
healthy-channel fairness, Retry-After seconds/dates and backoff reset.
Existing network integration and shutdown tests cover task cancellation,
active requests, cache persistence and Network Service admission.

This task does not introduce a persistent scheduler or solve coordination
between two simultaneously running XFeeder processes. Cache-key collisions
still produce configuration warnings and should be fixed with explicit
unique IDs. Extremely slow channels can still delay later channels since
execution remains serial; parallelism is a separately reviewed feature.
