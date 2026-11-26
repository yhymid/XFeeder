# Architektura (Rust, 3.0)

[English](architecture.md) · **Polski**

Jeden plik wykonywalny, dwa tryby: **worker** (domyślny) i **dashboard**
(`xfeeder dashboard`). Nie dzielą pamięci; dashboard edytuje `config.json`/`.env`,
czyta zrzuty telemetrii workera, `sent.json` i dziennik systemd, a prośby dla workera
zostawia w `requests/`.

```
config.json + .env ──► config ──► app (harmonogram) ──► potok feedów ──► wysyłka
                                     │                  │  http / scrapling │  discord / telegram
                                     ▼                  ▼                   ▼
                                  telemetria        stan (cache.feeds.json, cache.json)
                                     │
                                     ▼
              config.json.{network,activity}-runtime.json ◄── dashboard (axum)
                                                                   │
              app (co takt 30 s) ◄── requests/*.json ◄─────────────┘  Sprawdź teraz, Zapomnij
```

## Moduły (`src/`)

| Moduł | Za co odpowiada |
|---|---|
| `main.rs` | CLI, środowisko Tokio, obsługa sygnałów, uruchamianie workera i dashboardu. |
| `config.rs` | Odczyt `.env`, podstawianie `${VAR}`, configi 2.x i schema v2, zbieranie i sprawdzanie kanałów, ustawienia sieci, odciski kluczy cache (obecne i ze starszego 2.x). |
| `app.rs` | Obsługa kanału (wykrywanie nowych wpisów, osobne kubełki na cel, limit serii, 500 ms odstępu między wysyłkami, zapis po każdej potwierdzonej wysyłce) i harmonogram round-robin (takt 30 s, interwał na kanał, wydłużanie po błędach, opcjonalna równoległość, łagodne zamykanie). |
| `feed.rs` | Potok feedu: pobieranie warunkowe, ścieżki zapasowe, łańcuch parserów, odtworzenie zapisanego stanu po błędzie, bezpiecznik na feed. |
| `http.rs` | Wspólne klienty `reqwest`, ponawianie GET z `Retry-After`, ograniczanie pasma i liczby połączeń, opcjonalna polityka tylko adresów publicznych, liczniki bajtów i zapytań. |
| `parsers.rs`, `xmltree.rs` | Parsery feedów (YouTube, Atom, XML/RSS, JSON, API, RSS przez regex, zapasowy HTML) i drzewo XML zgodne z xml2js; wykrywanie stron blokady i wyzwań. |
| `solver.rs` | Opcjonalny klient `/v1` zgodny z FlareSolverr; zdejmuje opakowanie przeglądarkowego podglądu XML/JSON. |
| `filter.rs` | `Filters` kanału (include/exclude, regex, pola, maksymalny wiek). |
| `scrapling.rs` | Opcjonalny worker w Pythonie (`scrapling/browser_worker.py`, wbudowany w plik) rozmawiający JSON-em linia po linii; analiza sygnałów anty-bot i wybór trybu. |
| `deliver.rs` | Payloady webhooków Discorda (Components V2), obsługa 429; wiadomości HTML na Telegram; odczyt kanału Discorda jako źródła; edycja wysłanych wiadomości. |
| `state.rs` | Magazyny JSON z atomowym zapisem, kwarantanną uszkodzonych plików i blokadą „unsafe”; stan feedów (walidatory, zrzuty, zdrowie). |
| `diagnostics.rs` | Opcjonalny stały rejestrator: pliki zdarzeń JSON-lines i okresowy raport opóźnień w Markdown (`Settings.Diagnostics`). |
| `telemetry.rs` | Ograniczone, pseudonimizowane zdarzenia aktywności i metryki, publikowane co 2 s dla dashboardu. |
| `dashboard.rs` | API JSON, sesje z hasłem, sprawdzanie Host/Origin, rewizje `If-Match`, sterowanie workerem. |
| `dashboard/ui.rs` | Strony HTML renderowane po stronie serwera i formularze (bez JavaScriptu; CSP `default-src 'none'`), zapis ze sprawdzaniem rewizji, wykresy SVG, odczyt dziennika, sprawdzanie webhooków Discorda tylko do odczytu. |
| `dashboard/i18n.rs` | Tłumaczenie gotowego HTML z angielskiego na polski (dokładne teksty i wzorce), wybierane ciasteczkiem `xf_lang`. |
| `requests.rs` | Prośby dashboardu do workera: jeden plik JSON na prośbę w `requests/`, wykonywany przez harmonogram w każdym takcie (`Check`, `Forget`). |
| `adaptive.rs` | Opcjonalny interwał na feed liczony z dat wpisów (`Settings.AdaptivePolling`), nigdy dłuższy niż `TimeChecker`. |
| `clearance.rs` | Tymczasowe, opcjonalne ponowne użycie ciasteczka Cloudflare z przeglądarki (`Scrapling.ReuseClearance`). |
| `github_api.rs` | Listy z REST API GitHuba jako feedy; token tylko dla api.github.com. |
| `sent.rs` | `sent.json`: ID wiadomości i wpisy postów z webhooków, do późniejszej edycji. |
| `steam_merge.rs` | Jeden post na aktualizację gry: ogłoszenie Steam i build SteamDB edytują wspólny post (`Settings.SteamMerge`). |
| `mojang.rs` | Notki o zmianach Minecraft Java i Bedrock z plików JSON launchera; każdy wpis ma własny identyfikator. |
| `steam_events.rs` | JSON wydarzeń sklepu Steam jako feed; łatki odróżnione od newsów po typie wydarzenia. |
| `steam_pics.rs` | `steampics://APPID`: buildy, gałęzie i numery zmian z anonimowego SteamCMD (`Settings.SteamPics`). |
| `preview.rs`, `rerender.rs` | `xfeeder preview` (co daje feed, czasy, benchmarki) i `xfeeder rerender` (przebudowa wysłanych postów). |
| `profile_tests.rs` | Testy migawkowe na zapisanych feedach z produkcji (`profiles/`). |
| `build.rs` (główny folder) | Wpisuje krótki commit gita (`XFEEDER_GIT_COMMIT`) pokazywany w dashboardzie. |
| `text.rs`, `js.rs`, `diag.rs` | Pomocnicze funkcje HTML, encji i dat oraz normalizacja linków, semantyka wartości zgodna z JavaScriptem, logger maskujący sekrety. |

