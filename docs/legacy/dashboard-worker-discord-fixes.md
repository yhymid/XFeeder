# Dashboard lifecycle controls and Discord delivery timing

## Sidebar collapse

When the sidebar collapses to 72px, its status is displayed as a centered
indicator. The title and dynamic status message are hidden in the collapsed
rail, instead of leaving the 11px "Unknown" text inside an undersized grid.
A tooltip and accessible label preserve the full description. Small-screen
expanded navigation retains the full text.

## Start / Stop / Restart

The dashboard now provides Start, Stop and Restart buttons, backed by
authenticated, same-origin `/api/worker/control` GET/POST requests.
The child worker is launched with explicit config/cache paths via
`process.execPath` and without a shell.

- **Start** launches a worker owned by the current dashboard process.
  It refuses startup if a separate worker is detected using the runtime
  heartbeat or its previously published still-alive process ID. Never run
  two instances against the same delivery cache.
- **Stop** sends SIGTERM to a dashboard-owned worker and waits up to 15s
  for its graceful state flush. An incomplete shutdown returns an error,
  and the dashboard does **not** launch a replacement automatically.
- **Restart** waits for the owned worker to stop before spawning a new one.
- For workers started independently (terminal, systemd, Docker, etc.),
  Stop/Restart are unavailable through this control. Use their original
  process supervisor. This prevents the dashboard from sending arbitrary
  signals based on a potentially outdated PID.
- The UI disables unavailable actions and requires confirmation for
  Stop/Restart. The dashboard may itself run without a worker.

The dashboard is not a replacement for systemd/container supervision.
There is no cross-process cache locking protocol, so a tiny race remains
if an external worker begins starting before its first telemetry update.
Do not mix manual and dashboard-managed startups for the same cache path.

## Delayed Discord messages: behavior and diagnosis

Discord webhooks formerly accepted the default `wait=false`: a HTTP 204
could indicate the webhook request was accepted without returning a saved
message object. The sender now forces `wait=true` while preserving
Components V2 and thread ID query parameters.

This allows the sender to wait for the provider response confirming the
message. A normal successful Discord response contains a created message
identifier. The sender logs **provider response milliseconds** and whether
a message ID was present, without logging the webhook URL or the ID.
Provider 429 responses still follow the existing bounded retry policy.

The channel runner additionally measures the awaited durable cache write.
If that operation exceeds 1,000ms, it reports a sanitized warning with
`durationMs`. This distinguishes an API wait/rate limit from an expensive
local fsync. A normal 500ms pacing delay still occurs between sends.

These changes do **not** prove which delay occurred on a particular host:
the actual API response timestamps and cache-write warnings are needed to
diagnose that. Display latency inside a Discord client can also differ from
API confirmation.

**Never delete cache.json as a latency fix.** Cache files contain delivered
IDs, including destination-aware deduplication. Deleting them can cause
historical items to be sent again. Keep both `cache.json` and
`cache.feeds.json` when troubleshooting or backing up state.

## Verification

`tests/worker-control.test.js` covers process ownership, duplicate-start
refusal, stale-heartbeat PID checks, authenticated control endpoints,
rejected invalid actions and graceful stop/restart. The existing dashboard
and lifecycle tests remain regression gates.

`tests/delivery-discord.test.js` confirms that an unconfigured webhook
uses `wait=true` and delivery does not resolve until the provider sends
its success response. Delivery/cache tests continue to verify persistence
before the next destination begins.
