# Feed quirks seen in real sources

[← Index](../README.md) · [Polski](feed-quirks.pl.md)

These are odd things found while checking real feeds on 2026-11-23. Each one can break a feed reader, so they are collected here in one place. Code fixes belong in XFeeder's own branches; this file only records how the sources behave.

## Formats

| Quirk | Seen in | What to do |
|---|---|---|
| Atom served as `Content-Type: text/html` | Unreal Engine RSS | detect the format from the body, not the header |
| RSS 1.0 / RDF (`<rdf:RDF>` root, items outside `<channel>`) | Slashdot, Debian News | look for `item` under `rdf:RDF` |
| Dates in `dc:date` instead of `pubDate` | RDF feeds | read `dc:date` |
| Non-standard time zone `Z` in an RFC 822 date | s&box RSS | accept `Z` as UTC |
| Date without a time zone | HoYoverse (`2026-11-04 07:00:00`), PoE forum | assume the publisher's zone (HoYo: UTC+8) |
| JS `Date.toString()` dates | Ubisoft (`Tue Nov 03 2026 10:30:00 GMT+0000 (…)`) | custom parse |
| ISO-8859-1 encoding | Jagex RSS | honour the XML encoding declaration |
| `dc` namespace without its trailing slash | Jagex RSS | match the namespace loosely |
| Titles wrapped in HTML (`&lt;p&gt;Title&lt;/p&gt;`) | Unreal Engine | strip tags from titles |
| Titles padded with spaces / newlines | ESO RSS, Steam RSS (`" Minor Update"`) | trim |
| Two `<link>`s, image first | FFXIV Lodestone Atom | use `rel="alternate"` |
| Relative links | Bungie (`/7/en/News/...`), Riot, Mojang images | resolve against the site |
| Protocol-relative image URLs (`//host/...`) | Blizzard, Microsoft | prefix `https:` |
| A JSON field that is itself a JSON string | Steam `jsondata`, HoYoverse `sExt` | parse twice; Steam `jsondata` is sometimes `[]`, not an object (59 of 1978 posts) |
| BBCode tags with attributes | Steam bodies: `[p align="start"]` (7072× in 1978 posts), `[url="…" style="…"]`, `[url= https://…]` (space after `=`), `[img src="…" style="…"]`, `[td colwidth="…"]`, `[color=#…]`, `[dynamiclink href="…"][/dynamiclink]` | match tags with optional attributes |
| Every body starts with `<?xml encoding="utf-8"?>` | blender.org RSS (`content:encoded`) | drop processing instructions before HTML → text |
| Hashed app-art paths | Steam `header.jpg` for newer apps | check the image; fall back to `library_hero.jpg`, then none |
| Lists not sorted by date (pinned items first) | HoYoverse, Kuro, Jagex | sort by date after parsing |
| One page = many entries, no per-entry link | ChatGPT / Claude apps release notes | use the date heading as the id |
| "Living" articles that get edited instead of new posts | Diablo IV patch notes, Call of Duty patchnotes | watch the edit time / a content hash |
| SteamCMD account login (steampics:// with Login) | SteamCMD on the VPS | checked 2026-11-27: Deadlock (1422450) gives depots and the public build only with an account that has it (21 depots, build 26966428); anonymous gives only `common`. With a Steam Guard mobile authenticator SteamCMD prints "Please confirm the login in the Steam Mobile app" and waits only ~68 s, then `ERROR (Timeout)`; three unattended password logins timed out. One interactive `steamcmd +login NAME +quit` in a real terminal (approved in the app) saved the session (`ConnectCache` in `~/.local/share/Steam/config/config.vdf`); later `+@NoPromptForPassword 1 +login NAME` works without prompts. |
| Guild Wars 2: no source has every update | forum RSS (Invision, Cloudflare), Steam 1284210, guildwars2.com/en/feed/, api.guildwars2.com/v2/build | checked 2026-11-26: the release-notes forum RSS has one topic per scheduled release and none of the hotfixes (11-11, 11-12, 11-16, 11-17, 11-24 exist only on the wiki); Steam 1284210's last 12 events are blog news (event_type 28), no patch notes; guildwars2.com/en/feed/ is WordPress news teasers; /v2/build only gives the build number (limit 300 burst, 5/s). The wiki's Special:Ask Atom feed (games/publishers.md) covers releases and hotfixes. |
| Line breaks are content in Steam post bodies | Steam events JSON `announcement_body.body` (BBCode) | Steam shows `\n` as a line break; many patch notes are one item per line with no `[list]` (Hades II `· …`, Marvel Rivals `- …`). Treated as HTML they collapse into one line. XFeeder keeps them since Beta e66c15e. |
| JSON entries with no link of their own | Mojang `javaPatchNotes.json` (424 entries) and `bedrockPatchNotes.json` (82) | identity must come from the entry's `id`, not the feed URL; the image is an object (`{title, url}`, path relative to the host); Bedrock dates are plain days and `shortText` starts with the title glued to the first sentence; minecraft.net article URLs cannot be derived from the title (6 of 9 guesses 404, 2026-11-26). XFeeder reads both since Beta 07c99af. |
| Several items share the same `<link>` | kernel.org `kdist.xml` | fall back to `guid` for identity |
| Enclosure that is audio, not an image | podcast feeds (NPR) | check `enclosure@type` before using it as an image |
| Category as an object (`domain` / `term` attribute) | GitHub Changelog, Atom feeds | filter on the category text |
| Noise entries in a releases feed | OpenClaw `releases.atom` (`release-publish/...`) | Include filter on the title |
| All links temporarily point at a CI preview host | Mesa news RSS on 2026-11-25: for a while 494 entries linked `mesa.pages.freedesktop.org/-/mesa3d.org/-/jobs/<job>/artifacts/…` instead of `www.mesa3d.org`, so link-based identity saw old releases as new and reposted them; the links are back to normal | identify by host-independent slug, or refuse old entries (by date) when a whole known feed turns new at once |
| Same entries under new links, guid unchanged | Onet Wiadomości on 2026-11-24: 21 entries got a new link format (`/1795482011830/4/...`) with the same guid and were posted again | identify by guid when it is unique; XFeeder 3.1 records a `guid:<g>` alias |

## Blocking and errors

| Behaviour | Where | What to do |
|---|---|---|
| HTTP 200 with an HTML error page | `steamcommunity.com/games/<numeric id>/rss` for vanity apps | check that the body is a feed |
| HTTP 200 with `Success:"0"` | NVIDIA driver API, nothing found | treat as "no data" |
| HTTP 200 with a bot-challenge page | Black Desert (Incapsula), gitlab.freedesktop.org (Anubis) | treat as blocked, use the fallback |
| Browser UA blocked, bot UA allowed | intel.com (home IP), Codeberg, fortnite.com | send an honest feed-reader UA |
| Bot UA stalls, browser UA allowed | amd.com (home IP) | per-host UA; datacenter IPs may behave differently, so test from the server |
| Datacenter IP blocked (403) | lowcygier.pl, boop.pl (anti-bot challenge) from the XFeeder VPS; both 200 from home | browser fallback on the server |
| Images blocked from a datacenter IP | blender.org `wp-content/uploads` images (403 from the VPS) | post without the image, or fetch it from home |
| Datacenter IP blocked with any UA | intel.com, en-forum.guildwars2.com (403 "Request not allowed from this Internet Service Provider") from the XFeeder VPS | browser fallback or another source (GW2: Steam 1284210) |
| Page missing its data block 1 time in 4 | amd.com | a missing block means "no data", never "removed" |
| 410 Gone after an API retirement | Artificial Analysis v2 data API | drop the source |
| Scraping forbidden by the site | steamdb.info (FAQ + 403 to non-browser clients; robots.txt `Disallow: /api/PatchnotesRSS/`) | take the data from Steam itself (anonymous SteamCMD `app_info_print`) |
| Login wall instead of a feed | Reddit `.rss` (404 / 429 / "Welcome to Reddit") | do not use without OAuth |
| Feed advertised in `<head>` but returns HTML | Star Citizen comm-link RSS | check the body |
| 308 / 301 / 307 redirect | WordPress `/rss` → `/feed/` (gry-wideo.pl, lowcygier.pl), Mesa news RSS (drops `www.`), Gemini blog RSS, Fall Guys and Rocket League news (`?lang=`) | follow it and store the new address |

## Polling politeness

| Source | Cache / limit | Sensible interval |
|---|---|---|
| Steam events JSON | `max-age=300`, `If-Modified-Since` → 304 | 10–15 min per game |
| Steam store RSS | `max-age=120` | 10–15 min |
| Steam Web API | 100,000 calls/day (Steam API terms) | — |
| Epic free games | CDN cached | 30 min |
| Game Pass lists | — | 6 h |
| NVIDIA / AMD / Intel | Akamai caches (AMD `max-age=900`) | 30–60 min |
| SteamDB PatchnotesRSS | `ttl` 3600, "heavily cached" | ≥ 60 min, or replace with SteamCMD/PICS |
| SteamCMD `app_info_print` (PICS) | one login per run; 8 apps in 8 s | 10–15 min, all apps in one run |
| GitHub `releases.atom` | 10 entries only | 15–30 min for busy repos |
