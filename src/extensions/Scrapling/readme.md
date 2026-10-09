# XFeeder Scrapling Extension

Lokalna integracja Scrapling dla XFeeder (`src/extensions/Scrapling`).

## Co jest zaimplementowane

- Detekcja instalacji i capabilities (`detector.js`)
- Konfiguracja i routing per-URL (`config.js`)
- Tryby requestów `extract`:
  - `get`
  - `post`
  - `put`
  - `delete`
  - `fetch`
  - `stealthy-fetch`
- Tryby runtime:
  - `cli` (domyślnie, pełna zgodność flag Scrapling CLI)
  - `shell` (fallback przez Python API)
  - trwałe sesje przeglądarkowe Scraplinga 0.4.15 dla `fetch` i `stealthy-fetch`
- CLI wrapper:
  - `extract`
  - `install`
  - `mcp` (start serwera MCP)
  - `shell` (`--code`, `--loglevel`)
- Parser HTML -> feed items (`utils.js`)
- Integracja w `src/parsers/downloader.js` i `src/core/feed-pipeline.js`
- Przewodnik Anti-Bot: `ANTI_BOT_GUIDE.md`

## Instalacja lokalna (opcjonalna)

W katalogu extension:

```bash
python3 -m venv .venv
. .venv/bin/activate
# Reproducible dependency set resolved with Python 3.14:
pip install -r requirements.lock.txt
# On other supported Python versions, use the package pin and let pip resolve dependencies:
# pip install -r requirements.txt
python -m playwright install chromium
```

Uwaga: `scrapling install` próbuje uruchomić `playwright install-deps` (wymaga sudo), więc na hostach bez roota lepiej użyć tylko `playwright install chromium`.

## Konfiguracja

Sekcja `Scrapling` jest dodana do `config.json` i `config.json.example`.

Najważniejsze pola:

- `Enabled`
- `ForceGlobal`
- `AutoUseShellForAdvancedOptions`
- `PersistentBrowserSessions` (domyślnie `true`; wyłącza trwałe sesje przeglądarkowe)
- `PreferredMode`
- `FallbackStatusCodes`
- `AntiBot`
- `DefaultOptions`
- `PerUrlConfig["URL"]`
- `PerUrlConfig["URL"].htmlParseOptions`
- `PerUrlConfig["URL"].antiBot`

### Anti-Bot (XFeeder)

Pipeline pobierania (`src/parsers/downloader.js`) robi teraz:

1. Ocena odpowiedzi HTTP (status + nagłówki + treść HTML pod kątem challenge).
2. Jeśli wykryta blokada, adaptacyjna eskalacja trybów Scrapling:
   - bazowo wg `AntiBot.ModeOrder`
   - przy sygnałach WAF/Cloudflare preferuje `stealthy-fetch` przed lżejszymi trybami
3. Walidacja odpowiedzi z każdego trybu; challenge/„pusta” odpowiedź przechodzi do kolejnego trybu.
4. Zwrócenie pierwszej poprawnej odpowiedzi.

Konfiguracja `Scrapling.AntiBot`:

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

Opcje `DefaultOptions` / `PerUrlConfig` (mapowane na Scrapling):

- HTTP (`get/post/put/delete`):
  - `headers`, `cookies`, `timeoutSeconds`, `proxy`, `cssSelector`, `params`
  - `auth`
  - `followRedirects`, `verify`, `impersonate`, `useragent`, `stealthyHeaders`, `aiTargeted`
  - `retries`, `retryDelay`, `http3`, `proxyAuth`, `proxies`, `maxRedirects`, `cert`, `selectorConfig`
  - `proxyRotator` (lista proxy -> `ProxyRotator`, tylko `shell` runtime)
  - `data`, `jsonData` (dla `post`/`put`)
- Browser (`fetch/stealthy-fetch`):
  - `blockAds`, `dnsOverHttps`, `headless`, `disableResources`, `networkIdle`, `loadDom`
  - `timeoutMs`, `wait`, `pageAction`, `pageSetup`, `waitSelector`, `waitSelectorState`, `locale`, `timezoneId`
  - `realChrome`, `proxy`, `googleSearch`, `useragent`, `cookies`
  - `extraHeaders`, `aiTargeted`
  - `blockedDomains`, `retries`, `retryDelay`, `captureXhr`, `executablePath`
  - `cdpUrl`, `userDataDir`, `extraFlags`, `additionalArgs`, `selectorConfig`, `initScript`
  - `maxPages`, `proxyRotator` (tylko `shell` runtime)
  - `blockWebrtc`, `solveCloudflare`, `allowWebgl`, `hideCanvas` (dla `stealthy-fetch`)
- Routing:
  - `runtimeMode`: `cli` lub `shell`
  - `extractMode`: `get|post|put|delete|fetch|stealthy-fetch`
  - `mode`: alias kompatybilności
  - `AutoUseShellForAdvancedOptions=true`: gdy użyjesz opcji niedostępnych w `scrapling extract ...`, extension automatycznie przełączy runtime na `shell`
  - w `shell` obslugiwane sa klucze `camelCase` i `snake_case`
  - `pageAction` / `pageSetup` w `shell` moze byc stringiem z kodem Python albo obiektem `{path|file|code, function}`
  - `shell` zwraca teraz realne `status` i `headers` (zamiast stalego `200/{}`), co poprawia decyzje Anti-Bot
  - odpowiedzi Scrapling zwracaja metadane runtime: `runtime`, `resolvedRuntime`, `requestedRuntime`, `runtimeAutoSwitched`
  - tryby przeglądarkowe korzystają z procesu Pythona utrzymywanego między żądaniami; sesje są oddzielone według hosta i konfiguracji, a pula przechowuje maksymalnie cztery sesje LRU i zamyka je przy wyłączaniu aplikacji
  - walidacja konfliktow opcji: `proxyRotator` nie moze byc laczony z `proxy`/`proxies`
  - `rawCliArgs|cliArgs|extraCliArgs`: passthrough dodatkowych flag do `scrapling extract ...`

## MCP

MCP można odpalić przez API extension (metoda `startMcpServer`) lub bezpośrednio:

```bash
src/extensions/Scrapling/.venv/bin/scrapling mcp
SCRAPLING_MCP_AUTH_TOKEN=replace-with-a-long-random-token src/extensions/Scrapling/.venv/bin/scrapling mcp --http --host 127.0.0.1 --port 8000
```

W Scraplingu 0.4.15 transport HTTP wymaga tokenu. Przez API przekaż `authToken` (wrapper ustawia go w środowisku procesu) albo jawnie wybierz `noAuth: true` dla lokalnego, nieuwierzytelnionego serwera. Host domyślny to `127.0.0.1`.
