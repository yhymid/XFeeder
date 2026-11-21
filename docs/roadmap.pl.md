# Plan rozwoju: pomysły z podobnych projektów (2026-11)

[English](roadmap.md) · **Polski**

Przejrzano czterdzieści trzy podobne projekty (w dwóch rundach) pod kątem funkcji wartych
przeniesienia do XFeedera. Ta strona zapisuje, co zostało wzięte, co jest kandydatem, a co
odrzucone, żeby nie trzeba było powtarzać przeglądu.

## Zrobione w 3.0.0-alpha.1

| Funkcja | Skąd pomysł | Uwagi |
|---|---|---|
| `Solver` (API `/v1` FlareSolverr) | FlareSolverr, Byparr, TRAWL, byparr-proxy, fu_cloudflare | Włączany per feed albo `Auto`. |
| Wykrywanie feedu na stronach WWW | Easy-to-RSS, morss | Historia zapisywana pod znalezionym adresem. |
| Zdjęcie z podpisem na Telegramie, w razie błędu sam tekst | RSS-to-Telegram-Bot, rss-to-telegram-worker | `SendPhoto: false` wyłącza. |
| Stan wyjściowy przy pierwszym sprawdzeniu (`FirstRunSend`) | rss-to-telegram-worker („pierwsze pobranie ustala stan wyjściowy”), FeedCord (tylko posty nowsze niż start), rss-discord-bot (`lastPubDate`) | Bez tego nowy feed, nowy cel albo edytowany kanał (nowy klucz cache) wysyłał cały feed od nowa. |
| `Filters` kanału (include/exclude, regex, pola, wielkość liter, maksymalny wiek) | FeedCord `PostFilters` (podciąg + `label:`), RSSHub `filter`/`filterout`/`filter_case_sensitive`/`filter_time` | Dopasowanie kategorii pokrywa `label:` z FeedCorda. |
| Wykrywanie kodowania (nagłówek, `<?xml encoding>`, `<meta charset>`) | feedparser `encodings.py` | Naprawiło zepsuty tekst ISO-8859-2/windows-1250. |
| Zgodność ze Scraplingiem 0.5, przekazywanie `solve_cloudflare` | Scrapling `docs/migrating-to-v0.5.md` | 0.5 usunął `DynamicSession`; CDP przeszło do `RemoteSession`. |

## Kandydaci

