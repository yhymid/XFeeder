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

Z katalogu XFeedera:

```bash
npm install
npm run scrapling:install
npm run scrapling:check
```

Scrapling jest **opcjonalny**. Bez niego zwykłe RSS/Atom/JSON nadal działają;
brak jedynie fallbacku Scrapling/przeglądarki. Zainstalowany runtime jest używany
zgodnie z konfiguracją, gdy normalne pobranie zostanie zablokowane. Nie ma gwarancji
obsłużenia każdej blokowanej strony. Zrestartuj działający worker po instalacji.

Instalator wybiera `python3`, potem `python`, wymagając **Python 3.11+**. Sam Scrapling
0.4.15 dopuszcza 3.10, ale przypięty IPython 9.13.0 wymaga 3.11. Tworzy `.venv` w tym
katalogu przez `python -m venv`. Wszystkie dalsze operacje używają `.venv/bin/python`
(lub `.venv/Scripts/python.exe` na Windows) i jego `-m pip`, bez globalnej instalacji.

Instalowane są wyłącznie wersje z `requirements.lock.txt`, przez `pip install
--no-deps -r ...`, następnie `pip check`. Nie ma przejścia na nieprzypięte latest.
Lock obejmuje istniejący zestaw `scrapling[all]`: parsery/HTTP, Playwright/Patchright,
shell oraz MCP używane przez adapter. Dodano wyłącznie Windowsowe zależności już
wymagane przez ten zestaw: Colorama dla Click/IPython i pywin32 dla MCP, z markerem
`sys_platform == "win32"`. `requirements.txt` opisuje pin najwyższego poziomu;
wspierany instalator zawsze korzysta z pełnego lockfile'a. Wersje są przypięte,
ale plik nie jest lockiem z hashami wheelów dla wszystkich platform.

Instalator uruchamia przez Python z venv:

```text
-m playwright install chromium
-m patchright install chromium
```

Pobierane są rewizje Chromium zgodne z przypiętymi sterownikami dla `fetch` oraz
`stealthy-fetch` (mogą współdzielić cache). Binariów nie kopiujemy do release.
Domyślna lokalizacja to cache przeglądarek danego użytkownika; ewentualne
`PLAYWRIGHT_BROWSERS_PATH` musi być takie samo przy instalacji, checku i pracy workera.
Na końcu sprawdzany jest import/parser Scrapling, CLI oraz rzeczywisty start obu
sterowników Chromium na lokalnej stronie, bez odwiedzania zewnętrznej witryny.

Zdrowe istniejące `.venv` jest ponownie używane i aktualizowane do pinów. Uszkodzone
lub niezgodne środowisko powoduje błąd z instrukcją: zatrzymaj worker, przenieś je
do kopii zapasowej poza repo i uruchom instalator ponownie. Instalator nigdy sam
nie usuwa `.venv`. Błędy Pythona, venv, pip, browser install i weryfikacji kończą
proces kodem niezerowym. Ponowienie instalacji po usunięciu przyczyny jest bezpieczne.

Na Linux mogą być potrzebne pakiety systemowe Pythona/venv oraz biblioteki Chromium.
Instalator nie uruchamia `sudo` ani `install-deps` automatycznie. W razie braków
zastosuj komunikat narzędzia; administrator może użyć Python z venv z
`-m playwright install-deps chromium`. Windows ma obsługę ścieżek `Scripts/*.exe`;
rzeczywistą instalację zweryfikowano na Linux, a logikę Windows w testach offline.

Na systemach POSIX zamykanie drzewa przeglądarki wymaga systemowego `ps`
(na Linux pakiet `procps`/`procps-ng`). Runtime zapisuje PID i czas startu potomków
przed zamknięciem Pythona, obejmując również odłączoną grupę Chromium. Najpierw
pozwala Pythonowi zamknąć sesje, następnie kończy pozostałe procesy; nie uznaje
samego wyjścia Pythona za zakończenie całego drzewa. Windows używa `taskkill /T`.

`npm run scrapling:check` weryfikuje zarządzane `.venv`, pip, Scrapling i start
przeglądarek, bez instalowania ani pobierania czegokolwiek. Nie zmienia magazynu
zaufania TLS ani konfiguracji XFeedera.

Runtime automatycznie preferuje lokalne `.venv`, opcjonalnie wykrywa pakiet systemowy
przez `python3`/`python`. CLI jest parowane z wybranym interpreterem; polecenia są
uruchamiane bez shella. `upstream/` nie jest tworzony ani potrzebny. `.venv`, upstream
i cache Pythona są ignorowane przez Git i odrzucane przez packager również po
wymuszonym dodaniu do indexu.

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
