# Network Usage Control — TASK 02–14

Wdrożono wspólną konfigurację, globalny limiter downloadu HTTP, bramki
współbieżności, timeouty/retry oraz integrację z zadaniami kanałów i shutdownem.
TASK 08 korzysta z tej samej polityki Scrapling. TASK 09–13 dodają pacing uploadu,
accounting, API, UI Network oraz walidację całości. Wyniki i ograniczenia kosztu
Unlimited opisuje [raport benchmarku](network-benchmark.md). TASK 14 kończy się
[decyzją badawczą](network-adaptive-decision.md), bez automatycznego sterowania.
Walidację wydania 2.2.0 opisuje [raport release](release-2.2.0-validation.md).

## Konfiguracja

Opcjonalny obiekt `network` na głównym poziomie `config.json`:

```json
{
  "network": {
    "bandwidthProfile": "unlimited",
    "downloadLimitMbps": null,
    "uploadLimitMbps": null,
    "networkFriendlyMode": false,
    "maxConcurrentRequests": null,
    "maxConcurrentScraplingRequests": null,
    "scraplingResourceSaving": true,
    "setupTimeoutMs": 15000,
    "idleTimeoutMs": 15000,
    "requestDeadlineMs": null,
    "shutdownGraceMs": 5000
  }
}
```

To wartości domyślne; brak `network` nie ogranicza pasma ani dotychczasowej
współbieżności. Pliki użytkownika nie są automatycznie przepisywane.

| Profil | Download | Kanoniczne bajty/s |
| --- | --- | --- |
| `potato` | 10 Kbps | 1250 |
| `low` | 2 Mbps | 250000 |
| `medium` | 10 Mbps | 1250000 |
| `high` | 50 Mbps | 6250000 |
| `very-high` | 100 Mbps | 12500000 |
| `unlimited` | bez limitu | `null` |
| `custom` | `downloadLimitMbps` | Mbps × 125000, zaokrąglone |

Kbps/Mbps są dziesiętne: 8 bitów = 1 bajt. W `custom` download i upload są
niezależne, `null` pozostawia kierunek bez limitu. Wymagany jest co najmniej jeden
limit. Pozostałe profile ignorują poprawne wartości custom, zachowując je w pliku.
W Custom upload ma własny globalny budżet, niezależny od downloadu. Znane body
JSON/string/Buffer/ArrayBuffer są opóźniane przed wysłaniem, bez zmiany bajtów
i Content-Length. Stream/FormData/multipart i replay body wewnątrz redirectów
nie podlegają pacingowi; nie są raportowane jako objęte tym limitem.

Przykład: `{"bandwidthProfile":"custom","downloadLimitMbps":0.5,"uploadLimitMbps":null}`
wewnątrz `network` oznacza 62500 bajtów/s downloadu.

`normalizeNetworkConfig` w `src/network/config.js` zwraca `{ok, value, errors}`.
Błąd ma pola `path`, `code`, `message`; loader rzuca `NetworkConfigError` z tą samą
listą. Normalizator odrzuca nieznane pola/jednostki/profile, nieliczbowe i nieskończone
limity, zero, wartości ujemne, ponad 1000000 Mbps oraz wartości za małe do
przedstawienia jako dodatnia całkowita liczba bajtów/s. Concurrency musi być
całkowite 1–10000 albo `null`. Nieprawidłowa konfiguracja początkowa zatrzymuje start;
nieprawidłowy reload pozostawia ostatnią działającą konfigurację. Poprawny reload
zmienia wspólny budżet i limity również dla oczekujących operacji.

## Budżet i wspólny transport

Decyzja podjęta przed implementacją: token bucket z zegarem monotonicznym i kolejką
round-robin nadaje się do strumieni HTTP, bo przydziela małe porcje budżetu bez
przechowywania body. Zapas wynosi 100 ms transferu, co najmniej 1 bajt, maksymalnie
64 KiB. Porcja ma najwyżej 16 KiB w trybie ograniczonym. Konsumenci współdzielą
jeden budżet na proces; dwa pobrania w `medium` nie dostają osobno po 10 Mbps.

