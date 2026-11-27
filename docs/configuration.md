# XFeeder configuration (`config.json`)

**English** · [Polski](configuration.pl.md)

This document has two parts:

- **Part 1: a guide in three levels.** Start at the easy level and go further only when
  you need something.
  - [Level 1: Easy](#level-1-easy-a-first-working-config): one feed to one Discord
    channel, 5 minutes.
  - [Level 2: Medium](#level-2-medium-several-channels-threads-filters-telegram): several
    channels, forum threads, filters, Telegram, diagnostics.
  - [Level 3: Hard](#level-3-hard-sites-that-block-bots-cloudflare): sites that block bots
    (Cloudflare and other protections).
- **Part 2: [every setting](#part-2-every-setting)**: what each key does, defaults and
  requirements.

A complete example file: [`config.json.example`](../config.json.example).

**How it works in short:**
- XFeeder checks **channels** every so often. A channel is a list of feeds (RSS, Atom,
  JSON Feed, YouTube, a plain page that links its feed) and where new entries go: a
  Discord webhook, Telegram or both.
- Every entry is sent to every destination **exactly once**. The history of sent entries
  is kept in `cache.json`.
- **Changes to `config.json` and `.env` are picked up on their own**, on the next round
  (about every 30 s). A restart is needed only for `Settings.Diagnostics` and after
  installing Scrapling.
- Key names are case-sensitive: `TimeChecker` works, `timechecker` does not.

---

# Part 1: guide

## Level 1: Easy (a first working config)

**Goal:** new entries from one feed reach one Discord channel.

**Step 1. Webhook.** In Discord: channel settings → *Integrations* → *Webhooks* →
*New Webhook* → *Copy Webhook URL*.

**Step 2. The `.env` file** (in the same folder as `config.json`):

```dotenv
DISCORD_WEBHOOK=https://discord.com/api/webhooks/123456/abcdef
```

**Step 3. The `config.json` file:**

```json
{
  "channels": {
    "news": {
      "Webhook": "${DISCORD_WEBHOOK}",
      "RSS": ["https://wiadomosci.onet.pl/.feed"],
      "FirstRunSend": 1
    }
  }
}
```

**Step 4. Check and start:**

```sh
./xfeeder --check-config      # must show "warnings": []
./xfeeder --dry-run --once    # fetches the feeds, posts nothing: shows whether the feed works
./xfeeder                     # the real run
```

### What each line means

| Line | Meaning |
|------|---------|
| `"channels": { … }` | A channel group. The name must start with `channels`. |
| `"news": { … }` | A channel named `news`. The name shows in the logs and the history of sent entries is kept under it, so the channel can be edited freely later. |
| `"Webhook": "${DISCORD_WEBHOOK}"` | Where to post. `${…}` takes the value from `.env`, so the webhook URL does not sit in the config. |
| `"RSS": [ … ]` | The list of feeds. There can be many. |
| `"FirstRunSend": 1` | On the first check, send the 1 newest entry so you can see right away that it works. Without it, the first check only remembers the existing entries and only new ones are sent. |

### What happens by default (no need to write it)

| Setting | Default | When to change it |
|---------|---------|-------------------|
| `TimeChecker` (how often to check, in minutes) | 30 | You want it faster: an entry waits half an interval on average, so with 30 min that is about 15 min of delay. |
| `RequestSend` (how many entries at once from one feed) | 5 | The feed publishes many at once and you want them all: raise it. |
| `FirstRunSend` | 0 | See above. |

**Most common problems at this level:**
- `missing delivery target`: the `${…}` variable does not exist in `.env`, or there is a typo.
- Nothing arrived: the first check only remembers entries. Set `FirstRunSend` or wait for
  a new entry.
- `--dry-run` shows 403: the site blocks bots, see [Level 3](#level-3-hard-sites-that-block-bots-cloudflare).

## Level 2: Medium (several channels, threads, filters, Telegram)

```json
{
  "Settings": {
    "MaxConcurrentChannels": 2,
    "FirstRunSend": 1,
    "Diagnostics": true
  },
  "ChannelDefaults": {
    "Webhook": "${DISCORD_WEBHOOK}",
    "TimeChecker": 15
  },
  "Telegram": {
    "BotToken": "${TELEGRAM_BOT_TOKEN}",
    "ChatID": "${TELEGRAM_CHAT_ID}",
    "Enabled": false
  },
  "channels": {
    "news": {
      "Thread": "1419684809055272960",
      "RSS": ["https://wiadomosci.onet.pl/.feed", "https://lowcygier.pl/rss"],
      "Filters": { "Exclude": ["sponsorowany"], "MaxAgeHours": 24 }
    },
    "cs2": {
      "Thread": "1424422020971499670",
      "RSS": [
        "https://store.steampowered.com/feeds/news/app/730",
        "https://steamdb.info/api/PatchnotesRSS/?appid=730"
      ],
      "TimeChecker": 60
    },
    "github": {
      "Thread": "1419683936510148810",
      "RSS": ["https://github.com/yhymid/XFeeder/commits/main.atom"],
      "Telegram": { "Enabled": true },
      "Filters": { "Exclude": ["/^Merge (pull request|branch)/"] }
    }
  }
}
```

### What to turn on so it works well

| What | Why |
|------|-----|
| **Named channels** (`"news": {…}` instead of a list `[…]`) | The history of sent entries depends only on the name, so changing the webhook, the thread or the feed list breaks nothing. In list channels `[…]` such a change starts the history over. |
| **`ChannelDefaults`** | You write the shared webhook and interval once; a channel can override them (`cs2` has 60 min). |
| **`Thread`** | The webhook writes into a thread or forum post instead of the channel itself. Thread ID: right-click the thread → *Copy ID* (turn on developer mode in Discord's settings). |
| **`MaxConcurrentChannels: 2`** | A slow channel (e.g. a site fetched through the browser) does not hold up the others. |
| **`Filters`** | Drop unwanted entries (`Exclude`) or let only matching ones through (`Include`). Details in [2.3](#23-filters-filtering-entries). |
| **`Telegram`** with `"Enabled": false` in the main section | **Important:** when the main section has a token and a chat but no `Enabled: false`, **every** channel posts to Telegram. Here Telegram is off globally and on only in `github`. |
| **`Diagnostics: true`** | A `diagnostics/summary-*.md` report every 15 minutes: how long the path from publication to Discord takes, which feeds are slow and which can be checked more often. Needs a restart. |

### How to choose `TimeChecker`

- The delay is **half the interval** on average: with 15 min an entry waits about 7 minutes.
- GitHub, Steam and SteamDB feeds usually answer "not modified" (304), so frequent checks
  cost almost nothing.
- SteamDB caches its answer for an hour: checking more often than every 60 min gains nothing.
- Rarely updated feeds (game patches, commits) can use 30–60 min; news 5–15 min.
- `Settings.AdaptivePolling` picks a shorter interval per feed automatically (see
  [4](#4-settings-general-settings)).
- The diagnostics report shows for each feed how often it publishes (`publishes every`)
  and suggests which one can be checked more often.

## Level 3: Hard (sites that block bots, Cloudflare)

Some sites reject programs that are not a browser. Most often it is Cloudflare (a "Just a
moment…" or "Verify you are human" page). XFeeder then gets a 403 error instead of the
feed. The solution: **Scrapling**, fetching with a real browser (Chromium) that passes
Cloudflare's check on its own.

### Step 1. Make sure the site really blocks

Check **from the server XFeeder runs on** (blocks often depend on the IP address):

```sh
curl -sI -A "Mozilla/5.0" https://boop.pl/rss | grep -iE "^HTTP|^server|^cf-mitigated"
```

| Result | Meaning |
|--------|---------|
| `HTTP/2 200` | The site does not block. The problem is elsewhere (wrong URL, not a feed). |
| `HTTP/2 403` + `cf-mitigated: challenge` | A Cloudflare challenge. Go on. |
| `HTTP/2 403` + `server: cloudflare`, no `cf-mitigated` | Cloudflare blocks (a firewall rule). A browser may help, but not necessarily. |
| `403` / `429` / `503` without Cloudflare | Another protection (DataDome, Akamai, Sucuri…) or a rate limit. |

In XFeeder's log this shows as a 403 or
`returned a challenge/block page; no entries this time`.

### Step 2. Install Scrapling (once)

In the folder with `config.json` (details in [`scrapling/README.md`](../scrapling/README.md)):

```bash
python3 -m venv scrapling/.venv
scrapling/.venv/bin/pip install --no-deps -r /path/to/repo/scrapling/requirements.lock.txt
scrapling/.venv/bin/python -m playwright install chromium
scrapling/.venv/bin/python -m patchright install chromium
```

Restart XFeeder. With `Logs` on, the log shows
`[Scrapling] Runtime available (scrapling 0.4.x)`.

### Step 3. The simplest setup: the browser only when needed

```json
"Scrapling": {
  "AutoFallback": false,
  "PerUrlConfig": {
    "https://boop.pl/rss": { "fallback": true, "mode": "stealthy-fetch" }
  }
}
```

The URL in `PerUrlConfig` must be **exactly the same** as in the channel.

What happens then:
1. XFeeder fetches the feed with a plain request (a fraction of a second).
2. When it gets 403/429/503 or a challenge page, it opens the browser in `stealthy-fetch`
   mode.
3. `stealthy-fetch` solves the Cloudflare challenge itself (`solveCloudflare` is on by
   default in this mode, and the timeout is raised to 60 s).

> **It also works without `PerUrlConfig`:** `AutoFallback` is `true` by default, so every
> blocked feed moves to the browser on its own. `AutoFallback: false` + `fallback` for
> specific URLs gives you control over where the browser is used (it is slow and uses a
> few hundred MB of RAM).

### Step 4. The site always blocks: the browser right away

When a plain request never gets through, there is no point trying it:

```json
"https://boop.pl/rss": { "enabled": true, "mode": "stealthy-fetch" }
```

| `PerUrlConfig` | Plain request | Browser | For which sites |
|----------------|---------------|---------|-----------------|
| `"fallback": true` | first | only when blocked | block sometimes, or stopped blocking |
| `"enabled": true` | never | always | always block |
| `"enabled": false` | always | never | never use the browser for this URL |

Measured in production: boop.pl through the browser takes about 26 s per check; gry-wideo.pl
stopped blocking, so with `fallback` it went from 10.5 s down to 0.3 s. With
`Scrapling.ReuseClearance: true` (temporary, see [9.2](#92-main-settings)) boop.pl takes
8–11 ms after the browser's first pass.

### Step 5. The browser gets through, but entries are missing or incomplete

The site loads its content with a delay. Add waiting:

```json
"https://gry-wideo.pl/rss": {
  "fallback": true,
  "mode": "stealthy-fetch",
  "wait": 8000,
  "networkIdle": true
}
```

| Option | When |
|--------|------|
| `"wait": 8000` | The content appears after a few seconds (time in ms). |
| `"networkIdle": true` | Wait until the page finishes loading data. |
| `"waitSelector": ".post"` | Wait for a specific element of the page. |
| `"timeoutMs": 90000` | A slow site or a long challenge: more time (ms). |

If the URL is a plain page and not a feed, add `htmlParseOptions` with CSS selectors for the
entries (see [9.5](#95-htmlparseoptions-a-page-without-a-feed)).

### Step 6. Still blocked: diagnosis

1. Turn on explanations in the log:
   ```json
   "Scrapling": { "AntiBot": { "LogDecisions": true }, "PerUrlConfig": { … } }
   ```
   The log then shows `Mode stealthy-fetch looks blocked for … score=…` and the reasons.
2. Try further options in `PerUrlConfig` (one at a time):
   - `"realChrome": true`: real Chrome instead of Chromium (must be installed);
   - `"locale": "pl-PL"`, `"extraHeaders": {"Accept-Language": "pl"}`: looks like a local
     user;
   - `"proxy": "http://user:password@host:port"`: a different IP address, when the site
     has blocked the server's IP.
3. An alternative: the external FlareSolverr or Byparr solver (usually in Docker), see
   [`Solver`](#10-solver-flaresolverr--byparr):
   ```json
   "Solver": { "Url": "http://127.0.0.1:8191", "Feeds": ["https://boop.pl/rss"] }
   ```

### Step 7. Performance with the browser

| Setting | Why |
|---------|-----|
| `"Settings": { "MaxConcurrentChannels": 2 }` | A channel waiting 30 s for the browser does not hold up the other channels. |
| `"network": { "maxConcurrentScraplingRequests": 1 }` | At most one browser at a time: less RAM on a small server. |
| `fallback` instead of `enabled` | The browser only when it is really needed. |
| Do not use `ForceGlobal: true` | The browser for every feed: dozens of times slower. |

**False alarms.** A healthy RSS/Atom feed is not scanned for texts like "captcha", so an
article about captchas does not trigger the browser. When some ordinary HTML page is wrongly
treated as a block, raise `AntiBot.MinConfidence` (default 40, range 0–100) for that URL in
`PerUrlConfig[…].antiBot`.

### Other advanced things

- A Discord channel as a source of entries: [section 6](#6-auth-and-a-discord-channel-as-a-source).
- GitHub issues, pull requests, releases and branches: [6.1](#61-the-github-api-as-a-source-authgithubtoken).
- A proxy for all requests: [section 7](#7-proxy).
- Bandwidth limits, timeouts, blocking private addresses: [section 8](#8-network-limits-and-timeouts).

---

# Part 2: every setting

Contents:

1. [Secrets and `.env`](#1-secrets-and-env)
2. [Channels](#2-channels)
3. [`ChannelDefaults`](#3-channeldefaults-shared-channel-settings)
4. [`Settings`](#4-settings-general-settings)
5. [`Telegram`](#5-telegram)
6. [`Auth` and a Discord channel as a source](#6-auth-and-a-discord-channel-as-a-source)
7. [`Proxy`](#7-proxy)
8. [`network`](#8-network-limits-and-timeouts)
9. [`Scrapling`](#9-scrapling-a-browser-for-sites-that-block-bots)
10. [`Solver`](#10-solver-flaresolverr--byparr)
11. [Commands and environment variables](#11-commands-and-environment-variables)
12. [Checking the config and common problems](#12-checking-the-config-and-common-problems)

## 1. Secrets and `.env`

A value that is entirely `"${NAME}"` is replaced with the variable `NAME`:

1. first from the process's environment variables,
2. then from the `.env` file **next to `config.json`**.

| In the config                           | Result                                     |
|-----------------------------------------|--------------------------------------------|
| `"Webhook": "${DISCORD_WEBHOOK}"`       | the value from `.env`                      |
| `"Webhook": "https://…/${TOKEN}"`       | **does not work**: only a whole value is replaced |
| `"${MISSING}"` (no such variable)       | empty text; `--check-config` reports it    |

Rules:
- Variable names: letters, digits and `_`, not starting with a digit.
- In `.env`, one variable per line: `NAME=value`. Quotes around the value are removed,
  lines starting with `#` are skipped.
- Keep webhooks and tokens in `.env`, not in `config.json`. Do not commit `.env` to git.

## 2. Channels

### 2.1 Channel groups: a list or names

Channels live in keys whose name starts with `channels` (`channels`, `channels2`,
`channelsNews`…). Each group can be a **list** or an **object with names**:

```json
{
  "channels": [
    { "Webhook": "${HOOK_A}", "RSS": ["https://a.example/feed"] },
    { "Webhook": "${HOOK_B}", "RSS": ["https://b.example/feed"] }
  ],
  "channelsNamed": {
    "news":  { "Webhook": "${HOOK_NEWS}",  "RSS": ["https://news.example/rss"] },
    "steam": { "Webhook": "${HOOK_STEAM}", "RSS": ["https://store.steampowered.com/feeds/news/app/730"] }
  }
}
```

| Kind of group       | Channel name in logs | History of sent entries (`cache.json`) |
|---------------------|----------------------|-----------------------------------------|
| list `[...]`        | `channels#1`, `channels#2`… | a key computed from the webhook, thread and feed list |
| object `{"name": …}` | `news`, `steam`     | the key `group:name`, fixed             |

> **Important:** in a list group, changing `Webhook`, `Thread` or the feed list gives the
> channel a new history key. Nothing is posted twice (the first-check rule applies, see
> `FirstRunSend`), but the old history is no longer used. In a named group the key depends
> only on the name, so the channel can be edited freely. A fixed key of your own can also be
> set with `ID` / `CacheKey` (see below); to add feeds to a list channel and keep its history,
> set `"CacheKey"` to its current key.

Shorthands: instead of an object, a channel can be just a URL or a list of URLs. Then all
other settings (e.g. `Webhook`) must come from [`ChannelDefaults`](#3-channeldefaults-shared-channel-settings):

```json
"channels": [
  "https://example.com/feed.xml",
  ["https://a.example/rss", "https://b.example/rss"]
]
```

### 2.2 Channel settings

| Setting        | Type                   | Default   | What it does |
|----------------|------------------------|-----------|--------------|
| `Label` | text | – | The name shown in logs and the dashboard, e.g. `"Changelog"`. Not part of the history key: it can be changed at any time. |
| `RSS` / `Feeds` / `URLs` / `Sources` | a list of URLs (or one URL) | – | The channel's feeds. The four names mean the same; if you use several, the lists are joined and duplicates removed. |
| `Webhook`      | text                   | –         | The Discord webhook entries go to. |
| `Thread`       | text or number         | –         | ID of the thread or forum post the webhook writes to (the thread must be in the webhook's channel). |
| `TimeChecker`  | number (minutes)       | `30`      | How often to check the channel. A value ≤ 0 or an invalid one = 30. |
| `RequestSend`  | number                 | `5`       | At most how many entries to send per check and per feed. The rest waits for the next check. |
| `FirstRunSend` | number ≥ 0             | from `Settings.FirstRunSend`, else `0` | How many of the newest entries to send when a feed is seen for the first time. The rest are only marked as seen. |
| `Filters`      | object                 | –         | Entry filter, see [2.3](#23-filters-filtering-entries). |
| `Ping`         | role ID or object      | –         | Mention a role, users or @everyone above Discord posts, see [2.4](#24-ping-mentions). |
| `Telegram`     | object                 | –         | Telegram settings for this channel, see [Telegram](#5-telegram). |
| `Discord`      | object                 | –         | A Discord channel as the **source** of entries, see [section 6](#6-auth-and-a-discord-channel-as-a-source). |
| `AdaptivePolling` | `false` / object    | from `Settings` | Per-feed interval for this channel, see [4](#4-settings-general-settings). |
| `ID` / `Key` / `CacheKey` | text        | –         | A fixed history key of your own for the channel (instead of the computed one). |

Channel requirements (checked by `--check-config`):
- at least one source: a feed (`RSS`…) or `Discord`;
- at least one destination: `Webhook` or a complete Telegram (`BotToken` and `ChatID`).

Which URLs work as a feed:

| Source | Example |
|--------|---------|
| RSS / Atom | `https://example.com/feed.xml` |
| JSON Feed / JSON API | `https://example.com/feed.json` |
| YouTube channel | `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` |
| GitHub commits | `https://github.com/user/repo/commits/main.atom` |
| GitHub issues, PRs, releases, branches | `https://api.github.com/repos/user/repo/releases`, see [6.1](#61-the-github-api-as-a-source-authgithubtoken) |
| A game's Steam news | `https://store.steampowered.com/feeds/news/app/730` |
| A game's Steam news, sorted into patches and news | `https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=730&count_before=0&count_after=10&lang_list=0`: same posts and ids as the RSS (history is kept per URL, so after switching, `FirstRunSend` keeps old posts from being sent again), but every entry gets the category `Patch`, `Major update`, `Beta`, `Release` or `News`, and broadcasts are left out. Patches only: `"Filters": { "Include": ["Patch", "Major update"], "Fields": ["categories"] }`. The images come from the post itself. Steam does not document this address; the RSS above is the way back. |
| Steam builds and branches, from Steam itself | `steampics://730`: a new `public` build (category `Build`, linked to SteamDB's patch notes page, the same link as SteamDB's RSS; history is kept per URL, so after switching `FirstRunSend` keeps old posts from being sent again), a branch added or removed (`Branch added` / `Branch removed`, e.g. CS2's `1.42.0.0`) and a new build on another branch (`Branch build`). Needs [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD) on the machine and no account: one anonymous run checks every `steampics://` URL of the config, at most every 10 minutes. The first run gives one entry, the current build, which the first check marks as seen (or sends with `FirstRunSend`). See `Settings.SteamPics` in [section 4](#4-settings-general-settings). Some games show anonymous Steam no depots (Deadlock, Risk of Rain 2, NARAKA on 2026-11-23); they give no entries, so keep SteamDB or the store feed for them. Use this instead of `steamdb.info/api/PatchnotesRSS/`, which SteamDB asks people not to poll. |
| A plain page | `https://example.com/blog`: XFeeder finds the feed given in `<link rel="alternate">`. Writing the feed URL directly is better, though: it saves one request. |

A complete channel:

```json
"channelsNamed": {
  "cs2": {
    "Webhook": "${DISCORD_WEBHOOK_GAMES}",
    "Thread": "1424422020971499670",
    "RSS": [
      "https://store.steampowered.com/feeds/news/app/730",
      "https://steamdb.info/api/PatchnotesRSS/?appid=730"
    ],
    "TimeChecker": 15,
    "RequestSend": 3,
    "FirstRunSend": 1,
    "Filters": { "Exclude": ["sale", "/\\bdiscount\\b/"] }
  }
}
```

### 2.3 `Filters`: filtering entries

| Setting         | Type             | Default   | What it does |
|-----------------|------------------|-----------|--------------|
| `Include`       | list of patterns | –         | An entry passes when it matches **at least one** pattern. An empty list = everything passes. |
| `Exclude`       | list of patterns | –         | An entry matching any pattern is skipped. |
| `Fields`        | list of fields   | `title`, `contentSnippet`, `categories` | Where to look. Available: `title`, `contentSnippet`, `content`, `categories`, `author`, `link`, `guid`. |
| `CaseSensitive` | `true` / `false` | `false`   | Whether letter case matters. |
| `MaxAgeHours`   | number           | –         | Skips entries older than this many hours. Entries without a date are not dropped. |

A pattern is plain text or a regular expression written as `/…/`. In JSON the backslash
must be doubled: `"/\\bv\\d+\\.\\d+/"` means the regex `\bv\d+\.\d+`.
Each field value is checked on its own (the title, the text, every category), so `^` and
`$` anchor to one value: `"/^Build$/"` matches the category `Build`, not `Branch build`.

Examples:

```json
"Filters": { "Include": ["patch notes", "update"] }
```
Only entries with "patch notes" or "update" in the title, description or categories.

```json
"Filters": { "Exclude": ["sponsored", "/promotion[s]?/"], "MaxAgeHours": 48 }
```
No sponsored entries or promotions, only from the last 2 days.

```json
"Filters": { "Include": ["/\\bv\\d+\\.\\d+/"], "Fields": ["title"], "CaseSensitive": true }
```
Only entries with a version number (e.g. `v1.2`) in the title.

### 2.4 `Ping`: mentions

Mentions a role, users or `@everyone` in a line above the Discord post, so people get a
notification. Telegram posts are not affected.

```json
"Ping": "123456789012345678"
```

The short form is a role ID (or a list of them) and pings on every post of the channel.
The full form limits which posts ping:

```json
"Ping": {
  "Roles": ["123456789012345678"],
  "Users": [],
  "Everyone": false,
  "Feeds": ["/releases"],
  "Include": ["/^v?\\d+\\.\\d+/"],
  "Text": "🔔 New release"
}
```

| Setting | What it does |
|---|---|
| `Roles`, `Users` | Discord IDs (right click → *Copy ID* with Developer Mode on). `<@&ID>` / `<@ID>` also work. |
| `Everyone` | `true` pings `@everyone`. The webhook needs the *Mention @everyone* permission. |
| `Feeds` | Only entries of feeds whose URL contains one of these texts. Empty = all feeds. |
| `Include` | Only entries matching a pattern, as in [`Filters.Include`](#23-filters-filtering-entries) (`Fields`, `CaseSensitive` work too). |
| `Text` | Text before the mentions. |

A role is pinged only when it is *mentionable* (Server settings → Roles) or the webhook may
mention everyone. Only the mentions set here notify anyone: `@everyone`, `<@&…>` or
`<@…>` written in a feed entry are shown as text and never ping. Edits (`xfeeder rerender`,
`SteamMerge`) never ping again. `--dry-run` shows `(ping …)` next to entries that would ping.

Steam builds (`steampics://`) have the kind of change as their first category: `Build`
(new public build), `Branch build`, `Branch added`, `Branch removed`, `Changelist`. To ping
only for a new public build of Counter-Strike 2:

```json
"Ping": {
  "Roles": ["123456789012345678"],
  "Feeds": ["steampics://730"],
  "Include": ["/^Build$/"],
  "Fields": ["categories"],
  "CaseSensitive": true
}
```

`Feeds` compares text, so `steampics://730` would also match `steampics://7300`; list such
feeds in another channel or use `Include` to tell them apart.

## 3. `ChannelDefaults`: shared channel settings

Settings written in `ChannelDefaults` (formerly `DefaultChannel`) go to every channel.
What the channel itself says takes precedence. The `Telegram` and `Discord` objects are
merged field by field.

```json
"ChannelDefaults": {
  "Webhook": "${DISCORD_WEBHOOK}",
  "TimeChecker": 30,
  "RequestSend": 5,
  "Filters": { "Exclude": ["sponsored"] }
},
"channels": [
  { "RSS": ["https://a.example/feed"] },
  { "RSS": ["https://b.example/feed"], "TimeChecker": 10 }
]
```

Both channels post to the same webhook. The first is checked every 30 minutes, the second
every 10.

## 4. `Settings`: general settings

| Setting                 | Type             | Default   | What it does |
|-------------------------|------------------|-----------|--------------|
| `Logs`                  | `true` / `false` | `false`   | Also writes ordinary information to the log (stdout / `journalctl`), e.g. every send. Warnings and errors are always written. |
| `DebugExpert`           | `true` / `false` | `false`   | Detailed technical events (`[Expert] {...}`) in the log. For hunting bugs; a lot of text. |
| `MaxConcurrentChannels` | number 1–8       | `1`       | How many channels can be checked at once. `2` is enough for a slow channel (e.g. a site through the browser) not to hold up the rest. |
| `AdaptivePolling` | `false` / `true` / object | `false` | A separate interval for each feed, computed from the dates of its entries. After a fresh entry (younger than `BurstHours`, default 6) the feed is checked every `MinMinutes` (5); otherwise every average gap between the latest entries / `Divisor` (8). Always between `MinMinutes` and the channel's `TimeChecker`, so **no feed is checked less often than without this option** (a game updated once in six months stays at `TimeChecker`). Example: `{ "MinMinutes": 5, "BurstHours": 6, "Divisor": 8 }`. A channel (or `ChannelDefaults`) can have its own object or `"AdaptivePolling": false`. `false` = the previous scheduler. `xfeeder preview <URL>` shows which interval a feed would get. |
| `SteamMerge` | `false` / `true` / object | `false` | One post per game update. Whatever comes first (a SteamDB build or a Steam announcement) is posted right away. When the other one arrives within `WindowHours` (12) for the same game in the same channel, the first post is **edited**: the announcement's title, notes and picture plus a build line and a SteamDB button. Every build without an announcement stays its own post; an announcement joins the newest build that does not have one yet. Only announcements that look like an update join (update, patch, hotfix, version… or a title already named by SteamDB), so events and sales stay separate. When the edit fails, the entry is posted normally. Example: `{ "WindowHours": 12 }`. `false` = every entry separately, as before. Needs `sent.json`, so it works for posts sent since the version with `xfeeder rerender`. |
| `PostText` | `true` / `false` / object | `{ "Length": 1500 }` | Discord post text for RSS, Atom and Steam events: up to `Length` characters (300–3500) of the entry, cut at the end of a line, with headings in bold, links with their own text as `[text](url)` and a line that is only a Steam store or YouTube URL as a short named link. `false` (or `"Enabled": false`) = the previous text: the first ~500 characters, at most 800, plain. Telegram and delivery history are not affected. |
| `SteamPics` | object | see right | Settings of `steampics://` sources: `Command` (SteamCMD; default `/usr/games/steamcmd` when it exists, else `steamcmd`), `MinIntervalMinutes` (10; one run covers all apps), `TimeoutSeconds` (180; the first run of the day updates SteamCMD itself), `IgnoreBranches` (regex, `^dprp?$` = Valve's internal branches; `""` = none), `RawLog` (`true`: every change of an app, noise included, goes to `steam_pics.changes.jsonl` next to `cache.json`; it rotates at 20 MB), `Changelists` (`false`; `true` also posts every change number without a build or branch change, category `Changelist`), `Login` and `Password` (optional, `"${STEAMCMD_LOGIN}"` and `"${STEAMCMD_PASSWORD}"` with both in `.env`): a Steam account instead of anonymous, for games whose depots anonymous Steam hides, like Deadlock; the account must own or have access to the game. Runs use SteamCMD's saved session; only when there is none (first run, expired) the password is used, from a 0600 temporary script, never on the command line or in logs. Steam may then ask to approve the login in the Steam Mobile app: the log says so; SteamCMD itself waits only about a minute (`ERROR (Timeout)` after ~68 s, seen 2026-11-26), so approve it right away. If the login fails (wrong password, not approved in time, a code by e-mail), a warning is logged and anonymous is used for 6 hours, also across restarts, so Steam is not asked again and again; a network error or rate limit never sends the password. The dashboard never shows or changes `STEAMCMD_PASSWORD`. Without `Password`, log in once by hand (`steamcmd +login NAME`). A game read for the first time in the other mode is compared from that run on, so switching posts nothing. A separate Steam account for the bot is safer than your own. `Live` (`false`; only in builds with `cargo build --features live-pics`, not in release packages yet): an anonymous Steam connection asks every ~10 s which apps changed and, when a configured one did, runs SteamCMD and checks its channels at once instead of waiting for `MinIntervalMinutes`; at most every `LiveMinSeconds` (120). SteamCMD still reads and compares the data, so posts are the same as without it, only sooner; when the connection drops it reconnects and continues from the last change number, so changes in between are not missed; turning `Live` off and on again works without a restart; the normal interval keeps working. The state lives in `steam_pics.json`. |
| `FirstRunSend`          | number ≥ 0       | `0`       | The default `FirstRunSend` for channels (see [2.2](#22-channel-settings)). `0` = for a new feed send nothing, only remember the current entries. |
| `Diagnostics`           | `true` or object | off       | The diagnostics recorder, see below. **Needs a restart.** |

### `Settings.Diagnostics`

Writes every event and every log line (without tokens and webhook URLs) to
`diagnostics/events-YYYY-MM-DD.txt`, and every few minutes creates the report
`diagnostics/summary-YYYY-MM-DD.md`. The report shows the delay from publication to
Discord, the slowest feeds and hints on what to speed up.

| Setting          | Default         | What it does |
|------------------|-----------------|--------------|
| `Enabled`        | `true`          | Turns the recorder on (when the section exists). |
| `Dir`            | `diagnostics`   | Folder for the files (relative = next to `config.json`). |
| `SummaryMinutes` | `15`            | How often to refresh the report, in minutes (1–1440). |
| `RetentionDays`  | `14`            | How many days to keep the files (1–365). Older ones are deleted. |
| `MaxFileMB`      | `256`           | Maximum size of the event file per day. Beyond it, events are only counted in the report. |

```json
"Settings": {
  "Logs": false,
  "MaxConcurrentChannels": 2,
  "FirstRunSend": 1,
  "Diagnostics": { "Enabled": true, "RetentionDays": 30, "MaxFileMB": 512, "SummaryMinutes": 15 }
}
```

Shorter: `"Diagnostics": true` (all defaults). In production with 10 channels it takes
about 3 MB a day.

## 5. `Telegram`

The `Telegram` section in the main config holds the shared settings. A channel can complete
or override them with its own `Telegram` object.

> **Note:** if the main section has `BotToken` and `ChatID`, **every channel** also posts to
> Telegram. To keep a channel from doing so, give it `"Telegram": { "Enabled": false }`.

| Setting                 | Type             | Default   | What it does |
|-------------------------|------------------|-----------|--------------|
| `Enabled`               | `true` / `false` | `true`    | Turns Telegram on. |
| `BotToken`              | text             | –         | The bot token from @BotFather. **Required.** |
| `ChatID`                | text / number    | –         | Chat ID (`-100…` for groups and channels) or `@channel_name`. **Required.** |
| `MessageThreadID`       | number / `null`  | –         | Topic (thread) ID in a group with topics. |
| `DisableWebPagePreview` | `true` / `false` | `false`   | Turns off the link preview under the message. |
| `SendPhoto`             | `true` / `false` | `true`    | An entry with an image is sent as a photo with a caption (up to 1024 characters). When Telegram rejects the image, a plain message is sent. |
| `TimeoutMs`             | number (ms)      | `15000`   | Timeout of one request to Telegram. |

An empty `BotToken` or `ChatID` in a channel (`""`) means "use the value from the main
section".

```json
"Telegram": {
  "BotToken": "${TELEGRAM_BOT_TOKEN}",
  "ChatID": "${TELEGRAM_CHAT_ID}"
},
"channels2": {
  "dev": {
    "Webhook": "${DISCORD_WEBHOOK_DEV}",
    "Telegram": { "ChatID": "${TELEGRAM_CHAT_ID_DEV}", "MessageThreadID": 12 },
    "RSS": ["https://github.com/user/repo/commits/main.atom"]
  },
  "discordOnly": {
    "Webhook": "${DISCORD_WEBHOOK_MAIN}",
    "Telegram": { "Enabled": false },
    "RSS": ["https://example.com/feed"]
  }
}
```

## 6. `Auth` and a Discord channel as a source

A channel can read messages from a Discord channel (instead of a feed) and pass them on to a
webhook or Telegram. Reading needs a Discord **user account token**.

> Using a user account token from a program is against Discord's Terms of Service and can
> get the account banned. Use at your own risk.

`Auth` holds the shared login data for all source channels:

| Setting              | What it does |
|----------------------|--------------|
| `Token`              | The user account token. Required (here or in the channel's `Discord.Token`). |
| `x-super-properties` | Discord's browser header (optional; looks more like an ordinary client). |
| `cookie`             | Browser cookies (optional). |
| `GitHubToken`        | Token for the GitHub API, see [6.1](#61-the-github-api-as-a-source-authgithubtoken). |

The `Discord` object in a channel:

| Setting                         | Default   | What it does |
|---------------------------------|-----------|--------------|
| `ChannelIDs` (list) or `ChannelID` | –      | The Discord channels to read. **Required.** This is not the server ID. |
| `GuildID`                       | –         | The server ID (for links to messages). |
| `Limit`                         | `50`      | How many recent messages to fetch from each channel. |
| `Timeout`                       | `15000`   | Request timeout (ms). |
| `Webhook`, `Thread`             | from the channel | A different destination just for messages from Discord. |
| `Token`, `cookie`, `x-super-properties` | from `Auth` | Override the login data for this channel. |

```json
"Auth": { "Token": "${DISCORD_AUTH_TOKEN}" },
"channels3": {
  "announcements": {
    "Webhook": "${DISCORD_WEBHOOK_MAIN}",
    "Discord": { "GuildID": "1008460463148900373", "ChannelIDs": ["1405113384818708500"], "Limit": 20 }
  }
}
```

### 6.1 The GitHub API as a source (`Auth.GitHubToken`)

The Atom feeds on github.com give the commits of one branch (and they are current), but the
account activity feed (`github.com/LOGIN.atom`) takes its data from GitHub's "events", which
can be **several days behind**. The GitHub API gives, without delay, what the feeds lack. You
write the API URL like any feed:

| URL | What it posts |
|-----|---------------|
| `https://api.github.com/repos/OWNER/REPO/commits?sha=BRANCH` | commits (also from private repos) |
| `https://api.github.com/repos/OWNER/REPO/issues?state=all&sort=created` | issues and pull requests |
| `https://api.github.com/user/issues?filter=all&state=all&sort=created` | issues and PRs from all your repos (needs a token) |
| `https://api.github.com/repos/OWNER/REPO/pulls?state=all&sort=created&direction=desc` | pull requests only |
| `https://api.github.com/repos/OWNER/REPO/releases` | releases (drafts skipped) |
| `https://api.github.com/repos/OWNER/REPO/branches` | new branches |
| `https://api.github.com/repos/OWNER/REPO/tags` | new tags |

```json
"Auth": { "GitHubToken": "${GITHUB_TOKEN}" }
```

The token (in `.env`: `GITHUB_TOKEN=...`) is sent **only** to api.github.com. It gives a limit
of 5000 requests per hour instead of 60 and access to private repos. XFeeder only reads
(GET), so a fine-grained token with *Read-only* permissions (Contents, Issues, Pull
requests, Metadata) is enough. Unchanged answers (HTTP 304) do not use up the limit. The
token is masked in logs. Without a token, public repos also work, within 60 requests/h.

Do not add API commits for a branch that already has an Atom commit feed in the same
channel: history is kept per feed URL, so the same commit would be posted twice.

## 7. `Proxy`

| Setting   | Default   | What it does |
|-----------|-----------|--------------|
| `Enabled` | `false`   | Routes all of XFeeder's HTTP requests through a proxy. |
| `Url`     | –         | HTTP proxy address: `http://host:port` or `https://host:port`, also with `user:password@`. SOCKS is not supported. |

```json
"Proxy": { "Enabled": true, "Url": "http://127.0.0.1:8080" }
```

The Scrapling browser has its own setting: `proxy` in the Scrapling options.

## 8. `network`: limits and timeouts

The section is optional and the defaults suit a server. An unknown key or an out-of-range
value is a config **error**, reported by `--check-config`.

| Setting | Default | Range | What it does |
|---------|---------|-------|--------------|
| `bandwidthProfile` | `unlimited` | `potato`, `low`, `medium`, `high`, `very-high`, `unlimited`, `custom` | Download limit: potato 10 kbit/s, low 2 Mbit/s, medium 10, high 50, very-high 100 Mbit/s. |
| `downloadLimitMbps` | – | > 0 | Download limit in Mbit/s. Only with `custom`. |
| `uploadLimitMbps` | – | > 0 | Upload limit in Mbit/s. Only with `custom`. |
| `networkFriendlyMode` | `false` | – | Frugal mode: by default at most 2 HTTP requests and 1 browser at a time. |
| `maxConcurrentRequests` | no limit | 1–10000 | How many HTTP requests at once. |
| `maxConcurrentScraplingRequests` | no limit | 1–10000 | How many browser fetches at once. |
| `scraplingResourceSaving` | `true` | – | The browser does not load images or fonts (does not apply to solving Cloudflare). |
| `setupTimeoutMs` | `15000` | 0–… | Connection setup timeout. |
| `idleTimeoutMs` | `15000` | 0–… | How long silence may last during a download. |
| `requestDeadlineMs` | 120000 | 1–… | A hard time limit for a whole request, retries included. |
| `shutdownGraceMs` | `5000` | 0–60000 | How much time running tasks get when shutting down. |
| `outboundPolicy` | `unrestricted` | `unrestricted`, `public-only` | `public-only` blocks private and local addresses (e.g. `127.0.0.1`, `192.168.…`) and disables Scrapling. |
| `maxResponseBytes` | 16777216 (16 MiB) | 1–268435456 | Maximum response size after decompression. |

```json
"network": { "networkFriendlyMode": true, "requestDeadlineMs": 60000 }
```

## 9. `Scrapling`: a browser for sites that block bots

Some sites (e.g. behind Cloudflare) reject ordinary requests. Scrapling fetches them with a
real browser (Chromium). It **needs** Python and Scrapling installed in `scrapling/.venv`
(instructions in [`scrapling/README.md`](../scrapling/README.md)). The browser is much
slower (10–30 s per page instead of a fraction of a second) and uses a few hundred MB of RAM,
so use it only where it is necessary.

### 9.1 When XFeeder uses the browser

| Setting | Effect |
|---------|--------|
| `Enabled: false` | Never. |
| `PerUrlConfig["url"].enabled: true` | Always for this URL. |
| `PerUrlConfig["url"].fallback: true` | For this URL a plain request first; the browser only when the site blocks. **Recommended.** |
| `AutoFallback: true` | Like `fallback`, but for **all** feeds. |
| `ForceGlobal: true` | Always for all feeds (very slow). |
| `PerUrlConfig["url"].enabled: false` | Never for this URL, despite the global settings. |

"The site blocked" means a code from `FallbackStatusCodes` (default 403, 429, 503) or a
detected anti-bot page (see `AntiBot`).

A production example: boop.pl always blocks, while gry-wideo.pl works without the browser
(0.3 s instead of 10.5 s) but keeps the browser in reserve:

```json
"Scrapling": {
  "Enabled": true,
  "AutoFallback": false,
  "PerUrlConfig": {
    "https://boop.pl/rss": { "enabled": true, "mode": "stealthy-fetch" },
    "https://gry-wideo.pl/rss": { "fallback": true, "mode": "stealthy-fetch", "wait": 8000, "networkIdle": true }
  }
}
```

### 9.2 Main settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `Enabled` | `true` | Turns Scrapling on (works only when installed in `scrapling/.venv`). |
| `AutoFallback` | `true` | The browser for every blocked feed. |
| `ForceGlobal` | `false` | The browser for every feed. |
| `FallbackStatusCodes` | `[403, 429, 503]` | HTTP codes that mean a block. |
| `ReuseClearance` | `false` | **Temporary, can be turned off.** After the browser passes Cloudflare, keeps the site's cookies (`cf_clearance`) and the browser's User-Agent in `clearance.json` (next to `config.json`, mode 0600, not committed to git). Later checks of that site go through plain HTTP with that cookie first (boop.pl: 8–11 ms instead of 26 s). When the site rejects it, the entry is dropped and the browser works as before. `false` or absent = the previous system; `clearance.json` can then be deleted. |
| `AntiBot` | – | Recognising anti-bot pages, see 9.4. |
| `DefaultOptions` | – | Fetch options for all URLs, see 9.3. |
| `PerUrlConfig` | – | Settings for specific URLs (the URL must be **identical** to the one in the channel). The same options as `DefaultOptions` plus `enabled`, `fallback`, `antiBot`, `htmlParseOptions`. |

### 9.3 Fetch options (`DefaultOptions` and `PerUrlConfig`)

Modes (`mode`):

| Mode | What it does | Speed |
|------|--------------|-------|
| `get` | An HTTP request pretending to be a browser, without starting a browser. | fast |
| `fetch` | A browser. | slow |
| `stealthy-fetch` | A browser that hides automation; solves Cloudflare by default. | slowest, most effective |

If a mode fails, the next ones from `AntiBot.ModeOrder` are tried (at most `MaxAttempts`).

The main browser options (`fetch`, `stealthy-fetch`):

| Option | Default | What it does |
|--------|---------|--------------|
| `solveCloudflare` | `true` in `stealthy-fetch` | Solves the Cloudflare challenge (Turnstile). Raises the timeout to at least 60 s. |
| `timeoutMs` | `30000` | Page load timeout. |
| `wait` | `0` | How many ms to wait after loading (e.g. `8000` when the content appears late). |
| `networkIdle` | `false` | Wait until the page stops loading data. |
| `waitSelector` | – | Wait for a CSS element, e.g. `".content-ready"`. |
| `headless` | `true` | A browser without a window. |
| `disableResources` | depends on `scraplingResourceSaving` | Do not load images, fonts and similar resources (faster, but may break Cloudflare). |
| `blockAds` | `false` | Block ads. |
| `blockWebrtc`, `hideCanvas`, `allowWebgl` | – | Extra hiding of the browser fingerprint. |
| `realChrome` | `false` | Use the installed Chrome instead of Chromium. |
| `locale` | – | Browser language, e.g. `"pl-PL"`. |
| `proxy` | – | A proxy for the browser. |
| `extraHeaders` | – | Extra headers, e.g. `{"Accept-Language": "pl"}`. |
| `cookies` | – | Starting cookies. |
| `dnsOverHttps` | `false` | DNS over HTTPS. |
| `maxPages` | – | How many tabs a browser session can have. |

`get` mode options: `headers`, `timeoutSeconds` (default 30), `followRedirects` (`true`),
`verify` (`true`), `impersonate` (e.g. `"chrome"`), `stealthyHeaders` (`true`), `proxy`.

### 9.4 `AntiBot`: recognising blocking pages

Can be set globally (`Scrapling.AntiBot`) or per URL (`PerUrlConfig[…].antiBot`).

| Setting | Default | What it does |
|---------|---------|--------------|
| `Enabled` | `true` | Anti-bot page detection. |
| `StatusCodes` | `[403, 429, 503]` | Codes treated as a block. |
| `HeaderKeys` | – | Headers that give the protection away (e.g. `cf-mitigated`). |
| `BodySignatures` / `TitleSignatures` | – | Texts in the body / title of a challenge page (e.g. "just a moment"). |
| `TreatCloudflareAsSignal` | `true` | An answer from a Cloudflare server counts as a block signal. |
| `MinBodyBytes` | `0` | A suspiciously small answer (with other signals) = a block. |
| `MinConfidence` | `40` | Confidence threshold (0–100) from which a page counts as a block. |
| `PreferStealthOnSignals` | `true` | When a block is detected, start with `stealthy-fetch`. |
| `ModeOrder` | `["get", "fetch", "stealthy-fetch"]` | Order of modes for successive attempts. |
| `MaxAttempts` | `3` | At most how many modes to try. |
| `LogDecisions` | `false` | Write to the log why a page was treated as blocked. |

### 9.5 `htmlParseOptions`: a page without a feed

When the browser returns an ordinary HTML page, entries are cut out of it with CSS
selectors:

| Option | Default |
|--------|---------|
| `itemSelector` | `article, .post, .entry, li` |
| `titleSelector` | `h1, h2, h3, .title, .entry-title` |
| `linkSelector` | `a[href]` |
| `dateSelector` | `time[datetime], time, .date, .published` |
| `authorSelector` | `.author, [rel='author']` |

```json
"PerUrlConfig": {
  "https://example.com/news": {
    "enabled": true,
    "mode": "fetch",
    "htmlParseOptions": { "itemSelector": ".news-item", "titleSelector": "h3", "linkSelector": "a.more" }
  }
}
```

## 10. `Solver`: FlareSolverr / Byparr

An alternative to Scrapling: an external service with the FlareSolverr API (FlareSolverr,
Byparr, TRAWL), run separately (usually in Docker).

| Setting | Default | What it does |
|---------|---------|--------------|
| `Enabled` | `true` (when the section exists) | Turns the solver on. |
| `Url` | – | The service address, e.g. `http://127.0.0.1:8191`. **Required.** |
| `Feeds` | – | Feeds always fetched through the solver. |
| `Auto` | `false` | Other feeds go through the solver when a plain request is blocked. |
| `OnStatus` | `[403, 503]` | HTTP codes that trigger `Auto`. |
| `MaxTimeoutMs` | `60000` | How long the solver may work on one page. |

```json
"Solver": { "Url": "http://127.0.0.1:8191", "Feeds": ["https://boop.pl/rss"], "Auto": false }
```

## 11. Commands and environment variables

```
xfeeder [run] [--dry-run] [--once] [--check-config] [--debug-expert]
              [--config PATH] [--cache PATH]
xfeeder dashboard [--data-dir FOLDER]
xfeeder preview <URL>... [--profile NAME] [--items N] [--bench N] [--json]
xfeeder rerender [--channel NAME] [--hours N] [--limit N] [--apply]
xfeeder --version | --help
```

| Option | What it does |
|--------|--------------|
| `--check-config` | Loads and checks the config, prints the number of channels and the warnings, exits. |
| `--dry-run` | Fetches everything and shows what it would send; sends and saves nothing. |
| `--once` | One round of all channels, then exit. **Really sends**, unless combined with `--dry-run`. |
| `--debug-expert` | Detailed technical events in the log (secrets hidden). |
| `--config`, `--cache` | Another location of `config.json` and `cache.json` (default: the current folder). |
| `preview <URL>` | Shows what XFeeder reads from a feed (title, author, date, image, link, text) and how long the download, parsing and image check take. Sends and saves nothing; uses Scrapling, the solver and the proxy from `config.json`. `--bench 10` measures 10 times (min/median/p95/max), `--profile news` checks all feeds of a profile, `--json` gives output for scripts. |
| `rerender` | Rebuilds Discord posts already sent in the current layout, by editing the messages through their webhook (sends nothing new). Uses `sent.json` (next to `cache.json`, written since this version: message ID and entry content, no webhook URLs), so older posts stay as they are. Without `--apply` it only lists what it would change. `--channel channels11#11` limits it to a channel, `--hours 24` to the last hours, `--limit` (50) to the newest posts. |
| `dashboard --data-dir` | Starts the web dashboard for a folder with `config.json`. Default `http://127.0.0.1:3000`. English or Polish: the EN · PL switch in the top right corner (remembered in a cookie). It controls only a worker it started itself; a systemd worker is handled with `systemctl`. All pages: [dashboard guide](dashboard.md). |

```sh
XFEEDER_DASHBOARD_PASSWORD='a-strong-password' ./xfeeder dashboard --data-dir /opt/xfeeder
```

Variables can be set in the system or in `.env`.

| Variable | What it does |
|----------|--------------|
| `XFEEDER_DRY_RUN=1` | Fetches everything but sends and saves nothing (a test). |
| `XFEEDER_RUN_ONCE=1` | One round of all channels, then exit. |
| `XFEEDER_DEBUG_EXPERT=1` | Like `Settings.DebugExpert`. |
| `XFEEDER_DIAGNOSTICS=1` | Turns diagnostics on (like `Settings.Diagnostics: true`). |
| `XFEEDER_DASHBOARD_PASSWORD` | Dashboard password. **Required** when the dashboard listens beyond `127.0.0.1`. |
| `XFEEDER_DASHBOARD_HOST` / `_PORT` | Dashboard address and port (default `127.0.0.1:3000`). |
| `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` | The dashboard's public address behind a reverse proxy, e.g. `https://feeds.example.com`. |
| `XFEEDER_DASHBOARD_WORKER_CONTROL` | `off` = no Start/Stop/Restart in the dashboard (the worker runs as its own service or container). See [dashboard.md](dashboard.md). |
| `XFEEDER_DASHBOARD_SESSION_TTL_HOURS` | How long a login lasts (default 12 h). |
| `XFEEDER_SERVICE_UNIT` | systemd unit whose journal the dashboard's Logs page shows (default `xfeeder`). |

## 12. Checking the config and common problems

Before starting:

```sh
./xfeeder --check-config            # errors and warnings, number of channels
./xfeeder --dry-run --once          # a full round without sending
```

| Message / symptom | Cause and fix |
|-------------------|---------------|
| `missing delivery target` | The channel has neither `Webhook` nor a complete Telegram. Also check that the `${…}` variable exists in `.env`. |
| `missing feed sources or Discord source` | The channel has no `RSS`/`Feeds`/… and no `Discord`. |
| `Telegram is enabled but BotToken or ChatID is missing` | Fill in both fields or set `Telegram.Enabled: false`. |
| `cache key collision` | Two channels in a list group are identical. Give one of them an `ID`, or use a named group. |
| `Unsupported configuration section` | An unknown section (e.g. a typo in the name or the old `Matrix`). Nothing in it is executed. |
| A new channel sent nothing | That is intended: the first check only remembers entries. Set `FirstRunSend` if you want the last few right away. |
| A feed returns 403 | The site blocks bots: add it to `Scrapling.PerUrlConfig` with `"fallback": true`. |
| Entries arrive with a long delay | Mostly `TimeChecker`: an entry waits half an interval on average. The diagnostics report shows which feeds can be checked more often; `Settings.AdaptivePolling` does it automatically. |

Diagnostics (`Settings.Diagnostics`) and its report in `diagnostics/summary-*.md` are the
best place to check which feed is slow or failing.
