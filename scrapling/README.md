# XFeeder — fallback Scrapling

Opcjonalny fallback przeglądarkowy dla stron blokujących zwykłych klientów HTTP.
Bez niego RSS/Atom/JSON działają normalnie.

## Jak to działa (wersja Rust)

- Binarka `xfeeder` ma wbudowany skrypt `browser_worker.py`. Przy pierwszym
  użyciu zapisuje go do `scrapling/` obok `config.json`.
- Interpreter jest wybierany w kolejności: `scrapling/.venv/bin/python`, potem
  `python3` i `python`. Wymagany jest Python 3.10+ z modułem
  `scrapling.fetchers`.
- Działa jeden trwały proces Pythona we własnej grupie procesów. Komunikuje się
  JSON-em linia po linii i obsługuje tryby `get`, `fetch` i `stealthy-fetch`.
  Przy zamknięciu workera cała grupa (razem z Chromium) jest kończona.
- Scrapling jest używany, gdy `Scrapling.Enabled` jest włączone i zachodzi
  jeden z warunków:
  - `AutoFallback` jest włączone, a zwykłe pobranie zwróci kod z
    `FallbackStatusCodes` albo stronę anty-bot;
  - `PerUrlConfig["URL"].fallback: true`: to samo, ale tylko dla tego adresu
    (najpierw zwykłe HTTP, przeglądarka dopiero przy blokadzie);
  - `ForceGlobal` albo `PerUrlConfig["URL"].enabled: true` wymusza przeglądarkę
    przy każdym pobraniu.
- `network.outboundPolicy: "public-only"` wyłącza Scrapling.

## Instalacja (ręczna)

Z katalogu z `config.json`:

```bash
mkdir -p scrapling
python3 -m venv scrapling/.venv
scrapling/.venv/bin/pip install --no-deps -r /ścieżka/do/repo/scrapling/requirements.lock.txt
scrapling/.venv/bin/pip check
scrapling/.venv/bin/python -m playwright install chromium
scrapling/.venv/bin/python -m patchright install chromium
```

Na Linuksie mogą być potrzebne biblioteki systemowe Chromium
(`scrapling/.venv/bin/python -m playwright install-deps chromium`, wymaga roota).
Po instalacji zrestartuj worker. W logu pojawi się
`[Scrapling] Runtime available (scrapling X.Y.Z)`.

`requirements.lock.txt` zawiera przypięte wersje zestawu `scrapling[all]`.

## Konfiguracja

> W wersji Rust klucze `PreferredMode`, `AutoUseShellForAdvancedOptions` i
> `runtimeMode` są akceptowane dla zgodności, ale ignorowane: zawsze używany
> jest trwały worker Pythona (nie CLI `scrapling extract`).

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

Pipeline pobierania (`src/feed.rs`) robi teraz:

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
