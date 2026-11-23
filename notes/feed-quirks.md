# Feed quirks seen in real sources

[← Index](../README.md)

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
| A JSON field that is itself a JSON string | Steam `jsondata`, HoYoverse `sExt` | parse twice |
| Lists not sorted by date (pinned items first) | HoYoverse, Kuro, Jagex | sort by date after parsing |
| One page = many entries, no per-entry link | ChatGPT / Claude apps release notes | use the date heading as the id |
| "Living" articles that get edited instead of new posts | Diablo IV patch notes, Call of Duty patchnotes | watch the edit time / a content hash |
| Several items share the same `<link>` | kernel.org `kdist.xml` | fall back to `guid` for identity |
| Enclosure that is audio, not an image | podcast feeds (NPR) | check `enclosure@type` before using it as an image |
| Category as an object (`domain` / `term` attribute) | GitHub Changelog, Atom feeds | filter on the category text |
| Noise entries in a releases feed | OpenClaw `releases.atom` (`release-publish/...`) | Include filter on the title |

## Blocking and errors

| Behaviour | Where | What to do |
|---|---|---|
| HTTP 200 with an HTML error page | `steamcommunity.com/games/<numeric id>/rss` for vanity apps | check that the body is a feed |
| HTTP 200 with `Success:"0"` | NVIDIA driver API, nothing found | treat as "no data" |
| HTTP 200 with a bot-challenge page | Black Desert (Incapsula), gitlab.freedesktop.org (Anubis) | treat as blocked, use the fallback |
| Browser UA blocked, bot UA allowed | intel.com (home IP), Codeberg, fortnite.com | send an honest feed-reader UA |
| Bot UA stalls, browser UA allowed | amd.com (home IP) | per-host UA; datacenter IPs may behave differently, so test from the server |
| Datacenter IP blocked with any UA | intel.com, en-forum.guildwars2.com (403 "Request not allowed from this Internet Service Provider") from the XFeeder VPS | browser fallback or another source (GW2: Steam 1284210) |
| Page missing its data block 1 time in 4 | amd.com | a missing block means "no data", never "removed" |
| 410 Gone after an API retirement | Artificial Analysis v2 data API | drop the source |
| Login wall instead of a feed | Reddit `.rss` (404 / 429 / "Welcome to Reddit") | do not use without OAuth |
| Feed advertised in `<head>` but returns HTML | Star Citizen comm-link RSS | check the body |
| 308 / 301 / 307 redirect | Mesa news RSS (drops `www.`), Gemini blog RSS, Fall Guys and Rocket League news (`?lang=`) | follow it and store the new address |

## Polling politeness

| Source | Cache / limit | Sensible interval |
|---|---|---|
| Steam events JSON | `max-age=300`, `If-Modified-Since` → 304 | 10–15 min per game |
| Steam store RSS | `max-age=120` | 10–15 min |
| Steam Web API | 100,000 calls/day (Steam API terms) | — |
| Epic free games | CDN cached | 30 min |
| Game Pass lists | — | 6 h |
| NVIDIA / AMD / Intel | Akamai caches (AMD `max-age=900`) | 30–60 min |
| GitHub `releases.atom` | 10 entries only | 15–30 min for busy repos |
