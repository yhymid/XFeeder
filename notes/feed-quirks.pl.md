# Dziwactwa feedów z prawdziwych źródeł

[← Spis](../README.pl.md) · [English](feed-quirks.md)

To dziwne rzeczy znalezione przy sprawdzaniu prawdziwych feedów 2026-11-23. Każda z nich może zepsuć czytnik feedów, więc są zebrane w jednym miejscu. Poprawki w kodzie należą do gałęzi samego XFeedera; ten plik tylko opisuje, jak zachowują się źródła.

## Formaty

| Dziwactwo | Gdzie | Co robić |
|---|---|---|
| Atom wysyłany jako `Content-Type: text/html` | RSS Unreal Engine | rozpoznawać format po treści, nie po nagłówku |
| RSS 1.0 / RDF (root `<rdf:RDF>`, wpisy poza `<channel>`) | Slashdot, Debian News | szukać `item` pod `rdf:RDF` |
| Daty w `dc:date` zamiast `pubDate` | feedy RDF | czytać `dc:date` |
| Niestandardowa strefa czasowa `Z` w dacie RFC 822 | RSS s&box | przyjmować `Z` jako UTC |
| Data bez strefy czasowej | HoYoverse (`2026-11-04 07:00:00`), forum PoE | zakładać strefę wydawcy (HoYo: UTC+8) |
| Daty w formacie JS `Date.toString()` | Ubisoft (`Tue Nov 03 2026 10:30:00 GMT+0000 (…)`) | własne parsowanie |
| Kodowanie ISO-8859-1 | RSS Jagex | respektować deklarację kodowania w XML |
| Przestrzeń nazw `dc` bez końcowego ukośnika | RSS Jagex | dopasowywać przestrzeń nazw luźno |
| Tytuły opakowane w HTML (`&lt;p&gt;Title&lt;/p&gt;`) | Unreal Engine | usuwać tagi z tytułów |
| Tytuły ze spacjami / nowymi liniami na brzegach | RSS ESO, RSS Steama (`" Minor Update"`) | przycinać |
| Dwa `<link>`, obrazek pierwszy | Atom FFXIV Lodestone | używać `rel="alternate"` |
| Linki względne | Bungie (`/7/en/News/...`), Riot, obrazki Mojang | rozwijać względem strony |
| Adresy obrazków bez protokołu (`//host/...`) | Blizzard, Microsoft | dodać `https:` |
| Pole JSON, które samo jest napisem z JSON-em | Steam `jsondata`, HoYoverse `sExt` | parsować dwa razy; `jsondata` Steama to czasem `[]`, a nie obiekt (59 z 1978 postów) |
| Tagi BBCode z atrybutami | treści Steama: `[p align="start"]` (7072× w 1978 postach), `[url="…" style="…"]`, `[url= https://…]` (spacja po `=`), `[img src="…" style="…"]`, `[td colwidth="…"]`, `[color=#…]`, `[dynamiclink href="…"][/dynamiclink]` | dopasowywać tagi z opcjonalnymi atrybutami |
| Każda treść zaczyna się od `<?xml encoding="utf-8"?>` | RSS blender.org (`content:encoded`) | usuwać instrukcje przetwarzania przed HTML → tekst |
| Ścieżki grafik aplikacji z hashem | `header.jpg` Steama dla nowszych aplikacji | sprawdzić obrazek; potem `library_hero.jpg`, potem brak |
| Listy nieposortowane po dacie (przypięte wpisy pierwsze) | HoYoverse, Kuro, Jagex | sortować po dacie po parsowaniu |
| Jedna strona = wiele wpisów, bez linku do wpisu | release notes ChatGPT / aplikacji Claude | jako id używać nagłówka z datą |
| „Żywe” artykuły edytowane zamiast nowych postów | patch notes Diablo IV, patchnotes Call of Duty | śledzić czas edycji / hash treści |
| Logowanie kontem w SteamCMD (steampics:// z Login) | SteamCMD na VPS-ie | sprawdzone 2026-11-27: Deadlock (1422450) pokazuje depoty i build public tylko z kontem, które go ma (21 depotów, build 26966428); anonimowo jest tylko `common`. Z mobilnym Steam Guardem SteamCMD wypisuje „Please confirm the login in the Steam Mobile app” i czeka tylko ~68 s, potem `ERROR (Timeout)`; trzy logowania hasłem bez człowieka skończyły się timeoutem. Jedno interaktywne `steamcmd +login NAME +quit` w prawdziwym terminalu (zatwierdzone w aplikacji) zapisało sesję (`ConnectCache` w `~/.local/share/Steam/config/config.vdf`); potem `+@NoPromptForPassword 1 +login NAME` działa bez pytań. |
| Guild Wars 2: żadne źródło nie ma wszystkich aktualizacji | RSS forum (Invision, Cloudflare), Steam 1284210, guildwars2.com/en/feed/, api.guildwars2.com/v2/build | sprawdzone 2026-11-26: RSS forum z release notes ma jeden temat na zaplanowane wydanie i żadnego hotfixa (11-11, 11-12, 11-16, 11-17, 11-24 są tylko na wiki); ostatnie 12 wydarzeń Steama 1284210 to newsy z bloga (event_type 28), bez patch notes; guildwars2.com/en/feed/ to zapowiedzi newsów z WordPressa; /v2/build daje tylko numer buildu (limit 300 naraz, 5/s). Feed Atom Special:Ask z wiki (games/publishers.pl.md) obejmuje wydania i hotfixy. |
| Nowe linie to treść w postach Steama | JSON wydarzeń Steama `announcement_body.body` (BBCode) | Steam pokazuje `\n` jako nową linię; wiele patch notes to jeden punkt na linię bez `[list]` (Hades II `· …`, Marvel Rivals `- …`). Potraktowane jak HTML zlewają się w jedną linię. XFeeder zachowuje je od Bety e66c15e. |
| Wpisy JSON bez własnego linku | Mojang `javaPatchNotes.json` (424 wpisy) i `bedrockPatchNotes.json` (82) | tożsamość musi pochodzić z `id` wpisu, nie z adresu feedu; obrazek to obiekt (`{title, url}`, ścieżka względna wobec hosta); daty Bedrocka to same dni, a `shortText` zaczyna się od tytułu sklejonego z pierwszym zdaniem; adresów artykułów minecraft.net nie da się wyprowadzić z tytułu (6 z 9 prób to 404, 2026-11-26). XFeeder czyta oba od Bety 07c99af. |
| Kilka wpisów ma ten sam `<link>` | kernel.org `kdist.xml` | do tożsamości użyć `guid` |
| Załącznik to dźwięk, nie obrazek | feedy podcastów (NPR) | sprawdzić `enclosure@type`, zanim użyje się go jako obrazka |
| Kategoria jako obiekt (atrybut `domain` / `term`) | GitHub Changelog, feedy Atom | filtrować po tekście kategorii |
| Szum w feedzie wydań | `releases.atom` OpenClaw (`release-publish/...`) | filtr Include na tytule |
| Wszystkie linki chwilowo wskazują na host podglądu CI | RSS newsów Mesy 2026-11-25: przez jakiś czas 494 wpisy linkowały `mesa.pages.freedesktop.org/-/mesa3d.org/-/jobs/<job>/artifacts/…` zamiast `www.mesa3d.org`, więc tożsamość z linku uznała stare wydania za nowe i wysłała je ponownie; linki wróciły do normy | rozpoznawać po slugu niezależnym od hosta albo odrzucać stare wpisy (po dacie), gdy cały znany feed nagle robi się nowy |
| Te same wpisy pod nowymi linkami, guid bez zmian | Onet Wiadomości 2026-11-24: 21 wpisów dostało nowy format linku (`/1795482011830/4/...`) z tym samym guidem i poszło drugi raz | rozpoznawać po guidzie, gdy jest unikalny; XFeeder 3.1 zapisuje alias `guid:<g>` |

## Blokady i błędy

| Zachowanie | Gdzie | Co robić |
|---|---|---|
| HTTP 200 ze stroną błędu w HTML | `steamcommunity.com/games/<id liczbowe>/rss` dla aplikacji z nazwą własną | sprawdzić, czy treść to feed |
| HTTP 200 z `Success:"0"` | API sterowników NVIDII, nic nie znaleziono | traktować jako „brak danych” |
| HTTP 200 ze stroną wyzwania dla botów | Black Desert (Incapsula), gitlab.freedesktop.org (Anubis) | traktować jako blokadę, użyć zapasowego sposobu |
| UA przeglądarki zablokowany, UA bota dozwolony | intel.com (IP domowe), Codeberg, fortnite.com | wysyłać uczciwy UA czytnika feedów |
| UA bota się zawiesza, UA przeglądarki dozwolony | amd.com (IP domowe) | UA per host; IP z centrum danych mogą zachowywać się inaczej, więc testować z serwera |
| IP z centrum danych zablokowane (403) | lowcygier.pl, boop.pl (wyzwanie antybotowe) z VPS-a XFeedera; oba 200 z domu | zapasowa przeglądarka na serwerze |
| Obrazki zablokowane dla IP z centrum danych | obrazki `wp-content/uploads` z blender.org (403 z VPS-a) | wysłać post bez obrazka albo pobrać go z domu |
| IP z centrum danych zablokowane przy każdym UA | intel.com, en-forum.guildwars2.com (403 „Request not allowed from this Internet Service Provider”) z VPS-a XFeedera | zapasowa przeglądarka albo inne źródło (GW2: Steam 1284210) |
| Stronie brakuje bloku danych raz na 4 razy | amd.com | brak bloku znaczy „brak danych”, nigdy „usunięte” |
| 410 Gone po wycofaniu API | API danych v2 Artificial Analysis | usunąć źródło |
| Strona zabrania scrapowania | steamdb.info (FAQ + 403 dla klientów innych niż przeglądarka; robots.txt `Disallow: /api/PatchnotesRSS/`) | brać dane z samego Steama (anonimowy SteamCMD `app_info_print`) |
| Ściana logowania zamiast feedu | Reddit `.rss` (404 / 429 / „Welcome to Reddit”) | nie używać bez OAuth |
| Feed ogłoszony w `<head>`, ale zwraca HTML | RSS comm-linków Star Citizen | sprawdzić treść |
| Przekierowanie 308 / 301 / 307 | WordPress `/rss` → `/feed/` (gry-wideo.pl, lowcygier.pl), RSS newsów Mesy (bez `www.`), RSS bloga Gemini, newsy Fall Guys i Rocket League (`?lang=`) | iść za nim i zapisać nowy adres |

## Kulturalne odpytywanie

| Źródło | Cache / limit | Rozsądny interwał |
|---|---|---|
| JSON wydarzeń Steama | `max-age=300`, `If-Modified-Since` → 304 | 10–15 min na grę |
| RSS sklepu Steam | `max-age=120` | 10–15 min |
| Steam Web API | 100 000 wywołań dziennie (warunki API Steama) | — |
| Darmowe gry Epic | cache CDN | 30 min |
| Listy Game Pass | — | 6 h |
| NVIDIA / AMD / Intel | cache Akamai (AMD `max-age=900`) | 30–60 min |
| SteamDB PatchnotesRSS | `ttl` 3600, „heavily cached” | ≥ 60 min albo zastąpić SteamCMD/PICS |
| SteamCMD `app_info_print` (PICS) | jedno logowanie na przebieg; 8 aplikacji w 8 s | 10–15 min, wszystkie aplikacje w jednym przebiegu |
| `releases.atom` GitHuba | tylko 10 wpisów | 15–30 min dla aktywnych repozytoriów |
