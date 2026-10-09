# Bazowe zachowanie sieci — TASK 01

> Dokument historyczny: opisuje punkt odniesienia sprzed TASK 02–07.
> Aktualne limity, propagację anulowania i shutdown opisuje
> [Network Usage Control](network-control.md). Dwa testy dawnego braku propagacji
> abort zaktualizowano po wdrożeniu anulowania HTTP i backoffu.

Stan przed implementacją Network Usage Control. Zadanie dodaje wyłącznie testy,
fixture'y, dokumentację i integrację z `npm test`. Nie zmienia kodu produkcyjnego,
konfiguracji użytkownika ani zależności. Nie wprowadza limitera.

## Mapa ruchu

| Ścieżka                                    | Moduły inicjujące operację                                                                           | Transport i obecne zachowanie                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RSS, Atom, JSON Feed, YouTube              | `src/app/bootstrap.js` → `src/core/feed-pipeline.js` → `src/parsers/downloader.js` → `src/client.js` | Axios GET; pobranie wspólne dla kolejnych prób parserów; ETag/Last-Modified; 304 odtwarza cache.                                                                                                                                                                     |
| Parsery RSS/Atom/JSON/YouTube/XML/HTML/API | `src/parsers/{rss,atom,json,youtube,xml,fallback,api_x}.js`                                          | Korzystają z wstrzykniętego klienta. GET tego samego URL w pipeline wykorzystuje już pobraną odpowiedź. Inne URL i POST przechodzą przez `getWithFallback` / `postWithFallback`. Fallback `rss-parser` dostaje `parseString`, więc sam nie pobiera feedu.            |
| Źródła Discord                             | `src/parsers/discord.js` → klient wstrzyknięty przez bootstrap                                       | GET `discord.com/api/v9/channels/.../messages`; kanały kolejno; domyślny timeout 15 s. Bootstrap przekazuje `getHttpClient`, bez wrappera GET retry. Błąd jednego kanału nie zatrzymuje pozostałych. Samodzielne wywołanie parsera domyślnie używa globalnego Axios. |
| Wysyłka Discord                            | `src/message.js`                                                                                     | Bezpośredni `axios.post` webhooka, Components V2. Tylko 429 jest ponawiane, maksymalnie 3 retry (4 próby). Opóźnienie z body/headerów lub backoff, ograniczone do 0,5–15 s. Brak jawnego timeoutu i przekazywania sygnału.                                           |
| Wysyłka Telegram                           | `src/telegram.js`                                                                                    | Bezpośredni `axios.post` do `api.telegram.org/.../sendMessage`. JSON, domyślnie 15 s, bez retry i sygnału. Błąd API jest zgłaszany także dla HTTP 200 z `ok:false`.                                                                                                  |
| Scrapling: wybór ścieżki                   | `src/parsers/downloader.js` → `src/extensions/Scrapling/index.js`                                    | Wymuszenie globalne/per URL lub fallback po błędzie/challenge. HTTP 429 po wyczerpaniu GET retry zwraca `HTTP_RATE_LIMITED`, bez uruchamiania fallbacku.                                                                                                             |
| Scrapling: CLI                             | `src/extensions/Scrapling/cli.js`                                                                    | `execFile(scrapling, ["extract", ...])`; ruch wykonuje proces Python/ewentualna przeglądarka. Node odczytuje tymczasowy plik wyniku. CLI nie zwraca metadanych HTTP.                                                                                                 |
| Scrapling: shell                           | `src/extensions/Scrapling/shell.js`                                                                  | `execFile(python, ["-c", ...])`; Fetcher/DynamicFetcher/StealthyFetcher inicjują ruch poza Axios. Wynik JSON zawiera HTML, status i nagłówki. Żądanie metadanych może przełączyć CLI na shell.                                                                       |
| Scrapling: sesje przeglądarki              | `src/extensions/Scrapling/browser-worker.js` → `browser_worker.py`                                   | Node uruchamia trwały proces Python i komunikuje się JSON-em przez stdio. Python używa DynamicSession/StealthySession i `session.fetch`; Chromium pobiera również zasoby strony. Timeout procesu nie jest timeoutem aktywności HTTP.                                 |
| Proxy                                      | `src/client.js`                                                                                      | `Proxy.Enabled` + `Proxy.Url` wybierają HttpProxyAgent i HttpsProxyAgent (CONNECT). Klient jest cache'owany według tych ustawień. Explicit proxy wyłącza mechanizm proxy Axios przez `proxy:false`.                                                                  |
| Dashboard                                  | `src/dashboard/public/api.js` → `src/dashboard/server.js`                                            | Przeglądarka wywołuje API własnego dashboardu. To odrębny ruch sterujący, objęty istniejącymi testami dashboardu.                                                                                                                                                    |

Linki do obrazków, załączników i miniatur są w zwykłych parserach/senderach danymi
w payloadzie, nie dodatkowymi downloadami XFeedera. Dostawca wiadomości może
pobrać je później. Scrapling z przeglądarką może pobierać zasoby podrzędne.
`ScraplingDetector` uruchamia lokalne polecenia wykrywania; narzędzia instalacyjne
Scrapling mogą pobierać zależności, ale nie są częścią cyklu odczytu feedów.

## Retry, proxy i anulowanie: ograniczenia stanu bazowego

