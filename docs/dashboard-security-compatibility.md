# Dashboard API and security compatibility — X3-07

X3-07 records the existing dashboard behavior before the X3-11 security refactor.
It adds regression tests and a shared test helper only. Production code,
configuration/cache formats, dependencies, Node minimum and package version
remain unchanged. Passing these tests does not mean the deferred security
hardening is complete.

## Regression boundaries

| Test file | New tests | Coverage |
| --- | ---: | --- |
| `tests/dashboard-auth.test.js` | 14 | Public versus protected endpoints, successful/failed/malformed login, cookie attributes, TTL/defaults, forged cookies, logout/replay, separate sessions/server instances, exact expiry, sliding server expiry, local-open mode and passwordless non-loopback rejection |
| `tests/dashboard-mutations.test.js` | 11 | Validation without writes, config round trip and raw env references, revision conflicts, malformed JSON, invalid roots/settings, warning acknowledgement, env writes, origin rejection without file/session changes, existing missing-Origin and Host-derived behavior |
| `tests/dashboard-boundaries.test.js` | 18 | Raw traversal probes, static-path normalization, unsupported methods, response/cache headers, exact and exceeded 2 MiB body limits, UTF-8/chunked bodies, configured HTTPS origin, forwarded-header spoofing and invalid public-origin configuration |

`tests/helpers/dashboard.cjs` starts the actual server on an ephemeral loopback
port with temporary config, env and cache files containing synthetic data. It
restores auth environment overrides immediately after server creation and closes
connections at teardown. Requests have a bounded timeout. Raw HTTP paths reach
the server without client-side URL normalization, so traversal probes exercise
the server's path handling. Tests do not use real credentials or user state.

Oversized-body tests distinguish connection reset from an unrelated error or
timeout, compare file contents, and check that the server remains usable.
Byte-limit cases include multibyte data shorter than the limit in JavaScript
characters and chunked HTTP without Content-Length. Session tests replace
`Date.now` locally rather than waiting for a real session to expire.

Existing `tests/dashboard.test.js`, `tests/network-api.test.js` and
`tests/reverse-proxy.test.js` remain in the full suite. They retain the original
dashboard/model, Network revision/metrics/redaction and actual HTTPS reverse
proxy coverage. The new HTTPS-origin cases exercise the HTTP backend and cookie
headers; they do not simulate browser cookie storage or browser CSRF behavior.

## Historical X3-07 guarantees and limitations (superseded below)

- With a password configured, protected API routes reject anonymous requests.
  Health/auth state and static assets remain public. Passwordless mode is allowed
  for a loopback bind; a passwordless non-loopback bind is rejected.
- Sessions are held separately in memory for each server instance. Logout removes
  the supplied session and expires its cookie without revoking other sessions.
  Cookies use Path=/, HttpOnly and SameSite=Strict. Secure is set when the configured
  public origin uses HTTPS. Active authenticated reads extend server expiry,
  but do not reissue the cookie or extend its original browser Max-Age.
- On login/logout, validation and write routes, a nonempty Origin must exactly
  match the expected origin; literal `null` is rejected. GET routes do not enforce
  Origin. Missing Origin is currently accepted. Without a configured public
  origin, the expected value is derived from the request's Host using HTTP.
  These last two behaviors are characterization tests, not recommended security
  guarantees; X3-11 must replace their assertions when tightening the policy.
- `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` pins an exact HTTP(S) origin without path or
  trailing slash. Host and forwarded headers cannot replace that pinned value.
  Forwarded HTTPS headers alone do not enable HTTPS matching or Secure cookies.
- Invalid config/env payloads, stale supplied revisions, unacknowledged warnings
  and rejected origins leave the fixture files unchanged. Successful config writes
  retain raw env references and unrelated options. Full config revision checking
  is optional; Network writes already require If-Match. Env writes do not have a
  revision guard. Successful writes use the existing temporary-file rename path;
  these tests do not simulate disk failure or concurrent writers.
- The body limit is 2 MiB of bytes. Exceeding it currently destroys the request,
  producing a client connection error instead of a structured HTTP 413 response.
- Tested traversal paths cannot expose server code or fixture config/env/cache.
  Dot segments can normalize to a public asset. This is a bounded regression set,
  not an exhaustive filesystem, symlink or malformed-request security audit.
- The authenticated advanced state API still returns raw config and env content.
  The anonymous-access tests do not imply all authenticated responses redact
  secrets. Source inspection also confirms no login rate limit or explicit session
  count cap; those protections are not implemented by this task.

## Research and deferred work

The test selection was informed by the
[OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html),
[OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
and [MDN Origin reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin).
They provide review criteria rather than a claim that current behavior satisfies
every recommendation.

Deferred to X3-11: origin/Host trust policy, authentication abuse protection,
session limits and cookie expiry policy, authenticated secret exposure policy,
and explicit oversized-request responses. Broader hardening must update the
characterization tests deliberately rather than preserving known limitations.
X3-08 and all later numbered tasks have not been started in this change.

## Validation — 2026-10-13

- New tests: 43 passed on Node 26.11.1 and minimum Node 20.18.1;
  0 failed, 0 skipped on both versions.
- Full `npm test` on Node 26.11.1: 382 passed, 0 failed, 0 skipped.
- `node main.js --check-config --config tests/fixtures/config/channel-groups.json`:
  4 channels, zero warnings.
- Syntax checks for all four added JavaScript files and `git diff --check`: passed.

Changed files: the three test files, `tests/helpers/dashboard.cjs` and this document.
There are no production changes or configuration migrations in X3-07.

## C3-03 hardening — 2026-10-15

The characterization tests for insecure behavior were replaced deliberately.
Host is now checked against configured public authority or bind/loopback
authorities with the actual listening port. Public Origin, when configured, is
the sole accepted Origin; otherwise a fixed local/bind whitelist is used.
All mutation/login requests require Origin; supplied hostile Origins are rejected
on reads too. Forwarded headers never establish authority. Reverse proxies must
preserve the configured public Host or use an allowed backend authority.

State and write responses return `envStatus` (configured/missing), never raw
`.env`. The UI offers a write-only, explicitly confirmed full replacement; it
does not download existing secrets. Config editing still returns raw config
(including explicitly stored inline credentials required by its existing editor);
use environment references to keep secrets out of the config response.
Environment files are created privately (0600 on POSIX) through an exclusive
random temporary file, then renamed. Config PUT now requires an exact If-Match
revision (428 missing, 412 stale); the existing UI already supplies it.

Password login is globally capped at ten attempts per minute per server, including
malformed bodies and successful attempts. The fixed window uses constant memory,
ignores forwarded client identities, and returns 429/Retry-After. Sessions are
capped at 256. A saturated login window can delay legitimate logins for up to a
minute; authenticated sessions and health reads remain available. This is local
process protection, not a distributed abuse prevention service. Env writes still
replace the full file and do not provide merge or revision semantics.
