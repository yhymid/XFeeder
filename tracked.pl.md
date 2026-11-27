# Co XFeeder śledzi na produkcji

[← Spis](README.pl.md) · [English](tracked.md)

Feedy z działającego `config.json` XFeedera (poza kanałem testowym), sprawdzone **2026-11-23** z domowego łącza, a kolumna 🖥 z VPS-a XFeedera (IP z centrum danych). Webhooków, wątków i tokenów tu nie ma, prywatne repozytoria są pominięte.

## Polskie newsy i darmowe gry

| Źródło | Feed | Format | Dom | 🖥 VPS | Uwagi |
|---|---|---|---|---|---|
| FMHY tracker | https://fmhy-tracker.pages.dev/feed.xml | RSS | ✅ 200 | ✅ | tracker zmian FMHY prowadzony przez społeczność |
| boop.pl | https://boop.pl/rss | RSS | ✅ 200 | ✅ przez zapasową przeglądarkę | zwykłe zapytania czasem dostają 403; XFeeder odnawia wtedy clearance przeglądarką i wpisy przychodzą (sprawdzone w logach 2026-11-25) |
| gry-wideo.pl | https://gry-wideo.pl/feed/ | RSS | ✅ 200 | ✅ 200 | w configu jest `/rss`, które odpowiada **301** na `/feed/`; XFeeder logował wcześniej 403 na `/rss`, więc używaj od razu `/feed/` |
| lowcygier.pl | https://lowcygier.pl/feed/ | RSS | ✅ 200 | ❌ **403** na `/rss` | `/rss` odpowiada z domu **301** na `/feed/` |
| Onet Wiadomości | https://wiadomosci.onet.pl/.feed | RSS | ✅ 200 | ✅ | |

## Kod i repozytoria

| Źródło | Feed | Format | Uwagi |
|---|---|---|---|
| MARMAK git mirror | https://git.marmak.net.pl/MARMAK/mirror.rss | RSS | 200 z domu i z VPS-a |
| FMHY | https://github.com/fmhy/FMHY/commits/main.atom | Atom | commity `main` |
| FMHY edit | https://github.com/fmhy/edit/commits/main.atom | Atom | commity `main` |
| Aktywność yhymid | https://github.com/yhymid.atom | Atom | aktywność konta; zdarzenia GitHuba potrafią się spóźniać o dni |
| XFeeder | https://github.com/yhymid/XFeeder/commits/main.atom, `…/commits/Beta.atom` | Atom | commity |
| XFeeder | https://api.github.com/repos/yhymid/XFeeder/releases, `…/branches` | GitHub API (JSON) | czytane przez adapter GitHuba w XFeederze |
| Operator | https://github.com/yhymid/Operator/commits/discord.atom, `…/commits/telegram.atom` | Atom | commity |
| Operator | https://api.github.com/repos/yhymid/Operator/releases, `…/branches` | GitHub API | |
| Bladephoriafonk Website | https://github.com/yhymid/Bladephoriafonk-Website/commits/main.atom, `…/commits/rust-rewrite.atom` | Atom | commity |
| Bladephoriafonk Website | https://api.github.com/repos/yhymid/Bladephoriafonk-Website/releases, `…/branches` | GitHub API | |
| XCleaner | https://api.github.com/repos/yhymid/XCleaner/releases, `…/branches`, `…/commits?sha=main` | GitHub API | |
| Własne issue i PR-y | `https://api.github.com/user/issues?filter=all&state=all&sort=created` | GitHub API | wymaga `Auth.GitHubToken` |

Linie „pushed to … in yhymid/…” z feedu aktywności dublują feedy commitów; kanał changelogu odrzuca je regexem `Exclude` na `contentSnippet`.

## YouTube

| Kanał | Feed |
|---|---|
| Yhym's | https://www.youtube.com/feeds/videos.xml?channel_id=UC7WEPIfJ1zs8cClnBWfQHoA |
| Olek47 | https://www.youtube.com/feeds/videos.xml?channel_id=UCee52-G-iJdJ_rmp1p0dh2w |
| kirvor1012 | https://www.youtube.com/feeds/videos.xml?channel_id=UCn9DZgFd3ms10NZI5aIlT9g |
| wasapiku | https://www.youtube.com/feeds/videos.xml?channel_id=UCj68f7cl5SyigARbeQplzOQ |

## Steam

Każda gra łączy oficjalny RSS sklepu z RSS patch notes z SteamDB, a `SteamMerge` w XFeederze łączy je w jeden post. Wszystkie AppID są w [games/steam.pl.md](games/steam.pl.md).

| Gra | AppID | Feedy |
|---|---|---|
| Counter-Strike 2 | 730 | RSS sklepu + SteamDB |
| Left 4 Dead 2 | 550 | RSS sklepu + SteamDB |
| Deadlock | 1422450 | RSS sklepu + SteamDB |
| Half-Life: Alyx, Half-Life 2, Half-Life | 546560, 220, 70 | RSS sklepu + SteamDB (jeden kanał) |
| Rust | 252490 | RSS sklepu + SteamDB |
| s&box | 590830 | RSS sklepu + SteamDB |
| Steam Deck | 1675200 | RSS sklepu |
| Steam News | 593110 | RSS sklepu |
| Grupa Steam 39049601 | — | https://store.steampowered.com/feeds/news/group/39049601 (grupa „RSS Feed” Valve: wydarzenia sklepu, np. Next Fest) |

- **SteamDB to źródło społeczności**: `https://steamdb.info/api/PatchnotesRSS/?appid=<APPID>` (200 dnia 2026-11-23). Widzi zmiany buildów, których Valve nigdy nie ogłasza, ale robots.txt blokuje (`Disallow`) `/api/PatchnotesRSS/`, a FAQ SteamDB mówi, że RSS nie służy do automatycznego monitorowania. Te same dane o buildach daje bezpośrednio Steam przez anonimowy SteamCMD/PICS; zobacz [games/steam.pl.md](games/steam.pl.md#zmiany-buildów-i-gałęzi-co-pokazuje-zakładka-history-w-steamdb).
- Żeby oddzielić patche od newsów, JSON wydarzeń sklepu może zastąpić RSS sklepu bez ponownych postów (zobacz [games/steam.pl.md](games/steam.pl.md)).