`BandwidthController` udostępnia `consume(bytes, {signal})`, `setRate(bytesPerSecond)`,
`close()` i `snapshot()`. Unlimited (`null`) nie tworzy kolejki ani timera tokenów.
Abort usuwa waiter; zmiana profilu budzi kolejkę; close odrzuca wszystkie oczekujące
Promise. Liczniki przydziałów są podstawą diagnostyczną, nie pomiarem ruchu browsera.

Adapter opakowuje surową odpowiedź Node **przed dekompresją Axios**, nalicza bajty
zakodowanego body i stosuje backpressure. Zachowuje redirecty, proxy, statusy,
dekodowanie i istniejący `maxContentLength` Axios dla odpowiedzi buforowanych,
łącznie z kontrolą rozmiaru po dekompresji. Nie buforuje całego body do throttlingu.
Strumieniowi odbiorcy nadal odpowiadają za własny limit rozmiaru, jak przy zwykłym
`responseType: "stream"` Axios. Nie dodano globalnego, arbitralnego limitu body.

Wspólny adapter obejmuje klienta źródeł RSS/Atom/JSON/YouTube/Discord oraz odpowiedzi
HTTP na wysyłki Discord/Telegram. Nie zmienia payloadów ani konfiguracji proxy
nadawców. Bezpośredni `getHttpClient().get()` także korzysta z limitu.
`follow-redirects` został zadeklarowany jako zależność bezpośrednia, ponieważ adapter
korzysta z jego API; pakiet był już zależnością przechodnią Axios.

To kontrola przepływu na poziomie aplikacji, nie QoS interfejsu sieciowego:
TLS, nagłówki, bufory socketu i odrzucane body pośrednich redirectów nie są dokładnie
rozliczane. Transport obsługuje HTTP/1.x przez HTTP/HTTPS; jawne żądanie HTTP/2
jest odrzucane. Niezależny klient sieciowy zewnętrznej wtyczki nie jest automatycznie
przechwytywany. Ruch Pythona/Chromium nie przechodzi przez ten limiter.

## Współbieżność i Friendly Mode

Jedna funkcja `resolveNetworkPolicy` wyznacza politykę:

| Ustawienie | Friendly OFF | Friendly ON |
| --- | --- | --- |
| HTTP | dotychczasowa współbieżność | 2 |
| Scrapling | dotychczasowa współbieżność | 1 |
| Odstęp między startami Scrapling | brak | losowe 100–300 ms |
| Dodatkowy jitter retry | brak | losowe 50–150 ms |

Jawne `maxConcurrentRequests` i `maxConcurrentScraplingRequests` nadpisują wartości
z tabeli. Bramka jest wspólna dla instancji w procesie. Zmniejszenie limitu pozwala
trwającym operacjom skończyć; następne czekają. Permit jest zwalniany także po
błędzie i anulowaniu. Worker sesji Scrapling zachowuje wewnętrzną serializację
protokołu Pythona, niezależnie od maksymalnego limitu dopuszczonych zadań.
Nie ma automatycznego wykrywania latency ani samoczynnej zmiany profilu.

## Timeouty, retry i anulowanie

- Setup: od otrzymania permitu HTTP do końcowych nagłówków odpowiedzi. Domyślnie
  15000 ms; kolejka concurrency nie zużywa tego czasu.
- Idle: czas oczekiwania na następny chunk z serwera. Domyślnie 15000 ms.
  Oczekiwanie na tokeny i backpressure odbiorcy nie uruchamiają tego timera.
- Deadline: opcjonalny `requestDeadlineMs` obejmuje całą logiczną operację GET,
  również kolejki, limiter, retry i backoff. Domyślnie brak. Dla odpowiedzi
  strumieniowej działa aż do zakończenia strumienia.
- Błędy timeoutu mają `phase`: `setup`, `idle` lub `deadline`.

Setup/idle przyjmują całkowite 0–2147000000 ms; zero wyłącza dany timer. Globalny
deadline to `null` lub dodatnia liczba z tego zakresu. `shutdownGraceMs` ma zakres
0–60000 ms. Opcje pojedynczego requestu `setupTimeoutMs`, `idleTimeoutMs`, `deadlineMs`
nadpisują ustawienia globalne; `deadlineMs: 0` jawnie wyłącza deadline. Są walidowane
przed wysłaniem. Jawne starsze `timeout` służy jako wartość setup i idle, gdy nie
podano bardziej szczegółowych opcji; nie staje się całkowitym deadlinem.

