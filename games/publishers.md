# Games: publisher sources (not Steam, or better than Steam)

[← Index](../README.md)

Checked **2026-11-23** with plain public GET requests, no login. "Official" means the publisher hosts the data. Unless it is a real RSS/Atom feed, it is still an **undocumented website backend** that can change shape, so read every field defensively.

Format legend:
- **RSS / Atom**: XFeeder reads it today; at most a `Filters` entry is needed.
- **JSON**: a plain JSON endpoint; needs an adapter.
- **NEXT**: JSON inside `<script id="__NEXT_DATA__">` in the HTML; needs an adapter.
- **HTML**: a list in server-rendered HTML; needs CSS selectors.
- **Steam**: see [steam.md](steam.md).

## Summary

| Game | Best official source | Format | Patch filter | Status | Fallback |
|---|---|---|---|---|---|
| League of Legends | https://www.leagueoflegends.com/en-us/news/tags/patch-notes/ | NEXT | page is already patch-notes only | ✅ 200 | — (no RSS: `/rss.xml` 404) |
| Teamfight Tactics | https://teamfighttactics.leagueoflegends.com/en-us/news/tags/patch-notes/ | NEXT | drop `action.type = youtube_video` | ✅ 200 | `/en-us/news/game-updates/` |
| Valorant | https://playvalorant.com/en-us/news/tags/patch-notes/ | NEXT | tag page | ✅ 200 | — |
| Legends of Runeterra | https://playruneterra.com/en-us/news/ | JS only | — | ❌ no data in the HTML | none; game in maintenance mode |
| World of Warcraft (+ Classic) | https://news.blizzard.com/en-us/api/news/blizzard?feedCxpProductIds%5B%5D=blt2caca37e42f19839 | JSON | title `/hotfix\|patch notes/i`; Classic = title contains `Classic` | ✅ 200 | — |
| Overwatch 2 | https://overwatch.blizzard.com/en-us/news/patch-notes/ | HTML | every `h3.PatchNotes-patchTitle`; anchor `id="patch-YYYY-MM-DD"` | ✅ 200 | Steam 2357570 |
| Hearthstone | https://hearthstone.blizzard.com/en-us/api/blog/articleList/?page=1&pageSize=12 | JSON (full HTML body) | `tags` contains `patch` or title `/patch notes/i` | ✅ 200 | Blizzard API `blt5cfc6affa3ca0638` |
| Diablo IV | https://news.blizzard.com/en-us/api/news/blizzard?feedCxpProductIds%5B%5D=blt795c314400d7ded9 | JSON | title `/patch notes/i` (also PTR) | ✅ 200 | Steam 2344520 |
| Diablo III | …`feedCxpProductIds%5B%5D=blt2031aef34200656d` | JSON | **must** check `cxpProduct.title == "Diablo III"` (feed mixes in D4) | ✅ 200 | — |
| Diablo II: Resurrected | …`feedCxpProductIds%5B%5D=blt54fbd3787a705054` | JSON | title `/patch notes/i` | ID found, feed not tested | — |
| Diablo Immortal | …`feedCxpProductIds%5B%5D=blt525c436e4a1b0a97` | JSON | title `/patch notes/i` | ID found, feed not tested | — |
| StarCraft II | …`feedCxpProductIds%5B%5D=bltede2389c0a8885aa` | JSON | title `/patch notes/i` | ✅ 200 | — |
| Heroes of the Storm | …`feedCxpProductIds%5B%5D=blt2e50e1521bb84dc6` | JSON | title `/patch notes/i` | ✅ 200 | — |
| Minecraft Java | https://launchercontent.mojang.com/v2/javaPatchNotes.json | JSON | `type` = `release` / `snapshot` | ✅ 200 | `v2/news.json` |
| Minecraft Bedrock | https://launchercontent.mojang.com/v2/bedrockPatchNotes.json | JSON | all entries; `patchNoteType` (sometimes missing) | ✅ 200 | `v2/news.json` (`newsType` contains `Bedrock`) |
| Genshin Impact | https://sg-public-api-static.hoyoverse.com/content_v2_user/app/a1b1f9d3315447cc/getContentList?iAppId=32&iChanId=397&iPageSize=10&iPage=1&sLangKey=en-us | JSON | channel 397 = Updates; title `/Update Details\|Maintenance/` | ✅ 200 | HoYoLAB official account (below) |
| Honkai: Star Rail | https://sg-public-api-static.hoyoverse.com/content_v2_user/app/113fe6d3b4514cdd/getContentList?iPage=1&iPageSize=10&sLangKey=en-us&isPreview=0&iChanId=250 | JSON | channel 250 = notices; title `/Update Details/` | ✅ 200 | `iChanId=248` = all news |
| Zenless Zone Zero | not researched yet | — | — | ❓ | Steam 4162040 |
| Wuthering Waves | https://hw-media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/en/ArticleMenu.json | JSON (whole archive, unsorted) | title `/Patch Notes/` | ✅ 200 | Steam 3513350 |
| GTA V / GTA Online | **no official feed** (Newswire is a JS app; `/newswire/rss` 404) | — | — | ❌ | **Steam 271590** (mirrors Newswire), Enhanced 3240220 |
| Red Dead Redemption 2 | none (same as GTA) | — | — | ❌ | Steam 1174180 |
| Apex Legends | https://www.ea.com/games/apex-legends/apex-legends/news?type=game-updates | NEXT | title `/patch notes\|latest update/i` | ✅ 200 | **Steam 1172470 is better** ("Latest Update" posts) |
| EA SPORTS FC | https://www.ea.com/games/ea-sports-fc/fc-27/news (**slug changes every year**) | NEXT | title `/Title Update\|Pitch Notes/i` | ✅ 200 | Steam 4080220 (FC 27) |
| Call of Duty / Warzone | https://www.callofduty.com/patchnotes | HTML | links `/patchnotes/YYYY/MM/<slug>` | ✅ 200 | — (pages are living documents) |
| Rainbow Six Siege | https://www.ubisoft.com/en-us/game/rainbow-six/siege/news-updates | HTML + `window.__PRELOADED_STATE__` | title `/patch notes/i` | ✅ 200 | Steam 359550 |
| Fortnite | https://www.fortnite.com/news | HTML (fragile React stream) | title heuristics; Epic rarely posts patch notes now | ⚠️ 200 with a feed-reader UA, **403 with a Chrome UA** | status RSS https://status.epicgames.com/history.rss (incidents only) |
| Rocket League | https://www.rocketleague.com/news?lang=en | HTML (fragile) | title `/Patch Notes/` (the tag page is stale) | ⚠️ 200 | — |
| Fall Guys | https://www.fallguys.com/news?lang=en-US | NEXT | title `/update/i` | ✅ 200 | — (low cadence) |
| Destiny 2 | https://www.bungie.net/en/rss/News | **RSS** | title `^Destiny 2 (Update\|Hotfix)` (feed mixes in Marathon) | ✅ 200 | Steam 1085660 |
| Marathon | https://www.bungie.net/en/rss/News | **RSS** | title contains `Marathon` | ✅ 200 | Steam 3065800 |
| Path of Exile | https://www.pathofexile.com/forum/view-forum/patch-notes | HTML | whole forum = patch notes | ✅ 200 | Steam 238960; https://www.pathofexile.com/news/rss (announcements) |
| Path of Exile 2 | https://www.pathofexile.com/forum/view-forum/2212 | HTML | whole forum | ✅ 200 | Steam 2694490 |
| RuneScape | https://secure.runescape.com/m=news/latest_news.rss | **RSS** | `category = Game Updates` | ✅ 200 | — |
| Old School RuneScape | https://secure.runescape.com/m=news/latest_news.rss?oldschool=true | **RSS** | `category = Game Updates` | ✅ 200 | — |
| osu! | https://osu.ppy.sh/home/changelog?stream=lazer (send `Accept: application/json`) | JSON | `stream` = lazer / stable40 / web | ✅ 200 | news Atom https://osu.ppy.sh/home/news?format=atom; API v2 = 403 Cloudflare |
| Roblox | https://devforum.roblox.com/c/updates/release-notes/62.rss | **RSS** | title `^Release Notes for \d+` | ✅ 200 | `/c/updates/announcements/36.rss` |
| Star Citizen | no GET patch-notes feed (comm-link RSS returns HTML) | — | — | ❌ | https://status.robertsspaceindustries.com/index.xml ("Live Deployment" = patch) |
| Elder Scrolls Online | https://www.elderscrollsonline.com/en-us/rss/news | **RSS** | title `/Patch Notes/` | ✅ 200 | Steam 306130 (the forum feed is behind Cloudflare) |
| Guild Wars 2 | https://en-forum.guildwars2.com/forum/6-game-release-notes.xml/ | **RSS** | whole forum = update notes | ✅ 200 from home; ❌ **403 from the XFeeder VPS** ("Request not allowed from this Internet Service Provider", any UA, 2026-11-23) | on a server: **Steam 1284210**; https://api.guildwars2.com/v2/build (build id change = patch, 200 from the VPS) |
| Black Desert | official site behind an Incapsula block page | — | — | ❌ | **Steam 582660** |
| Lost Ark | https://www.playlostark.com/en-us/news | HTML | slug ends in `-release-notes` | ✅ 200 | **Steam 1599340 is better** |
| World of Tanks | https://worldoftanks.eu/en/rss/news/ | **RSS** | `category = Updates` | ✅ 200 | `.com` / `.asia` hosts |
| World of Warships | https://worldofwarships.eu/en/rss/news/ | **RSS** | `category = Game Updates` (+ `Work in Progress` = dev blog) | ✅ 200 | — |
| Final Fantasy XIV | https://na.finalfantasyxiv.com/lodestone/news/news.xml | **Atom** | `category = Updates` (+ Maintenance) | ✅ 200 | `topics.xml` (big "Patch X.Y Notes") |
| War Thunder | https://warthunder.com/en/game/changelog/ | HTML | whole page = changelog | ✅ 200 | Steam 236390 |
| Escape from Tarkov | site is a JS app, no feed | — | — | ❌ | **Steam 3932890** |
| Hytale | not researched yet | — | — | ❓ | — |
| Splitgate 2 | not found on Steam under this name; not researched | — | — | ❓ | — |
| AION 2 | not researched (NCSOFT) | — | — | ❓ | Steam 3393110 |

