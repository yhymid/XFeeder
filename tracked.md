# What XFeeder tracks in production

[← Index](README.md)

The feeds in XFeeder's live `config.json` (outside the test channel), checked on **2026-11-23**: from a home connection, and the 🖥 column from the XFeeder VPS (a datacenter IP). Webhooks, threads and tokens are not listed here, and private repositories are left out.

## Polish news and free games

| Source | Feed | Format | Home | 🖥 VPS | Notes |
|---|---|---|---|---|---|
| FMHY tracker | https://fmhy-tracker.pages.dev/feed.xml | RSS | ✅ 200 | ✅ | community tracker of FMHY changes |
| boop.pl | https://boop.pl/rss | RSS | ✅ 200 | ✅ via browser fallback | plain requests are sometimes answered 403; XFeeder then renews its clearance with the browser and entries arrive (checked in the logs on 2026-11-25) |
| gry-wideo.pl | https://gry-wideo.pl/feed/ | RSS | ✅ 200 | ✅ 200 | the config has `/rss`, which answers **301** to `/feed/`; XFeeder logged 403 on `/rss` earlier, so use `/feed/` directly |
| lowcygier.pl | https://lowcygier.pl/feed/ | RSS | ✅ 200 | ❌ **403** on `/rss` | `/rss` answers **301** to `/feed/` from home |
| Onet Wiadomości | https://wiadomosci.onet.pl/.feed | RSS | ✅ 200 | ✅ | |

## Code and repositories

| Source | Feed | Format | Notes |
|---|---|---|---|
| MARMAK git mirror | https://git.marmak.net.pl/MARMAK/mirror.rss | RSS | 200 from home and the VPS |
| FMHY | https://github.com/fmhy/FMHY/commits/main.atom | Atom | commits of `main` |
| FMHY edit | https://github.com/fmhy/edit/commits/main.atom | Atom | commits of `main` |
| yhymid activity | https://github.com/yhymid.atom | Atom | account activity; GitHub's events can lag by days |
| XFeeder | https://github.com/yhymid/XFeeder/commits/main.atom, `…/commits/Beta.atom` | Atom | commits |
| XFeeder | https://api.github.com/repos/yhymid/XFeeder/releases, `…/branches` | GitHub API (JSON) | read by XFeeder's GitHub adapter |
| Operator | https://github.com/yhymid/Operator/commits/discord.atom, `…/commits/telegram.atom` | Atom | commits |
| Operator | https://api.github.com/repos/yhymid/Operator/releases, `…/branches` | GitHub API | |
| Bladephoriafonk Website | https://github.com/yhymid/Bladephoriafonk-Website/commits/main.atom, `…/commits/rust-rewrite.atom` | Atom | commits |
| Bladephoriafonk Website | https://api.github.com/repos/yhymid/Bladephoriafonk-Website/releases, `…/branches` | GitHub API | |
| XCleaner | https://api.github.com/repos/yhymid/XCleaner/releases, `…/branches`, `…/commits?sha=main` | GitHub API | |
| Own issues and PRs | `https://api.github.com/user/issues?filter=all&state=all&sort=created` | GitHub API | needs `Auth.GitHubToken` |

The "pushed to … in yhymid/…" lines of the activity feed duplicate the commit feeds; the changelog channel drops them with an `Exclude` regex on `contentSnippet`.

## YouTube

| Channel | Feed |
|---|---|
| Yhym's | https://www.youtube.com/feeds/videos.xml?channel_id=UC7WEPIfJ1zs8cClnBWfQHoA |
| Olek47 | https://www.youtube.com/feeds/videos.xml?channel_id=UCee52-G-iJdJ_rmp1p0dh2w |
| kirvor1012 | https://www.youtube.com/feeds/videos.xml?channel_id=UCn9DZgFd3ms10NZI5aIlT9g |
| wasapiku | https://www.youtube.com/feeds/videos.xml?channel_id=UCj68f7cl5SyigARbeQplzOQ |

## Steam

Each game pairs the official store RSS with SteamDB's patch-notes RSS, and XFeeder's `SteamMerge` joins the two into one post. All AppIDs are in [games/steam.md](games/steam.md).

| Game | AppID | Feeds |
|---|---|---|
| Counter-Strike 2 | 730 | store RSS + SteamDB |
| Left 4 Dead 2 | 550 | store RSS + SteamDB |
| Deadlock | 1422450 | store RSS + SteamDB |
| Half-Life: Alyx, Half-Life 2, Half-Life | 546560, 220, 70 | store RSS + SteamDB (one channel) |
| Rust | 252490 | store RSS + SteamDB |
| s&box | 590830 | store RSS + SteamDB |
| Steam Deck | 1675200 | store RSS |
| Steam News | 593110 | store RSS |
| Steam group 39049601 | — | https://store.steampowered.com/feeds/news/group/39049601 (Valve's "RSS Feed" group: store features such as Next Fest) |

- **SteamDB is a community source**: `https://steamdb.info/api/PatchnotesRSS/?appid=<APPID>` (200 on 2026-11-23). It sees build changes that Valve never announces, but robots.txt `Disallow`s `/api/PatchnotesRSS/` and the SteamDB FAQ says the RSS is not meant for automatic monitoring. The same build data comes from Steam directly through anonymous SteamCMD/PICS; see [games/steam.md](games/steam.md#build-and-branch-changes-what-steamdbs-history-tab-shows).
- To split patches from news, the store events JSON can replace the store RSS without reposts (see [games/steam.md](games/steam.md)).
