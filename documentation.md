# XFeeder 1.5 — Pełna Dokumentacja

Nowoczesny, modularny czytnik RSS/Atom/JSON/API i wiadomości Discord z sekwencyjnym pipeline’em, stabilnym klientem HTTP, rozszerzeniami (Workshop) i czytelną konfiguracją. Ten dokument opisuje XFeeder 1.5: jak działa, jak go skonfigurować, jak pisać pluginy, oraz jak diagnozować problemy.

Spis treści
- 0. Co nowego w 1.5 (względem 1.3)
- 1. Co to jest XFeeder i co potrafi
- 2. Architektura i przepływ danych
- 3. Instalacja i uruchomienie
- 4. Struktura katalogów
- 5. Plik config.json (pełna specyfikacja)
- 6. Sieć i stabilność (client.js)
- 7. Pipeline i format Item
- 8. Wysyłka na Discord (Components V2)
- 9. Cache i deduplikacja
- 10. Workshop (pluginy)
- 11. Harmonogram i wydajność
- 12. Logowanie i obsługa błędów
- 13. Bezpieczeństwo i dane wrażliwe
- 14. Rozwiązywanie problemów (FAQ)
- 15. Dobre praktyki i tuningi
- 16. Załącznik: przykładowy config.json

—

0) Co nowego w 1.5
- Downloader (src/parsers/Downloader.js) na początku pipeline’u:
  - jedno spójne pobranie HTTP (proxy/UA/If-None-Match/If-Modified-Since),
  - dane (body + nagłówki) przekazywane dalej (dla pluginów i parserów).
- Guard na schematy nie-HTTP (np. quest://, cs2blog://):
  - nie wchodzą do warstwy HTTP; jeśli jest plugin (Workshop), obsłuży je jako pierwsze.
- RSSParser.parseURL → parseString:
  - najpierw pobieramy body przez getWithFallback, potem parseString na tym samym body (spójny klient HTTP).
- 304 Not Modified = “brak zmian”:
  - traktowane jako normalny brak zmian (bez wyjątków, bez fallbacków UA).
- Normalizacja linków i miękki limit cache:
  - mniej duplikatów (usuwanie utm_* i hash), mniejszy cache.json (limit per klucz).
- Mikro-opóźnienie 350 ms między wysyłkami:
  - mniejsze ryzyko 429 na webhookach Discorda.
- Utrzymany sekwencyjny pipeline i 30 s przerwy między kanałami:
  - brak równoległości w obrębie kanału, porządek: Downloader → Workshop → Moduły → Axios/regex → RSSParser → Error.

—

1) Co to jest XFeeder i co potrafi
- Czyta i publikuje:
  - RSS/Atom/XML/JSON/API (YouTube/Atom, JSONFeed, niestandardowe API),
  - wiadomości z kanałów Discord (API; wykrywa treść, załączniki, cytowania),
  - własne źródła przez pluginy (Workshop).
- Wysyła na Discord:
  - format Components V2 (kontenery, tekst, galerie, przyciski),
  - mikro-opóźnienie między wiadomościami (domyślnie 350 ms).
- Stabilność:
  - spójny HTTP: proxy, fallbacky UA, conditional requests (ETag/Last-Modified), 304 jako “OK”,
  - brak równoległości w kanałach: porządek i mniejsze ryzyko 429.
- Rozszerzalność:
  - system Workshop: pluginy z parserami (test/parse, priority), dostęp do HTTP i configu.

—

2) Architektura i przepływ danych

Główne komponenty
- main.js (core):
  - harmonogram kanałów (TimeChecker per kanał, 30 s między kanałami),
  - pipeline (sekwencyjnie): Downloader → Workshop → Moduły → Axios/regex → RSSParser → Error,
  - deduplikacja i cache (normalizacja linków, miękki limit),
  - wysyłka na webhook (Components V2) z mikro-opóźnieniem.
- src/client.js:
  - axios z proxy/UA fallback, Accept nagłówkami, If-None-Match/If-Modified-Since,
  - getWithFallback(url, opts?) zwraca 304 jako “OK” (not modified).
