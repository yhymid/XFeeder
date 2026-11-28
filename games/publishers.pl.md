# Gry: źródła wydawców (spoza Steama albo lepsze niż Steam)

[← Spis](../README.pl.md) · [English](publishers.md)

Sprawdzone **2026-11-23** zwykłymi publicznymi zapytaniami GET, bez logowania. „Oficjalne” znaczy, że dane trzyma wydawca. Jeśli to nie prawdziwy feed RSS/Atom, to nadal **nieudokumentowany backend strony**, który może zmienić kształt, więc każde pole czytaj ostrożnie.

Legenda formatów:
- **RSS / Atom**: XFeeder czyta to już dziś; najwyżej trzeba wpisu w `Filters`.
- **JSON**: zwykły endpoint JSON; wymaga adaptera.
- **NEXT**: JSON wewnątrz `<script id="__NEXT_DATA__">` w HTML; wymaga adaptera.
- **HTML**: lista w HTML renderowanym po stronie serwera; wymaga selektorów CSS.
- **Steam**: zobacz [steam.pl.md](steam.pl.md).

## Podsumowanie

| Gra | Najlepsze oficjalne źródło | Format | Filtr patchy | Stan | Zapasowe |
|---|---|---|---|---|---|
| League of Legends | https://www.leagueoflegends.com/en-us/news/tags/patch-notes/ | NEXT | strona to już same patch notes | ✅ 200 | — (bez RSS: `/rss.xml` 404) |
| Teamfight Tactics | https://teamfighttactics.leagueoflegends.com/en-us/news/tags/patch-notes/ | NEXT | odrzucić `action.type = youtube_video` | ✅ 200 | `/en-us/news/game-updates/` |
| Valorant | https://playvalorant.com/en-us/news/tags/patch-notes/ | NEXT | strona tagu | ✅ 200 | — |
| Legends of Runeterra | https://playruneterra.com/en-us/news/ | tylko JS | — | ❌ brak danych w HTML | brak; gra w trybie utrzymania |
| World of Warcraft (+ Classic) | https://news.blizzard.com/en-us/api/news/blizzard?feedCxpProductIds%5B%5D=blt2caca37e42f19839 | JSON | tytuł `/hotfix\|patch notes/i`; Classic = tytuł zawiera `Classic` | ✅ 200 | — |
| Overwatch 2 | https://overwatch.blizzard.com/en-us/news/patch-notes/ | HTML | każdy `h3.PatchNotes-patchTitle`; kotwica `id="patch-YYYY-MM-DD"` | ✅ 200 | Steam 2357570 |
| Hearthstone | https://hearthstone.blizzard.com/en-us/api/blog/articleList/?page=1&pageSize=12 | JSON (pełna treść HTML; data = `publish` w ms epoki, `created_at` to czas szkicu, 7–39 dni wcześniej; link do artykułu = `defaultUrl`; obrazek = `thumbnail.url`) | `tags` zawiera `patch` albo tytuł `/patch notes/i` | ✅ 200 | Blizzard API `blt5cfc6affa3ca0638` |
| Diablo IV | https://news.blizzard.com/en-us/api/news/blizzard?feedCxpProductIds%5B%5D=blt795c314400d7ded9 | JSON | tytuł `/patch notes/i` (także PTR) | ✅ 200 | Steam 2344520 |
| Diablo III | …`feedCxpProductIds%5B%5D=blt2031aef34200656d` | JSON | **trzeba** sprawdzić `cxpProduct.title == "Diablo III"` (feed miesza z D4) | ✅ 200 | — |
| Diablo II: Resurrected | …`feedCxpProductIds%5B%5D=blt54fbd3787a705054` | JSON | tytuł `/patch notes/i` | ID znalezione, feed nietestowany | — |
| Diablo Immortal | …`feedCxpProductIds%5B%5D=blt525c436e4a1b0a97` | JSON | tytuł `/patch notes/i` | ID znalezione, feed nietestowany | — |
| StarCraft II | …`feedCxpProductIds%5B%5D=bltede2389c0a8885aa` | JSON | tytuł `/patch notes/i` | ✅ 200 | — |
| Heroes of the Storm | …`feedCxpProductIds%5B%5D=blt2e50e1521bb84dc6` | JSON | tytuł `/patch notes/i` | ✅ 200 | — |
| Minecraft Java | https://launchercontent.mojang.com/v2/javaPatchNotes.json | JSON | `type` = `release` / `snapshot` | ✅ 200 | `v2/news.json` |
| Minecraft Bedrock | https://launchercontent.mojang.com/v2/bedrockPatchNotes.json | JSON | wszystkie wpisy; `patchNoteType` (czasem brak) | ✅ 200 | `v2/news.json` (`newsType` zawiera `Bedrock`) |
| Genshin Impact | https://sg-public-api-static.hoyoverse.com/content_v2_user/app/a1b1f9d3315447cc/getContentList?iAppId=32&iChanId=397&iPageSize=10&iPage=1&sLangKey=en-us | JSON | kanał 397 = Updates; tytuł `/Update Details\|Maintenance/` | ✅ 200 | oficjalne konto na HoYoLAB (niżej) |
| Honkai: Star Rail | https://sg-public-api-static.hoyoverse.com/content_v2_user/app/113fe6d3b4514cdd/getContentList?iPage=1&iPageSize=10&sLangKey=en-us&isPreview=0&iChanId=250 | JSON | kanał 250 = komunikaty; tytuł `/Update Details/` | ✅ 200 | `iChanId=248` = wszystkie newsy |
| Zenless Zone Zero | https://zenless.hoyoverse.com/en-us/news to aplikacja JS (bez wpisów w HTML); dane pochodzą z tego samego API treści HoYoverse co Genshin, tu nietestowane | — | — | ❌ brak feedu na stronie (2026-11-23) | **Steam 4162040** |
| Wuthering Waves | https://hw-media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/en/ArticleMenu.json | JSON (całe archiwum, nieposortowane) | tytuł `/Patch Notes/` | ✅ 200 | Steam 3513350 |
| GTA V / GTA Online | **brak oficjalnego feedu** (Newswire to aplikacja JS; `/newswire/rss` 404) | — | — | ❌ | **Steam 271590** (powiela Newswire), Enhanced 3240220 |
| Red Dead Redemption 2 | brak (jak GTA) | — | — | ❌ | Steam 1174180 |
| Apex Legends | https://www.ea.com/games/apex-legends/apex-legends/news?type=game-updates | NEXT | tytuł `/patch notes\|latest update/i` | ✅ 200 | **Steam 1172470 jest lepszy** (posty „Latest Update”) |
| EA SPORTS FC | https://www.ea.com/games/ea-sports-fc/fc-27/news (**slug zmienia się co roku**) | NEXT | tytuł `/Title Update\|Pitch Notes/i` | ✅ 200 | Steam 4080220 (FC 27) |
| Call of Duty / Warzone | https://www.callofduty.com/patchnotes | HTML | linki `/patchnotes/YYYY/MM/<slug>` | ✅ 200 | — (strony to żywe dokumenty) |
| Rainbow Six Siege | https://www.ubisoft.com/en-us/game/rainbow-six/siege/news-updates | HTML + `window.__PRELOADED_STATE__` | tytuł `/patch notes/i` | ✅ 200 | Steam 359550 |
| Fortnite | https://www.fortnite.com/news | HTML (kruchy strumień Reacta) | heurystyki na tytule; Epic rzadko publikuje teraz patch notes | ⚠️ 200 z UA czytnika feedów, **403 z UA Chrome** | RSS statusu https://status.epicgames.com/history.rss (tylko awarie) |
| Rocket League | https://www.rocketleague.com/news?lang=en | HTML (kruche) | tytuł `/Patch Notes/` (strona tagu jest nieaktualna) | ⚠️ 200 | — |
| Fall Guys | https://www.fallguys.com/news?lang=en-US | NEXT | tytuł `/update/i` | ✅ 200 | — (rzadkie posty) |
| Destiny 2 | https://www.bungie.net/en/rss/News | **RSS** | tytuł `^Destiny 2 (Update\|Hotfix)` (feed miesza z Marathonem) | ✅ 200 | Steam 1085660 |
| Marathon | https://www.bungie.net/en/rss/News | **RSS** | tytuł zawiera `Marathon` | ✅ 200 | Steam 3065800 |
| Path of Exile | https://www.pathofexile.com/forum/view-forum/patch-notes | HTML | całe forum = patch notes | ✅ 200 | Steam 238960; https://www.pathofexile.com/news/rss (ogłoszenia) |
| Path of Exile 2 | https://www.pathofexile.com/forum/view-forum/2212 | HTML | całe forum | ✅ 200 | Steam 2694490 |
| RuneScape | https://secure.runescape.com/m=news/latest_news.rss | **RSS** | `category = Game Updates` | ✅ 200 | — |
| Old School RuneScape | https://secure.runescape.com/m=news/latest_news.rss?oldschool=true | **RSS** | `category = Game Updates` | ✅ 200 | — |
| osu! | https://osu.ppy.sh/home/changelog?stream=lazer (send `Accept: application/json`) | JSON | `stream` = lazer / stable40 / web | ✅ 200 | Atom newsów https://osu.ppy.sh/home/news?format=atom; API v2 = 403 Cloudflare |
| Roblox | https://devforum.roblox.com/c/updates/release-notes/62.rss | **RSS** | tytuł `^Release Notes for \d+` | ✅ 200 | `/c/updates/announcements/36.rss` |
| Star Citizen | brak feedu patch notes przez GET (RSS comm-linków zwraca HTML) | — | — | ❌ | https://status.robertsspaceindustries.com/index.xml ("Live Deployment" = patch) |
| Elder Scrolls Online | https://www.elderscrollsonline.com/en-us/rss/news | **RSS** | tytuł `/Patch Notes/` | ✅ 200 | Steam 306130 (feed forum jest za Cloudflare) |
| Guild Wars 2 | https://en-forum.guildwars2.com/forum/6-game-release-notes.xml/ | **RSS** | całe forum = notatki aktualizacji | ✅ 200 z domu; ❌ **403 z VPS-a XFeedera** („Request not allowed from this Internet Service Provider”, każdy UA, 2026-11-23) | na serwerze: **Steam 1284210**; https://api.guildwars2.com/v2/build (zmiana id buildu = patch, 200 z VPS-a) |
| Guild Wars 2 (wiki, wszystkie aktualizacje) | https://wiki.guildwars2.com/index.php?title=Special:Ask&q=%5B%5BHas+context%3A%3AGame+update%5D%5D&sort=Has+release+date&order=desc&limit=10&p%5Bformat%5D=feed&p%5Btype%5D=atom&p%5Bpage%5D=full | **Atom** | jeden wpis na stronę `Game updates/YYYY-MM-DD`, wydania **i hotfixy**, pełny tekst | ✅ 200 z domu (2026-11-26); jeszcze nietestowane z VPS-a. Oficjalne wiki utrzymywane przez ArenaNet, bez Cloudflare. Strony piszą wolontariusze, od <1 h do ~1,5 dnia po aktualizacji; `updated` zmienia się przy każdej edycji (odsiewaj po id); tekst ma bloki `<style>` i ramkę Previous/Next. robots.txt zabrania crawlerom Special:Ask: sprawdzaj delikatnie (30–60 min). |
| Black Desert | oficjalna strona za blokadą Incapsula | — | — | ❌ | **Steam 582660** |
| Lost Ark | https://www.playlostark.com/en-us/news | HTML | slug kończy się na `-release-notes` | ✅ 200 | **Steam 1599340 jest lepszy** |
| World of Tanks | https://worldoftanks.eu/en/rss/news/ | **RSS** | `category = Updates` | ✅ 200 | `.com` / `.asia` hosts |
| World of Warships | https://worldofwarships.eu/en/rss/news/ | **RSS** | `category = Game Updates` (+ `Work in Progress` = blog deweloperski) | ✅ 200 | — |
| Final Fantasy XIV | https://na.finalfantasyxiv.com/lodestone/news/news.xml | **Atom** | `category = Updates` (+ Maintenance) | ✅ 200 | `topics.xml` (duże „Patch X.Y Notes”) |
| War Thunder | https://warthunder.com/en/game/changelog/ | HTML | cała strona = changelog | ✅ 200 | Steam 236390 |
| Escape from Tarkov | strona to aplikacja JS, bez feedu (ponownie sprawdzone 2026-11-23: `/news` nie ma linków w HTML, `/rss` 404) | — | — | ❌ | **Steam 3932890** |
| Hytale | https://hytale.com/rss.xml | **RSS** | tytuł `/PATCH NOTES\|HOTFIX/i` (blog miesza z postami fabularnymi) | ✅ 200 z domu i z VPS-a (86 wpisów, 2026-11-23) | — |
| Splitgate 2 | nowa nazwa **SPLITGATE: Arena Reloaded**; https://www.splitgate.com/news to aplikacja JS | — | — | ❌ brak feedu na stronie | **Steam 2918300** (JSON wydarzeń ✅) |
| AION 2 | https://aion2.plaync.com/ to aplikacja JS (bez linków do newsów w HTML, 2026-11-23) | — | — | ❌ brak feedu na stronie | **Steam 3393110** |