| Funkcja | Źródło | Dlaczego / koszt |
|---|---|---|
| Dzielenie długich postów na Telegramie; grupy mediów przy kilku obrazkach; strony Telegraph | RSS-to-Telegram-Bot, flowerss-bot | Zdjęcie z podpisem jest zrobione; długie posty są wciąż przycinane. Średni. |
| Szablony wiadomości na kanał (Discord i Telegram) | TheLovinator1/discord-rss-bot | Własny układ na feed. Średni (Components V2). |
| Rozszerzenia stron: Steam, szczegóły YouTube, API WordPressa | TheLovinator1/discord-rss-bot | Bogatsze posty dla popularnych źródeł. Średni na źródło. |
| Bluesky jako źródło | DiscordNewsBot, Tausendsassa | Publiczne API AT Protocol, bez logowania dla publicznych postów. Średni. |
| Godziny ciszy i tryb podsumowania | MultiNotify | Zbieranie wpisów w nocy i jeden post z podsumowaniem. Średni. |
| Webhooki Slack/Mattermost/ogólne | MultiNotify | Mattermost przyjmuje payloady w stylu Slacka. Mały–średni. |
| Pełna treść (pobranie artykułu) | morss, rss-proxy | Lepsze fragmenty i obrazki dla feedów z samymi tytułami. Średni; jedno zapytanie na wpis. |
| Klient HTTP podszywający się pod TLS przeglądarki | curl-impersonate-rs, warpsock, cuimp | Tylko jeśli `Solver`/Scrapling nie wystarczą; dodaje natywne zależności. |
| Proxy obrazków dla stron blokujących hotlinki | rsstt-img-relay | Potrzebne tylko, gdy Telegram/Discord nie wczytują obrazków z niektórych stron. Opcjonalny prefiks `ImageProxy`. Mały. |
| Import/eksport OPML w dashboardzie | rss-to-telegram-worker, FreshRSS | Hurtowe dodawanie feedów (np. z plenaryapp/awesome-rss-feeds). Średni (interfejs dashboardu). |
| Szukanie `og:image` dla wpisów bez obrazka | FeedCord `ImageParserService` | Jedno dodatkowe zapytanie na wpis; włączane na kanał. Mały. |
| Wyłączanie feedu po N kolejnych błędach i pokazanie go w dashboardzie | rss-to-telegram-worker (10 błędów), FeedCord `EnableAutoRemove` | XFeeder ma już bezpiecznik; brakuje widocznej listy „feedy z błędami”. Mały. |
| Skrót `rsshub://ścieżka` z konfigurowalną instancją | RSSHub, RSSWorker | Wygoda dla stron bez feedów. Mały. |
| Reddit jako źródło (OAuth, `.json`) | discord-feed-bot | RSS Reddita ma limity dla anonimowych klientów. Średni. |
| Osie czasu Mastodona/Misskey | cf-fedi-timeline-rss-worker | Publiczne konta Mastodona mają już `/@user.rss`; API potrzebne tylko dla osi domowych. Niski priorytet. |
| Pomijanie parsowania, gdy hash treści się nie zmienił | ifnmg-news-bot (`content_hash`) | Oszczędza CPU dla feedów bez ETag/Last-Modified. Mały, najpierw zmierzyć. |

### Druga runda (26 kolejnych projektów)

Wzięte z niej: `Solver` zgodny z FlareSolverr (FlareSolverr, Byparr, TRAWL; użycie
zwróconej strony zamiast odtwarzania ciasteczek za byparr-proxy, włączanie per feed za
pluginem fu_cloudflare do TT-RSS), wykrywanie feedów (Easy-to-RSS, morss) i zdjęcia na
Telegramie (RSS-to-Telegram-Bot).

Nieprzydatne dla XFeedera: legitbot (weryfikacja botów po stronie serwera),
quality-playbook (metoda przeglądu z AI, nie funkcja), Major-project-list (lista ćwiczeń),
vinted-bot (scraper serwisu ogłoszeń; jego cichy pierwszy obieg odpowiada `FirstRunSend`),
workery proxy na Cloudflare (framer-proxy-worker, cloudflare-rss-feed-proxy,
rss-proxy-aggregator: strona hostingu), bimp (zamknięte środowisko),
simoniz0r/discord-rss-bot (skrypt powłoki).

## Nieplanowane

| Projekt | Powód |
|---|---|
| RSS-Bridge, RSSHub (własny hosting), RSSWorker | *Generatory* feedów; uruchom je obok XFeedera i dodaj ich adresy jako feedy. |
| FreshRSS | Pełny czytnik. WebSub wymaga publicznego adresu zwrotnego, którego worker za NAT nie ma. |
| jpmonette/feed | Biblioteka Go do *tworzenia* feedów. |
| Jackett | Proxy indekserów torrentów (Torznab), niezwiązane. |
| plenaryapp/awesome-rss-feeds | Lista feedów, przydatna tylko razem z importem OPML. |
| Wersje na Cloudflare Workers (cf-fedi-timeline, rss-cloudflare, rss-discord-bot, ifnmg-news-bot) | Inne środowisko (D1/KV/Queues/cron); ich limity na czat pokrywa 500 ms odstępu między wysyłkami i obsługa 429. |
| Komendy slash Discorda do zarządzania feedami (ifnmg-news-bot, rss-discord-bot) | XFeeder wysyła przez webhooki i jest zarządzany przez `config.json`/dashboard; aplikacja bota byłaby nowym komponentem. |
