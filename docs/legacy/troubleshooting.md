# Troubleshooting

## Worker starts but no messages arrive

Run `npm run check-config`, then `npm run start:dry-run`. Confirm a channel has real feeds and a correctly configured destination. Check feed HTTP status, `TimeChecker`, `RequestSend`, retry/backoff and whether the item was already delivered. Do not delete `cache.json` to force sending; that can duplicate historical posts.

## Dashboard is available but worker is not ready

`/api/live` tests dashboard liveness. `/api/ready` returns 503 when the worker is unavailable, shutting down, has stale telemetry, invalid network settings or unsafe state. Check both processes and whether they use the same config/data directory. `/api/health` is the older dashboard endpoint and does not prove worker readiness.

## Unauthorized dashboard / HTTPS session problem

Use a strong `XFEEDER_DASHBOARD_PASSWORD` in the dashboard **service** environment. Behind HTTPS set `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` to the exact public origin and keep the backend bound to loopback. Check reverse-proxy Host/Origin behavior; do not disable CSRF protections to fix mismatches.

## Scrapling browser unavailable

Standard feed parsing still works without Scrapling. Run `npm run scrapling:check` and read `src/extensions/Scrapling/readme.md`. Python/Playwright/Patchright/Chromium versions must match the pinned environment. Docker's default Node image does not include Scrapling. `public-only` networking intentionally disables browser fallback.

## Cache or snapshot reports CACHE_UNSAFE

**Stop the worker.** Preserve both cache files and their corrupt/quarantine copies. Check disk space and permissions, then restore verified backups if needed; do not remove an unreadable cache to suppress errors. Only one worker may write a cache at a time. See `docs/async-state-contract.md` and `docs/state-store-contract.md`.

## Network loss, rate limits or missing feed entries

Check response status, timeouts, HTTP 304 replay, per-channel Retry-After and Network Usage Control. Proxy/redirect restrictions apply in strict outbound mode. Some sites block automation and cannot be reliably retrieved. Do not bypass account security measures or repeatedly retry a failing provider POST.

## Dependency or package installation failure

Use `npm ci` (not `npm install` to silently rewrite the lock), then `npm run deps:check`. For a supported patch/minor upgrade run `npm run deps:refresh -- <package> <exact-version>` with npm registry access and rerun all tests. Python dependencies are pinned separately.

## Capturing a bug report safely

Record the exact commit, OS/Node/Python versions, affected command, relevant HTTP status/error code and sanitized minimal config. Remove webhooks, passwords, cookies, tokens, personally identifiable content, cache records and full URLs with embedded secrets before sharing logs. For security issues use the private process in `SECURITY.md`.