- `getWithFallback` domyślnie wykonuje do 3 prób, z twardym maksimum 5.
  Ponawia 408/425/429/500/502/503/504 oraz wybrane błędy transportu.
  Backoff jest wykładniczy z jitterem 0,8–1,2; domyślna baza 500 ms, cap
  przed jitterem 8 s. `Retry-After` dla 429/503 zastępuje backoff, również
  powyżej capu. `postWithFallback` nie ponawia POST.
- Axios przyjmuje sygnał przez wspólne GET/POST: anulowanie aktywnego żądania
  i strumienia działa, anulowanego żądania nie ponawia się. Błąd strumienia po
  zwróceniu nagłówków trafia do konsumenta, poza pętlą retry.
- `download()` obecnie **nie przekazuje `opts.signal`**. Oczekiwanie backoff
  w kliencie i senderze Discord nie jest anulowalne. Testy charakterystyki
  zapisują te ograniczenia, nie traktują ich jako docelowego kontraktu.
  Przy późniejszej naprawie należy zmienić te testy wraz z implementacją.
- Nadawcy Discord/Telegram nie używają wspólnej konfiguracji `Proxy`.
  Globalne zmienne proxy środowiska nadal mogą wpływać na bezpośredni Axios,
  a także na klienta wspólnego przy wyłączonym explicit proxy. Scrapling ma
  własne opcje proxy przekazywane do jego runtime'u.
- W produkcji nie ma jeszcze modelu `network`. Obecny brak ograniczeń jest
  bazą dla przyszłego `Unlimited`; jawny obiekt z `bandwidthProfile: "unlimited"`
  w fixture jest dziś ignorowany, a nie walidowany jako nowy preset.

## Testy i granice pokrycia

Uruchom `npm test` (Node >=22). Runner wykonuje istniejące testy dashboardu oraz:

- `tests/network-http.test.js`: zwykłe GET/POST, chunked, zerwane połączenie
  przed/po nagłówkach, timeout, redirect/304, 403, 429 z Retry-After, 5xx,
  backoff/jitter, równoczesne żądania, AbortSignal, gzip/limit rozmiaru,
  walidacja protokołu, lokalne proxy HTTP i transfer Unlimited.
- `tests/network-paths.test.js`: rzeczywisty downloader/pipeline i parsery
  RSS/Atom/JSON/YouTube, walidatory 304, źródła Discord, wysyłka Discord/Telegram,
  istniejące ograniczenie propagacji sygnału w downloaderze.
- `tests/network-scrapling.test.js`: wybór CLI/shell/session, HTTP fallback,
  wykluczenie fallbacku po 429, wymuszenie i błąd runtime'u, kontrakt wywołań
  `execFile`, przekazywanie metadanych i usuwanie tymczasowego wyniku CLI.
- `tests/fixtures/network.cjs` i `feeds.cjs`: serwery loopback na dynamicznych
  portach, kontrolowane bramki retry, syntetyczne feedy i wiadomości.

Testy sieciowe nie czytają konfiguracji użytkownika. Czyszczą tymczasowo proxy
środowiska i blokują wychodzące żądania Node HTTP(S) poza loopback. Discord
source i Telegram zachowują prawdziwe tworzenie URL/options, a adapter testowy
kieruje transport do lokalnego serwera. Cleanup zamyka sockety, przywraca mocki,
środowisko i cache modułów. Testy w jednym pliku są sekwencyjne; pliki są
izolowane procesami runnera.

Scrapling jest testowany na granicy procesu: żaden Python ani Chromium nie jest
uruchamiany przez nowy zestaw. Nie jest to test działania zewnętrznego serwisu
antybotowego ani wersji biblioteki Python. Proxy ma test rzeczywistego forwardu
HTTP i wyboru agenta HTTPS; negocjacja TLS/CONNECT nie jest testowana end-to-end.

Retry używa kontrolowanych timerów zamiast oczekiwania określonej liczby
milisekund. Timeout sprawdza rodzaj błędu, a współbieżność — dojście obu żądań
do serwera przed zakończeniem odpowiedzi. Unlimited przesyła 16 MiB ze
sprawdzeniem długości i SHA-256 w czasie poniżej 5 s (limit 10 Mbps wymagałby
ponad 13 s). To szeroki test regresji, nie benchmark ani dowód braku każdego
możliwego, bardzo wysokiego limitu; silnie przeciążone CI może wymagać analizy
tego jednego progu. Serwer respektuje backpressure.

Osobny istniejący test przeglądarkowy: `npm run test:dashboard-browser` wymaga
dostępnego Playwright/Chromium zgodnie z README. Konfigurację aplikacji sprawdza
`node main.js --check-config`. Nie uruchamiaj zwykłego cyklu feedów jako testu
offline.

## Dokumentacja sprawdzona przed implementacją

- [Node.js node:test](https://nodejs.org/api/test.html): runner, mocki metod,
  hooki cleanup i izolacja plików.
- [Node.js Streams](https://nodejs.org/api/stream.html): backpressure,
  konsumpcja async iteratorami i propagacja błędów/anulowania.
- [Axios cancellation](https://github.com/axios/axios-docs/blob/master/posts/en/cancellation.md):
  przekazywanie `AbortController.signal` i odrębność timeoutu od anulowania.
