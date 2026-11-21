# XFeeder + Scrapling: anti-bot guide

**English** · [Polski](ANTI_BOT_GUIDE.pl.md)

A practical anti-bot setup for XFeeder with Scrapling.

## 1) What the XFeeder pipeline does

`src/feed.rs` works in stages:

1. Plain HTTP (GET with retries for transient failures).
2. Response analysis (status, headers, body, title and body size).
3. When the signals point to a block: Scrapling modes in turn (`ModeOrder`), with
   `stealthy-fetch` first on Cloudflare/WAF signals; every attempt is checked and the
   pipeline stops at the first real success.

Important: the check does not trust `status=200` alone. That is essential for challenge
pages and soft blocks.

## 2) Anti-bot logic

`Scrapling.AntiBot` fields:

- `Enabled`
- `LogDecisions`
- `PreferStealthOnSignals`
- `ModeOrder`
- `StatusCodes`
- `HeaderKeys`
- `BodySignatures`
- `TitleSignatures`
- `MinBodyBytes`
- `MinConfidence`
- `TreatCloudflareAsSignal`
- `MaxAttempts`

Detection in `src/scrapling.rs` (reasons in the decision log):

- "strong" signals: `status:<code>`, `header:antibot:<headers>`, `body:challenge`, `title:challenge`
- "weak" signals: `header:cloudflare` and `body:small:<bytes>`
- result: `score` (0–100) and `blocked` from the signals and the `MinConfidence` threshold

This limits false positives for ordinary sites behind Cloudflare (Cloudflare headers
alone are not treated as a hard block).

## 3) Why (Scrapling reports)

- Issue #46/#47: the challenge passes but the page is not ready → `waitSelector` needed.
- Issue #100: embedded Turnstile edge case.
- Issue #126: page-pool problems under high concurrency.
- Issue #191: success at first, then repeated Cloudflare blocks (session/proxy stability).
- Issue #261: silent failures such as `HTTP 200` + fake 404 or an almost empty body.
- Discussion #73 (DataDome): detectable despite stealth.
- Discussion #266: basic versus enterprise Cloudflare.

What this means for XFeeder:

- do not trust the HTTP code alone,
- always check the shape of the content,
- treat anti-bot per domain (not one setting for everything).

## 4) Starting profiles

### A) Basic Cloudflare

- `ModeOrder`: `["fetch", "stealthy-fetch"]`
- `MaxAttempts`: `2` or `3`
- `solveCloudflare: true`
- `timeoutMs >= 60000`
- `waitSelector` on the target element

### B) Embedded/custom Turnstile

- `ModeOrder`: `["stealthy-fetch"]`
- `timeoutMs`: `90000-120000`
- `waitSelector` required
- `MinConfidence`: raise it (e.g. `50`) to filter out false successes

### C) Heavier WAFs (DataDome/Akamai)

- `ModeOrder`: `["fetch", "stealthy-fetch"]`
- `dnsOverHttps: true`, `blockAds: true`
- good proxies (residential/mobile), rotation (`proxyRotator`) and a lower rate
- per-URL signature tuning (`BodySignatures`, `TitleSignatures`)

## 5) A faster alternative

For basic Cloudflare, `Scrapling.ReuseClearance: true` (temporary) keeps the cookie after
the browser's first pass, and later checks use plain HTTP (8–11 ms instead of ~25 s on
boop.pl). See the [README](README.md).

## 6) Diagnostics in production

Turn on:

- `Scrapling.AntiBot.LogDecisions = true`

Watch:

- `score` and the reasons of anti-bot decisions,
- whether the response has real content (title, length, expected elements),
- whether blocks grow over time (a sign of a fixed browser fingerprint/IP),
- whether retries and fallbacks cost too much time.

`xfeeder preview <URL> --bench 5` shows whether a feed went through Scrapling and how
long it took.

## 7) Limits

Anti-bot handling does not guarantee 100 % success, especially with enterprise WAFs.
Often you need:

- a better class of proxy,
- a slower rate,
- separate profiles per domain,
- sometimes an external anti-bot tool (e.g. `Solver` with FlareSolverr).