## Details per publisher

### Riot (LoL, TFT, Valorant)
- Read `<script id="__NEXT_DATA__">` → `props.pageProps.page.blades[]` → the first blade with `type == "articleCardGrid"` → `.items[]`.
- Fields:
  - `title`
  - `publishedAt` (ISO UTC)
  - `action.payload.url`: relative, so prefix the site origin. For `action.type == "youtube_video"` it is a YouTube URL.
  - `media.url`, else `imageMedia.url`
  - `description.body` (short teaser)
- Locale is in the path (`/en-us/`, `/pl-pl/`). LoL and TFT patches come out about every 2 weeks, on Tuesdays at 19:00 UTC.

### Blizzard (one JSON API for most games)
- `https://news.blizzard.com/en-us/api/news/blizzard?feedCxpProductIds%5B%5D=<id>`. Use **one request per game**: two ids returned only the first game.
- Items are in `feed.contentItems[].properties`:
  - `newsId` (dedupe on this)
  - `title`
  - `lastUpdated`: moves on every edit, so never dedupe on it
  - `newsUrl`
  - `staticAsset.imageUrl`: protocol-relative, so prefix `https:`
  - `summary`
  - `category`: **unreliable**, use a title regex instead
  - `cxpProduct.title`
- Dead (404): `news.blizzard.com/en-us/rss`, `/en-us/feed`, `worldofwarcraft.blizzard.com/en-us/news/patch-notes`.

