# XFeeder: browser fetching through Scrapling

**English** · [Polski](README.pl.md)

An optional browser path for sites that block ordinary HTTP clients. Without it
RSS/Atom/JSON work as usual.

## How it works

- The `xfeeder` binary embeds the `browser_worker.py` script. On first use it writes it
  to `scrapling/` next to `config.json` (and rewrites it when it differs from the
  embedded one).
- The interpreter is chosen in this order: `scrapling/.venv/bin/python`, then `python3`
  and `python`. Python 3.10+ with the `scrapling.fetchers` module is required.
- One persistent Python process runs in its own process group. It speaks line-delimited
  JSON and handles the `get`, `fetch` and `stealthy-fetch` modes. When the worker shuts
  down, the whole group (Chromium included) is ended.
- Scrapling is used when `Scrapling.Enabled` is on and one of these holds:
  - `AutoFallback` is on and a plain download returns a code from
    `FallbackStatusCodes` or an anti-bot page;
  - `PerUrlConfig["URL"].fallback: true`: the same, for that URL only (plain HTTP
    first, the browser only when blocked);
  - `ForceGlobal` or `PerUrlConfig["URL"].enabled: true` forces the browser on every
    download.
- `network.outboundPolicy: "public-only"` disables Scrapling.
- `ReuseClearance: true` (temporary, off by default): after the browser passes
  Cloudflare, the site's cookies and the browser's User-Agent are kept in
  `clearance.json` (0600), and later checks of that site try plain HTTP with them first.
  A rejected cookie is dropped and the browser path is used again. `false` restores the
  previous behaviour.

## Installation (manual)

From the directory that holds `config.json`:

```bash
mkdir -p scrapling
python3 -m venv scrapling/.venv
scrapling/.venv/bin/pip install --no-deps -r /path/to/repo/scrapling/requirements.lock.txt
scrapling/.venv/bin/pip check
scrapling/.venv/bin/python -m playwright install chromium
scrapling/.venv/bin/python -m patchright install chromium
```

On Linux, Chromium's system libraries may be needed
(`scrapling/.venv/bin/python -m playwright install-deps chromium`, requires root).
Restart the worker after installing. The log then shows
`[Scrapling] Runtime available (scrapling X.Y.Z)`.

`requirements.lock.txt` pins the versions of the `scrapling[all]` set.

## Configuration

> `PreferredMode`, `AutoUseShellForAdvancedOptions` and `runtimeMode` are accepted for
> 2.x compatibility but ignored: the persistent Python worker is always used (not the
> `scrapling extract` CLI).

Main fields of the `Scrapling` section:

- `Enabled`, `AutoFallback`, `ForceGlobal`
- `PersistentBrowserSessions` (default `true`; `false` turns persistent browser sessions off)
- `ReuseClearance` (see above)
- `FallbackStatusCodes`
- `AntiBot`
- `DefaultOptions`
- `PerUrlConfig["URL"]`, `PerUrlConfig["URL"].htmlParseOptions`, `PerUrlConfig["URL"].antiBot`

### Anti-bot

The download pipeline (`src/feed.rs`):

1. Assess the HTTP response (status, headers, HTML body and title for a challenge).
2. When a block is detected, try Scrapling modes in turn:
   - following `AntiBot.ModeOrder`;
   - with WAF/Cloudflare signals, `stealthy-fetch` before the lighter modes.
3. Check the response of every mode; a challenge or an "empty" response moves on to the
   next mode.
4. Return the first good response.

`Scrapling.AntiBot` fields: `Enabled`, `LogDecisions`, `PreferStealthOnSignals`,
`ModeOrder`, `StatusCodes`, `HeaderKeys`, `BodySignatures`, `TitleSignatures`,
`MinBodyBytes`, `MinConfidence`, `TreatCloudflareAsSignal`, `MaxAttempts`.

`DefaultOptions` / `PerUrlConfig` options (passed to Scrapling; both `camelCase` and
`snake_case` work):

- HTTP (`get`):
  - `headers`, `cookies`, `timeoutSeconds`, `proxy`, `cssSelector`, `params`, `auth`
  - `followRedirects`, `verify`, `impersonate`, `useragent`, `stealthyHeaders`, `aiTargeted`
  - `retries`, `retryDelay`, `http3`, `proxyAuth`, `proxies`, `maxRedirects`, `cert`, `selectorConfig`
  - `proxyRotator` (a proxy list → `ProxyRotator`)
- Browser (`fetch` / `stealthy-fetch`):
  - `blockAds`, `dnsOverHttps`, `headless`, `disableResources`, `networkIdle`, `loadDom`
  - `timeoutMs`, `wait`, `pageAction`, `pageSetup`, `waitSelector`, `waitSelectorState`, `locale`, `timezoneId`
  - `realChrome`, `proxy`, `googleSearch`, `useragent`, `cookies`, `extraHeaders`, `aiTargeted`
  - `blockedDomains`, `retries`, `retryDelay`, `captureXhr`, `executablePath`
  - `cdpUrl`, `userDataDir`, `extraFlags`, `additionalArgs`, `selectorConfig`, `initScript`
  - `maxPages`, `proxyRotator`
  - `blockWebrtc`, `solveCloudflare`, `allowWebgl`, `hideCanvas` (for `stealthy-fetch`)
- Mode choice: `extractMode` (`get|fetch|stealthy-fetch`), with `mode` as an alias.
- `pageAction` / `pageSetup` can be a string of Python code or an object
  `{path|file|code, function}`.
- Browser modes use a process kept between requests; sessions are separated by host and
  configuration, the pool keeps at most four sessions (LRU) and closes them on shutdown.
- `proxyRotator` cannot be combined with `proxy`/`proxies`.

## MCP

XFeeder does not start Scrapling's MCP server. It can be started by hand from the same
environment:

```bash
scrapling/.venv/bin/scrapling mcp
SCRAPLING_MCP_AUTH_TOKEN=a-long-random-token scrapling/.venv/bin/scrapling mcp --http --host 127.0.0.1 --port 8000
```

In Scrapling 0.4.15 the HTTP transport requires a token.
