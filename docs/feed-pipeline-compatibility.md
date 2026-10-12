# Feed pipeline compatibility — X3-05

X3-05 records existing 2.2.0 behavior on `3.0-dev` before source adapters are
refactored. It adds offline fixtures and separates fetch, detection, parsing,
identity/deduplication and pipeline decisions into tests. Production code,
dependencies, configuration format, package version and Node minimum are unchanged.

## Test boundaries

| Test file | Protected behavior |
| --- | --- |
| `tests/feed-fetch.test.js` | Real loopback HTTP, validator headers, bodyless 304, 403 fallback policies, Scrapling result metadata, unresolved challenges, deadline and cancellation cleanup |
| `tests/feed-parsers.test.js` | RSS 2.0, Atom, JSON Feed and YouTube entry fields; invalid XML, HTML and empty feed handling; malformed dates; heuristic detection tested separately from parsing |
| `tests/feed-identity.test.js` | Tracking URL normalization, link/GUID precedence, duplicate identity, stable content fallback and current bounded cache-list behavior |
| `tests/feed-pipeline.test.js` | Parser selection in the recorded bootstrap order, response reuse, parser fallthrough, request context/config refresh, snapshot persistence/replay, cancellation and duplicate preservation |

The [fixture directory](../tests/fixtures/feed-pipeline/README.md) describes nine
synthetic documents. Stateful 304/403/timeout responses are local server fixtures
in the fetch tests. YouTube URLs select the parser but never cause real provider
requests. Browser work is replaced at the `Scrapling.fetch` boundary; Python and
browser binaries are not needed. Existing network and challenge-page tests remain
in the full suite.

The pipeline tests explicitly record the current bootstrap parser order:
YouTube → Atom → XML → JSON → generic API → RSS regex → HTML fallback.
They exercise `createFeedPipeline` directly, not the application scheduler. A
matching parser ends traversal, and parsers requesting the original URL share the
initial download. Secondary GET/POST requests keep the active configuration,
configuration path and cancellation signal.

## Current decisions and limitations

- ETag and Last-Modified are saved from response headers without case sensitivity.
  A 304 replays the previous parsed entries without running parsers or rewriting
  the snapshot; a missing snapshot yields an empty list.
- A transport timeout can replay cached pending entries and reports failure through
  the runtime context. Invalid/unsupported source URLs and unresolved challenges
  do not replay entries. Cancellation propagates without saving partial results.
- A 403 reaches Scrapling only when existing policy allows it. Global disable,
  `AutoFallback: false` and per-URL disable suppress that fallback. Explicit
  per-URL enable forces Scrapling even when automatic fallback is disabled.
  A second challenge is still rejected, within the configured attempt limit.
- Format detection examines text markers; it can label malformed XML as RSS.
  It is not a validator and is not the main pipeline's parser dispatch mechanism.
- XML/RSS/Atom parsers return no entries for the supplied invalid, empty or HTML
  documents. The full chain intentionally supports ordinary article HTML through
  metadata fallback. **Known limitation:** that permissive fallback also turns the
  empty or malformed XML fixture into a substitute entry. X3-05 characterizes this
  behavior; it does not fix it or claim that all malformed feeds are rejected.
- Parsing and the feed snapshot preserve duplicate entries. Identity prefers the
  normalized link over GUID: identical GUIDs with different links remain distinct,
  while identical links share a key. Tracking parameters and fragments are removed.
  `pushCache` prepends/caps identifiers but does not itself deduplicate them. These
  tests do not assert that same-batch duplicates can never be delivered.
- Invalid dates become null in the dedicated parsers. Atom prefers `updated`,
  YouTube prefers `published`. Several missing-date paths still use the current
  time; X3-05 does not introduce a clock abstraction or sorting policy.
- XML RSS keeps categories, while the regex RSS parser drops them and uses an empty
  missing author. Atom categories retain their parsed attribute objects. JSON Feed
  parsing expects an already-decoded response and currently reads legacy `author`
  fields. These fixtures do not establish complete standards conformance.

Research references used for fixture design:
[RSS 2.0](https://www.rssboard.org/rss-specification),
[Atom RFC 4287](https://www.rfc-editor.org/info/rfc4287/),
[JSON Feed 1.1](https://www.jsonfeed.org/version/1.1/), and
[HTTP conditional requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests).
Expected results reflect the current code, including the limitations above.

## Validation — 2026-10-12

- 47 new tests: 9 fetch/fallback, 13 parsing/detection, 6 identity and 19 pipeline.
- Targeted tests pass on Node 26.11.1 and minimum Node 20.18.1: 47 passed, 0 failed,
  0 skipped on each version.
- Full `npm test` on Node 26.11.1: 287 passed, 0 failed, 0 skipped.
- `node main.js --check-config --config tests/fixtures/config/channel-groups.json`:
  4 channels, zero warnings; no network access.
- Syntax checks and `git diff --check` pass.

Changed files: the four test files listed above, nine document fixtures and their
README under `tests/fixtures/feed-pipeline/`, and this compatibility record.

Deferred: X3-06 delivery regressions, source adapter refactoring, and decisions
about permissive malformed/empty-feed fallback, batch deduplication and broader
standards support. No later numbered task was started.
