# X3-23 — Health, liveness and readiness

## Motivation

A listening dashboard is not evidence that XFeeder's worker can process
channels. Health checks distinguish **liveness** (dashboard HTTP server is
responding) from **readiness** (a running worker has applied the current network
configuration, is accepting work and has usable persisted state).

These probes follow the separation described by the
[Kubernetes liveness/readiness probe guidance](https://kubernetes.io/docs/concepts/workloads/pods/probes/).
They do not add another HTTP listener or expose secrets.

## HTTP endpoints

These routes are served by the existing dashboard listener, after its current
Host/Origin validation:

| Route | Success | Meaning |
| --- | --- | --- |
| `GET /api/health` | 200 | Existing backwards-compatible dashboard endpoint; unchanged. |
| `GET /api/health/live` (alias `/api/live`) | 200 | Dashboard HTTP event loop is responding; independent of worker. |
| `GET /api/health/ready` (alias `/api/ready`) | 200 or 503 | Worker readiness; 503 while startup/shutdown, disconnected/stale telemetry, invalid/unapplied network config, no runnable channels or unsafe cache. |

The new endpoints return only `ok`, `service`, `status`. They are intentionally
unauthenticated for orchestrator probes, like `/api/health`, but remain
protected by the dashboard's existing Host and Origin checks. Responses have
`Cache-Control: no-store` and do not include configuration, secret values,
URLs, filesystem paths, worker identifiers, PIDs or traffic data.

## Readiness source

The worker already atomically publishes an allowlisted network-runtime snapshot
every two seconds. X3-23 adds an optional boolean `workerReady` to that
existing snapshot. It becomes true only when the queue is initialized, there
is at least one channel, the app is not shutting down, ChannelTasks is not
stopping, the network has not stopped, and **both** delivery and feed state
stores pass their fail-closed usability checks. In particular, `CACHE_UNSAFE`
cannot be hidden behind a healthy HTTP listener.

The dashboard computes readiness by validating current network config,
reading the existing runtime snapshot and confirming all of the following:
`available`, `applied`, `workerReady`, and `metrics.stopping === false`.
Existing runtime age protection rejects telemetry older than 6.5 seconds, so
a crashed/unreachable worker becomes not-ready after the staleness window.
An older worker snapshot without the new readiness flag fails closed.

This is an application-level readiness indication rather than a health check
that contacts remote feeds, Discord, Telegram or Scrapling on every probe.
It does not promise that the next external request will succeed.

## Operational usage

With dashboard running on localhost port 3000:

```sh
curl -fsS http://127.0.0.1:3000/api/health/live
curl -fsS http://127.0.0.1:3000/api/health/ready
```

A service manager may use `/api/live` to monitor the dashboard container;
`/api/ready` also depends on the separately running XFeeder worker. When
deploying both services independently, do not configure the dashboard's
liveness to depend on worker readiness: restarting the dashboard cannot
repair an offline worker. Provide appropriate startup grace for the initial
two-second telemetry update.

## Non-goals and safety

No sensitive config, environment variables, runtime state snapshots, delivery
cache contents or addresses are exposed. No extra network requests or watchdog
threads are started. There is no automatic process restart, HTTP probing of
providers or modification to the existing `/api/health` contract.

Readiness reflects worker-published state and current **network** config
signature; it does not validate every source credential or verify remote
delivery endpoints. A worker crash may remain temporarily ready until its
existing 6.5-second telemetry TTL expires. For stronger crash detection,
an external supervisor must watch the process in addition to these endpoints.

`tests/health-probes.test.js` checks success/503 cases, stale/unapplied
telemetry, missing worker flag, shutdown, broken config, DNS rebinding/Host
checks, secret-free public responses and actual runtime publication changes.