GET zachowuje ograniczoną liczbę prób i ponawia wyłącznie przejściowe statusy
408/425/429/500/502/503/504 oraz wybrane błędy sieci. Zachowuje exponential backoff
z jitterem i respektuje `Retry-After` dla 429/503 (sekundy lub data HTTP).
Friendly dodaje jitter także do Retry-After, nigdy go nie skraca. Każda próba
ponownie pozyskuje concurrency i korzysta ze wspólnego budżetu. Abort, deadline,
błędy konfiguracji i parsowania nie są powodem retry. Nie dodano automatycznego
retry wysyłek POST; istniejące ponowienie Discord 429 pozostaje anulowalne.

`AbortSignal` przechodzi przez downloader, HTTP, limiter, bramki, backoff,
Scrapling i wykonywanie kanału. Anulowanie nie uruchamia kolejnego fallbacku.

## Kanały i shutdown

`ChannelTasks` rozróżnia `scheduled`, `waiting`, `running`, `completed`, `failed`,
`cancelled`. Powody waiting obejmują concurrency, bandwidth, Friendly spacing
oraz retry. Samo oczekiwanie i anulowanie nie zwiększają licznika błędów.
Kanał z tym samym kluczem cache nie może uruchomić się drugi raz równolegle;
kolejne wywołanie otrzymuje ten sam Promise. Stan jest dostępny wewnętrznie przez
`app.channelStates` i stan kolejki. Osobne API/UI Network przedstawia metryki sieci.

Istniejący shutdown aplikacji obsługuje teraz SIGINT i SIGTERM, jest idempotentny
oraz działa także po `--once` i `--check-config`. Zatrzymuje scheduler i admission,
odrzuca kolejki permitów i backoff, pozostawiając aktywnym operacjom domyślnie
5 sekund na zakończenie. Potem anuluje pozostałe requesty/tokeny/kanały i zamyka
sesje Scrapling. Zakończenie zadań ma dodatkowy limit 2 sekund dla wtyczek
ignorujących sygnał. Cache jest zapisywany po wygaszeniu pracy, aby uniknąć zapisu
przed ostatnią aktualizacją. Już potwierdzone wysyłki są zapamiętywane przed
anulowalną przerwą między wiadomościami. Dry-run/check-config nie zapisuje cache.

## Kompatybilność i zakres

Unlimited nadal nie ogranicza pasma ani współbieżności. Intencjonalne zmiany to
propagacja abort i rozdzielenie timeoutów: wolny zdrowy transfer może trwać dłużej
niż wcześniejszy timeout Axios; całkowity limit wymaga jawnego deadline.
Nieznane pola w `network` są błędem, nie są po cichu ignorowane. Resource Saving
z wcześniejszego TASK 08 pozostaje domyślnie włączone; strony zależne od CSS lub
WebSocket mogą wymagać [override per URL](scrapling-resource-saving.md).

Nie włączono automatycznej polityki adaptacyjnej. Implementacja i testy nie
modyfikują użytkowego config.json, .env ani cache. Zapis z dashboardu zmienia
konfigurację wyłącznie po wybraniu przez użytkownika przycisku zapisu.

## Upload, metryki i dashboard (TASK 09–12)

Budżet uploadu jest osobnym `BandwidthController`. Obecni nadawcy Discord i Telegram
wysyłają małe, buforowane JSON-y. Adapter rezerwuje całe znane body przed otwarciem
socketu, po uzyskaniu permitu. Zachowuje oryginalny payload, kodowanie i nagłówki
Axios. Nie zamienia zwykłych wiadomości na strumienie. Taki pacing ogranicza średni
ruch sekwencji wiadomości; po rezerwacji dopuszcza burst wielkości body. Nie stanowi
precyzyjnego shaping każdego pakietu. Każde jawne retry rezerwuje budżet ponownie.
Abort/shutdown przerywa rezerwację bez wysłania body. Setup nie obejmuje rezerwacji;
deadline obejmuje ją. Zmiana profilu budzi kolejkę uploadu.

`network.metricsSnapshot()` udostępnia:

- `downloadedBytes`: zakodowane bajty body odczytane z surowej odpowiedzi;
- `uploadedBytes`: bajty body przekazane transportowi, bez twierdzenia, że serwer
  potwierdził odbiór;