- src/parsers/*:
  - wbudowane parsery (YouTube, XML, Atom, JSON, RSS/regex, Fallback/HTML, Discord API),
- src/parsers/Downloader.js:
  - wstępny HTTP GET (jedno miejsce), zwraca status, body, nagłówki (bez plików tymczasowych).
- src/message.js:
  - budowanie payloadu Components V2,
  - brak fallbacku do klasycznych embedów w 1.5 (celowo usunięty).
- src/workshop/*:
  - loader (.plugin.js), pluginy rejestrujące parsery.

Przepływ (kanał RSS)
- Kolejka wybiera kanał (co TimeChecker minut); po użyciu: 30 s przerwy do kolejnego.
- Dla każdego feedu:
  - Downloader (GET, obsługa 304),
  - Workshop (pluginy) — pierwszeństwo, mogą użyć ctx.body,
  - wbudowane parsers (sekwencyjnie),
  - Axios/regex (użyje body z Downloadera jeśli możliwe),
  - RSSParser.parseString (też użyje body, jeśli jest),
  - wysyłka nowych wpisów na webhook, update cache.

Przepływ (blok Discord)
- parseDiscord pobiera wiadomości z ChannelIDs; dedup po guid,
- wysyła wiadomości (Components V2) z mikro-opóźnieniem,
- aktualizuje cache.

—

3) Instalacja i uruchomienie
- Wymagania:
  - Node.js 18+ (zalecane LTS),
  - npm/pnpm/yarn.
- Instalacja:
  - npm install
- Uruchomienie:
  - npm start lub node main.js
- Proxy (opcjonalnie):
  - config.json → Proxy.Enabled: true, Proxy.Url: "http://127.0.0.1:8080"
- Środowiska:
  - Systemd/Docker: zadbaj o prawa zapisu (cache/logi w katalogu projektu).

—

4) Struktura katalogów
- main.js — core
- src/client.js — HTTP (proxy, UA fallback, ETag/Last-Modified)
- src/message.js — wysyłka na webhook (Components V2)
- src/parsers/
  - rss.js, atom.js, xml.js, json.js, youtube.js, api_x.js, fallback.js, discord.js, utils.js
  - Downloader.js — nowy downloader (pierwszy w pipeline)
- src/workshop/
  - loader.js — ładowanie pluginów (.plugin.js)
  - workshop-cache.json — KV dla pluginów (jeśli używasz)
- cache.json — cache deduplikacji
- http-meta.json (opcjonalnie, jeśli włączone) — metadane HTTP (ETag/Last-Modified)

—

5) Plik config.json (pełna specyfikacja)

Top-level
- Settings (opcjonalne):
  - Logs: bool (domyślnie true) — logi do plików (jeśli używasz rozszerzonego loggera),
  - MaxCachePerKey: number (domyślnie 2000) — miękki limit cache per klucz,
  - DelayBetweenSendsMs: number (domyślnie 350) — mikro-opóźnienie między wysyłkami,
  - ParserTimeoutMs: number (domyślnie 15000) — maksymalny czas pracy pojedynczego parsera,
  - DelayBetweenChannelsMs: number (domyślnie 30000) — przerwa pętli między kanałami.
- Proxy (opcjonalne):
  - Enabled: bool,
  - Url: string.
- Http (opcjonalne):
  - AcceptEncoding: "gzip, deflate, br",
  - Cookies: { "<host>": "cf_clearance=...;" },
  - ExtraHeaders: { "<pattern>": { "Header": "Value" } } — dla URL zawierających pattern.
- Auth (opcjonalne):
  - Token, x-super-properties, cookie — globalne (używane w Discord parserach / pluginach).
- Workshop (opcjonalne):
  - Enabled: bool (domyślnie true),
  - Plugins: obiekt konfiguracyjny per pluginId.
- channels*, channels2*, … (dowolnie wiele grup kanałów):
  - Każdy kanał:
    - Webhook: string,
    - Thread: string lub "null",
    - RSS: [url, url, …] — feedy (RSS/Atom/JSON/API; lub własne schematy obsługiwane przez pluginy),
    - TimeChecker: number (minuty),
    - RequestSend: number (ile nowych wysyłać per runda),
    - Discord, Discord2, … (opcjonalnie, wiele bloków):
      - Webhook, Thread (nadpisy dla tego bloku),
      - ChannelIDs: [string, …] — WYMAGANE,
      - GuildID: string (opcjonalnie, dla referera/URL),
      - Limit, TimeChecker, RequestSend (lokalnie).

Notatki:
- Ładowane są wszystkie klucze zaczynające się od “channels” (case-insensitive).
- Token użytkownika (self-bot) łamie ToS Discorda — używaj na własną odpowiedzialność.

—

6) Sieć i stabilność (client.js)

Mechanizmy
- Proxy (https-proxy-agent/http-proxy-agent v7),
- Keep-Alive (po stronie Node, gdy bez proxy),
- Fallbacky User-Agent (per request; nie modyfikują globalnych nagłówków),
- Conditional requests:
  - ETag/If-None-Match i Last-Modified/If-Modified-Since,
  - 304 zwracane jako “OK” (not modified), bez wyjątku i bez cooldownu.
- Specjalne nagłówki (możesz dołożyć w Http.ExtraHeaders),
- API:
  - getWithFallback(url, opts?) — opts.headers/timeout/responseType.

Ograniczenia
- Nie wymuszaj “zstd” — Node nie rozkompresuje natywnie.

—

7) Pipeline i format Item

Kolejność (sekwencyjna)
- Downloader (jeśli HTTP/HTTPS),
- Workshop (pluginy; mogą użyć ctx.body z Downloadera),
- Moduły (wbudowane): YouTube → Atom → XML → JSON → ApiX → RSS → Fallback,
- Axios/regex (prosty RSS) — użyje body z Downloadera, jeśli dostępne,
- RSSParser.parseString — też użyje body z Downloadera,
- Error (log “brak danych”).

Item (wpis) — co zwraca parser
- title: string,
- link: string,
- contentSnippet: string (bez HTML, skrócony),
- isoDate: ISO 8601 lub null,
- enclosure: string lub null (miniatura/obraz),
- author: string lub null,
- guid: string (stabilny id; fallback: link),
- categories: string[].

Wskazówki
- link — klucz deduplikacji (core normalizuje: usuwa utm_* i hash),
- isoDate — używaj parseDate,
- contentSnippet — oczyść stripHtml i skróć do ~500–800 znaków.

—

8) Wysyłka na Discord (Components V2)
- Layout:
  - Kontener (type:17), tekst (type:10), galerie (type:12), przyciski (type:1/2),
  - YouTube: tytuł + link + miniatura + przycisk,
  - Discord messages: karta “💬” + treść + załączniki + cytowanie + metadane,
  - RSS/Atom/JSON: tytuł + snippet + media + autor/data + przycisk.
- Brak fallbacku do klasycznych embedów w 1.5 (celowe uproszczenie).
- Opóźnienie między wysyłkami: DelayBetweenSendsMs (domyślnie 350 ms).

—

9) Cache i deduplikacja
- cache.json:
  - pamięć “widzianych” ID/linków per klucz (feed lub Discord blok),
  - miękki limit MaxCachePerKey (domyślnie 2000).
- Deduplikacja:
  - feedy: po znormalizowanym linku,
  - Discord: po guid (id wiadomości).
- http-meta.json (opcjonalnie, jeśli utrzymujesz ETag/Last-Modified lokalnie).

—

10) Workshop (pluginy)
- Ładowanie:
  - src/workshop/loader.js — wczytuje pliki .plugin.js z katalogu src/workshop,
  - domyślnie włączone (Workshop.Enabled !== false),
  - pluginy jadą jako pierwsze w pipeline (HTTP/HTTPS lub schematy własne).
- API przekazywane do pluginu:
  - api.http.get (ctx.get): getWithFallback,
  - api.utils: parseDate, stripHtml (opcjonalnie),
  - api.send: wysyłka na webhook (Components V2),
  - api.config: pełny config.json (tylko do odczytu),
  - api.kv (jeśli loader takowy udostępnia) — magazyn per plugin,
  - registerParser({ name, priority, test(url, ctx), parse(url, ctx) }).
- Kontekst ctx (1.5):
  - ctx.get — HTTP,
  - ctx.api — API XFeeder,
  - ctx.body/ctx.headers/ctx.status — jeśli Downloader już pobrał body (HTTP/HTTPS).

Minimalny plugin:
```js
module.exports = {
  id: "hello",
  enabled: true,
  init(api) {
    api.registerParser({
      name: "hello-parser",
      priority: 55,
      test: (url) => url.includes("example.com/hello"),
      parse: async (url, ctx) => {
        const res = ctx.body ? { data: ctx.body } : await ctx.get(url);
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

—

11) Harmonogram i wydajność
- Kolejka kanałów:
  - XFeeder scala channels*, channels2*, channels3* w jedną listę,
  - dla każdego kanału sprawdza TimeChecker; po obsłużeniu — DelayBetweenChannelsMs (domyślnie 30 s).
- W obrębie kanału:
  - sekwencyjnie (po kolei) feedy z listy RSS,
  - brak równoległości (celowo, mniejsze ryzyko 429),
  - micro-trottle 350 ms między wysyłkami.

—

12) Logowanie i obsługa błędów
- Konsola (stdout/stderr) — informacje o sukcesach i ostrzeżenia/błędy,
- Jeśli używasz rozszerzonego loggera:
  - WarnLog.txt, ErrorLog.txt, CrashLog.txt (opcjonalne),
  - redakcja danych wrażliwych (tokeny, cookies, webhooki).
- Zamykanie:
  - SIGINT: zapisuje cache i wychodzi,
  - uncaughtException / unhandledRejection: zapis (o ile włączone), próba zapisu cache i wyjście.

—

13) Bezpieczeństwo i dane wrażliwe
- Token użytkownika Discord (self-bot) łamie ToS Discorda — używaj na własne ryzyko,
- Webhooki traktuj jak sekrety (URL = sekret),
- Cookies (np. cf_clearance):
  - trzymaj tylko w configu; unikaj logowania wartości,
  - używaj Http.Cookies["host"] w config.json.

—

14) Rozwiązywanie problemów (FAQ)

- Nic nie pojawia się na Discordzie:
  - sprawdź Webhook i Thread,
  - sprawdź logi “Parser:… Sukces (N)” — czy pipeline coś zwraca?
  - deduplikacja: link mógł być już w cache (cache.json).
- Widzisz 304 Not Modified:
  - to nie błąd — oznacza brak nowych wpisów (If-None-Match/If-Modified-Since).
- 429 Too Many Requests:
  - poczekaj (mikro-opóźnienie już działa), ewentualnie zwiększ DelayBetweenSendsMs,
  - rozważ większy TimeChecker kanału.
- 403/401 na feedzie:
  - sprawdź, czy feed nie wymaga cookie/headers,
  - użyj Http.Cookies/Http.ExtraHeaders w configu.
- Własny schemat (np. quest://):
  - nie przechodzi do HTTP — obsłuży go tylko plugin (Workshop).
- Discord parser zwraca 404:
  - podaj poprawne ChannelIDs (GuildID to nie ID kanału).

—

15) Dobre praktyki i tuningi
- TimeChecker: dopasuj do źródła (np. 10–60 min),
- DelayBetweenSendsMs: 300–500 ms (mniej 429),
- MaxCachePerKey: 1000–5000 (w zależności od liczby feedów),
- Normalizacja linków: unikaj linków ze zmiennym query,
- Workshop:
  - agresywny test(url) (oszczędza czas),
  - nie zwracaj tysięcy elementów naraz,
  - używaj ctx.body jeśli Downloader już pobrał treść (mniej zapytań).

—

16) Załącznik: przykładowy config.json

```json
{
  "Settings": {
    "Logs": true,
    "MaxCachePerKey": 2000,
    "DelayBetweenSendsMs": 350,
    "ParserTimeoutMs": 15000,
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
        "quest://@me"
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

Skrót najważniejszych różnic 1.5 vs 1.3
- Downloader na początku pipeline’u (jedno spójne pobranie HTTP, body przekazywane dalej),
- Schematy nie-HTTP obsługiwane tylko przez Workshop,
- RSSParser.parseString na pobranym body (jeden klient HTTP, spójne nagłówki i proxy),
- 304 = “brak zmian”, bez wyjątków i cooldownów,
- Normalizacja linków + miękki limit cache,
- Mikro-opóźnienie 350 ms między wysyłkami (mniej 429),
- Utrzymany sekwencyjny pipeline i 30 s przerwy między kanałami.