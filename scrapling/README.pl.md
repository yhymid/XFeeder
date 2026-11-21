# XFeeder: przeglądarka przez Scrapling

[English](README.md) · **Polski**

Opcjonalna ścieżka przez przeglądarkę dla stron, które blokują zwykłych klientów HTTP.
Bez niej RSS/Atom/JSON działają normalnie.

## Jak to działa

- Plik `xfeeder` ma wbudowany skrypt `browser_worker.py`. Przy pierwszym użyciu
  zapisuje go do `scrapling/` obok `config.json` (i nadpisuje, gdy różni się od
  wbudowanego).
- Interpreter jest wybierany w kolejności: `scrapling/.venv/bin/python`, potem
  `python3` i `python`. Wymagany jest Python 3.10+ z modułem `scrapling.fetchers`.
- Działa jeden stały proces Pythona we własnej grupie procesów. Komunikuje się JSON-em
  linia po linii i obsługuje tryby `get`, `fetch` i `stealthy-fetch`. Przy zamknięciu
  workera cała grupa (razem z Chromium) jest kończona.
- Scrapling jest używany, gdy `Scrapling.Enabled` jest włączone i zachodzi jeden
  z warunków:
  - `AutoFallback` jest włączone, a zwykłe pobranie zwróci kod z
    `FallbackStatusCodes` albo stronę anty-bot;
  - `PerUrlConfig["URL"].fallback: true`: to samo, ale tylko dla tego adresu
    (najpierw zwykłe HTTP, przeglądarka dopiero przy blokadzie);
  - `ForceGlobal` albo `PerUrlConfig["URL"].enabled: true` wymusza przeglądarkę przy
    każdym pobraniu.
- `network.outboundPolicy: "public-only"` wyłącza Scrapling.
- `ReuseClearance: true` (tymczasowe, domyślnie wyłączone): po udanym przejściu
  Cloudflare przez przeglądarkę ciasteczka strony i User-Agent przeglądarki trafiają do
  `clearance.json` (0600), a kolejne sprawdzenia tej strony najpierw próbują zwykłego
  HTTP z nimi. Odrzucone ciasteczko jest kasowane i wraca ścieżka przez przeglądarkę.
  `false` przywraca stary system.

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
Po instalacji zrestartuj workera. W logu pojawi się
`[Scrapling] Runtime available (scrapling X.Y.Z)`.

`requirements.lock.txt` zawiera przypięte wersje zestawu `scrapling[all]`.

## Konfiguracja

> Klucze `PreferredMode`, `AutoUseShellForAdvancedOptions` i `runtimeMode` są
> akceptowane dla zgodności z 2.x, ale ignorowane: zawsze używany jest stały worker
> Pythona (nie CLI `scrapling extract`).

Najważniejsze pola sekcji `Scrapling`:

- `Enabled`, `AutoFallback`, `ForceGlobal`
- `PersistentBrowserSessions` (domyślnie `true`; `false` wyłącza stałe sesje przeglądarki)
- `ReuseClearance` (patrz wyżej)
- `FallbackStatusCodes`
- `AntiBot`
- `DefaultOptions`
- `PerUrlConfig["URL"]`, `PerUrlConfig["URL"].htmlParseOptions`, `PerUrlConfig["URL"].antiBot`

### Anty-bot

Potok pobierania (`src/feed.rs`):

1. Ocena odpowiedzi HTTP (status, nagłówki, treść i tytuł HTML pod kątem wyzwania).
2. Przy wykrytej blokadzie kolejne tryby Scraplinga:
   - według `AntiBot.ModeOrder`;
   - przy sygnałach WAF/Cloudflare `stealthy-fetch` przed lżejszymi trybami.
3. Sprawdzenie odpowiedzi z każdego trybu; wyzwanie albo „pusta” odpowiedź przechodzi do
   następnego trybu.
4. Zwrócenie pierwszej poprawnej odpowiedzi.

Pola `Scrapling.AntiBot`: `Enabled`, `LogDecisions`, `PreferStealthOnSignals`,
`ModeOrder`, `StatusCodes`, `HeaderKeys`, `BodySignatures`, `TitleSignatures`,
`MinBodyBytes`, `MinConfidence`, `TreatCloudflareAsSignal`, `MaxAttempts`.

Opcje `DefaultOptions` / `PerUrlConfig` (przekazywane do Scraplinga; działają zarówno
`camelCase`, jak i `snake_case`):

- HTTP (`get`):
  - `headers`, `cookies`, `timeoutSeconds`, `proxy`, `cssSelector`, `params`, `auth`
  - `followRedirects`, `verify`, `impersonate`, `useragent`, `stealthyHeaders`, `aiTargeted`
  - `retries`, `retryDelay`, `http3`, `proxyAuth`, `proxies`, `maxRedirects`, `cert`, `selectorConfig`
  - `proxyRotator` (lista proxy → `ProxyRotator`)
- Przeglądarka (`fetch` / `stealthy-fetch`):
  - `blockAds`, `dnsOverHttps`, `headless`, `disableResources`, `networkIdle`, `loadDom`
  - `timeoutMs`, `wait`, `pageAction`, `pageSetup`, `waitSelector`, `waitSelectorState`, `locale`, `timezoneId`
  - `realChrome`, `proxy`, `googleSearch`, `useragent`, `cookies`, `extraHeaders`, `aiTargeted`
  - `blockedDomains`, `retries`, `retryDelay`, `captureXhr`, `executablePath`
  - `cdpUrl`, `userDataDir`, `extraFlags`, `additionalArgs`, `selectorConfig`, `initScript`
  - `maxPages`, `proxyRotator`
  - `blockWebrtc`, `solveCloudflare`, `allowWebgl`, `hideCanvas` (dla `stealthy-fetch`)
- Wybór trybu: `extractMode` (`get|fetch|stealthy-fetch`), `mode` jako alias.
- `pageAction` / `pageSetup` może być tekstem z kodem Pythona albo obiektem
  `{path|file|code, function}`.
- Tryby przeglądarkowe korzystają z procesu utrzymywanego między zapytaniami; sesje są
  rozdzielone według hosta i konfiguracji, pula trzyma maksymalnie cztery sesje (LRU)
  i zamyka je przy wyłączaniu.
- `proxyRotator` nie może być łączony z `proxy`/`proxies`.

## MCP

XFeeder nie uruchamia serwera MCP Scraplinga. Można go odpalić ręcznie z tego samego
środowiska:

```bash
scrapling/.venv/bin/scrapling mcp
SCRAPLING_MCP_AUTH_TOKEN=długi-losowy-token scrapling/.venv/bin/scrapling mcp --http --host 127.0.0.1 --port 8000
```

W Scraplingu 0.4.15 transport HTTP wymaga tokenu.