- `unshapedUploadBytes`: zaobserwowane bajty nieobjętych pacingiem typów body przy
  aktywnym limicie; **nie** obejmuje niedostępnego accounting replay redirectów;
- `downloadBytesPerSecond`, `uploadBytesPerSecond`: przybliżone tempo z pięciu
  jednosekundowych bucketów, na zegarze monotonicznym; brak timera/logów per chunk;
- aktywne i oczekujące HTTP/Scrapling oraz oczekujące download/upload;
- profil, efektywne limity w bajtach/s, Friendly Mode i efektywną współbieżność;
- `scraplingBytes.status: "unavailable"` i wartości `null` dla bajtów przeglądarki;
- jawne opisy zakresu accounting i ograniczeń uploadu.

Liczniki są procesowe, resetują się po restarcie i nie są globalnym monitorem karty
sieciowej. Retry liczy się jako kolejny rzeczywisty transfer, a dekompresja nie
powiększa licznika drugi raz. „Active HTTP” oznacza zajęte pozwolenie, również gdy
wiadomość czeka na budżet uploadu. Liczniki nigdy nie zawierają URL/body/sekretów.

| Endpoint | Operacja | Odpowiedź |
| --- | --- | --- |
| `GET /api/settings/network` | Odczyt | Tylko ustawienia sieci, efektywna polityka, rewizja, błędy i status runtime |
| `PUT /api/settings/network` | Zastąpienie obiektu `network` | Jak GET, po walidacji i atomowym zapisie; pozostała konfiguracja zachowana |
| `GET /api/network/metrics` | Snapshot rzeczywistego workera | `available`, `applied`, `updatedAt`, `metrics` lub powód niedostępności |

Endpointy dziedziczą uwierzytelnianie dashboardu; zapis również kontrolę Origin.
PUT przyjmuje sam obiekt sieci i wymaga `If-Match: "<revision>"` z poprzedniego GET
(ten sam hash jest w ETag). Brak rewizji: 428; konflikt: 412; błąd walidacji: 400
z listą `{path, code, message}`. Rewizja obejmuje cały plik, więc inny edytor
konfiguracji nie może zostać nieświadomie nadpisany przez Network. Pełny istniejący
endpoint `/api/config` respektuje If-Match, a frontend zawsze go wysyła; starsi
klienci bez nagłówka zachowują dotychczasowe zachowanie. API Network nie zwraca
pozostałej konfiguracji, .env ani ścieżek plików.

Worker i dashboard nie muszą działać w jednym procesie. Aktywny worker kolejki
odświeża konfigurację co 1 sekundę, publikuje agregat co 2 sekundy do
`<configPath>.network-runtime.json` (atomowo, tryb 0600), a UI odczytuje co 3 sekundy
wyłącznie na otwartym widoku Settings. Snapshot starszy niż 6,5 sekundy jest
niedostępny. API zwraca wyłącznie dozwolone pola. Hash efektywnej konfiguracji
rozróżnia zapis od zastosowania; dashboard nie pokazuje własnych pustych liczników
zamiast licznika workera. Shutdown usuwa własny snapshot. `--once`/`--check-config`
nie tworzą raportowania. Jeden plik konfiguracji odpowiada jednemu workerowi.

Settings → Network korzysta z istniejących komponentów dashboardu: select profilu,
Custom download/upload z walidacją inline, Friendly Mode, rozwijane Advanced
(concurrency i Resource Saving), osobny „Save network” oraz kompaktowy status.
Osobny zapis nie usuwa niezapisanych zmian innych sekcji. Górny przycisk nadal
zapisuje całą konfigurację. Konflikt zachowuje draft; nie wykonuje ślepego retry.

## Pliki i weryfikacja

- `src/network/*`: normalizacja, polityka, token bucket, bramki, anulowanie,
  kontekst waiting, wspólny serwis i adapter HTTP.
- `src/client.js`, `src/parsers/downloader.js`, `src/core/feed-pipeline.js`,
  `src/parsers/discord.js`, `src/message.js`, `src/telegram.js`: transport,
  retry, propagacja sygnałów i błędów.
