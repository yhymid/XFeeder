# X3-22 — Asynchronous atomic StateStore writes

## Motivation

Before X3-22, `cacheStore.save()` synchronously serialized and wrote all
delivery history on the event loop after each successful destination. An
asynchronous conversion must not weaken the strict XFeeder guarantee:

> A confirmed destination write finishes on disk **before** the next target
> can be attempted. A failed write never marks a destination durable.

`X3-22` changes the production path; it does not change delivery keys,
cache JSON schemas, retries, source adapters, network controls or dedup.

## Atomic writer and ordering

`createCacheStore` retains synchronous `save()` for legacy tooling and
fixtures and adds `saveAsync()` and `flush()`:

1. Serialize a JSON snapshot **when** `saveAsync()` is invoked; concurrent
   writes cannot serialize a newer state into an older queued write.
2. Serialize writes for a given cache-store instance in invocation order.
3. Create a unique same-directory temporary file with exclusive `wx` and
   restrictive permissions, write the full JSON, and `fsync` that file.
4. Close and atomically rename it over the destination, then attempt to
   `fsync` the containing directory (unsupported directory-fsync platforms
   are tolerated).
5. Delete temporary files on failure; preserve the last complete
   destination file. A write failure latches `CACHE_UNSAFE`, blocking
   further reads, writes and delivery processing until restarted with
   verified on-disk state.

The writer makes no claim of multi-process coordination or atomic commits
across **both** state files. Only one XFeeder writer per cache path is
supported. External concurrent writers must use a separate lock/transaction
protocol in a future task.

## Integrations

- `app.cacheStore.save()` is backed by the async delivery write. The
  channel runner **awaits** it after each confirmed destination success.
  Sync-only injected fixture stores remain compatible because awaiting
  `undefined` is harmless.
- The feed pipeline awaits `setFeedSnapshot`. The production callback
  persists through `stateStore.feeds.setFeedSnapshotAsync`; an I/O failure
  with `CACHE_UNSAFE` propagates instead of being mistaken for a parser
  error or allowing fallthrough to another parser.
- `app.shutdown()` awaits `stateStore.saveAsync()` after stopping network
  and tasks. Delivery state is flushed first, then feed snapshots. A failed
  flush causes shutdown to report failure rather than a clean exit.
- StateStore also exposes `saveAsync()` and `flush()` over both domains.
  Its original synchronous `save()` is retained for the migration
  helper/tests.
- The X3-21 restart-safe snapshot migration continues to copy feed data to
  the separate file **before** removing its legacy copy.

## Crash model

Atomic rename avoids a torn *visible* JSON document during interrupted
writes. File sync plus directory sync improves durability after process/host
failure on supported filesystems, but cannot guarantee survival of faulty
hardware, unsafe filesystem caching or a crash during an external provider
request. If the provider accepted a POST while the process died before
receiving confirmation, XFeeder cannot know whether that POST succeeded.
The existing per-destination best-effort delivery policy and lack of
automatic ambiguous POST retries are unchanged; strict exactly-once
delivery is not claimed.

## Regression coverage

`tests/async-cache.test.js` tests overlapping writes, ordered snapshots,
atomic rename interruption, temporary-file cleanup, persistent error latch,
delivery write barriers, 304 snapshot persistence and fail-closed parser
errors. The existing delivery-state, cache-safety, shutdown, network and
Scrapling tests remain CI gates.

## Compatibility boundary

Direct `createCacheStore().save()` and
`app.cacheStore.setFeedSnapshot()` still support the older synchronous
interface for test/external integrations. Production feed and delivery
work use the awaited async path. Callers using `app.cacheStore.save()`
should now await its returned Promise.
