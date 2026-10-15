# X3-24 / X3-25 — Structured Activity and Metrics Registry

## EventBus

Worker activity does not depend on parsing debug/terminal.txt or on
enabling Expert Debug. The dashboard and worker are separate processes;
they use one bounded privacy-safe snapshot, not a shared event emitter.

src/core/event-bus.js subscribes to the existing instrumentation through
subscribeActivity(), independently of console output. Only a fixed set
of domain event types is accepted, including worker.started/stopped,
channel.started/completed/failed, feed.fetch.started/completed,
feed.not_modified, feed.parse.completed, feed.failed,
delivery.sent/failed, scrapling.used and config.reloaded.

Events have an ID, timestamp, type, level, **hashed** channel and source
IDs, optionally a fixed destination, HTTP status, duration, item count
and safe error code. Raw source URLs, request/response bodies, headers,
credentials, arbitrary messages, error text and stack traces are never
copied. Invalid events are ignored. Event listeners cannot break the
delivery pipeline.

The worker holds at most 2,000 events in a bounded ring. Every two
seconds src/core/activity-runtime.js atomically publishes them alongside
a metrics snapshot into a private (0600) sibling config activity-runtime
JSON file. The whole snapshot is limited to 2 MiB. Writes are best-effort:
telemetry failure cannot stop delivery. After a process restart, counters
reset; the file preserves a limited post-mortem activity view.

## Dashboard

GET /api/activity uses the structured snapshot when present.
A compatibility-only fallback reads the last 2 MiB of legacy Expert Debug
logs when an older worker has not produced structured activity.
The UI shows which source was used. Event collection no longer requires
switching on Expert Debug.

GET /api/metrics requires the existing dashboard session. The dashboard
explicitly reconstructs public fields from the local runtime snapshot,
rather than returning arbitrary JSON fields. Existing Host/Origin checks
remain enforced. No additional server port is opened.

## Metrics

Counters: feed_fetch_total, feed_fetch_error_total,
feed_not_modified_total, items_parsed_total,
scrapling_fallback_total, and delivery_total by fixed webhook/telegram
destination and success/error status.

Gauges: active_jobs, queue_due_channels, failing_feeds.
The last is a bounded observed set of up to 256 hashed failing feeds;
it is not a durable count of every configured feed.

Histograms: feed_fetch_duration_ms, channel_run_duration_ms,
delivery_duration_ms with fixed bucket boundaries 100, 500, 1000,
5000 and 30000 ms, plus overflow, min/max/count/sum.

No source URL, hostname, channel name, token, error message or other
untrusted label is used as a metric dimension. Counters are process-local
and may omit in-flight work if the worker crashes. Queue- and channel-level
events can overlap, so this telemetry is not an audit-grade exact-once
ledger. See the X3-21/X3-22 delivery persistence contracts for delivery
state guarantees.

## Scope and limitations

The instrumentation reuses existing expert event producers rather than
changing HTTP, parser or delivery semantics. Observability is best-effort,
bounded and never a gate for sending. The release packager and .gitignore
exclude private runtime snapshots. A separate OpenTelemetry/Prometheus
exporter is intentionally deferred.

Reference material:
- https://nodejs.org/api/events.html
- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- https://prometheus.io/docs/concepts/metric_types/
- https://opentelemetry.io/docs/languages/js/

## NET-10 — Network accounting bridge

The worker Metrics Registry now samples the existing NetworkService
metricsSnapshot() in-process. Its network field reports actual HTTP
transport-body accounting alongside transfer rates, HTTP/Scrapling
concurrency, effective bandwidth preset and limits, and Friendly Mode.
It does not install a second byte counter or re-count responses from
EventBus. No per-chunk events or new log lines are emitted.

The network counters count **bytes the managed HTTP transport observes**.
An HTTP 503 followed by a successful retry is genuine traffic twice and
both attempted responses count; a gzip response contributes compressed
wire-body bytes, **not** the expanded parser payload length.
Response headers, TLS framing and redirects may be outside the
available body-byte accounting. Upload stream/replay enforcement is
still limited as documented by Network Service.

Current speeds use existing fixed-size five-second windows calculated
using Node's monotonic performance clock. This provides an approximate
rate, not bandwidth measurement at the NIC.

The browser/Python Scrapling transport is outside Node HTTP byte
accounting. The metrics explicitly report
scraplingBytes.status = "unavailable" and null byte totals, rather than
inventing an estimate or silently mixing browser bytes into HTTP totals.
Scrapling active and waiting *task counts* remain available.

Only a fixed whitelist of numeric counters, limits, profile and booleans
reaches the dashboard via authenticated GET /api/metrics. Snapshot
redaction deliberately ignores additional runtime JSON fields.
The original GET /api/network/metrics API remains unchanged.

Regression coverage: tests/network-metrics-bridge.test.js verifies
a retry plus gzip response's actual managed transport-body byte count,
no extra counting from repeated metrics snapshots, fixed field
whitelisting, missing browser byte totals, and nonfatal measurement
callback failures.