- `src/app/channel-tasks.js`, `channel-runner.js`, `runtime.js`, `bootstrap.js`
  oraz `main.js`: stany kanałów, deduplikacja, cache i shutdown.
- `src/config-loader.js`, `src/core/channel-config.js`, `src/dashboard/validation.js`:
  wspólna walidacja i zarezerwowany główny klucz `network`.
- `src/extensions/Scrapling/index.js`, `resource-policy.js`: wspólna bramka/polityka.
- `tests/network-control.test.js`: deterministyczny zegar, presety, fairness,
  burst, aktualizacja profilu, permit, anulowanie i stany kanałów.
- `tests/network-integration.test.js`: realne lokalne HTTP/HTTPS/CONNECT, łączny
  throughput, Potato/idle, gzip i rozmiar po dekompresji, backpressure dużego body,
  retry/jitter, deadline, hot reload oraz shutdown w różnych fazach.
- `tests/network-paths.test.js`, `network-http.test.js`, `fixtures/network.cjs`,
  `fixtures/tls/*`, `scrapling-browser.cjs`, `package.json`, `package-lock.json`:
  aktualizacje regresji/fixture'ów, syntetyczny certyfikat localhost i uruchamianie testów.
- `src/network/upload.js`, `metrics.js`, `runtime-state.js`, `incoming-download.js`, `download-stream.js`:
  pacing uploadu, agregaty, komunikacja z dashboardem i synchroniczna ścieżka Unlimited.
- `src/dashboard/network.js`, `server.js`, `public/views/network.js`, `views/settings.js`,
  `state.js`, `app.js`, `model.mjs`: API, rewizje, formularz Network i status runtime.
- `tests/network-upload.test.js`, `network-api.test.js`, `network-dashboard-browser.cjs`,
  `scripts/benchmark-network.cjs`, `.gitignore`: testy 09–13, benchmark i pomijanie
  tymczasowego snapshotu w repozytorium. Bez nowych zależności produkcyjnych w 09–14.

```bash
npm test
node main.js --check-config

# Osobno: rzeczywisty Scrapling 0.4.15 i lokalny Chromium.
XFEEDER_BROWSER_PATH=/path/to/chromium npm run test:scrapling-browser

# Opcjonalna istniejąca kontrola dashboardu, z zewnętrznym Playwright.
PLAYWRIGHT_MODULE=/path/to/playwright-core \
XFEEDER_BROWSER_PATH=/path/to/chromium npm run test:dashboard-browser

PLAYWRIGHT_MODULE=/path/to/playwright-core \
XFEEDER_BROWSER_PATH=/path/to/chromium npm run test:network-browser
npm run benchmark:network
npm run benchmark:network -- --steady # dłuższa rozgrzewka i próbka buforowanego HTTP
```

Testy korzystają z loopback i tymczasowych konfiguracji. Rzeczywisty test Scrapling
sprawdza również shutdown aktywnej przeglądarki i zakończenie jej drzewa procesów
na Linux; Windows/macOS nie były sprawdzane. Testy przepustowości używają tolerancji
czasowej, a rdzeń limitera jest sprawdzany na fałszywym zegarze.

Weryfikacja 9 października 2026: `npm test` — 161/161, rzeczywisty Scrapling —
7/7, przeglądarkowy test dashboardu i UI Network — PASS, `--check-config` — kod wyjścia 0,
bez ostrzeżeń. Chromium pobrano do katalogu tymczasowego na potrzeby testów.
Scenariusze E2E i wyniki pomiarów: [raport TASK 13](network-benchmark.md).
Pomoc użytkowa: [troubleshooting](network-troubleshooting.md).

## Research przed implementacją

Sprawdzona dokumentacja: [zegar monotoniczny](https://nodejs.org/api/perf_hooks.html),
[timery](https://nodejs.org/api/timers.html), [strumienie i backpressure](https://nodejs.org/api/stream.html),
[timeout HTTP](https://nodejs.org/api/http.html), [anulowanie Axios](https://github.com/axios/axios-docs/blob/master/posts/en/cancellation.md),
[konfiguracja Axios](https://github.com/axios/axios/blob/v1.x/docs/pages/advanced/request-config.md),
[HTTP 429](https://www.rfc-editor.org/rfc/rfc6585.html), [sygnały procesu](https://nodejs.org/api/process.html).
