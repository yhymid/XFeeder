# Contributing

```sh
cargo fmt
cargo clippy --all-targets
cargo test
```

- Keep `config.json`, `cache.json` and the dashboard API compatible with
  existing installations. Changes to entry identity or cache keys cause
  re-posts or lost history and need a migration.
- Never commit `.env`, `config.json`, `cache*.json`, `*.runtime.json`, tokens or
  webhook URLs. Use the fixtures in `tests/fixtures`.
- Test against real data with `--dry-run --once` (no posts, no cache writes).
- One behaviour change per commit; describe compatibility impact.
