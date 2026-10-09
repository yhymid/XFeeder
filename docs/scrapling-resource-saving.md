# Scrapling Resource Saving — TASK 08

Resource Saving ogranicza liczbę zasobów pobieranych przez przeglądarkę Scrapling.
Nie jest limitem bitów na sekundę. Ruch Pythona/Chromium nie przechodzi przez
klienta Axios w Node; nie podlega jego ewentualnemu limiterowi.

## Wersja i decyzja

Sprawdzono 6 października 2026:

- `requirements.txt` przypina `scrapling[all]==0.4.15`; lock ma Scrapling 0.4.15
  i Playwright 1.63.0. Lokalna `.venv` zawiera dokładnie te wersje.
- Kopia kodu w `upstream/` ma wersję 0.4.7 i nie jest źródłem importu używanego
  przez lokalny runtime. Nie zmieniono zależności ani tej kopii.
- [Dokumentacja dynamicznych fetcherów dla 0.4.15](https://github.com/D4Vinci/Scrapling/blob/v0.4.15/docs/fetching/dynamic.md)
  oraz zainstalowany kod potwierdzają natywne `disable_resources`,
  `blocked_domains`, `block_ads` i ponowne wykorzystanie kart/sesji.
  `disable_resources` blokuje m.in. obrazy, fonty, media, stylesheet i websocket;
  pozostawia JavaScript oraz XHR/fetch. Blokowanie może zmieniać działanie stron.
- Używamy tych opcji, bez własnego produkcyjnego interception Playwright.
  Sprawdzono również [API Fetchers](https://scrapling.readthedocs.io/en/latest/api-reference/fetchers.html)
  i [Playwright Networking](https://playwright.dev/docs/network).

TASK 08 korzysta teraz ze wspólnej konfiguracji, polityki współbieżności i shutdownu
z [TASK 02–07](network-control.md). Globalna bramka Scrapling zastępuje wcześniejszą
osobną kolejkę. Worker zachowuje wyłącznie serializację wymaganą przez synchroniczny
protokół Pythona. Limit downloadu HTTP nadal nie obejmuje ruchu przeglądarki.

## Konfiguracja

Fragment do scalenia z istniejącym `config.json`:

```json
{
  "network": {
    "scraplingResourceSaving": true,
    "networkFriendlyMode": true,
    "maxConcurrentScraplingRequests": 1
  },
  "Scrapling": {
    "Enabled": true,
    "PersistentBrowserSessions": true,
    "PerUrlConfig": {
      "https://example.com/page-requiring-css": {
        "scraplingResourceSaving": false
      }
    }
  }
}
```

Brak `scraplingResourceSaving` oznacza **true**. Resource Saving ustawia domyślne
`disableResources: true` wyłącznie dla `fetch` i `stealthy-fetch`. Zwykłe
`get/post/put/delete` Scrapling pozostają bez tej automatycznej opcji.
Wyłączenie globalne: `network.scraplingResourceSaving: false`.
Override per URL używa istniejącego `Scrapling.PerUrlConfig` i dokładnego URL.
Można też przekazać `scraplingResourceSaving` w opcjach pojedynczego wywołania.

Opcje natywne są nadal dostępne w `Scrapling.DefaultOptions`, `PerUrlConfig`
i opcjach wywołania:

```json
{
  "disableResources": false,
  "blockAds": false,
  "blockedDomains": []
}
```

Kolejność nadpisywania: DefaultOptions → per URL → opcje wywołania.
Aliasy `disable_resources`, `block_ads`, `blocked_domains` normalizowane są
przed scaleniem każdej warstwy. Jawne `disableResources: false` wygrywa
z domyślnym oszczędzaniem. Z kolei wyłączenie samego Resource Saving nie usuwa
jawnie ustawionych blockerów użytkownika: jeśli DefaultOptions ma
`disableResources: true`, per URL trzeba nadpisać właśnie tę opcję na false.
Nie są automatycznie włączane `blockAds` ani lista domen. Istniejące
`aiTargeted` i surowe flagi CLI pozostają jawnymi ustawieniami zaawansowanymi.

Nie ma automatycznego ponowienia ze wszystkimi zasobami po błędzie: takie
ponowienie mogłoby zwiększyć ruch i omijać świadomie ustawione blokady.
Dla konkretnej strony użyj override. Opcje sesji stanowią część jej istniejącego
klucza cache, więc zmiana polityki nie używa sesji utworzonej z innymi opcjami.

## Współbieżność i anulowanie

Friendly Mode jest domyślnie wyłączony. Po włączeniu dopuszcza jedno zadanie
Scrapling naraz w procesie XFeeder, wspólnie dla instancji, URL i runtime'ów.
`network.maxConcurrentScraplingRequests` pozwala jawnie ustawić dodatni całkowity
limit, również bez Friendly Mode. To osobna granica dla Scrapling; nie zmienia
liczby zwykłych requestów HTTP. Limit jest górną granicą, a nie gwarancją
równoległego wykonania: istniejący synchroniczny worker Pythona wykonuje jedno
żądanie sesyjne naraz. CLI/shell mogą korzystać z wyższego jawnego limitu.

Permit jest zwalniany po zakończeniu operacji lub cleanupie po błędzie/abort.
Anulowany waiter nie uruchamia procesu. Sygnał przekazany jako
`download(url, { signal, ... })` dociera do fallbacku Scrapling; anulowanie nie
powoduje kolejnej próby innym fetcherem. Ten sam sygnał obejmuje zwykłe HTTP,
oczekiwanie na bandwidth, concurrency oraz backoff retry.

CLI/shell i worker obsługują `AbortSignal`. Na POSIX procesy uruchamiane są
w osobnej grupie; abort/timeout kończy grupę, z eskalacją do SIGKILL po sekundzie.
Na Windows ścieżka cleanup używa `taskkill /T /F`. Worker trzyma oczekujące
operacje w Node, dzięki czemu abort aktywnej przeglądarki nie odrzuca niezwiązanych
oczekujących operacji. Po zakończeniu starego procesu kolejna operacja może
uruchomić nowy. Zamknięcie sesji odrzuca oczekujących zamiast restartować browser.
Istniejący hook shutdown aplikacji wywołuje ten sam cleanup.

Testy rzeczywistych procesów wykonano na Linux. Windows/macOS nie były testowane.
Cleanup dotyczy procesów zarządzanych przez XFeeder; nie gwarantuje zakończenia
zewnętrznej przeglądarki wskazanej przez `cdpUrl`. TASK 07 zatrzymuje scheduler
i nowe operacje, po upływie okresu łagodnego zamykania anuluje aktywną pracę
oraz wywołuje cleanup sesji przed końcowym zapisem cache.

## Metryki i testy

Response Scrapling nie daje pełnego, wiarygodnego licznika requestów/bajtów całej
przeglądarki. `get_pool_stats()` opisuje karty, nie transfer. Nie dodano pól
`bytes saved` ani szacowanego transferu. Istniejący `bodyBytes` w diagnostyce jest
rozmiarem zwróconego HTML, a nie sumą ruchu strony i jej zasobów.

```bash
npm test

# Rzeczywisty Scrapling 0.4.15 i lokalny Chromium; tylko serwer loopback:
XFEEDER_SCRAPLING_PYTHON=/path/to/venv/bin/python \
XFEEDER_BROWSER_PATH=/path/to/chromium \
npm run test:scrapling-browser

node main.js --check-config
```

Zwykłe testy Node nie wymagają Pythona. Sprawdzają politykę, aliasy/override,
wybór wszystkich runtime'ów, współbieżność 1/2, anulowanie kolejki, zwalnianie
permitów i zatrzymanie fallbacku po abort. Test przeglądarkowy sprawdza faktyczne
blokowanie CSS/obrazów oraz poprawne renderowanie JS/XHR po fallbacku z HTTP 403.
Warianty off/per URL sprawdzają stronę, która bez CSS nie generuje wyniku.
Test abort na Linux sprawdza zakończenie drzewa procesów oraz dalszą obsługę kolejki.
Interception występuje wyłącznie w tym teście jako blokada wyjścia poza loopback.

Kompatybilność: domyślne Resource Saving może wymagać override na stronach zależnych
od CSS, WebSocketów lub mediów. Istniejące jawne opcje zachowują pierwszeństwo.
Pliki konfiguracyjne użytkownika nie są automatycznie modyfikowane.
