# Dashboard

[English](dashboard.md) · **Polski**

`xfeeder dashboard` to strona WWW do podglądu i edycji działającego XFeedera: kanały,
posty, logi, diagnostyka i ustawienia. Jest częścią tego samego pliku binarnego, nie
używa JavaScriptu i nie wymaga instalowania niczego więcej.

## Uruchamianie

```sh
./xfeeder dashboard --data-dir /sciezka/do/folderu   # folder z config.json, .env, cache.json
# http://127.0.0.1:3000/
```

Na serwerze uruchamiaj go jako usługę systemd `xfeeder-dashboard` (zob.
[Wdrożenie](deployment.pl.md#dashboard)); startuje, zatrzymuje się i restartuje razem z
workerem.

Dashboard i worker to osobne procesy. Dashboard nigdy sam nie wysyła postów i nie
zapisuje plików historii workera (`cache.json`, `sent.json`): edytuje `config.json` i
`.env`, czyta telemetrię workera i przekazuje mu prośby, np. „sprawdź teraz”, przez małe
pliki (zob. [Prośby do workera](#prośby-do-workera)).

## Dostęp i bezpieczeństwo

| Sytuacja | Co zrobić |
|---|---|
| Własny komputer | Otwórz `http://127.0.0.1:3000/`. Na `127.0.0.1` hasło nie jest potrzebne. |
| Serwer | Zostaw adres `127.0.0.1` i otwórz tunel SSH: `SSH_KEY=~/.ssh/klucz scripts/dashboard-tunnel.sh user@serwer`. Działa dowolny port lokalny: `scripts/dashboard-tunnel.sh user@serwer 8080`. |
| Dostęp z sieci | Ustaw `XFEEDER_DASHBOARD_PASSWORD`, `XFEEDER_DASHBOARD_HOST=0.0.0.0`, a za reverse proxy z HTTPS także `XFEEDER_DASHBOARD_PUBLIC_ORIGIN=https://feeds.example.com`. |

- Bez hasła dashboard odmawia nasłuchiwania na adresie innym niż lokalny (loopback).
- Przyjmowane są tylko zapytania z oczekiwaną nazwą hosta (lokalnie: `127.0.0.1`,
  `localhost`, `[::1]` z dowolnym portem), a formularze tylko z tego samego źródła.
- Ciasteczko logowania jest `HttpOnly`, `SameSite=Strict` (i `Secure` przez HTTPS) i
  ważne przez `XFEEDER_DASHBOARD_SESSION_TTL_HOURS` (12 h). Liczba błędnych prób hasła
  jest ograniczona.
- Strony to zwykły HTML ze ścisłą polityką Content-Security-Policy
  (`default-src 'none'`): żadne skrypty nie są ładowane ani uruchamiane.
- Wartości sekretów z `.env` nigdy nie są pokazywane, tylko informacja, czy są ustawione.
  Adresy webhooków, tokeny i wartości ciasteczek są usuwane z logów, aktywności i
  diagnostyki.

| Zmienna | Domyślnie | Co robi |
|---|---|---|
| `XFEEDER_DASHBOARD_HOST` | `127.0.0.1` | Adres nasłuchiwania. |
| `XFEEDER_DASHBOARD_PORT` | `3000` | Port. |
| `XFEEDER_DASHBOARD_PASSWORD` | – | Hasło; wymagane dla adresu innego niż lokalny. |
| `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` | – | Publiczny adres `https://…` za reverse proxy. |
| `XFEEDER_DASHBOARD_WORKER_CONTROL` | `on` | `off` ukrywa Start/Stop/Restart i odrzuca je, gdy worker działa jako osobna usługa lub kontener (Docker). Drugi worker na tym samym `cache.json` i tak nie wystartuje: worker trzyma blokadę `cache.json.lock`. |
| `XFEEDER_DASHBOARD_SESSION_TTL_HOURS` | `12` | Jak długo trwa logowanie. |
| `XFEEDER_SERVICE_UNIT` | `xfeeder` | Usługa systemd, której dziennik czyta strona **Logi**. |

Można je ustawić w środowisku, w pliku usługi systemd albo w `.env`. Edytor `.env` w
dashboardzie ukrywa i chroni linie `XFEEDER_DASHBOARD_*`.

## Język

Przełącznik **EN · PL** w prawym górnym rogu zmienia język wszystkich stron (zapamiętany
w ciasteczku `xf_lang`). Treść feedów, linie logów i zawartość plików są pokazywane bez
zmian.

## Strony

### Przegląd

- **Sterowanie workerem**: czy worker działa. Worker uruchomiony z dashboardu można tu
  uruchomić, zatrzymać i zrestartować; przy workerze z systemd zamiast przycisków jest
  polecenie `systemctl`.
- Liczniki od startu workera: sprawdzenia, posty, błędy, czasy.
- Wykresy **posty dziennie** (ostatnie 30 dni) i **posty na kanał** (ostatnie 7 dni).
- **Ostatnie posty** z linkami do wiadomości na Discordzie oraz **ostatnie problemy**.
- **Feedy z problemami**: feedy, które zwracają błędy, są blokowane albo odpowiadają
  wolno.

### Kanały

Lista kanałów w kolejności z `config.json`, z celem (nazwa webhooka i kanał Discorda,
sprawdzane zapytaniem tylko do odczytu; usunięty webhook jest pokazany jako ostrzeżenie),
rzeczywistym odstępem sprawdzania i feedami.

- **Edytuj**: wszystkie ustawienia kanału w jednym formularzu (`Label`, cel, feedy,
  odstęp, `Filters`, `FirstRunSend`, …). Zapis kanału z grupy-listy przypina jego obecny
  klucz historii (`CacheKey`), więc edycja nie wyśle ponownie starych wpisów.
- **Duplikuj** i **Usuń** (ze stroną potwierdzenia).
- Kliknięcie kanału otwiera **stronę kanału**:
  - cel, odstęp, posty z ostatnich 7 dni, liczba zapamiętanych wpisów, sprawdzenie
    webhooka;
  - wykres postów dziennie, tabela feedów i ostatnie posty;
  - **Sprawdź teraz**: worker sprawdza wszystkie feedy kanału w następnym cyklu
    (najpóźniej po 30 s);
  - **Historia wysyłek**: wpisy, które kanał pamięta jako już wysłane, z tytułami.
    **Zapomnij** usuwa jeden z nich, więc wpis **zostanie wysłany ponownie** przy
    następnym sprawdzeniu, jeśli nadal jest w feedzie.

### Strona feedu

Otwierana z linku feedu: gdzie feed jest używany, jego rzeczywisty odstęp (także z
`AdaptivePolling`), stan, czy używana jest przeglądarka (Scrapling) lub solver, ostatnie
zapisane wpisy i podpowiedzi. **Testuj teraz** pobiera feed raz i pokazuje wpisy tak, jak
czyta je XFeeder; nic nie wysyła i nic nie zapisuje.

### Posty

Posty wysłane na Discorda (z `sent.json`), od najnowszych, z filtrami po kanale i
tekście. **Przebuduj** edytuje wysłaną wiadomość tak, by miała obecny wygląd (to samo co
`xfeeder rerender` dla jednego posta); nic nowego nie jest wysyłane.

### Aktywność

Zdarzenia workera w czytelnej postaci (sprawdzenia, wysyłki, błędy, decyzje Scraplinga),
z filtrami po kanale, feedzie i tekście. Kliknięcie nazwy kanału lub feedu filtruje po
niej.

### Logi

Ostatnie 200–5000 linii dziennika systemd workera (`journalctl -u xfeeder`), od
najnowszych, z filtrem „tylko ostrzeżenia i błędy” i wyszukiwarką. Sekrety są usuwane
przed wyświetleniem. Użytkownik dashboardu potrzebuje dostępu do odczytu dziennika
(członek grupy `adm` lub `systemd-journal`); `sudo` nie jest używane. Ustaw
`XFEEDER_SERVICE_UNIT`, jeśli usługa ma inną nazwę.

### Diagnostyka

- **System**: wersja i commit gita, PID i czas działania workera, pamięć workera i
  dashboardu, limit API GitHuba (pozostało / limit, czas odnowienia), rozmiary plików
  danych.
- **Rejestrator**: czy `Settings.Diagnostics` jest włączone, i najnowszy raport
  (`diagnostics/summary-*.md`: opóźnienie od publikacji do Discorda, najwolniejsze feedy,
  podpowiedzi).
- **Pliki**: pliki diagnostyki na dysku.

### Ustawienia

- **Ogólne**: `Logs`, `DebugExpert`, `MaxConcurrentChannels`, `FirstRunSend`.
- **Rejestrator diagnostyki**, **Adaptacyjne sprawdzanie**, **Steam + SteamDB w jednym
  poście** (`SteamMerge`), **Cloudflare** (`Scrapling.ReuseClearance`) i **Telegram**
  (domyślne dla wszystkich kanałów). Każda sekcja zapisuje ustawienie opisane w
  [przewodniku konfiguracji](configuration.pl.md), więc wyłączenie przywraca wcześniejsze
  działanie.
- **Sieć**: limity i limity czasu z sekcji `network`.
- **Sekrety (.env)**: które zmienne używane w `config.json` są ustawione; ustawienie lub
  podmiana wartości bez oglądania starej.
- **Zapisane ciasteczka Cloudflare**: strony z ciasteczkiem w `clearance.json`, z datą
  wygaśnięcia; **Zapomnij** usuwa jedną (worker sam zauważy zmianę).

### Zaawansowane

- Edytor **.env**: wszystkie niezastrzeżone linie. Poprzedni plik zostaje jako `.env.bak`.
- Edytor **config.json**: cały plik, sprawdzany przed zapisem. Poprzedni plik zostaje
  jako `config.json.bak`.

## Jak działa zapis

- Każdy formularz niesie wersję pliku, z której powstał. Jeśli plik zmienił się w
  międzyczasie (ręcznie albo w innej karcie), zapis jest odrzucany („Konfiguracja
  zmieniła się na dysku od otwarcia tej strony”); odśwież stronę i spróbuj ponownie.
- Plik jest zapisywany atomowo z uprawnieniami `0600`; poprzednia wersja zostaje jako
  `.bak`.
- Worker sam przeładowuje `config.json` i `.env`, zwykle w ciągu kilku sekund; restart
  nie jest potrzebny (poza `Settings.Diagnostics`).

## Prośby do workera

**Sprawdź teraz** i **Zapomnij** zmieniają stan działającego workera, który trzyma
`cache.json` w pamięci. Dlatego dashboard zapisuje jeden mały plik JSON na prośbę do
folderu `requests/` obok `config.json` (folder `0700`, pliki `0600`). W każdym cyklu
harmonogramu (30 s) worker je czyta, wykonuje i usuwa pliki.

- **Sprawdź teraz** sprawia, że kanał jest od razu do sprawdzenia.
- **Zapomnij** usuwa jeden identyfikator z historii kanału i zapisuje `cache.json`. Jeśli
  kanał akurat pracuje, prośba czeka do następnego cyklu.
- Z `--dry-run` prośby są wykonywane tylko w pamięci.
- Niepoprawne lub za duże pliki są usuwane; w jednym cyklu obsługiwanych jest najwyżej
  100 próśb.

## Rozwiązywanie problemów

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| `403 Untrusted Host` | Adres w przeglądarce się nie zgadza. Użyj `127.0.0.1` lub `localhost`, a za proxy ustaw `XFEEDER_DASHBOARD_PUBLIC_ORIGIN`. |
| Dashboard nie startuje z adresem innym niż lokalny | Ustaw `XFEEDER_DASHBOARD_PASSWORD`. |
| `Address already in use` | Na tym porcie działa już inny dashboard, np. usługa systemd. Użyj go albo ustaw inny `XFEEDER_DASHBOARD_PORT`. |
| Strona Logi: „Cannot run journalctl” albo brak linii | Dodaj użytkownika dashboardu do grupy `adm` lub `systemd-journal` albo ustaw `XFEEDER_SERVICE_UNIT`. |
| „zmieniła się na dysku od otwarcia tej strony” przy zapisie | Plik zmienił się po otwarciu strony. Odśwież stronę. |
| Sprawdź teraz / Zapomnij nic nie robi | Worker nie działa albo używa innego folderu danych. Pliki pozostawione w `requests/` zostaną odebrane po jego starcie. |
| Webhook pokazany jako brakujący | Webhook został usunięty na Discordzie: utwórz nowy i wpisz jego adres do `.env`. |