## Szczegóły według wydawcy

### Riot (LoL, TFT, Valorant)
- Czytaj `<script id="__NEXT_DATA__">` → `props.pageProps.page.blades[]` → pierwszy blade z `type == "articleCardGrid"` → `.items[]`.
- Pola:
  - `title`
  - `publishedAt` (ISO UTC)
  - `action.payload.url`: względny, więc dodaj adres strony z przodu. Dla `action.type == "youtube_video"` to adres YouTube.
  - `media.url`, a jeśli go nie ma, `imageMedia.url`
  - `description.body` (krótka zapowiedź)
- Język jest w ścieżce (`/en-us/`, `/pl-pl/`). Patche LoL i TFT wychodzą mniej więcej co 2 tygodnie, we wtorki o 19:00 UTC.

### Blizzard (jedno API JSON dla większości gier)
- `https://news.blizzard.com/en-us/api/news/blizzard?feedCxpProductIds%5B%5D=<id>`. Używaj **jednego zapytania na grę**: przy dwóch id wróciła tylko pierwsza gra.
- Wpisy są w `feed.contentItems[].properties`:
  - `newsId` (po nim odsiewaj duplikaty)
  - `title`
  - `lastUpdated`: zmienia się przy każdej edycji, więc nigdy nie odsiewaj po nim
  - `newsUrl`
  - `staticAsset.imageUrl`: bez protokołu, więc dodaj `https:`
  - `summary`
  - `category`: **niewiarygodne**, zamiast tego użyj regexu na tytule
  - `cxpProduct.title`
