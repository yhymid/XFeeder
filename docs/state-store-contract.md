# X3-21 — StateStore domain split and migration

## Architecture and domain boundaries

The long-lived `cache.json` was a mixed store: destination delivery IDs and
feed validators/items shared a `__xfeeder.feedSnapshots` section. From X3-21,
`src/core/state-store.js` provides three explicit domains:

| Domain | Storage | Responsibility |
| --- | --- | --- |
| `delivery` | unchanged `cache.json` | channel/source/target delivery buckets, immediate success persistence, fail-closed corruption |
| `feeds` | sibling `cache.feeds.json` | ETag, Last-Modified and cached parsed entries used by HTTP 304 replay; room for per-feed failure/HTTP metadata |
| `runtime` | memory only | diagnostic scheduler state and bounded temporary events; no disk writes |

For a custom cache filename `/data/mycache.json`, the sibling is
`/data/mycache.feeds.json`. This is not a new external database dependency.
The existing cache API is kept as `app.cacheStore` (with feed calls routed
through the new feed domain); `app.stateStore` exposes the domains explicitly.
The current channel-runner's delivery writes still target only the original
cache. Neither the config nor delivery-key/dedup schema is changed.

## Restart-safe migration from legacy feed snapshots

On startup, both stores load through the existing fail-closed JSON cache
implementation. When `cache.json` contains legacy `__xfeeder.feedSnapshots`:

1. Copy only snapshot URLs missing in the new feed store. Preserve newer copies
   if an earlier migration already completed the first write.
2. **Persist the new feed file first** using the existing temp-write/rename.
3. Only after that succeeds, remove `feedSnapshots` from the legacy cache,
   leave any other legacy metadata untouched, then persist `cache.json`.

If the feed write fails, startup fails before altering delivery state.
A crash after step 2 but before step 3 can be resumed without overwriting
the newer feed copy or losing pending-entry snapshots. An invalid feed file
blocks startup, retains the original and creates a content-addressed
quarantine, just like an invalid delivery cache. Repeated launches do not
silently start with missing validators/snapshots.

Dry runs call the same interface with `persistMigration:false`: they can
read legacy snapshots without creating the new file, deleting metadata or
writing delivery state. In-memory feed writes are not persisted.

## Methods and guarantees

- `feeds.getFeedState(url)`/`setFeedState(url,state)` support additional
  metadata (e.g. consecutiveFailures, lastSuccessAt, lastHttpStatus), while
  the existing feed-pipeline compatibility methods handle ETag and entries.
  Read results are copied to keep callers from mutating stored snapshots.
- `delivery.getState()` and `getChannelBucket()` preserve all legacy
  delivery bucket names. Destination success is still saved immediately.
- `runtime.get/set/snapshot/delete` and `appendEvent/events/prune` are
  in-memory only. Events are limited to 1000 entries. They are not a
  persisted audit log or a replacement for X3-24 event aggregation.
- `stateStore.save()` saves delivery and feed domains, including on graceful
  shutdown. X3-22 will improve the synchronous write model; X3-21 does
  **not** change cache write cadence or the process' concurrency policy.

**Important remaining limitations:** migration is restart-safe but not a
multi-file transaction; it relies on the safe order above. Existing feed
fetches do not yet calculate every optional per-feed health counter; those
can be added without changing the StateStore interface. Scheduler runtime
state is intentionally ephemeral here (persistent scheduling is a separate
future decision). Direct independent calls to `createCacheStore` retain their
old single-file semantics for compatibility and legacy tooling.

## Privacy and packaging

The sibling `*.feeds.json` can contain cached article content and
validators. It is ignored by Git and rejected by the release packager if
forcibly tracked. `cache.json` retains the same private treatment. An
administrator should back up both state files together after migrating.

## Test coverage

`tests/state-store.test.js` covers migration and restart, preserved
per-destination IDs, interrupted migration, corrupt feed files,
read-only dry-run, separate feed writes/metadata, runtime isolation and the
unchanged bootstrap cacheStore facade. Existing cache-safety,
delivery-state, feed-pipeline, 304 and shutdown tests remain CI gates.
