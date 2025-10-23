# XFeeder 1.3 — Pełna Dokumentacja

Nowoczesny, modularny czytnik RSS/Atom/JSON, Discord (kanały i webhooki) z mechanizmami stabilizacji sieci, parsowania, logowania i rozszerzeń (Workshop). Ten dokument opisuje projekt od A do Z: jak działa, jak go skonfigurować, jak pisać pluginy, jak diagnozować problemy, i jak wycisnąć maksimum stabilności.

Spis treści
- 1. Co to jest XFeeder i co potrafi
- 2. Architektura i przepływ danych
- 3. Instalacja i uruchomienie
- 4. Struktura katalogów
- 5. Plik config.json (pełna specyfikacja)
- 6. Sieć i stabilność (client.js)
- 7. Pipeline parserów i format Item
- 8. Wysyłka do Discorda (Components V2 + fallback embeds)
- 9. Cache i deduplikacja
- 10. Workshop (pluginy) — skrót z przykładami
- 11. Harmonogram i wydajność
- 12. Logowanie i obsługa błędów
- 13. Bezpieczeństwo, ToS i dane wrażliwe
- 14. Rozwiązywanie problemów (FAQ)
- 15. Dobre praktyki i tuningi
- 16. Załączniki: przykładowy config.json

—

1) Co to jest XFeeder i co potrafi
- XFeeder to czytnik źródeł:
  - RSS/Atom/XML/JSON/API (w tym YouTube, GitHub/Atom, JSONFeed)
  - wiadomości z kanałów Discord (API)
  - własne źródła z pluginów (Workshop)
- Wysyła treści na Discorda przez webhooki:
  - nowy format Components V2 (kontenery, galerie, przyciski)
  - automatyczny fallback do klasycznych embedów, gdy Components V2 zostanie odrzucony
- Stabilność:
  - per-host cooldown (circuit breaker), ETag/Last-Modified (If-None-Match/If-Modified-Since)
  - fallback User-Agent, keep-alive, proxy, nagłówki per domena
- Modowalność:
  - system pluginów “Workshop”: własne parsery z priorytetami, KV storage per plugin
- Kontrola:
  - per-kanał: co ile minut sprawdzać, ile wpisów wysłać
  - globalnie: limity cache, równoległość pobrań, opóźnienia między wysyłkami

—

2) Architektura i przepływ danych

Główne komponenty
- main.js — orkiestracja:
  - pętla kanałów (kolejka): sprawdza channels[*] co X minut
  - dla każdego kanału: pobiera feedy (równolegle do limitu), deduplikuje, wysyła na webhook, aktualizuje cache
  - osobna ścieżka dla “bloków Discord”
  - ładuje pluginy (Workshop) i parsuje przez pipeline (pluginy → wbudowane → fallbacki)
- src/client.js — warstwa sieciowa (HTTP):
  - axios + keep-alive/proxy
  - fallback UA, per-host cooldown, conditional requests (ETag/Last-Modified)
  - nagłówki per domena (np. boop.pl, lowcygier.pl), cookie cf_clearance z configu
