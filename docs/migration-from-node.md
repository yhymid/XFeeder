# Migrating from the Node.js version (2.x / 3.0 JS alpha)

The Rust worker reads the same files, so migration is a binary swap.

1. Build `xfeeder` (see [deployment](deployment.md)).
2. Back up the data directory (`config.json`, `.env`, `cache.json`,
   `cache.feeds.json` if present).
3. Validate without posting:
   ```sh
   xfeeder --check-config
   xfeeder --dry-run --once
   ```
   Lines starting with `[Cache] … using delivery history recorded by XFeeder
   2.x` confirm that old history was found. `[Dry Run]` lines are entries that
   would be posted. They should only be entries the old worker has not
   delivered yet.
4. Stop the Node service and point its `ExecStart` at the binary, e.g.
   `ExecStart=/path/to/xfeeder --config /data/config.json --cache /data/cache.json`.
5. Start it and watch `journalctl -u xfeeder -f`.

Rollback: restore the old `ExecStart` (and the cache backup if needed).

## What carries over

| Item | Status |
|---|---|
| `config.json` (2.x and schema v2) | Same format; `${VAR}` references from `.env`. |
| `cache.json` delivery history | Reused, including 2.x channel keys and legacy per-feed buckets. |
| `cache.feeds.json` / snapshots in `cache.json` | Reused (validators, saved items, health). |
| Dashboard UI and API | Same UI, same endpoints. |
| Scrapling | Same Python worker; install it into `scrapling/.venv` next to the config. |
| Workshop plugins | **Not ported**; the section is ignored with a warning. |
| Docker image, npm scripts | Removed. |

## Notes

- Old numeric top-level keys in `cache.json` (`"0"`, `"1"`, …) from very old
  versions are left untouched and ignored.
- Discord answers `400 Unknown Channel (10003)` when a configured `Thread` no
  longer exists. The worker logs it once, stops sending to that destination for
  the rest of the channel run (instead of failing every entry, as 2.x did) and
  retries on the next interval; fix or remove the `Thread` id.
