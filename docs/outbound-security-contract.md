# X3-19 — Content limits and SSRF protection

## Threat model / research

A user-supplied feed URL, parser follow-up URL or redirected HTTP request can
try to contact local interfaces, metadata services or other private network
destinations (CWE-918). URL string validation alone is insufficient because
numeric IP encodings, DNS rebinding and redirects can change the address
actually contacted. A separate risk is oversized or decompression-expanded
HTTP responses, especially when using `responseType: "stream"`.

References:
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html): address resolution validation, redirect protection, defense in depth.
- [Axios streamed maxContentLength advisory GHSA-vf2m-468p-8v99](https://github.com/axios/axios/security/advisories/GHSA-vf2m-468p-8v99): older Axios streaming code can bypass buffered-body size limits.
- [Node DNS lookup contract](https://nodejs.org/api/dns.html#dnslookuphostname-options-callback): lookup happens at connection time.

## New settings (opt-in for compatibility)

Place fields inside the existing `network` object in `config.json`:

```json
{
  "network": {
    "outboundPolicy": "public-only",
    "maxResponseBytes": 8388608
  }
}
```

- `outboundPolicy`: `"unrestricted"` (existing-compatible default) or
  `"public-only"`. The default deliberately does **not** prevent SSRF:
  existing deployments use LAN/local feeds, proxies and a standalone browser.
  Enable `public-only` to protect an installation that processes feeds
  supplied by untrusted parties.
- `maxResponseBytes`: null/unset (unlimited, legacy default) or a positive
  integer, 1–268435456 bytes (256 MiB). 8388608 is an example *recommendation*,
  not an implicit new default. Applies to responses using the managed Axios
  adapter, after decoding for buffered and streamed responses. An explicitly
  smaller Axios `maxContentLength` still wins; explicit streaming limits are
  enforced as well.

Both fields use existing network validation. Invalid settings fail with
`INVALID_NETWORK_CONFIG`; there is no cache migration.

## Strict public-only mode

At the managed HTTP adapter boundary, the mode:

1. Rejects non-HTTP(S) URLs, URL credentials, loopback/private/link-local/
   metadata/reserved IPv4 and non-global IPv6 literals (including alternate
   encodings normalized by the WHATWG URL parser).
2. Validates DNS results **during socket resolution**, rejects mixed
   public/private answers and returns only the checked addresses. This
   avoids a separate preflight DNS lookup followed by an unchecked lookup.
3. Disables automatic HTTP redirects (`maxRedirects: 0`). A redirect is a
   non-successful response, not permission to contact a second destination.
   Requests that rely on redirects must use unrestricted mode or be updated
   to use an approved direct endpoint.
4. Disallows custom transports, agents, Unix sockets, custom DNS lookups and
   external proxies in strict mode. Proxy resolution could bypass local
   socket checks. Environment proxy variables are ignored in strict mode.
5. Disables automatic and forced Scrapling/browser fallback in the standard
   downloader when strict egress is active, since Python/Chromium do not use
   Node's protected socket lookup.

`OUTBOUND_TARGET_BLOCKED` is returned for blocked managed HTTP requests;
no socket should be opened for rejected direct IP/localhost requests.
The decision is made per request based on the active validated Network
Service config. DNS failures are not reclassified as successful downloads.

**Important limitations:** this is opt-in application-layer protection, not
an OS firewall. It does not secure arbitrary third-party plugins or
independent browser calls outside the standard downloader, local file access,
and standalone non-HTTP network clients. For adversarial deployments, also
enforce host/container egress ACLs, restrict metadata routes and untrusted
plugin capabilities. Strict mode currently prioritizes safety over HTTP
redirect and proxy compatibility; there is no implicit private-host allowlist.

## Content limits

When `maxResponseBytes` is set, buffered managed Axios responses get a
bounded `maxContentLength`. Stream responses are wrapped in a bounded
Transform, which counts bytes delivered after Axios decoding and destroys
the underlying source on overflow. The stream reports
`ERR_RESPONSE_TOO_LARGE`, and the managed operation/HTTP permit is released
through the existing cleanup lifecycle. This prevents bypasses where
`responseType: "stream"` does not enforce buffered-body limits.

This setting is **per response**, not a cumulative request budget. It does
not cap Python/Chromium Scrapling downloads, raw upload sizes, or unbounded
third-party transports outside managed HTTP. An explicitly smaller
per-request `maxContentLength` is still supported.

## Regression tests and compatibility

`tests/outbound-security.test.js` covers:
- configuration validation and legacy defaults;
- reserved IPv4/IPv6, localhost, alternate numeric URL forms and URL userinfo;
- socket-level DNS answer checks and mixed-address rejection;
- proxy/agent bypass rejection and zero-redirect policy;
- blocked loopback HTTP GET/POST before socket connection;
- buffered response over-limit and streamed over-limit cleanup;
- opt-in `maxContentLength` on streams; forced browser fallback is prohibited.

Pre-existing HTTP, TLS, proxy, retry, downloader, Scrapling, Network Usage
Control, delivery, cache and startup tests must continue passing with the
legacy (unrestricted) default. No existing feed starts failing merely because
the new feature exists.