- src/parsers/* — wbudowane parsery:
  - YouTube (Atom), XML, Atom, JSON, RSS (regex), Fallback (HTML scraping)
  - Discord (API: pobieranie wiadomości z kanałów)
- src/message.js — wysyłka do Discorda:
  - budowa payloadu Components V2
  - fallback do “embeds” przy błędzie 4xx/5xx
- src/workshop/* — system pluginów:
  - loader ładuje .plugin.js
  - pluginy rejestrują parsery (priority/test/parse)
- cache.json — pamięć deduplikacyjna (per feed/Discord blok)
- http-meta.json — meta HTTP (ETag/Last-Modified per URL)
- WarnLog.txt / ErrorLog.txt / CrashLog.txt — logi systemowe (opcjonalne)

Przepływ (kanał z RSS)
- Kolejka wybiera kanał → sprawdza czy minął TimeChecker
- W tle pobiera feedy równolegle (do limitu)
- Dla każdego feedu pipeline:
  - pluginy (według priority) → wbudowane parsery → fallback regex → rss-parser.parseString
- Dedup: porównanie linków (po normalizacji); nowości idą na webhook
- Wysyłka: opóźnienia między wiadomościami (by unikać 429)
- Aktualizacja cache
- Logi i błędy zapisane (z redakcją danych wrażliwych)

Przepływ (blok Discord)
- parseDiscord pobiera wiadomości z podanych ChannelIDs przez API Discorda
- deduplikuje po guid (id wiadomości)
- wysyła na webhook w formie “Discord message card” (Components V2)
- analogicznie aktualizuje cache

—

3) Instalacja i uruchomienie
- Wymagania:
  - Node.js 18+ (zalecane LTS)
  - npm lub pnpm/yarn
- Instalacja:
  - npm install
- Uruchomienie:
  - npm start
  - lub node main.js
- Proxy (opcjonalnie):
  - ustaw w config.json → Proxy.Enabled: true, Proxy.Url: "http://127.0.0.1:8080"
- Systemd/Docker:
  - możesz uruchomić jako usługę, pamiętaj o prawach zapisu (cache/logi w katalogu projektu)

—

4) Struktura katalogów
- main.js — core
- src/client.js — HTTP klient (proxy, cooldown, ETag, fallback UA)
- src/message.js — wysyłka do Discorda (Components V2 + fallback)
- src/parsers/ — wbudowane parsery:
  - rss.js, atom.js, xml.js, json.js, youtube.js, api_x.js, fallback.js, discord.js, utils.js
- src/workshop/ — pluginy (pliki .plugin.js) + loader.js + workshop-cache.json (KV)
- cache.json — pamięć deduplikacji
- http-meta.json — meta ETag/Last-Modified
- WarnLog.txt, ErrorLog.txt, CrashLog.txt — logi (opcjonalnie)

—

5) Plik config.json (pełna specyfikacja)

Top-level klucze
- Settings (opcjonalne)
  - Logs: bool (domyślnie true) — logi do plików
  - MaxCachePerKey: number (domyślnie 2000) — ile wpisów trzymać w cache per klucz
  - DelayBetweenSendsMs: number (domyślnie 350) — opóźnienie między wysyłkami do Discorda (ms)
  - ParserTimeoutMs: number (domyślnie 15000) — maks. czas pracy pojedynczego parsera
  - FetchConcurrency: number (domyślnie 3) — równoległość pobrań feedów w kanale
  - DelayBetweenChannelsMs: number (domyślnie 30000) — przerwa pętli między kanałami
- Proxy (opcjonalne)
  - Enabled: bool
  - Url: string (np. http://127.0.0.1:8080)
- Http (opcjonalne)
  - AcceptEncoding: string — "gzip, deflate, br" (nie dodawaj “zstd”, Node/axios nie rozkompresują natywnie)
  - Cookies: { "<host>": "cookie-string" } — np. "boop.pl": "cf_clearance=...;"
  - ExtraHeaders: { "<pattern>": { "Header-Name": "Value", ... }, ... } — dodatkowe nagłówki dopasowywane po fragmencie URL
- Auth (opcjonalne)
  - Token, x-super-properties, cookie — globalne dane dla Discord API (używane w blokach Discord/wybranych pluginach)
- Workshop (opcjonalne)
  - Enabled: bool (domyślnie true)
  - Plugins: obiekt konfiguracyjny per pluginId (dowolna struktura wtyczki)
- channels, channels2, channels3, … (wiele tablic kanałów)
  - Każdy element (kanał) może mieć:
    - Webhook: string (URL webhooka Discord)
    - Thread: string lub "null" (opcjonalnie — wątek)
    - RSS: [url, url, ...] — listy feedów (RSS/Atom/JSON/API; mogą być też schematy własne pluginów)
    - TimeChecker: number — co ile minut sprawdzać ten kanał
    - RequestSend: number — ile nowych wpisów wysłać w jednej rundzie
    - Discord / Discord2 / Discord3 … — osobne “bloki Discord” (w tych samych obiektach kanału):
      - Webhook: string (może nadpisać kanałowy)
      - Thread: string lub "null"
      - Token/x-super-properties/cookie: jeśli chcesz nadpisać globalny Auth per blok
      - ChannelIDs: [string, …] — wymagane! id kanałów Discord do pobrania wiadomości
      - GuildID: string — opcjonalny; używany do referera/linków
      - Limit: number — ile wiadomości pobrać z kanału
      - TimeChecker/RequestSend — lokalne nadpisania

Uwagi:
- Ładowane są wszystkie klucze zaczynające się na "channels" (case-insensitive).
- “Discord blocks” w jednym kanale: możesz mieć wiele (“Discord”, “Discord2”, …), każdy z własnym webhookiem/Thread.
- Token użytkownika (self-bot) do Discorda łamie ToS — używaj wyłącznie na własną odpowiedzialność.

Przykładowy minimalny config — patrz rozdział 16 (Załącznik).

—

6) Sieć i stabilność (client.js)

Funkcje i mechanizmy
- Proxy v7:
  - https-proxy-agent / http-proxy-agent (klasy v7)
  - konfiguracja w Proxy.Enabled i Proxy.Url
- Keep-Alive (bez proxy):
  - http/https.Agent z keepAlive i maxSockets (wydajniejsze reuse połączeń)
- Fallback User-Agent:
  - próby z różnymi UA (np. Firefox/Chrome/FeedFetcher) przy błędach
- Per-Host Cooldown:
  - po “twardych” błędach (401/403/429) — cooldown hosta, eskalowany wykładniczo
  - po błędach sieci (ECONNRESET, ETIMEDOUT…) — krótki cooldown
  - log “Cooldown hosta X na Ys”
- Conditional Requests:
  - ETag/If-None-Match i Last-Modified/If-Modified-Since
  - meta trzymana w http-meta.json (klucz = URL)
  - 304 Not Modified nie jest błędem — oznacza “brak zmian”
- Specjalne nagłówki per domena:
  - boop.pl, lowcygier.pl — symulacja przeglądarki (Sec-*, Alt-Used, Priority, Referer)
  - cookie cf_clearance pobierane z config.Http.Cookies["boop.pl"]
- Dodatkowe nagłówki z configu:
  - Http.ExtraHeaders: mapowanie pattern→headers (jeśli url.includes(pattern) to dołóż nagłówki)
- API:
  - getWithFallback(url, axiosOpts?) — drugi parametr pozwala dołożyć headers/timeout/responseType itp.

Ograniczenia
- Accept-Encoding: nie dodawaj “zstd” (Node nie rozkompresuje natywnie).
- Nie trzymaj tajnych ciasteczek w logach (logger wycina większość, ale i tak uważaj).

—

7) Pipeline parserów i format Item

Kolejność (priority: mniejszy = wcześniej)
- pluginy (z Workshop)
- wbudowane:
  - YouTube (10)
  - Atom (20)
  - XML (30)
  - JSON (40)
  - ApiX (50)
  - RSS (60)
  - Fallback (90)
- jeśli wszystkie zwrócą puste:
  - fallback regex (szukaj <item>…</item>)
  - rss-parser.parseString (ostatnia próba na tym samym body)

Specyfikacja Item (co zwraca parser)
- title: string
- link: string
- contentSnippet: string (bez HTML, skrócony)
- isoDate: ISO 8601 lub null
- enclosure: string lub null (miniatura/obraz)
- author: string lub null
- guid: string (stabilny id; fallback: link)
- categories: string[]

Wskazówki
- link jest kluczowy dla deduplikacji feedów — jeśli masz zmienne query (utm_*), postaraj się zredukować do stabilnej postaci (core i tak normalizuje linki).
- isoDate normalizuj przez parseDate (obsługuje ISO/RFC/Unix).
- contentSnippet: z użyciem stripHtml, rozsądnie skrócony (500–800 znaków).

—

8) Wysyłka do Discorda (Components V2 + fallback embeds)

Domyślny format (Components V2)
- Kontener (type: 17), tekst (type: 10), galerie (type: 12), rząd z accessory (type: 9), przyciski (type: 1/2).
- YouTube: specjalny układ (tytuł, link, miniatura, przycisk).
- Discord messages: karty “💬”, treść, załączniki, cytowany post (referenced).
- RSS/Atom/JSON: tytuł, snippet, media, autor/data, przycisk “Otwórz”.

Fallback do “embeds”
- Gdy Components V2 zwróci 4xx/5xx (np. nagła zmiana API), XFeeder ponowi wysyłkę w formie klasycznego JSON “embeds”.

Opóźnienia
- DelayBetweenSendsMs (domyślnie 350ms) — by unikać 429.

—

9) Cache i deduplikacja

- cache.json
  - pamięć “widzianych” ID/linków per feed/Discord blok
  - maksymalna długość listy per klucz: MaxCachePerKey (domyślnie 2000)
- Deduplikacja:
  - feedy: po znormalizowanym linku (hash i utm_* usuwane)
  - Discord: po guid (id wiadomości)
- http-meta.json
  - meta HTTP (ETag/Last-Modified) per URL dla If-None-Match/If-Modified-Since

—

10) Workshop (pluginy) — skrót z przykładami

Włączenie
- config.Workshop.Enabled = true (domyślnie on)
- Katalog pluginów: src/workshop (tylko pliki .plugin.js)

Minimalny plugin
```js
// src/workshop/hello.plugin.js
module.exports = {
  id: "hello",
  enabled: true,
  init(api) {
    api.registerParser({
      name: "hello-parser",
      priority: 55,
      test: (url) => url.includes("example.com/hello"),
      parse: async (url, ctx) => {
        const res = await ctx.get(url);
        const data = res.data || {};
        return [{
          title: data.title || "Brak tytułu",
          link: data.url || url,
          contentSnippet: api.utils.stripHtml(data.description || "").result.slice(0, 500),
          isoDate: api.utils.parseDate(data.date || new Date().toISOString()),
          enclosure: data.image || null,
          author: data.author || null,
          guid: data.id || data.url || url,
          categories: data.tags || []
        }];
      }
    });
  }
};
```

Konfiguracja pluginu
- Własne ustawienia w: config.Workshop.Plugins.<pluginId>
- Odczyt: const cfg = api.config?.Workshop?.Plugins?.["hello"] || {}

Więcej (szczegółowe how-to) — patrz osobny dokument “XFeeder Workshop — Jak pisać pluginy”.

—

11) Harmonogram i wydajność

Kolejka kanałów
- XFeeder zbiera channels, channels2, channels3, … w jedną listę.
- Dla każdego kanału sprawdza: minęło TimeChecker minut od ostatniej rundy?
- Po obsłużeniu jednego kanału czeka DelayBetweenChannelsMs i przechodzi do kolejnego.

Równoległość i timeouty
- W obrębie jednego kanału feedy są pobierane równolegle: FetchConcurrency (domyślnie 3).
- Każdy parser ma limit czasu ParserTimeoutMs (domyślnie 15s) — nie wiesza całej pętli.
- Między wysyłkami do Discorda: DelayBetweenSendsMs (domyślnie 350ms).

—

12) Logowanie i obsługa błędów

Pliki logów
- WarnLog.txt — ostrzeżenia
- ErrorLog.txt — błędy
- CrashLog.txt — nieobsłużone wyjątki i odrzucenia (uncaughtException, unhandledRejection)

Redakcja danych wrażliwych
- automatyczne maskowanie webhooków, tokenów, cookies, itp. w logach
- nadal unikaj ręcznego logowania tych danych

Zamykanie
- SIGINT (Ctrl+C): zapisuje cache i wychodzi
- nieobsłużone błędy: zapis do CrashLog, próba zapisania cache i wyjście

—

13) Bezpieczeństwo, ToS i dane wrażliwe

- Token użytkownika Discord (self-bot) — łamie ToS Discorda:
  - dotyczy parsera Discord i niektórych pluginów (np. quest-tracking)
  - używasz na własną odpowiedzialność (możliwe blokady kont)
- Webhooki:
  - są redagowane w logach, ale dalej traktuj URL jako sekret
- Cookies (np. cf_clearance):
  - przechowuj wyłącznie w configu, jeśli musisz; nie loguj

—

14) Rozwiązywanie problemów (FAQ)

- Nie mam żadnych wiadomości na Discordzie
  - Upewnij się, że kanał ma Webhook, a RSS zawiera poprawne linki
  - Zobacz logi: “[Parser:XYZ] Sukces (N) → url” — czy pipeline coś zwraca?
  - Sprawdź deduplikację: link mógł być już w cache (cache.json)
- Ciągle 304 Not Modified
  - To nie błąd — oznacza brak zmian (If-None-Match/If-Modified-Since zadziałało)
- 429 Too Many Requests
  - XFeeder ustawia cooldown hosta i nie będzie pytał przez jakiś czas
  - Zmniejsz FetchConcurrency i/lub wydłuż DelayBetweenChannelsMs
  - Zwiększ DelayBetweenSendsMs
- 403/401 na feedzie
  - Sprawdź nagłówki: czy wymagany jest cookie (np. cf_clearance)?
  - Dodaj Http.Cookies["host"] i ewentualnie dodatkowe nagłówki w Http.ExtraHeaders
- Discord parser zwraca 404
  - Upewnij się, że podałeś ChannelIDs (GuildID NIE jest id kanału)
- Components V2: 400/415/501
  - XFeeder automatycznie przełączy się na klasyczny embed fallback

—

15) Dobre praktyki i tuningi

- Mniejsze logi:
  - Settings.Logs: false (wyłączy pliki logów)
  - redukuj liczby kanałów/feeedów jeśli to sandbox
- Stabilne linki:
  - unikaj losowych query; core usuwa utm_*, ale inne nadal mogą robić duble
- Pamięć:
  - MaxCachePerKey utrzymuj na rozsądnym poziomie (1000–5000)
- Wydajność:
  - FetchConcurrency: 2–5 zwykle wystarcza
  - ParserTimeoutMs: 10–20s
  - DelayBetweenChannelsMs: 20–60s (zależnie od liczby kanałów)
- Proxy:
  - przy “trudnych” feedach włącz proxy (przeglądarka/proxy)
- Pluginy:
  - test(url) filtruj agresywnie
  - nie zwracaj tysięcy pozycji na rundę

—

16) Załączniki: przykładowy config.json

Przykład 1 — RSS + Discord blocks + Workshop
```json
{
  "Settings": {
    "Logs": true,
    "MaxCachePerKey": 2000,
    "DelayBetweenSendsMs": 350,
    "ParserTimeoutMs": 15000,
    "FetchConcurrency": 3,
    "DelayBetweenChannelsMs": 30000
  },

  "Proxy": {
    "Enabled": false,
    "Url": "http://127.0.0.1:8080"
  },

  "Http": {
    "AcceptEncoding": "gzip, deflate, br",
    "Cookies": {
      "boop.pl": "cf_clearance=PASTE_YOUR_CF_VALUE"
    },
    "ExtraHeaders": {
      "https://boop.pl/rss": {
        "If-Modified-Since": "Wed, 22 Oct 2025 17:00:09 +0000"
      }
    }
  },

  "Auth": {
    "Token": "DISCORD_USER_TOKEN",
    "x-super-properties": "BASE64_SUPER_PROPS",
    "cookie": "cookie-string"
  },

  "Workshop": {
    "Enabled": true,
    "Plugins": {
      "quest-tracking": {
        "MentionRole": "ROLE_ID_OPTIONAL"
      },
      "cs2-blog-watcher": {
        "start_index": 41413,
        "sleep_time": 5,
        "webhook_url": "https://discord.com/api/webhooks/XXX/YYY",
        "thread_id": "111111111111111111"
      }
    }
  },

  "channels": [
    {
      "Webhook": "https://discord.com/api/webhooks/AAA/BBB",
      "Thread": "222222222222222222",
      "RSS": [
        "https://boop.pl/rss",
        "https://wiadomosci.onet.pl/.feed",
        "quest://@me"  // feed pluginu quest-tracking
      ],
      "TimeChecker": 30,
      "RequestSend": 3,

      "Discord": {
        "GuildID": "GUILD_ID",
        "Webhook": "https://discord.com/api/webhooks/CCC/DDD",
        "Thread": "333333333333333333",
        "ChannelIDs": ["DISCORD_CHANNEL_ID_1", "DISCORD_CHANNEL_ID_2"],
        "Limit": 5,
        "RequestSend": 1
      }
    }
  ],

  "channels2": [
    {
      "Webhook": "https://discord.com/api/webhooks/EEE/FFF",
      "RSS": [
        "https://lowcygier.pl/rss",
        "https://git.example.com/user/project.atom"
      ],
      "TimeChecker": 60,
      "RequestSend": 2
    }
  ]
}
```

—

Załącznik: skrót najważniejszych różnic i zachowań
- Kolejka: obsługa wielu grup channels*; każda grupa to tablica kanałów
- Dedup: feedy po linku (po normalizacji), Discord po guid
- HTTP: explicit retry UA, cooldowny, ETag/Last-Modified, nagłówki per domeny “trudne”
- Discord API:
  - wymagane ChannelIDs (nie GuildID)
  - Token użytkownika — ToS risk
- Workshop:
  - katalog “src/workshop”, pliki “*.plugin.js”, Enabled: true
  - plugin rejestruje parsery; te jadą przed wbudowanymi (po priority)
- Wysyłka:
  - Components V2 → fallback embeds
  - opóźnienia między wysyłkami (anty-429)