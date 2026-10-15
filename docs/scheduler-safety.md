# Scheduler failure protection — C3-04

The existing serial round-robin scheduler is retained. Each channel cache key
has in-memory `lastAttemptAt`, `lastSuccessAt`, `nextRunAt` and `failures` state.
An attempt records its start even if it fails. Success records completion,
resets failures, and schedules the next run after `TimeChecker` minutes.

Failure waits at least the same base interval after completion. Consecutive
failures use 1x, 2x, 4x, then at most 8x the interval, capped at one hour unless
the base interval itself is longer. Available Retry-After seconds or HTTP dates
set a minimum deadline even when longer than the backoff cap. The next serial
rotation after that deadline executes the channel; it never starts early.
Each channel owns its timing, so failures do not rewrite healthy-channel dates.
The existing sequential work can still delay other channels while it runs.

`getState().scheduleByCacheKey` exposes copies; `lastCheckByCacheKey` remains the
legacy last-success view. State is not persistent across restarts. Cancellation
does not increment failure counts. This is not a concurrent or durable scheduler,
and does not change per-request retries or cache/delivery semantics.

`tests/scheduler-safety.test.js` uses a controlled clock without sleeps. The
pre-fix reproduction made five failed-channel calls in two minutes instead of
two; healthy channels each ran once. Regression tests cover bounded backoff,
success reset, independent schedules and both Retry-After representations.