- Martwe (404): `news.blizzard.com/en-us/rss`, `/en-us/feed`, `worldofwarcraft.blizzard.com/en-us/news/patch-notes`.

| Gra | cxpProductId |
|---|---|
| World of Warcraft (z Classic) | `blt2caca37e42f19839` |
| Overwatch (tylko newsy, bez patch notes) | `blt376fb94931906b6f` |
| Hearthstone | `blt5cfc6affa3ca0638` |
| Diablo IV | `blt795c314400d7ded9` |
| Diablo III | `blt2031aef34200656d` |
| StarCraft II | `bltede2389c0a8885aa` |
| Heroes of the Storm | `blt2e50e1521bb84dc6` |
| Diablo Immortal | `blt525c436e4a1b0a97` |
| Diablo II: Resurrected | `blt54fbd3787a705054` |

### Mojang (Minecraft)
- Wpisy mają `id`, `title`, `version`, `type` / `patchNoteType`, `date`, `image.url` (względny wobec `https://launchercontent.mojang.com`), `contentPath`, `shortText`.
- Pełna treść: `https://launchercontent.mojang.com/v2/<contentPath>`.
- Wpisy nie mają adresu strony. Do linku użyj `v2/news.json`, który ma `readMoreLink`.

### HoYoverse / Kuro
- Kanały Genshina: 395 = wszystko, 396 = informacje, **397 = aktualizacje**, 398 = wydarzenia. HSR: 248 = wszystko, 249 = newsy, **250 = komunikaty**, 251 = wydarzenia.
- Pola: `iInfoId` (id), `sTitle`, `dtStartTime` (bez strefy czasowej, prawdopodobnie UTC+8), `sContent` (pełny HTML) i `sExt`: **napis** z JSON-em, w którym `banner[0].url` to obrazek.
- Listy **nie są posortowane po dacie** (przypięte wpisy są pierwsze), więc sortuj po parsowaniu.
- Treść Wuthering Waves: `…/json/G152/en/article/<articleId>.json`.
- Zapasowe źródło Genshina na HoYoLAB: `https://bbs-api-os.hoyolab.com/community/post/wapi/userPost?size=10&uid=1015537`.

### EA / Ubisoft
- EA: `__NEXT_DATA__` → `props.pageProps.initialNewsData.items[]` (`title`, `publishingDate`, `image.ar16X9`, `summary`). Sprawdzaj też osobny obiekt `featured`.
- Ubisoft: `window.__PRELOADED_STATE__` → `Updates.feed.items[]`. Data jest w formacie JS `Date.toString()`, np. „Tue Nov 03 2026 10:30:00 GMT+0000 (…)”.

### Inne
- **Fora Path of Exile** nie mają RSS; dopisek `/rss` zwraca ten sam HTML. Daty na liście nie mają strefy czasowej.
- **RSS Jagex** jest w ISO-8859-1. Przestrzeni nazw `dc` brakuje końcowego ukośnika, a wpisy nie są ułożone po dacie.
- **Atom FFXIV** ma dwa linki na wpis, obrazek pierwszy, więc używaj `rel="alternate"`.
- Tytuły w **RSS ESO** mają białe znaki na brzegach.
- Linki w **RSS Bungie** są względne (`/7/en/News/...`), więc dodaj z przodu `https://www.bungie.net`.
