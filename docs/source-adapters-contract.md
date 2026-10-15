# X3-15 — Source adapter contract

## Scope

The bootstrap previously listed seven parser functions directly and injected
the Discord parser separately. X3-15 moves source ownership to
`src/core/source-adapters.js`, retaining the established modular-monolith
boundaries. This is a registry and dependency-injection refactor, not a new
network client, feed format, or source authentication mechanism.

## Existing source behavior

Feed parsing remains in this exact priority order:

1. `parseYouTube`
2. `parseAtom`
3. `parseXML`
4. `parseJSON`
5. `parseApiX`
6. `parseRSS`
7. `parseFallback`

The registry exports the **original function references** through
`feedParsers` (no wrapper, extra fetch, or parser rename). The feed pipeline
still handles the initial HTTP/Scrapling download, shares downloaded content
with parser HTTP clients, preserves conditional requests/304 snapshot replay,
blocks unresolved challenges, and falls through to another parser on failure.

Discord is a distinct source with `read(config)`. It receives a managed HTTP
client on each invocation through `getDiscordHttpClient`, so current
configuration and Network Service options remain fresh. Constructing a
registry does not create a client or make a request. A missing HTTP provider
throws rather than quietly invoking the Discord parser with an unmanaged
Axios default.

`createSourceAdapters` accepts injected parser functions / a custom feed
adapter array for future sources. Each feed adapter provides `id` and `parse`;
identifiers must be unique and `parse` must be a function. The registry and
its descriptors are frozen, without installing a global registration service.

## Invariants

- Preserve parser priority, function identity and fallthrough.
- Keep Discord source-specific input and token headers unchanged.
- Preserve user configuration and existing cache/NormalizedEntry keys; no
  migration or replay of delivered entries.
- No extra downloads, browser requests or transport retry rules.
- Keep Scrapling optional and gated at the existing downloader.
- Source registration is not equivalent to support for arbitrary JSON/GraphQL
  APIs; each new adapter needs a dedicated format contract and fixtures.
- Continue using the existing per-destination delivery pipeline for both
  Discord and feed source entries.

## Validation

`tests/source-adapters.test.js` checks default parser identity and priority,
lazy managed Discord HTTP client selection, injection of a synthetic custom
source and rejection of invalid/duplicate adapters. Existing feed-pipeline
and delivery-state suites cover response sharing, parser fallthrough, dedup,
dry-run, delivery failure and replay. No new dependencies or production
configuration options are introduced.
