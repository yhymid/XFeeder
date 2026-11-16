# Logging and error taxonomy — X3-12 / X3-13

XFeeder 3.0 remains a modular monolith. Logging and failure classification are
lightweight, CommonJS-compatible boundaries, not a transport/queue rewrite.

## Security and design review

Primary references:
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- Node.js Error cause: https://nodejs.org/api/errors.html#errorcause

OWASP recommends not recording authentication tokens, passwords, session
identifiers or connection credentials; also controlling log injection via
untrusted CR/LF. Node's `Error.cause` preserves the original underlying error
without modifying the network error object. Both principles guide the design.

## Logging (X3-12)

Use `createLogger(scope)` from `src/core/logger.js`. It offers
`info(message, details)`, `warn`, `error` and `debug`, using the existing
console/terminal capture as transport. Debug remains tied to Expert Debug.
Metadata passes through `core/diagnostics.sanitize`, and message/scope
through `sanitizeText`. Structured output is compact, bounded by the existing
diagnostic sanitizer, and never prints the raw Axios response/body by default.

The app bootstrap, scheduler, feed parsing/downloading, Discord source and
Discord delivery now use this boundary for their critical failures; Scrapling's
browser stderr and invalid protocol output also use it. The HTTP/client and
channel-runner paths already sanitize URL/error text and are not rewritten
merely for style. Feed parser failures are isolated: a rejected parser still
allows the next parser to handle the downloaded response.

**Limit:** Not every historical `console.*` caller or third-party output has
migrated. `core/terminal-log` still captures writes from other sources and
does not provide automatic byte-stream redaction (tokens can be split across
stream writes). Protect `debug/terminal.txt` as private runtime data; never
interpret this task as a proof that arbitrary third-party terminal output is
secret-free. Future code should use the logger rather than raw untrusted text.

## Error semantics (X3-13)

`src/core/errors.js` defines `XFeederError`, `classifyError`, and
`errorRecord`. Categories are configuration, validation, network, timeout,
cancellation, source, parser, challenge, scrapling, delivery, state,
persistence, security, and unknown.

This classifier is conservative: use an explicit context for ambiguous
provider/parser failures. Cancellation and recognized timeouts take priority.
`errorRecord` emits only category, code, HTTP status and a sanitized bounded
message, not headers, request bodies, credentials or `cause`.

The `XFeederError` wrapper is **opt-in**. Do not replace Axios errors
wholesale: existing retry, `Retry-After`, cancellation and state safety depend
on the underlying error shape. Classifying an error **does not** decide whether
a request is safe to retry; especially never replay a possibly accepted
Discord/Telegram POST without its existing delivery policy. All downstream
modules should preserve original error propagation and only derive the safe
record for logs/events/metrics.

## Compatibility

No config/cache/schema migration, new dependency or change to delivery
identity, backoff, network pacing, browser cleanup or publication semantics.
The logger is an opt-in boundary, so pre-existing stdout wording is not a
stable machine-readable API. See tests/logger.test.js and
tests/error-taxonomy.test.js for regression cases.