| Game | cxpProductId |
|---|---|
| World of Warcraft (incl. Classic) | `blt2caca37e42f19839` |
| Overwatch (news only, no patch notes) | `blt376fb94931906b6f` |
| Hearthstone | `blt5cfc6affa3ca0638` |
| Diablo IV | `blt795c314400d7ded9` |
| Diablo III | `blt2031aef34200656d` |
| StarCraft II | `bltede2389c0a8885aa` |
| Heroes of the Storm | `blt2e50e1521bb84dc6` |
| Diablo Immortal | `blt525c436e4a1b0a97` |
| Diablo II: Resurrected | `blt54fbd3787a705054` |

### Mojang (Minecraft)
- Entries have `id`, `title`, `version`, `type` / `patchNoteType`, `date`, `image.url` (relative to `https://launchercontent.mojang.com`), `contentPath`, `shortText`.
- Full body: `https://launchercontent.mojang.com/v2/<contentPath>`.
- Entries have no web URL. For a link, use `v2/news.json`, which has `readMoreLink`.

### HoYoverse / Kuro
- Genshin channels: 395 = all, 396 = info, **397 = updates**, 398 = events. HSR: 248 = all, 249 = news, **250 = notices**, 251 = events.
- Fields: `iInfoId` (id), `sTitle`, `dtStartTime` (no time zone, probably UTC+8), `sContent` (full HTML), and `sExt`: a JSON **string** whose `banner[0].url` is the image.
- The lists are **not sorted by date** (pinned items come first), so sort after parsing.
- Wuthering Waves body: `…/json/G152/en/article/<articleId>.json`.
- HoYoLAB fallback for Genshin: `https://bbs-api-os.hoyolab.com/community/post/wapi/userPost?size=10&uid=1015537`.

### EA / Ubisoft
- EA: `__NEXT_DATA__` → `props.pageProps.initialNewsData.items[]` (`title`, `publishingDate`, `image.ar16X9`, `summary`). Also check the separate `featured` object.
- Ubisoft: `window.__PRELOADED_STATE__` → `Updates.feed.items[]`. The date is in JS `Date.toString()` format, e.g. "Tue Nov 03 2026 10:30:00 GMT+0000 (…)".

### Others
- **Path of Exile forums** have no RSS; a `/rss` suffix returns the same HTML. The dates in the list have no time zone.
- **Jagex RSS** is ISO-8859-1. The `dc` namespace lacks its trailing slash, and items are not date-ordered.
- **FFXIV Atom** has two links per entry, the image first, so use `rel="alternate"`.
- **ESO RSS** titles are padded with whitespace.
- **Bungie RSS** links are relative (`/7/en/News/...`), so prefix `https://www.bungie.net`.