## Tożsamość wpisu i cache

Układ `cache.json` (bez zmian od 2.x):

```
{ "<kluczCacheKanału>": { "<adresFeedu>::webhook": ["<id>", …], "<adresFeedu>::telegram": [...] } }
```

- ID wpisu = znormalizowany `link` (bez parametrów śledzących i fragmentu), w drugiej
  kolejności `guid`, a na końcu `hash:` + 20 znaków hex SHA-1 z tytułu, daty, autora i fragmentu treści.
- Listy są od najnowszych i mają limit 2000 na kubełek.
- Stary pojedynczy kubełek (`"<adresFeedu>": [...]`) jest przy pierwszym użyciu
  rozdzielany na cele.
- Klucz cache kanału = `<grupa>:<12 znaków hex SHA-1>` definicji kanału. 2.x
  hashował nieco inny zestaw pól; worker liczy oba i używa klucza z 2.x, gdy tylko
  ten jest w cache.
- Pierwsze zobaczenie: gdy cel nie ma historii dla feedu (brak kubełka
  `<feed>::<cel>` albo jest pusty, i brak starego kubełka), obecne wpisy trafiają do
  kubełka jako już widziane, poza `FirstRunSend` najnowszymi (wg daty). Edycja kanału
  zmienia jego klucz cache, więc to chroni też przed powtórkami po zmianie configu. Żeby
  dodać feedy do kanału i zachować jego historię, przypnij klucz przez
  `"CacheKey": "<obecny klucz>"`.
- `Filters` działają na pobranych wpisach przed wykrywaniem nowych; odfiltrowane wpisy
  nie są zapisywane, więc złagodzenie filtra może je później przepuścić.
- Gdy cel jest trwale nieosiągalny (usunięty wątek lub webhook, unieważniony token,
  nieznany czat), reszta obiegu kanału go pomija; w następnym interwale jest jedna próba.
- Zapisywane są tylko ID **potwierdzonych** wysyłek, a plik jest zapisywany po każdej,
  więc awaria nigdy nie gubi historii ani nie powoduje duplikatów.

## Harmonogram

- Kanały, którym minął `TimeChecker`, są uruchamiane kolejno w kolejności round-robin;
  harmonogram śpi 30 s tylko wtedy, gdy żaden kanał nie czeka. 2.x brał jeden kanał na
  takt 30 s, więc kanał mógł czekać do N × 30 s.
- Po obiegu z błędami następny jest opóźniony o `interwał × 2^(n-1)`, maksymalnie
  8 interwałów albo 1 godzina.
- Z `Settings.AdaptivePolling` kanał budzi się dla feedu, który najwcześniej ma termin,
  i pobiera tylko feedy, którym termin minął.
- W każdym takcie worker wykonuje czekające prośby z dashboardu: *Sprawdź
  teraz* od razu oznacza kanał do sprawdzenia, *Zapomnij* usuwa jeden
  identyfikator z kubełka (odkładane, gdy kanał akurat pracuje) i zapisuje
  `cache.json`.
- `MaxConcurrentChannels > 1` uruchamia różne kanały równolegle.
- Po SIGTERM/SIGINT żaden nowy kanał nie startuje; trwające dostają
  `network.shutdownGraceMs` na dokończenie, potem są przerywane. Drugi sygnał przerywa
  od razu.
- Stan jest zapisywany przed wyjściem.

## Zmiany względem 2.x

- Pluginy Workshop i obraz Dockera nie zostały przeniesione.
- Klient HTTP ponawia odpowiedzi `406`/`415` raz z `Accept: */*`; niektóre strony
  (np. gry-wideo.pl) odrzucają nagłówek Accept typowy dla feedów.
- Poprawne odpowiedzi XML/JSON nie są skanowane pod kątem sygnatur anty-bot, co
  zapobiega fałszywym alarmom przy artykułach wspominających np. „captcha”.
- Treść odpowiedzi jest dekodowana przez `encoding_rs` (BOM, poprawny UTF-8, kodowanie
  z nagłówka, deklaracja w dokumencie); 2.x mapował bajty ISO-8859-2/windows-1250 jeden
  do jednego, psując polskie znaki.
- Tryb `get` Scraplinga obsługuje stały worker w Pythonie zamiast uruchamiania CLI
  Scraplinga.
