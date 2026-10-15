# X3-32 — Dashboard API cleanup (compatibility phase)

## Motivation and current status

The original browser editor still reads /api/state, a single payload with
raw legacy configuration and summary metadata. Removing that endpoint before
the browser is migrated would make existing deployments unusable. Instead,
X3-32 introduces a new, separately authenticated **safe-by-default API**
while retaining the old route as a clearly marked deprecated compatibility
contract. The current v2 editor remains a separate follow-up.

## Safe read models

All routes below require the same dashboard session and existing Host/Origin
policy. They send Cache-Control: no-store and ETag from the current config
revision, never exposing raw .env, webhook URLs, feed URLs, provider tokens,
credentials, cache entries, environment paths, or config paths:

- GET /api/overview: readiness, channel/feed counts and destination totals.
- GET /api/channels: allowlisted summaries with a stable opaque ID, label,
  frequency, max entries, source counts and boolean destination availability.
- GET /api/channels/:id: the same summary for a single known opaque ID,
  400 for malformed IDs and 404 for unknown IDs.
- GET /api/settings: safe general flags, concurrency, proxy/Scrapling booleans
  and the already allowlisted Network Service settings.
- GET /api/system/info: version, config schema version, worker readiness and
  opaque configuration revision.

Channel IDs are SHA-256-derived 24-hex-character identifiers from the
configuration group and channel name or index. They do not embed feed URLs,
provider IDs, secrets or cache keys, and are only API locators. They can change
when a channel is renamed or an unnamed array is reordered. **They are not
the persisted delivery/cache identity**, which is deliberately unchanged.

## Conditional writes

PUT /api/settings accepts only general.logs, general.expertDiagnostics and
general.maxConcurrentChannels. It rejects unknown fields and out-of-range
values. It preserves all other config sections, including inline credentials,
and supports both legacy and schema v2 in place.

GET /api/advanced/config is explicit advanced access and may include raw
inline secrets. It must **never** be fetched by normal overview or settings
pages. It returns a warning and ETag, and does not return .env.

PUT /api/advanced/config accepts a complete, validated legacy or v2 config,
but only with a session, trusted Origin, exact If-Match ETag, and acknowledged
warnings where applicable. It uses the existing same-directory atomic write
and restrictive file permissions. 428 is returned when If-Match is absent,
412 when a different process/tab saved an intervening revision, and
400/422 when validation fails/warnings need confirmation. The write response
contains only success and a new revision, not the submitted secrets.

Existing /api/config, /api/state and /api/env remain available for the
legacy editor. GET /api/state is marked with Deprecation: true and successor
Link. The existing raw .env replacement route is still restricted by
authentication and same-origin checks. It is not recommended for default UI.

## Remaining X3-32 work

- Migrate the browser editor away from /api/state and legacy raw .env editing.
  This includes a purpose-built v2 editor and a separate Advanced JSON page.
- PUT /api/channels/:id and POST /api/channels/:id/run require explicit
  compatibility design. In particular, run-now needs a secure
  dashboard-to-worker command channel rather than a false HTTP success or
  a second worker instance using the same cache.
- Decide when the deprecated legacy routes can be removed, in a breaking
  release only after browser migration and documented transition.
- After completing the entire X3-32 scope, integrate NET-11/NET-12 using
  the safe new API. This first phase is not a claim of full roadmap completion.

## Regression

tests/dashboard-api-v2.test.js covers authenticated read projections,
v1/v2 configs, prevention of raw credential/source disclosure, invalid
and missing channel IDs, trusted-Origin enforcement, if-match revision
conflicts, safe partial settings updates, and atomic v2 advanced writes.
Existing dashboard-security/config migration and Node 22/24/26 CI remain
gates, together with Scrapling browser smoke.

References:
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Match
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/412
- https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
