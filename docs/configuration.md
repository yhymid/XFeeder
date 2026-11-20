# Konfiguracja XFeedera (`config.json`)

Ten dokument opisuje każdy parametr `config.json`: co robi, jaka jest wartość domyślna,
czego wymaga i jak wygląda w praktyce. Pełny przykład jest w
[`config.json.example`](../config.json.example).

Spis treści:

1. [Jak to działa w skrócie](#1-jak-to-działa-w-skrócie)
2. [Najmniejszy działający config](#2-najmniejszy-działający-config)
3. [Sekrety i `.env`](#3-sekrety-i-env)
4. [Kanały](#4-kanały)
5. [`ChannelDefaults`: wspólne ustawienia kanałów](#5-channeldefaults-wspólne-ustawienia-kanałów)
6. [`Settings`: ustawienia ogólne](#6-settings-ustawienia-ogólne)
7. [`Telegram`](#7-telegram)
8. [`Auth` i kanał Discorda jako źródło](#8-auth-i-kanał-discorda-jako-źródło)
9. [`Proxy`](#9-proxy)
10. [`network`: limity i czasy](#10-network-limity-i-czasy)
11. [`Scrapling`: przeglądarka dla stron, które blokują boty](#11-scrapling-przeglądarka-dla-stron-które-blokują-boty)
12. [`Solver`: FlareSolverr / Byparr](#12-solver-flaresolverr--byparr)
13. [Zmienne środowiskowe XFeedera](#13-zmienne-środowiskowe-xfeedera)
14. [Sprawdzanie configu i częste problemy](#14-sprawdzanie-configu-i-częste-problemy)

---

## 1. Jak to działa w skrócie

- XFeeder co jakiś czas sprawdza **kanały**. Kanał to lista feedów (RSS, Atom, JSON Feed,
  YouTube, zwykła strona z linkiem do feedu) i miejsce, gdzie trafiają nowe wpisy: webhook
  Discorda, Telegram albo oba.
- Każdy wpis jest wysyłany do każdego celu **dokładnie raz**. Historia wysłanych wpisów jest
  w `cache.json`, osobno dla każdego celu.
- **Zmiany w `config.json` i `.env` są wczytywane same**, przy następnym obiegu (co około
  30 s). Restart jest potrzebny tylko dla `Settings.Diagnostics`.
- Wielkość liter w nazwach kluczy ma znaczenie: `TimeChecker` działa, `timechecker` nie.
- Wszystkie sekcje poza kanałami są opcjonalne.

## 2. Najmniejszy działający config

```json
{
  "channels": [
    {
      "Webhook": "${DISCORD_WEBHOOK}",
      "RSS": ["https://example.com/feed.xml"]
    }
  ]
}
```

i w `.env` obok:

```dotenv
DISCORD_WEBHOOK=https://discord.com/api/webhooks/123456/abcdef
```

Ten kanał sprawdza feed co 30 minut (domyślnie) i wysyła maksymalnie 5 nowych wpisów na
jedno sprawdzenie. Przy pierwszym uruchomieniu niczego nie wysyła: obecne wpisy oznacza jako
już widziane (patrz [`FirstRunSend`](#6-settings-ustawienia-ogólne)).

## 3. Sekrety i `.env`

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

## 4. Kanały

### 4.1 Grupy kanałów: lista albo nazwy

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
> nowy klucz historii. Nic nie zostanie wysłane podwójnie (działa pierwsze sprawdzenie, patrz
> `FirstRunSend`), ale stara historia przestaje być używana. W grupie z nazwami klucz zależy
> tylko od nazwy, więc kanał można dowolnie edytować. Własny stały klucz można też ustawić
> parametrem `ID` (patrz niżej).

Skróty: zamiast obiektu kanał może być samym adresem albo listą adresów. Wtedy wszystkie
pozostałe ustawienia (np. `Webhook`) muszą przyjść z [`ChannelDefaults`](#5-channeldefaults-wspólne-ustawienia-kanałów):

```json
"channels": [
  "https://example.com/feed.xml",
  ["https://a.example/rss", "https://b.example/rss"]
]
```

### 4.2 Parametry kanału

| Parametr       | Typ                    | Domyślnie | Co robi |
|----------------|------------------------|-----------|---------|
| `RSS` / `Feeds` / `URLs` / `Sources` | lista adresów (lub jeden adres) | – | Feedy kanału. Cztery nazwy znaczą to samo; jeśli użyjesz kilku, listy są łączone, a duplikaty usuwane. |
| `Webhook`      | tekst                  | –         | Webhook Discorda, do którego idą wpisy. |
| `Thread`       | tekst lub liczba       | –         | ID wątku albo posta na forum, do którego webhook ma pisać (wątek musi być w kanale webhooka). |
| `TimeChecker`  | liczba (minuty)        | `30`      | Co ile minut sprawdzać kanał. Wartość ≤ 0 lub niepoprawna = 30. |
| `RequestSend`  | liczba                 | `5`       | Ile najwyżej wpisów wysłać na jedno sprawdzenie i jeden feed. Reszta poczeka na kolejne sprawdzenie. |
| `FirstRunSend` | liczba ≥ 0             | z `Settings.FirstRunSend`, inaczej `0` | Ile najnowszych wpisów wysłać, gdy feed jest widziany pierwszy raz. Pozostałe są tylko oznaczane jako widziane. |
| `Filters`      | obiekt                 | –         | Filtr wpisów, patrz [4.3](#43-filters-filtrowanie-wpisów). |
| `Telegram`     | obiekt                 | –         | Ustawienia Telegrama dla tego kanału, patrz [Telegram](#7-telegram). |
| `Discord`      | obiekt                 | –         | Kanał Discorda jako **źródło** wpisów, patrz [rozdział 8](#8-auth-i-kanał-discorda-jako-źródło). |
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

### 4.3 `Filters`: filtrowanie wpisów

| Parametr        | Typ              | Domyślnie | Co robi |
|-----------------|------------------|-----------|---------|
| `Include`       | lista wzorców    | –         | Wpis przechodzi, gdy pasuje do **co najmniej jednego** wzorca. Pusta lista = wszystko przechodzi. |
| `Exclude`       | lista wzorców    | –         | Wpis pasujący do któregokolwiek wzorca jest pomijany. |
| `Fields`        | lista pól        | `title`, `contentSnippet`, `categories` | Gdzie szukać. Dostępne: `title`, `contentSnippet`, `content`, `categories`, `author`, `link`, `guid`. |
| `CaseSensitive` | `true` / `false` | `false`   | Czy rozróżniać wielkość liter. |
| `MaxAgeHours`   | liczba           | –         | Pomija wpisy starsze niż tyle godzin. Wpisy bez daty nie są odrzucane. |

Wzorzec to zwykły fragment tekstu albo wyrażenie regularne zapisane jako `/…/`.
W JSON-ie ukośnik wsteczny trzeba podwoić: `"/\\bv\\d+\\.\\d+/"` oznacza regex `\bv\d+\.\d+`.

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

## 5. `ChannelDefaults`: wspólne ustawienia kanałów

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

## 6. `Settings`: ustawienia ogólne

| Parametr                | Typ              | Domyślnie | Co robi |
|-------------------------|------------------|-----------|---------|
| `Logs`                  | `true` / `false` | `false`   | Wypisuje do logu (stdout / `journalctl`) także zwykłe informacje, np. każde wysłanie. Ostrzeżenia i błędy są wypisywane zawsze. |
| `DebugExpert`           | `true` / `false` | `false`   | Szczegółowe zdarzenia techniczne (`[Expert] {...}`) w logu. Do szukania błędów, bardzo dużo tekstu. |
| `MaxConcurrentChannels` | liczba 1–8       | `1`       | Ile kanałów może być sprawdzanych jednocześnie. `2` wystarcza, żeby wolny kanał (np. strona przez przeglądarkę) nie blokował reszty. |
| `FirstRunSend`          | liczba ≥ 0       | `0`       | Domyślna wartość `FirstRunSend` dla kanałów (patrz [4.2](#42-parametry-kanału)). `0` = przy nowym feedzie nic nie wysyłaj, tylko zapamiętaj obecne wpisy. |
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
| `MaxFileMB`      | `256`           | Maksymalny rozmiar pliku zdarzeń na dzień. Po przekroczeniu zdarzenia są już tylko liczone w raporcie. |

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

## 7. `Telegram`

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

## 8. `Auth` i kanał Discorda jako źródło

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

## 9. `Proxy`

| Parametr  | Domyślnie | Co robi |
|-----------|-----------|---------|
| `Enabled` | `false`   | Kieruje wszystkie zapytania HTTP XFeedera przez proxy. |
| `Url`     | –         | Adres proxy HTTP: `http://host:port` albo `https://host:port`, także z `user:hasło@`. SOCKS nie jest obsługiwany. |

```json
"Proxy": { "Enabled": true, "Url": "http://127.0.0.1:8080" }
```

Przeglądarka Scraplinga ma osobne ustawienie: `proxy` w opcjach Scraplinga.

## 10. `network`: limity i czasy

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
| `requestDeadlineMs` | brak | 1–… | Twardy limit czasu całego zapytania. |
| `shutdownGraceMs` | `5000` | 0–60000 | Ile czasu przy zamykaniu dać trwającym zadaniom. |
| `outboundPolicy` | `unrestricted` | `unrestricted`, `public-only` | `public-only` blokuje adresy prywatne i lokalne (np. `127.0.0.1`, `192.168.…`) oraz wyłącza Scrapling. |
| `maxResponseBytes` | brak | 1–268435456 | Maksymalny rozmiar odpowiedzi. |

```json
"network": { "networkFriendlyMode": true, "requestDeadlineMs": 60000 }
```

## 11. `Scrapling`: przeglądarka dla stron, które blokują boty

Niektóre strony (np. za Cloudflare) odrzucają zwykłe zapytania. Scrapling pobiera je
prawdziwą przeglądarką (Chromium). **Wymaga** Pythona i Scraplinga zainstalowanych w
`scrapling/.venv` (instrukcja w [`scrapling/README.md`](../scrapling/README.md)). Przeglądarka
jest dużo wolniejsza (10–30 s na stronę zamiast ułamka sekundy) i zużywa kilkaset MB RAM,
więc warto jej używać tylko tam, gdzie to konieczne.

### 11.1 Kiedy XFeeder używa przeglądarki

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

### 11.2 Parametry główne

| Parametr | Domyślnie | Co robi |
|----------|-----------|---------|
| `Enabled` | `true` | Włącza Scrapling (działa tylko, gdy jest zainstalowany w `scrapling/.venv`). |
| `AutoFallback` | `true` | Przeglądarka dla każdego zablokowanego feedu. |
| `ForceGlobal` | `false` | Przeglądarka dla każdego feedu. |
| `FallbackStatusCodes` | `[403, 429, 503]` | Kody HTTP oznaczające blokadę. |
| `AntiBot` | – | Rozpoznawanie stron anty-bot, patrz 11.4. |
| `DefaultOptions` | – | Opcje pobierania dla wszystkich adresów, patrz 11.3. |
| `PerUrlConfig` | – | Ustawienia dla konkretnych adresów (adres musi być **identyczny** jak w kanale). Te same opcje co w `DefaultOptions` oraz `enabled`, `fallback`, `antiBot`, `htmlParseOptions`. |

### 11.3 Opcje pobierania (`DefaultOptions` i `PerUrlConfig`)

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

### 11.4 `AntiBot`: rozpoznawanie stron blokujących

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

### 11.5 `htmlParseOptions`: strona bez feedu

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

## 12. `Solver`: FlareSolverr / Byparr

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

## 13. Zmienne środowiskowe XFeedera

Można je ustawić w systemie albo w `.env`.

| Zmienna | Co robi |
|---------|---------|
| `XFEEDER_DRY_RUN=1` | Pobiera wszystko, ale nic nie wysyła i nie zapisuje (test). |
| `XFEEDER_RUN_ONCE=1` | Jeden obieg wszystkich kanałów i koniec. |
| `XFEEDER_DEBUG_EXPERT=1` | Jak `Settings.DebugExpert`. |
| `XFEEDER_DIAGNOSTICS=1` | Włącza diagnostykę (jak `Settings.Diagnostics: true`). |
| `XFEEDER_DASHBOARD_PASSWORD` | Hasło do dashboardu. **Wymagane**, gdy dashboard słucha poza `127.0.0.1`. |
| `XFEEDER_DASHBOARD_HOST` / `_PORT` | Adres i port dashboardu (domyślnie `127.0.0.1:3000`). |
| `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` | Publiczny adres dashboardu za reverse proxy, np. `https://feeds.example.com`. |
| `XFEEDER_DASHBOARD_SESSION_TTL_HOURS` | Jak długo trwa zalogowanie (domyślnie 12 h). |

## 14. Sprawdzanie configu i częste problemy

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
| Wpisy przychodzą z dużym opóźnieniem | To głównie `TimeChecker`: wpis czeka średnio pół interwału. Raport diagnostyki pokazuje, które feedy można sprawdzać częściej. |

Diagnostyka (`Settings.Diagnostics`) i jej raport w `diagnostics/summary-*.md` są najlepszym
miejscem, żeby sprawdzić, który feed jest wolny albo zawodzi.
