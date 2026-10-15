# X3-17 — Shared HTTP client contract

## Findings and research

XFeeder already has a proven managed transport: `src/network/http-adapter.js`
wraps Axios's Node adapter, and `NetworkService` owns HTTP admission,
download/upload budgets, per-request deadlines, stream release, metrics and
graceful cancellation. The HTTP GET policy in `src/client.js` additionally
provides bounded transient retries and 304 handling. Discord and Telegram
delivery send directly through Axios with this same managed adapter, with
provider-specific timeout and retry decisions.

Relevant upstream contracts:
- Axios request config (custom `adapter` and `signal`):
  https://github.com/axios/axios/blob/v1.x/docs/pages/advanced/request-config.md
- Node.js `AsyncLocalStorage` (channel-local asynchronous context):
  https://nodejs.org/api/async_context.html

Replacing the Axios transport with native fetch or reimplementing redirects,
proxies or stream consumption at this point would risk changing the tested
Network Usage Control, proxy CONNECT, HTTPS verification, cancellation and
provider delivery semantics. **X3-17 does not replace the transport.**

## Implementation

`src/network/http-client.js` centralizes the mandatory managed adapter:
- `createManagedClient(defaults)`: creates the existing Axios instance for
  feed GET/POST and authenticated Discord-source GET, retaining its configured
  headers, per-config proxy agents, client cache and default timeouts.
- `postManaged(url, data, options)`: uses Axios's original static
  `axios.post()` interface with `networkAdapter`. This keeps existing
  provider test seams, defaults, payloads, error objects, and each provider's
  manual retry semantics intact. If no explicit signal is supplied it inherits
  the current channel context's signal. An explicitly supplied value
  (including `null`) remains authoritative. Custom adapter overrides cannot
  bypass the managed network transport through this boundary.

The existing application still owns feed retries in `getWithFallback`,
one-shot `postWithFallback` behavior, source fallbacks in the downloader,
Discord webhook 429 retries in `message.js`, and Telegram one-shot delivery
in `telegram.js`. This preserves the rule that an ambiguously accepted POST
must not be automatically replayed.

## Invariants and non-goals

- One HTTP transport implementation, reusing the existing network adapter.
- No new global HTTP client cache, configuration schema, or proxy policy.
- No HTTP/2 switch, native fetch migration, new dependencies or extra retries.
- Existing link identity, destination-aware dedup, success persistence,
  conditional requests/304 snapshots and Scrapling fallback stay unchanged.
- Error code/status/cancellation and `Retry-After` values remain available
  to the existing scheduler and delivery code.
- Runtime Network Service still enforces admission/bandwidth. This facade
  does not claim that third-party Python/Chromium traffic is rate-shaped.
- `tests/http-client-contract.test.js` protects shared adapter configuration,
  option immutability, inherited/explicit signals, unchanged provider POST
  handling, loopback bytes, no retry on HTTP 503 and active-operation cleanup.

## Deferred

X3-18 will review shared retry/backoff policies without retrying ambiguous
POSTs. X3-19 will separately review outbound URL validation, redirects and
SSRF exposure with explicit security fixtures. HTTP transport replacement is
out of scope until parity tests cover its behavior.
