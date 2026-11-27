# Konfiguracja XFeedera (`config.json`)

[English](configuration.md) · **Polski**

Dokument ma dwie części:

- **Część 1: przewodnik w trzech poziomach.** Zacznij od poziomu łatwego i idź dalej tylko
  wtedy, gdy czegoś potrzebujesz.
  - [Poziom 1: Łatwy](#poziom-1-łatwy-pierwszy-działający-config): jeden feed na jeden kanał
    Discorda, 5 minut.
  - [Poziom 2: Średni](#poziom-2-średni-kilka-kanałów-wątki-filtry-telegram): kilka kanałów,
    wątki na forum, filtry, Telegram, diagnostyka.
  - [Poziom 3: Trudny](#poziom-3-trudny-strony-które-blokują-boty-cloudflare): strony, które
    blokują boty (Cloudflare i inne zabezpieczenia).
- **Część 2: [wszystkie parametry](#część-2-wszystkie-parametry)**: co robi każdy klucz,
  wartości domyślne i wymagania.

Pełny przykładowy plik: [`config.json.example`](../config.json.example).

**Jak to działa w skrócie:**
- XFeeder co jakiś czas sprawdza **kanały**. Kanał to lista feedów (RSS, Atom, JSON Feed,
  YouTube, zwykła strona z linkiem do feedu) i miejsce, gdzie trafiają nowe wpisy: webhook
  Discorda, Telegram albo oba.
- Każdy wpis jest wysyłany do każdego celu **dokładnie raz**. Historia wysłanych wpisów jest
  w `cache.json`.
- **Zmiany w `config.json` i `.env` są wczytywane same**, przy następnym obiegu (co około
  30 s). Restart jest potrzebny tylko dla `Settings.Diagnostics` i po instalacji Scraplinga.
- Wielkość liter w nazwach kluczy ma znaczenie: `TimeChecker` działa, `timechecker` nie.

---

# Część 1: przewodnik

## Poziom 1: Łatwy (pierwszy działający config)

**Cel:** nowe wpisy z jednego feedu trafiają na jeden kanał Discorda.

**Krok 1. Webhook.** W Discordzie: ustawienia kanału → *Integracje* → *Webhooki* →
*Nowy webhook* → *Kopiuj adres URL webhooka*.

**Krok 2. Plik `.env`** (w tym samym folderze co `config.json`):

```dotenv
DISCORD_WEBHOOK=https://discord.com/api/webhooks/123456/abcdef
```

**Krok 3. Plik `config.json`:**

```json
{
  "channels": {
    "news": {
      "Webhook": "${DISCORD_WEBHOOK}",
      "RSS": ["https://wiadomosci.onet.pl/.feed"],
      "FirstRunSend": 1
    }
  }
}
```

**Krok 4. Sprawdzenie i start:**

```sh
./xfeeder --check-config      # musi pokazać "warnings": []
./xfeeder --dry-run --once    # pobiera feedy, nic nie wysyła: widać, czy feed działa
./xfeeder                     # właściwe uruchomienie
```

### Co znaczy każda linia

| Linia | Znaczenie |
|-------|-----------|
| `"channels": { … }` | Grupa kanałów. Nazwa musi zaczynać się od `channels`. |
| `"news": { … }` | Kanał o nazwie `news`. Nazwa pojawia się w logach, a historia wysłanych wpisów jest pod nią zapisana, więc kanał można potem dowolnie edytować. |
| `"Webhook": "${DISCORD_WEBHOOK}"` | Gdzie wysyłać. `${…}` bierze wartość z `.env`, dzięki czemu adres webhooka nie leży w configu. |
| `"RSS": [ … ]` | Lista feedów. Może być ich wiele. |
| `"FirstRunSend": 1` | Przy pierwszym sprawdzeniu wyślij 1 najnowszy wpis, żeby od razu zobaczyć, że działa. Bez tego XFeeder za pierwszym razem tylko zapamiętuje istniejące wpisy i wysyła dopiero nowe. |

### Co dzieje się domyślnie (nie trzeba tego wpisywać)

| Ustawienie | Domyślnie | Kiedy zmienić |
|------------|-----------|---------------|
| `TimeChecker` (co ile minut sprawdzać) | 30 | Chcesz szybciej: wpis czeka średnio pół interwału, więc przy 30 min to około 15 min opóźnienia. |
| `RequestSend` (ile wpisów na raz z jednego feedu) | 5 | Feed publikuje dużo naraz, a chcesz wszystko: zwiększ. |
| `FirstRunSend` | 0 | Patrz wyżej. |

**Najczęstsze problemy na tym poziomie:**
- `missing delivery target`: zmienna z `${…}` nie istnieje w `.env` albo jest literówka.
- Nic nie przyszło: pierwsze sprawdzenie tylko zapamiętuje wpisy. Ustaw `FirstRunSend` albo
  poczekaj na nowy wpis.
- `--dry-run` pokazuje 403: strona blokuje boty, patrz [Poziom 3](#poziom-3-trudny-strony-które-blokują-boty-cloudflare).

## Poziom 2: Średni (kilka kanałów, wątki, filtry, Telegram)

```json
{
  "Settings": {
    "MaxConcurrentChannels": 2,
    "FirstRunSend": 1,
    "Diagnostics": true
  },
  "ChannelDefaults": {
    "Webhook": "${DISCORD_WEBHOOK}",
    "TimeChecker": 15
  },
  "Telegram": {
    "BotToken": "${TELEGRAM_BOT_TOKEN}",
    "ChatID": "${TELEGRAM_CHAT_ID}",
    "Enabled": false
  },
  "channels": {
    "news": {
      "Thread": "1419684809055272960",
      "RSS": ["https://wiadomosci.onet.pl/.feed", "https://lowcygier.pl/rss"],
      "Filters": { "Exclude": ["sponsorowany"], "MaxAgeHours": 24 }
    },
    "cs2": {
      "Thread": "1424422020971499670",
      "RSS": [
        "https://store.steampowered.com/feeds/news/app/730",
        "https://steamdb.info/api/PatchnotesRSS/?appid=730"
      ],
      "TimeChecker": 60
    },
    "github": {
      "Thread": "1419683936510148810",
      "RSS": ["https://github.com/yhymid/XFeeder/commits/main.atom"],
      "Telegram": { "Enabled": true },
      "Filters": { "Exclude": ["/^Merge (pull request|branch)/"] }
    }
  }
}
```

### Co włączyć, żeby działało prawidłowo

| Co | Po co |
|----|-------|
| **Kanały z nazwami** (`"news": {…}` zamiast listy `[…]`) | Historia wysłanych wpisów zależy tylko od nazwy, więc zmiana webhooka, wątku albo listy feedów niczego nie psuje. W kanałach w liście `[…]` taka zmiana zaczyna historię od nowa. |
| **`ChannelDefaults`** | Wspólny webhook i interwał wpisujesz raz; kanał może je nadpisać (`cs2` ma 60 min). |
| **`Thread`** | Webhook pisze do wątku albo posta na forum zamiast do samego kanału. ID wątku: prawy klik na wątek → *Kopiuj ID* (włącz tryb dewelopera w ustawieniach Discorda). |
| **`MaxConcurrentChannels: 2`** | Wolny kanał (np. strona przez przeglądarkę) nie blokuje pozostałych. |
| **`Filters`** | Odrzucanie niechcianych wpisów (`Exclude`) albo przepuszczanie tylko pasujących (`Include`). Szczegóły w [2.3](#23-filters-filtrowanie-wpisów). |
| **`Telegram`** z `"Enabled": false` w sekcji głównej | **Ważne:** gdy główna sekcja ma token i czat, a nie ma `Enabled: false`, na Telegram idzie **każdy** kanał. Tutaj Telegram jest wyłączony globalnie i włączony tylko w `github`. |
| **`Diagnostics: true`** | Raport `diagnostics/summary-*.md` co 15 minut: ile trwa droga od publikacji do Discorda, które feedy są wolne i które można sprawdzać częściej. Wymaga restartu. |

### Jak dobrać `TimeChecker`

- Opóźnienie to średnio **połowa interwału**: przy 15 min wpis czeka około 7 minut.
- Feedy z GitHuba, Steama i SteamDB zwykle odpowiadają „bez zmian” (304), więc częste
  sprawdzanie prawie nic nie kosztuje.
- SteamDB trzyma odpowiedź w cache przez godzinę: sprawdzanie częściej niż co 60 min nic nie
  da.
- Feedy rzadko aktualizowane (patche gier, commity) mogą mieć 30–60 min; newsy 5–15 min.
- `Settings.AdaptivePolling` sam dobiera krótszy interwał dla każdego feedu (patrz
  [4](#4-settings-ustawienia-ogólne)).
- Raport diagnostyki pokazuje dla każdego feedu, jak często publikuje
  (`publishes every`), i podpowiada, który można sprawdzać częściej.

## Poziom 3: Trudny (strony, które blokują boty, Cloudflare)

Niektóre strony odrzucają programy, które nie są przeglądarką. Najczęściej to Cloudflare
(strona „Just a moment…”, „Verify you are human”). Wtedy XFeeder dostaje błąd 403 zamiast
feedu. Rozwiązanie: **Scrapling**, czyli pobieranie prawdziwą przeglądarką (Chromium), która
sama przechodzi sprawdzenie Cloudflare.

### Krok 1. Upewnij się, że strona naprawdę blokuje

Sprawdź **z serwera, na którym działa XFeeder** (blokady często zależą od adresu IP):

```sh
curl -sI -A "Mozilla/5.0" https://boop.pl/rss | grep -iE "^HTTP|^server|^cf-mitigated"
```

| Wynik | Znaczenie |
|-------|-----------|
| `HTTP/2 200` | Strona nie blokuje. Problem jest gdzie indziej (zły adres, to nie jest feed). |
| `HTTP/2 403` + `cf-mitigated: challenge` | Wyzwanie Cloudflare. Przejdź dalej. |
| `HTTP/2 403` + `server: cloudflare`, bez `cf-mitigated` | Cloudflare blokuje (reguła firewalla). Przeglądarka może pomóc, ale nie musi. |
| `403` / `429` / `503` bez Cloudflare | Inne zabezpieczenie (DataDome, Akamai, Sucuri…) albo limit zapytań. |

W logu XFeedera widać to jako 403 albo
`returned a challenge/block page; no entries this time`.

### Krok 2. Zainstaluj Scrapling (raz)

W folderze z `config.json` (szczegóły w [`scrapling/README.pl.md`](../scrapling/README.pl.md)):

```bash
python3 -m venv scrapling/.venv
scrapling/.venv/bin/pip install --no-deps -r /ścieżka/do/repo/scrapling/requirements.lock.txt
scrapling/.venv/bin/python -m playwright install chromium
scrapling/.venv/bin/python -m patchright install chromium
```

Zrestartuj XFeedera. Gdy włączysz `Logs`, w logu pojawi się
`[Scrapling] Runtime available (scrapling 0.4.x)`.

### Krok 3. Najprostsze ustawienie: przeglądarka tylko gdy trzeba

```json
"Scrapling": {
  "AutoFallback": false,
  "PerUrlConfig": {
    "https://boop.pl/rss": { "fallback": true, "mode": "stealthy-fetch" }
  }
}
```

Adres w `PerUrlConfig` musi być **dokładnie taki sam** jak w kanale.

Co się wtedy dzieje:
1. XFeeder pobiera feed zwykłym zapytaniem (ułamek sekundy).
2. Gdy dostanie 403/429/503 albo stronę wyzwania, otwiera przeglądarkę w trybie
   `stealthy-fetch`.
3. `stealthy-fetch` sam rozwiązuje wyzwanie Cloudflare (`solveCloudflare` jest w tym trybie
   domyślnie włączone, a limit czasu podniesiony do 60 s).

> **Bez `PerUrlConfig` też zadziała:** `AutoFallback` jest domyślnie `true`, więc każdy
> zablokowany feed sam przejdzie na przeglądarkę. `AutoFallback: false` + `fallback` dla
> konkretnych adresów daje kontrolę nad tym, gdzie przeglądarka jest używana (jest wolna
> i zużywa kilkaset MB RAM).

### Krok 4. Strona blokuje zawsze: od razu przeglądarka

Gdy zwykłe zapytanie nigdy nie przechodzi, nie ma sensu go próbować:

```json
"https://boop.pl/rss": { "enabled": true, "mode": "stealthy-fetch" }
```

| `PerUrlConfig` | Zwykłe zapytanie | Przeglądarka | Dla jakich stron |
|----------------|------------------|--------------|------------------|
| `"fallback": true` | najpierw | tylko przy blokadzie | blokują czasem albo przestały blokować |
| `"enabled": true` | nigdy | zawsze | blokują zawsze |
| `"enabled": false` | zawsze | nigdy | nigdy nie używaj przeglądarki dla tego adresu |

Pomiar z produkcji: boop.pl przez przeglądarkę to około 26 s na sprawdzenie; gry-wideo.pl
przestało blokować, więc z `fallback` schodzi z 10,5 s do 0,3 s. Z
`Scrapling.ReuseClearance: true` (tymczasowe, patrz [9.2](#92-parametry-główne)) boop.pl po
pierwszym przejściu przeglądarki zajmuje 8–11 ms.

### Krok 5. Przeglądarka przechodzi, ale wpisów brak albo są niepełne

Strona ładuje treść z opóźnieniem. Dodaj czekanie:

```json
"https://gry-wideo.pl/rss": {
  "fallback": true,
  "mode": "stealthy-fetch",
  "wait": 8000,
  "networkIdle": true
}
```

| Opcja | Kiedy |
|-------|-------|
| `"wait": 8000` | Treść pojawia się po kilku sekundach (czas w ms). |
| `"networkIdle": true` | Czekaj, aż strona skończy pobierać dane. |
| `"waitSelector": ".post"` | Czekaj na konkretny element strony. |
| `"timeoutMs": 90000` | Wolna strona albo długie wyzwanie: więcej czasu (ms). |

Jeśli adres to zwykła strona, a nie feed, dodaj `htmlParseOptions` z selektorami CSS wpisów
(patrz [9.5](#95-htmlparseoptions-strona-bez-feedu)).

### Krok 6. Nadal zablokowane: diagnoza

1. Włącz wyjaśnienia w logu:
   ```json
   "Scrapling": { "AntiBot": { "LogDecisions": true }, "PerUrlConfig": { … } }
   ```
   W logu zobaczysz `Mode stealthy-fetch looks blocked for … score=…` i powody.
2. Spróbuj kolejnych opcji w `PerUrlConfig` (po jednej):
   - `"realChrome": true`: prawdziwy Chrome zamiast Chromium (musi być zainstalowany);
   - `"locale": "pl-PL"`, `"extraHeaders": {"Accept-Language": "pl"}`: wygląda jak polski
     użytkownik;
   - `"proxy": "http://user:hasło@host:port"`: inny adres IP, gdy strona zablokowała IP
     serwera.
3. Alternatywa: zewnętrzny solver FlareSolverr albo Byparr (zwykle w Dockerze), patrz
   [`Solver`](#10-solver-flaresolverr--byparr):
   ```json
   "Solver": { "Url": "http://127.0.0.1:8191", "Feeds": ["https://boop.pl/rss"] }
   ```

### Krok 7. Wydajność przy przeglądarce

| Ustawienie | Po co |
|------------|-------|
| `"Settings": { "MaxConcurrentChannels": 2 }` | Kanał czekający 30 s na przeglądarkę nie blokuje innych kanałów. |
| `"network": { "maxConcurrentScraplingRequests": 1 }` | Najwyżej jedna przeglądarka naraz: mniej RAM-u na małym serwerze. |
| `fallback` zamiast `enabled` | Przeglądarka tylko wtedy, gdy naprawdę trzeba. |
| Nie używaj `ForceGlobal: true` | Przeglądarka dla każdego feedu: kilkadziesiąt razy wolniej. |

**Fałszywe alarmy.** Zdrowy feed RSS/Atom nie jest sprawdzany pod kątem tekstów typu
„captcha”, więc artykuł o captchach nie wywoła przeglądarki. Gdy jakaś zwykła strona HTML
jest błędnie uznawana za blokadę, podnieś `AntiBot.MinConfidence` (domyślnie 40, zakres
0–100) dla tego adresu w `PerUrlConfig[…].antiBot`.

### Inne zaawansowane rzeczy

- Kanał Discorda jako źródło wpisów: [rozdział 6](#6-auth-i-kanał-discorda-jako-źródło).
- Issue, pull requesty, wydania i gałęzie z GitHuba: [6.1](#61-github-api-jako-źródło-authgithubtoken).
- Proxy dla wszystkich zapytań: [rozdział 7](#7-proxy).
- Limity łącza, czasy, blokada adresów prywatnych: [rozdział 8](#8-network-limity-i-czasy).

---

# Część 2: wszystkie parametry

Spis parametrów:

1. [Sekrety i `.env`](#1-sekrety-i-env)
2. [Kanały](#2-kanały)
3. [`ChannelDefaults`](#3-channeldefaults-wspólne-ustawienia-kanałów)
4. [`Settings`](#4-settings-ustawienia-ogólne)
5. [`Telegram`](#5-telegram)
6. [`Auth` i kanał Discorda jako źródło](#6-auth-i-kanał-discorda-jako-źródło)
7. [`Proxy`](#7-proxy)
8. [`network`](#8-network-limity-i-czasy)
9. [`Scrapling`](#9-scrapling-przeglądarka-dla-stron-które-blokują-boty)
10. [`Solver`](#10-solver-flaresolverr--byparr)
11. [Polecenia i zmienne środowiskowe](#11-polecenia-i-zmienne-środowiskowe)
12. [Sprawdzanie configu i częste problemy](#12-sprawdzanie-configu-i-częste-problemy)

## 1. Sekrety i `.env`

Wartość, która w całości ma postać `"${NAZWA}"`, jest zastępowana zmienną `NAZWA`:

1. najpierw ze zmiennych środowiskowych procesu,
2. potem z pliku `.env` leżącego **obok `config.json`**.

| Zapis w configu                         | Wynik                                      |
|-----------------------------------------|--------------------------------------------|
| `"Webhook": "${DISCORD_WEBHOOK}"`       | wartość z `.env`                           |
| `"Webhook": "https://…/${TOKEN}"`       | **nie działa**: zamiana tylko całej wartości |
| `"${BRAK}"` (brak zmiennej)             | pusty tekst; `--check-config` to zgłosi    |

Zasady:
- Nazwa zmiennej: litery, cyfry i `_`, nie może zaczynać się od cyfry.
- W `.env` jedna zmienna na linię: `NAZWA=wartość`. Cudzysłowy wokół wartości są zdejmowane,
  linie zaczynające się od `#` są pomijane.
- Webhooki i tokeny trzymaj w `.env`, nie w `config.json`. Pliku `.env` nie wrzucaj do gita.

## 2. Kanały

### 2.1 Grupy kanałów: lista albo nazwy

Kanały są w kluczach, których nazwa zaczyna się od `channels` (`channels`, `channels2`,
`channelsNews`…). Każda grupa może być **listą** albo **obiektem z nazwami**:

```json
{
  "channels": [
    { "Webhook": "${HOOK_A}", "RSS": ["https://a.example/feed"] },
    { "Webhook": "${HOOK_B}", "RSS": ["https://b.example/feed"] }
  ],
  "channelsNamed": {
    "news":  { "Webhook": "${HOOK_NEWS}",  "RSS": ["https://news.example/rss"] },
    "steam": { "Webhook": "${HOOK_STEAM}", "RSS": ["https://store.steampowered.com/feeds/news/app/730"] }
  }
}
```

| Rodzaj grupy        | Nazwa kanału w logach | Historia wysłanych wpisów (`cache.json`) |
|---------------------|-----------------------|-------------------------------------------|
| lista `[...]`       | `channels#1`, `channels#2`… | klucz liczony z webhooka, wątku i listy feedów |
| obiekt `{"nazwa": …}` | `news`, `steam`     | klucz `grupa:nazwa`, stały                |

> **Ważne:** w grupie-liście zmiana `Webhook`, `Thread` albo listy feedów daje kanałowi
> nowy klucz historii. XFeeder pamięta, jakiego klucza ostatnio używała każda pozycja kanału,
> i przenosi historię pod nowy klucz, więc nic nie idzie dwa razy ani nie ginie. Zmiana adresu
> samego feedu nadal zaczyna dla niego nową historię (działa tylko zasada pierwszego
> sprawdzenia, `FirstRunSend`). Przestawienie kanałów na liście może przenieść historię do
> innego kanału, co nigdy nie jest gorsze niż pusta historia. W grupie z nazwami klucz zależy
> tylko od nazwy. Własny stały klucz można ustawić parametrem `ID` / `CacheKey` (patrz niżej).

Skróty: zamiast obiektu kanał może być samym adresem albo listą adresów. Wtedy wszystkie
pozostałe ustawienia (np. `Webhook`) muszą przyjść z [`ChannelDefaults`](#3-channeldefaults-wspólne-ustawienia-kanałów):

```json
"channels": [
  "https://example.com/feed.xml",
  ["https://a.example/rss", "https://b.example/rss"]
]
```

### 2.2 Parametry kanału

| Parametr       | Typ                    | Domyślnie | Co robi |
|----------------|------------------------|-----------|---------|
| `Label` | tekst | – | Nazwa pokazywana w logach i dashboardzie, np. `"Changelog"`. Nie wchodzi do klucza historii: można ją zmieniać w dowolnej chwili. |
| `RSS` / `Feeds` / `URLs` / `Sources` | lista adresów (lub jeden adres) | – | Feedy kanału. Cztery nazwy znaczą to samo; jeśli użyjesz kilku, listy są łączone, a duplikaty usuwane. |
| `Webhook`      | tekst                  | –         | Webhook Discorda, do którego idą wpisy. |
| `Thread`       | tekst lub liczba       | –         | ID wątku albo posta na forum, do którego webhook ma pisać (wątek musi być w kanale webhooka). |
| `TimeChecker`  | liczba (minuty)        | `30`      | Co ile minut sprawdzać kanał. Wartość ≤ 0 lub niepoprawna = 30. |
| `RequestSend`  | liczba                 | `5`       | Ile najwyżej wpisów wysłać na jedno sprawdzenie i jeden feed. Reszta poczeka na kolejne sprawdzenie. |
| `FirstRunSend` | liczba ≥ 0             | z `Settings.FirstRunSend`, inaczej `0` | Ile najnowszych wpisów wysłać, gdy feed jest widziany pierwszy raz. Pozostałe są tylko oznaczane jako widziane. |
| `Filters`      | obiekt                 | –         | Filtr wpisów, patrz [2.3](#23-filters-filtrowanie-wpisów). |
| `Ping`         | ID roli albo obiekt    | –         | Wzmianka roli, osób albo @everyone nad postem na Discordzie, patrz [2.4](#24-ping-wzmianki). |
| `Telegram`     | obiekt                 | –         | Ustawienia Telegrama dla tego kanału, patrz [Telegram](#5-telegram). |
| `Discord`      | obiekt                 | –         | Kanał Discorda jako **źródło** wpisów, patrz [rozdział 6](#6-auth-i-kanał-discorda-jako-źródło). |
| `AdaptivePolling` | `false` / obiekt     | z `Settings` | Interwał na feed dla tego kanału, patrz [4](#4-settings-ustawienia-ogólne). |
| `ID` / `Key` / `CacheKey` | tekst       | –         | Własny, stały klucz historii kanału (zamiast liczonego). |

Wymagania kanału (sprawdza je `--check-config`):
- co najmniej jedno źródło: feed (`RSS`…) albo `Discord`;
- co najmniej jeden cel: `Webhook` albo pełny Telegram (`BotToken` i `ChatID`).

Jakie adresy działają jako feed:

| Źródło | Przykład |
|--------|----------|
| RSS / Atom | `https://example.com/feed.xml` |
| JSON Feed / JSON API | `https://example.com/feed.json` |
| Kanał YouTube | `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` |
| Commity na GitHubie | `https://github.com/user/repo/commits/main.atom` |
| Newsy gry na Steamie | `https://store.steampowered.com/feeds/news/app/730` |
| Newsy gry ze Steama z podziałem na łatki i newsy | `https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=730&count_before=0&count_after=5&lang_list=0`: te same posty i identyfikatory co w RSS (historia jest zapisywana per adres, więc po zmianie źródła stare posty powstrzymuje `FirstRunSend`), ale każdy wpis dostaje kategorię `Patch`, `Major update`, `Beta`, `Release` albo `News`, a transmisje są pomijane. Notatki do buildu z gałęzi beta lub testowej (`public-beta`, `latest_experimental`, …) dostają `Beta`. Data to chwila publikacji posta, a nie początek wydarzenia. `count_after=5` zmniejsza pobieranie o połowę (5 najnowszych postów). Same łatki: `"Filters": { "Include": ["Patch", "Major update"], "Fields": ["categories"] }`. Obrazki pochodzą z samego posta. Steam nie dokumentuje tego adresu; powrotem jest RSS z wiersza wyżej. |
| Issue, PR, wydania, gałęzie z GitHuba | `https://api.github.com/repos/user/repo/releases`, patrz [6.1](#61-github-api-jako-źródło-authgithubtoken) |
| Buildy i gałęzie gier prosto ze Steama | `steampics://730`: nowy build `public` (kategoria `Build`, link do strony patch notes na SteamDB, ten sam co w RSS SteamDB; historia jest zapisywana per adres, więc po zmianie źródła stare posty powstrzymuje `FirstRunSend`), dodana lub usunięta gałąź (`Branch added` / `Branch removed`, np. `1.42.0.0` w CS2) i nowy build innej gałęzi (`Branch build`). Wymaga [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD) na maszynie, bez konta: jedno anonimowe uruchomienie sprawdza wszystkie adresy `steampics://` z configu, najwyżej co 10 minut. Pierwsze uruchomienie daje jeden wpis, aktualny build, który pierwsze sprawdzenie oznacza jako widziany (albo wysyła przy `FirstRunSend`). Patrz `Settings.SteamPics` w [rozdziale 4](#4-settings-ustawienia-ogólne). Niektóre gry nie pokazują depotów anonimowemu Steamowi (Deadlock, Risk of Rain 2, NARAKA na 2026-11-23); nie dają wpisów, więc dla nich zostaw SteamDB albo feed sklepu. Zamiast `steamdb.info/api/PatchnotesRSS/`, którego SteamDB prosi nie odpytywać automatycznie. |
| Zwykła strona | `https://example.com/blog`: XFeeder znajdzie feed podany w `<link rel="alternate">`. Lepiej jednak wpisać od razu adres feedu, bo to oszczędza jedno zapytanie. |

Przykład pełnego kanału:

```json
"channelsNamed": {
  "cs2": {
    "Webhook": "${DISCORD_WEBHOOK_GAMES}",
    "Thread": "1424422020971499670",
    "RSS": [
      "https://store.steampowered.com/feeds/news/app/730",
      "https://steamdb.info/api/PatchnotesRSS/?appid=730"
    ],
    "TimeChecker": 15,
    "RequestSend": 3,
    "FirstRunSend": 1,
    "Filters": { "Exclude": ["sale", "/\\bdiscount\\b/"] }
  }
}
```

### 2.3 `Filters`: filtrowanie wpisów

| Parametr        | Typ              | Domyślnie | Co robi |
|-----------------|------------------|-----------|---------|
| `Include`       | lista wzorców    | –         | Wpis przechodzi, gdy pasuje do **co najmniej jednego** wzorca. Pusta lista = wszystko przechodzi. |
| `Exclude`       | lista wzorców    | –         | Wpis pasujący do któregokolwiek wzorca jest pomijany. |
| `Fields`        | lista pól        | `title`, `contentSnippet`, `categories` | Gdzie szukać. Dostępne: `title`, `contentSnippet`, `content`, `categories`, `author`, `link`, `guid`. |
| `CaseSensitive` | `true` / `false` | `false`   | Czy rozróżniać wielkość liter. |
| `MaxAgeHours`   | liczba           | –         | Pomija wpisy starsze niż tyle godzin. Wpisy bez daty nie są odrzucane. |

Wzorzec to zwykły fragment tekstu albo wyrażenie regularne zapisane jako `/…/`.
W JSON-ie ukośnik wsteczny trzeba podwoić: `"/\\bv\\d+\\.\\d+/"` oznacza regex `\bv\d+\.\d+`.
Każda wartość pola jest sprawdzana osobno (tytuł, tekst, każda kategoria), więc `^` i `$`
dotyczą jednej wartości: `"/^Build$/"` pasuje do kategorii `Build`, ale nie `Branch build`.

Przykłady:

```json
"Filters": { "Include": ["patch notes", "update"] }
```
Tylko wpisy, w których tytule, opisie albo kategoriach jest „patch notes” lub „update”.

```json
"Filters": { "Exclude": ["sponsorowany", "/promocj[aei]/"], "MaxAgeHours": 48 }
```
Bez wpisów sponsorowanych i promocji, tylko z ostatnich 2 dni.

```json
"Filters": { "Include": ["/\\bv\\d+\\.\\d+/"], "Fields": ["title"], "CaseSensitive": true }
```
Tylko wpisy z numerem wersji (np. `v1.2`) w tytule.

### 2.4 `Ping`: wzmianki

Wspomina role, osoby, `@everyone` albo `@here` w linii nad postem na Discordzie, żeby ludzie
dostali powiadomienie. Posty na Telegramie bez zmian.

```json
"Ping": "123456789012345678"
```

Krótka forma pinguje przy każdym poście kanału: ID roli albo lista wzmianek zapisanych tak,
jak pisze je Discord, w dowolnym połączeniu:

```json
"Ping": ["<@&123456789012345678>", "<@234567890123456789>", "@everyone", "@here"]
```

Samo ID to rola. Pełna forma
ogranicza, które posty pingują:

```json
"Ping": {
  "Roles": ["123456789012345678"],
  "Users": [],
  "Everyone": false,
  "Feeds": ["/releases"],
  "Include": ["/^v?\\d+\\.\\d+/"],
  "Text": "🔔 Nowe wydanie"
}
```

| Ustawienie | Co robi |
|---|---|
| `Roles`, `Users` | ID z Discorda (prawy przycisk → *Kopiuj ID* przy włączonym trybie dewelopera). Działa też `<@&ID>` / `<@ID>`. |
| `Everyone` | `true` pinguje `@everyone`. Webhook potrzebuje uprawnienia *Wspominanie @everyone*. |
| `Here` | `true` pinguje `@here` (tylko osoby online). To samo uprawnienie co przy `Everyone`. |
| `Feeds` | Tylko wpisy z feedów, których adres zawiera jeden z tych tekstów. Pusto = wszystkie feedy. |
| `Include` | Tylko wpisy pasujące do wzorca, jak w [`Filters.Include`](#23-filters-filtrowanie-wpisów) (działają też `Fields`, `CaseSensitive`). |
| `Text` | Tekst przed wzmiankami. |

Rola dostaje ping tylko wtedy, gdy jest *wzmiankowalna* (Ustawienia serwera → Role) albo
webhook może wspominać wszystkich. Powiadamiają wyłącznie wzmianki ustawione tutaj:
`@everyone`, `<@&…>` czy `<@…>` wpisane w treści feedu są pokazywane jako tekst i nigdy
nie pingują. Edycje (`xfeeder rerender`, `SteamMerge`) nie pingują ponownie. `--dry-run`
pokazuje `(ping …)` przy wpisach, które by pingowały.

Buildy Steama (`steampics://`) mają rodzaj zmiany jako pierwszą kategorię: `Build` (nowy
build publiczny), `Branch build`, `Branch added`, `Branch removed`, `Changelist`. Ping tylko
przy nowym buildzie publicznym Counter-Strike 2:

```json
"Ping": {
  "Roles": ["123456789012345678"],
  "Feeds": ["steampics://730"],
  "Include": ["/^Build$/"],
  "Fields": ["categories"],
  "CaseSensitive": true
}
```

`Feeds` porównuje tekst, więc `steampics://730` pasowałoby też do `steampics://7300`; takie
feedy umieść w innym kanale albo rozróżnij je przez `Include`.

## 3. `ChannelDefaults`: wspólne ustawienia kanałów

Ustawienia wpisane w `ChannelDefaults` (dawniej `DefaultChannel`) dostaje każdy kanał.
To, co jest wpisane w samym kanale, ma pierwszeństwo. Obiekty `Telegram` i `Discord` są
łączone pole po polu.

```json
"ChannelDefaults": {
  "Webhook": "${DISCORD_WEBHOOK}",
  "TimeChecker": 30,
  "RequestSend": 5,
  "Filters": { "Exclude": ["sponsored"] }
},
"channels": [
  { "RSS": ["https://a.example/feed"] },
  { "RSS": ["https://b.example/feed"], "TimeChecker": 10 }
]
```

Oba kanały piszą na ten sam webhook. Pierwszy jest sprawdzany co 30 minut, drugi co 10.

## 4. `Settings`: ustawienia ogólne

| Parametr                | Typ              | Domyślnie | Co robi |
|-------------------------|------------------|-----------|---------|
| `Logs`                  | `true` / `false` | `false`   | Wypisuje do logu (stdout / `journalctl`) także zwykłe informacje, np. każde wysłanie. Ostrzeżenia i błędy są wypisywane zawsze. |
| `DebugExpert`           | `true` / `false` | `false`   | Szczegółowe zdarzenia techniczne (`[Expert] {...}`) w logu. Do szukania błędów, bardzo dużo tekstu. |
| `MaxConcurrentChannels` | liczba 1–8       | `1`       | Ile kanałów może być sprawdzanych jednocześnie. `2` wystarcza, żeby wolny kanał (np. strona przez przeglądarkę) nie blokował reszty. |
| `AdaptivePolling` | `false` / `true` / obiekt | `false` | Osobny interwał dla każdego feedu, liczony z dat jego wpisów. Po świeżym wpisie (młodszym niż `BurstHours`, domyślnie 6) feed jest sprawdzany co `MinMinutes` (5); poza tym co średni odstęp między ostatnimi wpisami / `Divisor` (8). Zawsze między `MinMinutes` a `TimeChecker` kanału, więc **żaden feed nie jest sprawdzany rzadziej niż bez tej opcji** (gra aktualizowana raz na pół roku zostaje przy `TimeChecker`). Przykład: `{ "MinMinutes": 5, "BurstHours": 6, "Divisor": 8 }`. Kanał (lub `ChannelDefaults`) może mieć własny obiekt albo `"AdaptivePolling": false`. `false` = stary harmonogram. Jaki interwał dostanie feed, pokazuje `xfeeder preview <URL>`. |
| `SteamMerge` | `false` / `true` / obiekt | `false` | Jeden post na aktualizację gry. Co przyjdzie pierwsze (build z SteamDB albo ogłoszenie na Steamie), idzie od razu. Gdy drugie przyjdzie w ciągu `WindowHours` (12) dla tej samej gry w tym samym kanale, pierwszy post jest **edytowany**: tytuł, notatki i obrazek ogłoszenia plus linia z buildem i przycisk SteamDB. Każdy build bez ogłoszenia zostaje osobnym postem; ogłoszenie dołącza do najnowszego builda, który jeszcze go nie ma. Dołączają tylko ogłoszenia wyglądające na aktualizację (update, patch, hotfix, wersja… albo tytuł podany przez SteamDB), więc eventy i promocje idą osobno. Gdy edycja się nie uda, wpis idzie normalnie. Przykład: `{ "WindowHours": 12 }`. `false` = każdy wpis osobno, jak dotąd. Wymaga `sent.json`, więc działa dla postów wysłanych od wersji z `xfeeder rerender`. |
| `PostText` | `true` / `false` / obiekt | `{ "Length": 1500 }` | Tekst postów Discorda z RSS, Atom i wydarzeń Steama: do `Length` znaków (300–3500) wpisu, ucięty na końcu linii, z pogrubionymi nagłówkami, linkami z własnym tekstem jako `[tekst](adres)` i linią z samym adresem sklepu Steam lub YouTube jako krótkim linkiem z nazwą. `false` (albo `"Enabled": false`) = dotychczasowy tekst: pierwsze ok. 500 znaków, najwyżej 800, bez formatowania. Nie dotyczy Telegrama ani historii wysyłek. |
| `SteamPics` | obiekt | patrz obok | Ustawienia źródeł `steampics://`: `Command` (SteamCMD; domyślnie `/usr/games/steamcmd`, jeśli istnieje, inaczej `steamcmd`), `MinIntervalMinutes` (10; jedno uruchomienie obejmuje wszystkie gry), `TimeoutSeconds` (180; pierwsze uruchomienie dnia aktualizuje sam SteamCMD), `IgnoreBranches` (regex, `^dprp?$` = wewnętrzne gałęzie Valve; `""` = żadne), `RawLog` (`true`: każda zmiana gry, łącznie z szumem, trafia do `steam_pics.changes.jsonl` obok `cache.json`; rotacja przy 20 MB), `Changelists` (`false`; `true` wysyła też każdy numer zmiany bez nowego buildu i gałęzi, kategoria `Changelist`), `Login` i `Password` (opcjonalne, `"${STEAMCMD_LOGIN}"` i `"${STEAMCMD_PASSWORD}"`, oba w `.env`): konto Steam zamiast anonimowego, dla gier, których depotów anonimowy Steam nie pokazuje, jak Deadlock; konto musi mieć grę lub dostęp do niej. Przebiegi używają zapamiętanej sesji SteamCMD; hasło jest używane tylko, gdy jej nie ma (pierwszy przebieg, wygaśnięcie), z tymczasowego pliku 0600, nigdy w linii poleceń ani w logach. Steam może wtedy poprosić o zatwierdzenie logowania w aplikacji Steam Mobile: log o tym mówi; sam SteamCMD czeka tylko około minuty (`ERROR (Timeout)` po ~68 s, sprawdzone 26.11.2026), więc zatwierdź od razu. Gdy logowanie się nie uda (złe hasło, brak zatwierdzenia na czas, kod mailem), w logu jest ostrzeżenie, a przez 6 godzin używany jest tryb anonimowy, także po restarcie, żeby Steam nie był pytany w kółko; błąd sieci ani limit zapytań nigdy nie wysyła hasła. Dashboard nigdy nie pokazuje ani nie zmienia `STEAMCMD_PASSWORD`. Bez `Password` zaloguj się raz ręcznie (`steamcmd +login NAZWA`). Gra odczytana pierwszy raz w drugim trybie jest porównywana od tego przebiegu, więc zmiana trybu niczego nie wysyła. Bezpieczniej użyć osobnego konta Steam dla bota niż własnego. `Live` (`false`; tylko w buildach `cargo build --features live-pics`, jeszcze nie w paczkach wydań): anonimowe połączenie ze Steamem co ~10 s pyta, które gry się zmieniły, i gdy zmieniła się skonfigurowana, od razu uruchamia SteamCMD i sprawdza jej kanały, zamiast czekać `MinIntervalMinutes`; najwyżej co `LiveMinSeconds` (120). Dane dalej czyta i porównuje SteamCMD, więc posty są takie same jak bez tego, tylko szybciej; po zerwaniu połączenia łączy się ponownie i kontynuuje od ostatniego numeru zmiany, więc zmiany w przerwie nie przepadają; wyłączenie i ponowne włączenie `Live` działa bez restartu; zwykły interwał działa dalej. Stan jest w `steam_pics.json`. |
| `FirstRunSend`          | liczba ≥ 0       | `0`       | Domyślna wartość `FirstRunSend` dla kanałów (patrz [2.2](#22-parametry-kanału)). `0` = przy nowym feedzie nic nie wysyłaj, tylko zapamiętaj obecne wpisy. |
| `Diagnostics`           | `true` lub obiekt | wyłączone | Rejestrator diagnostyki, patrz niżej. **Wymaga restartu.** |

### `Settings.Diagnostics`

Zapisuje każde zdarzenie i każdą linię logu (bez tokenów i adresów webhooków) do
`diagnostics/events-RRRR-MM-DD.txt`, a co kilkanaście minut tworzy raport
`diagnostics/summary-RRRR-MM-DD.md`. Raport pokazuje opóźnienie od publikacji do Discorda,
najwolniejsze feedy i wskazówki, co przyspieszyć.

| Parametr         | Domyślnie       | Co robi |
|------------------|-----------------|---------|
| `Enabled`        | `true`          | Włącza rejestrator (gdy sekcja istnieje). |
| `Dir`            | `diagnostics`   | Folder na pliki (względny = obok `config.json`). |
| `SummaryMinutes` | `15`            | Co ile minut odświeżać raport (1–1440). |
| `RetentionDays`  | `14`            | Ile dni trzymać pliki (1–365). Starsze są usuwane. |
| `MaxFileMB`      | `256`           | Maksymalny rozmiar pliku zdarzeń na dzień. Po przekroczeniu zdarzenia są już tylko liczone w raporcie. `0` = bez limitu (pliki starsze niż `RetentionDays` i tak są usuwane). |

```json
"Settings": {
  "Logs": false,
  "MaxConcurrentChannels": 2,
  "FirstRunSend": 1,
  "Diagnostics": { "Enabled": true, "RetentionDays": 30, "MaxFileMB": 512, "SummaryMinutes": 15 }
}
```

Krócej: `"Diagnostics": true` (same wartości domyślne). Na produkcji przy 10 kanałach
zajmuje około 3 MB dziennie.

## 5. `Telegram`

Sekcja `Telegram` w głównym configu to ustawienia wspólne. Kanał może je uzupełnić albo
nadpisać swoim obiektem `Telegram`.

> **Uwaga:** jeśli główna sekcja ma `BotToken` i `ChatID`, **każdy kanał** wysyła też na
> Telegram. Żeby jakiś kanał tego nie robił, daj mu `"Telegram": { "Enabled": false }`.

| Parametr                | Typ              | Domyślnie | Co robi |
|-------------------------|------------------|-----------|---------|
| `Enabled`               | `true` / `false` | `true`    | Włącza Telegram. |
| `BotToken`              | tekst            | –         | Token bota z @BotFather. **Wymagany.** |
| `ChatID`                | tekst / liczba   | –         | ID czatu (`-100…` dla grup i kanałów) albo `@nazwa_kanału`. **Wymagany.** |
| `MessageThreadID`       | liczba / `null`  | –         | ID tematu (wątku) w grupie z tematami. |
| `DisableWebPagePreview` | `true` / `false` | `false`   | Wyłącza podgląd linku pod wiadomością. |
| `SendPhoto`             | `true` / `false` | `true`    | Wpis z obrazkiem idzie jako zdjęcie z podpisem (do 1024 znaków). Gdy Telegram odrzuci obrazek, idzie zwykła wiadomość. |
| `TimeoutMs`             | liczba (ms)      | `15000`   | Limit czasu jednego zapytania do Telegrama. |

Pusty `BotToken` lub `ChatID` w kanale (`""`) oznacza „użyj wartości z głównej sekcji”.

```json
"Telegram": {
  "BotToken": "${TELEGRAM_BOT_TOKEN}",
  "ChatID": "${TELEGRAM_CHAT_ID}"
},
"channels2": {
  "dev": {
    "Webhook": "${DISCORD_WEBHOOK_DEV}",
    "Telegram": { "ChatID": "${TELEGRAM_CHAT_ID_DEV}", "MessageThreadID": 12 },
    "RSS": ["https://github.com/user/repo/commits/main.atom"]
  },
  "tylkoDiscord": {
    "Webhook": "${DISCORD_WEBHOOK_MAIN}",
    "Telegram": { "Enabled": false },
    "RSS": ["https://example.com/feed"]
  }
}
```

## 6. `Auth` i kanał Discorda jako źródło

Kanał może czytać wiadomości z kanału Discorda (zamiast feedu) i przekazywać je na webhook
albo Telegram. Do odczytu potrzebny jest **token konta użytkownika** Discorda.

> Używanie tokenu konta użytkownika przez program jest niezgodne z regulaminem Discorda
> i grozi blokadą konta. Używasz na własne ryzyko.

`Auth` to wspólne dane logowania dla wszystkich kanałów-źródeł:

| Parametr             | Co robi |
|----------------------|---------|
| `Token`              | Token konta użytkownika. Wymagany (tu albo w `Discord.Token` kanału). |
| `x-super-properties` | Nagłówek przeglądarki Discorda (opcjonalnie, wygląda bardziej jak zwykły klient). |
| `cookie`             | Ciasteczka przeglądarki (opcjonalnie). |
| `GitHubToken`        | Token do API GitHuba, patrz [6.1](#61-github-api-jako-źródło-authgithubtoken). |

Obiekt `Discord` w kanale:

| Parametr                        | Domyślnie | Co robi |
|---------------------------------|-----------|---------|
| `ChannelIDs` (lista) lub `ChannelID` | –    | Kanały Discorda do czytania. **Wymagane.** To nie jest ID serwera. |
| `GuildID`                       | –         | ID serwera (dla linków do wiadomości). |
| `Limit`                         | `50`      | Ile ostatnich wiadomości pobierać z każdego kanału. |
| `Timeout`                       | `15000`   | Limit czasu zapytania (ms). |
| `Webhook`, `Thread`             | z kanału  | Inny cel tylko dla wiadomości z Discorda. |
| `Token`, `cookie`, `x-super-properties` | z `Auth` | Nadpisanie danych logowania dla tego kanału. |

```json
"Auth": { "Token": "${DISCORD_AUTH_TOKEN}" },
"channels3": {
  "ogloszenia": {
    "Webhook": "${DISCORD_WEBHOOK_MAIN}",
    "Discord": { "GuildID": "1008460463148900373", "ChannelIDs": ["1405113384818708500"], "Limit": 20 }
  }
}
```

### 6.1 GitHub API jako źródło (`Auth.GitHubToken`)

Feedy Atom na github.com dają commity jednej gałęzi (i są aktualne), ale feed aktywności
konta (`github.com/LOGIN.atom`) bierze dane z „events” GitHuba, które potrafią być
**kilka dni do tyłu**. API GitHuba daje bez opóźnienia to, czego feedy nie mają. Adres API
wpisujesz jak zwykły feed:

| Adres | Co wysyła |
|-------|-----------|
| `https://api.github.com/repos/WŁAŚCICIEL/REPO/commits?sha=GAŁĄŹ` | commity (też z prywatnych repo) |
| `https://api.github.com/repos/WŁAŚCICIEL/REPO/issues?state=all&sort=created` | issue i pull requesty |
| `https://api.github.com/user/issues?filter=all&state=all&sort=created` | issue i PR ze wszystkich Twoich repo (wymaga tokena) |
| `https://api.github.com/repos/WŁAŚCICIEL/REPO/pulls?state=all&sort=created&direction=desc` | tylko pull requesty |
| `https://api.github.com/repos/WŁAŚCICIEL/REPO/releases` | wydania (bez szkiców) |
| `https://api.github.com/repos/WŁAŚCICIEL/REPO/branches` | nowe gałęzie |
| `https://api.github.com/repos/WŁAŚCICIEL/REPO/tags` | nowe tagi |

```json
"Auth": { "GitHubToken": "${GITHUB_TOKEN}" }
```

Token (w `.env`: `GITHUB_TOKEN=...`) jest wysyłany **tylko** do api.github.com. Daje limit
5000 zapytań na godzinę zamiast 60 oraz dostęp do prywatnych repo. XFeeder wyłącznie czyta
(GET), więc wystarczy token fine-grained z uprawnieniami *Read-only* (Contents, Issues,
Pull requests, Metadata). Z tokenem niezmienione odpowiedzi (HTTP 304) nie zużywają limitu,
bez tokena zużywają. Token jest maskowany w logach. Bez tokena publiczne repo też działają,
w granicach 60 zapytań/h: 13 adresów API sprawdzanych co 30 minut zużywa już 26 z nich. Gdy
limit się skończy (albo GitHub poprosi o zwolnienie), XFeeder nie wysyła żadnego zapytania do
API aż do czasu resetu podanego przez GitHuba, dla wszystkich adresów API naraz, a ostrzeżenie
zapisuje raz na godzinę.

Nie dodawaj commitów z API dla gałęzi, która ma już feed Atom z commitami w tym samym
kanale: historia jest zapisywana osobno dla każdego adresu feedu, więc ten sam commit
poszedłby dwa razy.

## 7. `Proxy`

| Parametr  | Domyślnie | Co robi |
|-----------|-----------|---------|
| `Enabled` | `false`   | Kieruje wszystkie zapytania HTTP XFeedera przez proxy. |
| `Url`     | –         | Adres proxy HTTP: `http://host:port` albo `https://host:port`, także z `user:hasło@`. SOCKS nie jest obsługiwany. |

```json
"Proxy": { "Enabled": true, "Url": "http://127.0.0.1:8080" }
```

Przeglądarka Scraplinga ma osobne ustawienie: `proxy` w opcjach Scraplinga.

## 8. `network`: limity i czasy

Sekcja jest opcjonalna, a wartości domyślne są dobre dla serwera. Nieznany klucz albo wartość
spoza zakresu to **błąd** configu, który zgłosi `--check-config`.

| Parametr | Domyślnie | Zakres | Co robi |
|----------|-----------|--------|---------|
| `bandwidthProfile` | `unlimited` | `potato`, `low`, `medium`, `high`, `very-high`, `unlimited`, `custom` | Limit pobierania: potato 10 kbit/s, low 2 Mbit/s, medium 10, high 50, very-high 100 Mbit/s. |
| `downloadLimitMbps` | – | > 0 | Limit pobierania w Mbit/s. Tylko z `custom`. |
| `uploadLimitMbps` | – | > 0 | Limit wysyłania w Mbit/s. Tylko z `custom`. |
| `networkFriendlyMode` | `false` | – | Oszczędny tryb: domyślnie najwyżej 2 zapytania HTTP i 1 przeglądarka naraz. |
| `maxConcurrentRequests` | bez limitu | 1–10000 | Ile zapytań HTTP naraz. |
| `maxConcurrentScraplingRequests` | bez limitu | 1–10000 | Ile pobrań przeglądarką naraz. |
| `scraplingResourceSaving` | `true` | – | Przeglądarka nie ładuje obrazków ani czcionek (nie dotyczy rozwiązywania Cloudflare). |
| `setupTimeoutMs` | `15000` | 0–… | Limit czasu nawiązania połączenia. |
| `idleTimeoutMs` | `15000` | 0–… | Ile może trwać cisza w trakcie pobierania. |
| `requestDeadlineMs` | 120000 | 1–… | Twardy limit czasu całego zapytania, razem z ponowieniami. |
| `shutdownGraceMs` | `5000` | 0–60000 | Ile czasu przy zamykaniu dać trwającym zadaniom. |
| `outboundPolicy` | `unrestricted` | `unrestricted`, `public-only` | `public-only` blokuje adresy prywatne i lokalne (np. `127.0.0.1`, `192.168.…`) oraz wyłącza Scrapling. |
| `maxResponseBytes` | 16777216 (16 MiB) | 1–268435456 | Maksymalny rozmiar odpowiedzi po rozpakowaniu. |

```json
"network": { "networkFriendlyMode": true, "requestDeadlineMs": 60000 }
```

## 9. `Scrapling`: przeglądarka dla stron, które blokują boty

Niektóre strony (np. za Cloudflare) odrzucają zwykłe zapytania. Scrapling pobiera je
prawdziwą przeglądarką (Chromium). **Wymaga** Pythona i Scraplinga zainstalowanych w
`scrapling/.venv` (instrukcja w [`scrapling/README.pl.md`](../scrapling/README.pl.md)). Przeglądarka
jest dużo wolniejsza (10–30 s na stronę zamiast ułamka sekundy) i zużywa kilkaset MB RAM,
więc warto jej używać tylko tam, gdzie to konieczne.

### 9.1 Kiedy XFeeder używa przeglądarki

| Ustawienie | Efekt |
|------------|-------|
| `Enabled: false` | Nigdy. |
| `PerUrlConfig["adres"].enabled: true` | Zawsze dla tego adresu. |
| `PerUrlConfig["adres"].fallback: true` | Dla tego adresu najpierw zwykłe zapytanie; przeglądarka tylko, gdy strona zablokuje. **Polecane.** |
| `AutoFallback: true` | Jak `fallback`, ale dla **wszystkich** feedów. |
| `ForceGlobal: true` | Zawsze dla wszystkich feedów (bardzo wolne). |
| `PerUrlConfig["adres"].enabled: false` | Nigdy dla tego adresu, mimo ustawień globalnych. |

„Strona zablokowała” oznacza kod z `FallbackStatusCodes` (domyślnie 403, 429, 503) albo
wykrytą stronę anty-bot (patrz `AntiBot`).

Przykład z produkcji: boop.pl zawsze blokuje, a gry-wideo.pl działa bez przeglądarki
(0,3 s zamiast 10,5 s), ale ma przeglądarkę w zapasie:

```json
"Scrapling": {
  "Enabled": true,
  "AutoFallback": false,
  "PerUrlConfig": {
    "https://boop.pl/rss": { "enabled": true, "mode": "stealthy-fetch" },
    "https://gry-wideo.pl/rss": { "fallback": true, "mode": "stealthy-fetch", "wait": 8000, "networkIdle": true }
  }
}
```

### 9.2 Parametry główne

| Parametr | Domyślnie | Co robi |
|----------|-----------|---------|
| `Enabled` | `true` | Włącza Scrapling (działa tylko, gdy jest zainstalowany w `scrapling/.venv`). |
| `AutoFallback` | `true` | Przeglądarka dla każdego zablokowanego feedu. |
| `ForceGlobal` | `false` | Przeglądarka dla każdego feedu. |
| `FallbackStatusCodes` | `[403, 429, 503]` | Kody HTTP oznaczające blokadę. |
| `ReuseClearance` | `false` | **Tymczasowe, do wyłączenia.** Po przejściu Cloudflare przez przeglądarkę zapisuje ciasteczka strony (`cf_clearance`) i User-Agenta przeglądarki w `clearance.json` (obok `config.json`, uprawnienia 0600, nie trafia do gita). Kolejne sprawdzenia tej strony idą najpierw zwykłym HTTP z tym ciasteczkiem (boop.pl: 8–11 ms zamiast 26 s). Gdy strona je odrzuci, wpis jest kasowany i działa przeglądarka jak dotąd. `false` lub brak = stary system; plik `clearance.json` można wtedy usunąć. |
| `AntiBot` | – | Rozpoznawanie stron anty-bot, patrz 9.4. |
| `DefaultOptions` | – | Opcje pobierania dla wszystkich adresów, patrz 9.3. |
| `PerUrlConfig` | – | Ustawienia dla konkretnych adresów (adres musi być **identyczny** jak w kanale). Te same opcje co w `DefaultOptions` oraz `enabled`, `fallback`, `antiBot`, `htmlParseOptions`. |

### 9.3 Opcje pobierania (`DefaultOptions` i `PerUrlConfig`)

Tryby (`mode`):

| Tryb | Co robi | Szybkość |
|------|---------|----------|
| `get` | Zapytanie HTTP udające przeglądarkę, bez uruchamiania przeglądarki. | szybki |
| `fetch` | Przeglądarka. | wolny |
| `stealthy-fetch` | Przeglądarka z ukrywaniem automatyzacji; domyślnie rozwiązuje Cloudflare. | najwolniejszy, najskuteczniejszy |

Jeśli tryb zawiedzie, próbowane są kolejne z `AntiBot.ModeOrder` (najwyżej `MaxAttempts`).

Najważniejsze opcje przeglądarki (`fetch`, `stealthy-fetch`):

| Opcja | Domyślnie | Co robi |
|-------|-----------|---------|
| `solveCloudflare` | `true` w `stealthy-fetch` | Rozwiązuje wyzwanie Cloudflare (Turnstile). Wydłuża limit czasu do co najmniej 60 s. |
| `timeoutMs` | `30000` | Limit czasu ładowania strony. |
| `wait` | `0` | Ile ms poczekać po załadowaniu (np. `8000`, gdy treść pojawia się z opóźnieniem). |
| `networkIdle` | `false` | Czekaj, aż strona przestanie pobierać dane. |
| `waitSelector` | – | Czekaj na element CSS, np. `".content-ready"`. |
| `headless` | `true` | Przeglądarka bez okna. |
| `disableResources` | zależnie od `scraplingResourceSaving` | Nie ładuj obrazków, czcionek i podobnych zasobów (szybciej, ale może zepsuć Cloudflare). |
| `blockAds` | `false` | Blokuj reklamy. |
| `blockWebrtc`, `hideCanvas`, `allowWebgl` | – | Dodatkowe ukrywanie odcisku przeglądarki. |
| `realChrome` | `false` | Użyj zainstalowanego Chrome zamiast Chromium. |
| `locale` | – | Język przeglądarki, np. `"pl-PL"`. |
| `proxy` | – | Proxy dla przeglądarki. |
| `extraHeaders` | – | Dodatkowe nagłówki, np. `{"Accept-Language": "pl"}`. |
| `cookies` | – | Ciasteczka startowe. |
| `dnsOverHttps` | `false` | DNS przez HTTPS. |
| `maxPages` | – | Ile kart może mieć sesja przeglądarki. |

Opcje trybu `get`: `headers`, `timeoutSeconds` (domyślnie 30), `followRedirects` (`true`),
`verify` (`true`), `impersonate` (np. `"chrome"`), `stealthyHeaders` (`true`), `proxy`.

### 9.4 `AntiBot`: rozpoznawanie stron blokujących

Można je ustawić globalnie (`Scrapling.AntiBot`) albo dla adresu (`PerUrlConfig[…].antiBot`).

| Parametr | Domyślnie | Co robi |
|----------|-----------|---------|
| `Enabled` | `true` | Wykrywanie stron anty-bot. |
| `StatusCodes` | `[403, 429, 503]` | Kody uznawane za blokadę. |
| `HeaderKeys` | – | Nagłówki zdradzające ochronę (np. `cf-mitigated`). |
| `BodySignatures` / `TitleSignatures` | – | Teksty w treści / tytule strony wyzwania (np. „just a moment”). |
| `TreatCloudflareAsSignal` | `true` | Odpowiedź z serwera Cloudflare liczy się jako sygnał blokady. |
| `MinBodyBytes` | `0` | Podejrzanie mała odpowiedź (przy innych sygnałach) = blokada. |
| `MinConfidence` | `40` | Próg pewności (0–100), od którego strona jest uznana za blokadę. |
| `PreferStealthOnSignals` | `true` | Przy wykrytej blokadzie zacznij od `stealthy-fetch`. |
| `ModeOrder` | `["get", "fetch", "stealthy-fetch"]` | Kolejność trybów przy kolejnych próbach. |
| `MaxAttempts` | `3` | Ile trybów najwyżej spróbować. |
| `LogDecisions` | `false` | Wypisuj w logu, dlaczego strona została uznana za zablokowaną. |

### 9.5 `htmlParseOptions`: strona bez feedu

Gdy przeglądarka zwróci zwykłą stronę HTML, wpisy są z niej wycinane selektorami CSS:

| Opcja | Domyślnie |
|-------|-----------|
| `itemSelector` | `article, .post, .entry, li` |
| `titleSelector` | `h1, h2, h3, .title, .entry-title` |
| `linkSelector` | `a[href]` |
| `dateSelector` | `time[datetime], time, .date, .published` |
| `authorSelector` | `.author, [rel='author']` |

```json
"PerUrlConfig": {
  "https://example.com/news": {
    "enabled": true,
    "mode": "fetch",
    "htmlParseOptions": { "itemSelector": ".news-item", "titleSelector": "h3", "linkSelector": "a.more" }
  }
}
```

## 10. `Solver`: FlareSolverr / Byparr

Alternatywa dla Scraplinga: zewnętrzna usługa z API FlareSolverr (FlareSolverr, Byparr,
TRAWL), uruchomiona osobno (zwykle w Dockerze).

| Parametr | Domyślnie | Co robi |
|----------|-----------|---------|
| `Enabled` | `true` (gdy sekcja istnieje) | Włącza solver. |
| `Url` | – | Adres usługi, np. `http://127.0.0.1:8191`. **Wymagany.** |
| `Feeds` | – | Feedy pobierane zawsze przez solver. |
| `Auto` | `false` | Inne feedy idą przez solver, gdy zwykłe zapytanie zostanie zablokowane. |
| `OnStatus` | `[403, 503]` | Kody HTTP uruchamiające `Auto`. |
| `MaxTimeoutMs` | `60000` | Ile solver może pracować nad jedną stroną. |

```json
"Solver": { "Url": "http://127.0.0.1:8191", "Feeds": ["https://boop.pl/rss"], "Auto": false }
```

## 11. Polecenia i zmienne środowiskowe

```
xfeeder [run] [--dry-run] [--once] [--check-config] [--debug-expert]
              [--config ŚCIEŻKA] [--cache ŚCIEŻKA]
xfeeder dashboard [--data-dir FOLDER]
xfeeder preview <URL>... [--profile NAZWA] [--items N] [--bench N] [--json]
xfeeder rerender [--channel NAZWA] [--hours N] [--limit N] [--apply]
xfeeder --version | --help
```

| Opcja | Co robi |
|-------|---------|
| `--check-config` | Wczytuje i sprawdza config, wypisuje liczbę kanałów i ostrzeżenia, kończy. |
| `--dry-run` | Pobiera wszystko i pokazuje, co by wysłał; nic nie wysyła i nie zapisuje. |
| `--once` | Jeden obieg wszystkich kanałów i koniec. **Wysyła naprawdę**, chyba że razem z `--dry-run`. |
| `--debug-expert` | Szczegółowe zdarzenia techniczne w logu (sekrety są ukryte). |
| `--config`, `--cache` | Inne położenie `config.json` i `cache.json` (domyślnie bieżący folder). |
| `preview <URL>` | Pokazuje, co XFeeder odczyta z feedu (tytuł, autor, data, obrazek, link, tekst) i ile trwa pobranie, parsowanie i sprawdzenie obrazka. Nic nie wysyła i nie zapisuje; używa Scraplinga, solvera i proxy z `config.json`. `--bench 10` mierzy 10 razy (min/mediana/p95/max), `--profile news` sprawdza wszystkie feedy profilu, `--json` daje wynik dla skryptów. |
| `rerender` | Przebudowuje wysłane już posty Discorda w aktualnym wyglądzie, edytując wiadomości przez ich webhook (nic nowego nie wysyła). Korzysta z `sent.json` (obok `cache.json`, zapisywany od tej wersji: ID wiadomości i treść wpisu, bez adresów webhooków), więc starsze posty zostają bez zmian. Bez `--apply` tylko wypisuje, co by zmienił. `--channel channels11#11` ogranicza do kanału, `--hours 24` do ostatnich godzin, `--limit` (50) do najnowszych postów. |
| `dashboard --data-dir` | Uruchamia panel WWW dla folderu z `config.json`. Domyślnie `http://127.0.0.1:3000`. Po angielsku albo po polsku: przełącznik EN · PL w prawym górnym rogu (zapamiętywany w ciasteczku). Steruje tylko workerem, którego sam uruchomił; worker z systemd obsługuje `systemctl`. Wszystkie strony: [przewodnik po dashboardzie](dashboard.pl.md). |

```sh
XFEEDER_DASHBOARD_PASSWORD='silne-hasło' ./xfeeder dashboard --data-dir /opt/xfeeder
```

Zmienne można ustawić w systemie albo w `.env`.

| Zmienna | Co robi |
|---------|---------|
| `XFEEDER_DRY_RUN=1` | Pobiera wszystko, ale nic nie wysyła i nie zapisuje (test). |
| `XFEEDER_RUN_ONCE=1` | Jeden obieg wszystkich kanałów i koniec. |
| `XFEEDER_DEBUG_EXPERT=1` | Jak `Settings.DebugExpert`. |
| `XFEEDER_DIAGNOSTICS=1` | Włącza diagnostykę (jak `Settings.Diagnostics: true`). |
| `XFEEDER_DASHBOARD_PASSWORD` | Hasło do dashboardu. **Wymagane**, gdy dashboard słucha poza `127.0.0.1`. |
| `XFEEDER_DASHBOARD_HOST` / `_PORT` | Adres i port dashboardu (domyślnie `127.0.0.1:3000`). |
| `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` | Publiczny adres dashboardu za reverse proxy, np. `https://feeds.example.com`. |
| `XFEEDER_DASHBOARD_WORKER_CONTROL` | `off` = bez Start/Stop/Restart w dashboardzie (worker działa jako osobna usługa lub kontener). Zobacz [dashboard.pl.md](dashboard.pl.md). |
| `XFEEDER_DASHBOARD_SESSION_TTL_HOURS` | Jak długo trwa zalogowanie (domyślnie 12 h). |
| `XFEEDER_SERVICE_UNIT` | Usługa systemd, której dziennik pokazuje strona Logi w dashboardzie (domyślnie `xfeeder`). |

## 12. Sprawdzanie configu i częste problemy

Przed uruchomieniem:

```sh
./xfeeder --check-config            # błędy i ostrzeżenia, liczba kanałów
./xfeeder --dry-run --once          # pełny obieg bez wysyłania
```

| Komunikat / objaw | Przyczyna i rozwiązanie |
|-------------------|-------------------------|
| `missing delivery target` | Kanał nie ma `Webhook` ani pełnego Telegrama. Sprawdź też, czy zmienna `${…}` istnieje w `.env`. |
| `missing feed sources or Discord source` | Kanał nie ma `RSS`/`Feeds`/… ani `Discord`. |
| `Telegram is enabled but BotToken or ChatID is missing` | Uzupełnij oba pola albo ustaw `Telegram.Enabled: false`. |
| `cache key collision` | Dwa kanały w grupie-liście są identyczne. Nadaj jednemu `ID` albo użyj grupy z nazwami. |
| `Unsupported configuration section` | Nieznana sekcja (np. literówka w nazwie albo stary `Matrix`). Nic z niej nie zostanie wykonane. |
| Nowy kanał nic nie wysłał | Tak ma być: pierwsze sprawdzenie tylko zapamiętuje wpisy. Ustaw `FirstRunSend`, jeśli chcesz od razu kilka ostatnich. |
| Feed zwraca 403 | Strona blokuje boty: dodaj ją do `Scrapling.PerUrlConfig` z `"fallback": true`. |
| Wpisy przychodzą z dużym opóźnieniem | To głównie `TimeChecker`: wpis czeka średnio pół interwału. Raport diagnostyki pokazuje, które feedy można sprawdzać częściej; `Settings.AdaptivePolling` robi to automatycznie. |

Diagnostyka (`Settings.Diagnostics`) i jej raport w `diagnostics/summary-*.md` są najlepszym
miejscem, żeby sprawdzić, który feed jest wolny albo zawodzi.
