# Changelog

Releases are cut by hand when enough has changed. Each release on GitHub uses the matching
section below as its description.

## Unreleased

### Added
- README (EN/PL): how "never posts twice" and the Cloudflare handling work, with examples
  and limits.
- Dashboard overview (translated to Polish too): a "Steam builds (steampics://)" section with the state (live + SteamCMD, SteamCMD only, error), with the number of games, how
  many are read with the Steam account, games Steam shows no depots for, the last SteamCMD run
  and error, a failed login's anonymous pause and live mode's connection. The worker saves this
  as `status` in `steam_pics.json`.
- Live mode for `steampics://` (`Settings.SteamPics.Live`, build feature `live-pics`, off by
  default and not in release packages): an anonymous Steam connection (steam-vent 0.5.0) asks
  every ~10 s for changed apps and wakes the SteamCMD run and the channels of a configured app
  at once, at most every `LiveMinSeconds` (120). SteamCMD still reads and compares, so it can
  only make posts sooner, not different; reconnects with a growing pause.
- Docker, next to the plain binary ([docs/docker.md](docs/docker.md)): `docker/Dockerfile`
  builds three images, `slim` (the static binary on distroless, ~17 MB), `scrapling` (+ Python,
  Scrapling and Chromium) and `full` (+ SteamCMD, amd64 only), all as UID 65532 with state in
  `/data`. `compose.yaml` runs the worker and, with `--profile dashboard`, the dashboard on
  `127.0.0.1:3000` with worker control off. `.github/workflows/docker.yml` (run by hand) pushes
  them to ghcr.io for a release. `build.rs` takes the commit from `XFEEDER_GIT_COMMIT` when
  there is no `.git`.
- Only one worker per `cache.json`: the worker holds an exclusive lock on `cache.json.lock`
  (also across containers sharing the directory), and a second one exits with "another XFeeder
  worker is already using …". `--dry-run` does not lock. `XFEEDER_DASHBOARD_WORKER_CONTROL=off`
  turns off the dashboard's Start/Stop/Restart for a worker run as its own service or container.
- `Settings.SteamPics.Login`: read `steampics://` games with a Steam account (for games whose
  depots anonymous Steam hides, like Deadlock). Only the account name is configured
  (`${STEAMCMD_LOGIN}`); the session comes from one manual `steamcmd +login NAME`. A lost
  session (password or Steam Guard prompt) stops the run at once and falls back to anonymous
  for 6 hours; switching modes re-baselines instead of posting "Branch added".
  `Password` (`${STEAMCMD_PASSWORD}`) logs in when there is no saved session: from a 0600
  temporary script, never on the command line or in logs; Steam may ask to approve it in the
  Steam Mobile app (SteamCMD waits only about a minute).
- Readable Discord posts (`Settings.PostText`, on by default): RSS, Atom and Steam event
  posts show up to 1500 characters (`Length`, 300–3500) instead of the first ~500, cut at the
  end of a line; headings (`<h1>`–`<h6>`, bold-only lines, `<Section>` lines) are bold with
  an empty line before them; links keep their text as `[text](url)`; a line that is only a
  Steam store or YouTube URL becomes a short named link. The text is kept in a new
  `contentText` field, so `contentSnippet`, Telegram and delivery identities do not change.
  `"PostText": false` restores the previous text.
- `xfeeder preview --json --payload` adds the Discord payload of each entry, as it would be
  posted.
- Channel `Ping`: mention a role, users or `@everyone` in a line above Discord posts. A role
  ID pings on every post; the object form can limit it to some feeds (`Feeds`, e.g.
  `/releases`) and to entries matching `Include` patterns, with an optional `Text`.
  `--dry-run` shows which entries would ping; edits never ping again.
- Steam events as a source: `store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=…`
  gives the same posts as a game's store RSS (same ids; history is kept per source URL, so a switched channel relies on `FirstRunSend` to not repost),
  sorted by Steam's own event type into `Patch`, `Major update`, `Beta`, `Release` and
  `News` categories for `Filters`. Broadcasts and streams are left out, images come from
  the post, and SteamMerge treats it like the store RSS. The RSS keeps working as before.
- Steam builds and branches from Steam itself: `steampics://APPID` reads Steam's product
  info with anonymous SteamCMD (one run for all apps, at most every 10 minutes) and posts a
  new public build (with the depot size change), branches added or removed (CS2's version
  pins such as `1.42.0.0`) and new builds on other branches. Build posts link SteamDB's patch
  notes page like SteamDB's RSS does (history is kept per source URL, so `FirstRunSend` keeps a switched channel from reposting), and SteamMerge joins
  them with the announcement. Every raw change is logged to `steam_pics.changes.jsonl`.
  Settings: `Settings.SteamPics`.

### Fixed
- Entries that share one link (kernel.org, Claude release notes) keep the same identity on
  every check. Before, an entry was keyed `link#guid` only while another entry of the same
  fetch had its link, so it could be sent again when a second entry with that link appeared,
  or a new entry could be skipped when it was alone again. Once history holds a link as
  `link#…`, every entry with it keeps `link#guid`; the first time a link is shared while
  history has only the bare link, the oldest entry takes its place (logged). Found in a code
  review; on prod's history (one affected feed, 181 entries) it changes nothing to send now.
- Steam builds keep the last 50 events per app instead of 20, so with `Changelists` a build
  post cannot rotate out before it is sent.
- A SteamCMD run that timed out or was cancelled left the real SteamCMD running:
  `/usr/games/steamcmd` and `steamcmd.sh` are shell scripts that start it as a child, and only
  the script was killed. SteamCMD now runs in its own process group, which is killed as a whole.
- Steam builds (`steampics://`): an answer with an older change number (stale cached info)
  or without any depot (partial answer) is ignored instead of being compared, which would
  have posted a fake rollback or "Branch removed" for every branch. Found in a code review.
- Post text links: link text that looks like an address shows the real target (no
  `[https://a.example](https://b.example)`), and a link split over lines no longer leaves
  hidden characters in the post. `sent.json` keeps at most 1500 characters of post text.
- Post text: a first line that only repeats the title is dropped (Mesa, GitHub), and GitHub
  release notes wrapped at ~72 columns are joined back into sentences.
- Post text: a line that is only a long list of `[@name](url)` links (GitHub release thanks,
  OpenClaw has 80+) shows 12 names and "… and N more" instead of using up the text.
- Steam posts keep their line breaks. A body like `· fix one\n· fix two` (Hades II, Marvel
  Rivals, The Isle) was joined into one long line, because a line break in HTML is a space.
  Checked on 585 posts of 195 games: lists glued into one line 9 → 0, lines over 400
  characters 106 → 43, identities unchanged.
- Filters and `Ping.Include` check each field value on its own (title, text, every
  category) instead of one joined text, so `^` and `$` anchor to one value: `/^Build$/`
  matches a Steam build post's `Build` category, not `Branch build`. Before, a ping for only
  new public builds was not possible. Production filters use no anchors (checked).
- The XML parser no longer logs "Error fetching …: not XML" for JSON feeds it hands on to
  the next parser; the line now says "not an XML document, trying the next parser".
- Minecraft patch notes (`launchercontent.mojang.com/v2/javaPatchNotes.json` and
  `bedrockPatchNotes.json`) were never posted: their entries have no link or guid, so all
  424 + 82 got the feed's own address as one shared identity. A dedicated parser keeps each
  entry's `id`, date, short text, picture and category (`snapshot`/`release`,
  `retail`/`beta`). A delivery history holding only the feed's own address no longer counts
  as history, so the first check after the update marks the existing patch notes as seen
  (`FirstRunSend`) instead of posting all of them. Entries have no link: the launcher has no
  page per entry and minecraft.net addresses cannot be derived from the title.
- A user mention (`<@ID>`) written in a feed entry could notify that user (Discord's
  webhook default parses user mentions). Every webhook post now sends `allowed_mentions`,
  so only the mentions configured in `Ping` notify.
- Entries that share one link but have different guids (kernel.org lists every release with
  `https://www.kernel.org/`) were treated as one entry, so only the first was ever sent.
  They now get their own identity; feeds with unique links keep theirs.
- RSS 1.0 / RDF feeds (Slashdot, Debian News) gave no entries. Items under `<rdf:RDF>` are
  read now, with `dc:date` dates and `rdf:about` links.
- Podcast feeds used the audio file as the post image. Enclosures are used only when they
  are images; `media:group` and `itunes:image` are read too.
- Category filters did not match Atom categories (`term`/`label`) or RSS categories with a
  `domain` attribute (GitHub Changelog): categories are plain text now.
- Steam events: BBCode tags with attributes (`[p align="start"]`, `[url="…" style="…"]`,
  `[img src="…" style="…"]`, table cells, colours, `[dynamiclink]`) were left in the text as
  is. Checked against the last 10 posts of 202 games: none are left.
- Steam posts without their own image used the app's `header.jpg`, which newer games no
  longer have (broken image in Discord). XFeeder now checks it, tries the library hero
  image next, and sends no image when neither exists.
- WordPress feeds that start every body with `<?xml encoding="utf-8"?>` (blender.org)
  showed it in the text.
- Commit trailers (`Co-Authored-By`, `Signed-off-by`, session links) and "The post …
  appeared first on …" tails were removed from the snippet only, so the longer Discord text
  still showed them. On 27.11 that was 7 GitHub commit feeds, fmhy, Intel and OpenClaw
  releases, the GitHub Blog and Xbox Wire.
- XML feeds are parsed safely:
  - a document nested deeper than 256 levels is refused; about 50 000 levels used to
    overflow the stack and stop the whole process;
  - anything after the root element is ignored: Cloudflare appends a `<script>` to
    unrealengine.com/rss, which pushed it to the regex fallback (titles with `<p>`, no text,
    no categories);
  - HTML entities such as `&nbsp;` or `&eacute;` are resolved, and unknown ones stay as
    written, where before one of them rejected the whole feed;
  - text stays text: "1.10" no longer becomes "1.1", and 20-digit ids keep their digits.
- Network defaults: a request has 120 s in total (`requestDeadlineMs`) and at most 16 MiB
  after decompression (`maxResponseBytes`); both were unlimited, so a slow server could hold
  a request forever and a 0.25 MB gzip answer could grow memory to 1.8 GB. A `Retry-After`
  longer than 30 s is no longer waited out inside the request (one `429` with
  `Retry-After: 3600` held the whole schedule for about 2 hours); the feed fails that check
  and is tried at the next one.

- Nothing sent twice, nothing skipped (feed review F07):
  - when entries start sharing a link, the link's place in history goes only to the entry
    the send record (`sent.json`) says was sent under it. Before, the oldest entry by date
    took it, so a new entry was skipped when the sent one had left the feed, was hidden by
    a filter, or had no date. Without a record every entry with the link is sent, so at
    worst one post goes out twice;
  - an entry whose guid is not a URL is also remembered by its guid, so a feed that changes
    its links but keeps its guids posts nothing again (onet did on 24.11: 21 posts twice);
  - history never drops the id of an entry the feed still lists. A feed with more than
    2000 entries (openai.com lists 1430) would have sent old entries again on every check;
  - pending entries go out oldest first, so after downtime the older ones of a fast feed
    (onet: 20 items, about 7 new per hour) are sent before they drop off it.

### Changed
- Faster parsing, measured on all 278 configured feeds (27.11 download, one pass on a Steam
  Deck OLED):

  ```
  ┌──────────────────────────────┬──────────┬──────────┐
  │                              │ before   │ after    │
  ├──────────────────────────────┼──────────┼──────────┤
  │ CPU time, 3 passes (user)    │ 15.2 s   │  7.0 s   │
  │ Instructions per pass (F09)  │ 76.9 G   │ 18.0 G   │
  │ Allocations per pass (F09)   │ 22.6 M   │  7.6 M   │
  └──────────────────────────────┴──────────┴──────────┘
  ```

  - HTML tag patterns use ASCII word boundaries: the Unicode `\b` made the regex engine fall
    back to its slow path on any text with non-ASCII characters;
  - Steam events JSON is parsed once per download instead of twice;
  - one XML tree per download is shared by all parsers;
  - Telegram escaping is linear instead of quadratic.
- Steam events (`ajaxgetadjacentpartnerevents`, feed review F04/F05): the date is the post
  time like in the store RSS, not the event's start (93 of 1948 posts started over an hour
  later, one 282 days later, so they had future dates); patch notes for a build on a beta
  branch are `Beta` instead of `Patch` (about 25 on 27.11); titles like "Update 21" or
  "Latest Update 11/16/2026" count as patches (only one-digit numbers did).
- The first check of a feed records every entry it lists, also those the channel's filter
  hides (`MaxAgeHours`, `Exclude`). Before, they were left out, and an old entry that came
  back into the window (an Atom `updated` bump after an edit) was posted as new.
  `FirstRunSend` still picks only entries the filter lets through (feed review F07-6).
- Entries with no link keep the `#…` of their guid in their identity, so link-less entries
  (a JSON feed without `url`/`id`, a JSON Feed `id` like `…/changelog#v1`) no longer all share
  the feed URL and stop being posted after the first. Identities of all 278 feeds checked on
  27.11 are unchanged (feed review F07-7).
- `cache.feeds.json` (feed snapshots and health) is written at most once a minute, as compact
  JSON, instead of whole after every changed feed. Measured on production 3.0 on 27.11: a
  6.1 MB file and 185 MB of disk writes in 5 minutes. Compact it is 4.9 MB, so the worst
  case is now 5 writes (about 25 MB) in 5 minutes; not yet measured live. Delivery history
  (`cache.json`) is still saved after every send, and the feed store is always written on
  shutdown (feed review F09, item 17).
- The last-resort RSS parser compiled a regex for every tag of every item. On a 5 000-item
  feed it took 209.5 s; now 0.78 s (release build, same synthetic feed). The regexes are
  compiled once per tag (feed review F09, F10).
- `Ping` takes every mention form: `"Here": true` for `@here`, and the short form accepts a
  list of mentions as Discord writes them (`"<@&role>"`, `"<@user>"`, `"@everyone"`,
  `"@here"`), not only role IDs. `Settings.Diagnostics.MaxFileMB: 0` means no daily limit
  (old days are still removed after `RetentionDays`).
- Discord posts show feed text as written (feed review F06, F10). Markdown characters from
  the feed are escaped: censored names like `C***p` in ban lists no longer turn bold or
  italic (195 such names on 27.11), a line starting with `# `, `-# ` or `> ` is no longer a
  heading or quote, `1. ` stays text, a literal `[text](url)` is not a link, and
  `<@…>`/`<t:…>` syntax is shown, not rendered. Bare URLs, the generated headings and links,
  and bold or `` `code` `` the author wrote (Cursor's changelog) are kept. Titles lose HTML
  tags (Gitea activity) and are escaped too, and so are authors. Decorative lines
  (`______`) are dropped. Long `@mention` lists are shortened before the text is cut.
  Older posts are not changed.
- Telegram posts keep their line breaks: paragraphs and list items were run into one block
  (697 of 822 sampled snippets had line breaks). A `PostText.Length` above 1800 no longer
  cuts the text a second time mid-word; the body gets what the title and the lines under it
  leave of Discord's 4000 characters. A cut text no longer ends with a heading that has
  nothing under it (feed review F06).
- Post text and images (feed review F02, F05, F08):
  - Steam RSS headings (`<div class="bb_h1">`, 557 of 564 in the 11 Steam RSS feeds) are
    bold like other headings;
  - an RSS item with both `<summary>` and `<description>` uses the longer one (Godot posted
    a one-line teaser and lost all 15 cover images);
  - an item's `<image>` is its picture (Bungie: 25 posts without one);
  - the first picture of a post is a real one: emoji, icons, images 64 px or smaller,
    `data:` and SVG are skipped (Roblox's forum posted a 20 px emoji in 14 posts), and
    `&amp;` in its address is decoded.
- GitHub API (feed review F04): when the limit is used up or GitHub asks to slow down
  (`403`/`429` with `x-ratelimit-remaining: 0` or `Retry-After`), no API request is sent
  until GitHub's reset time, for all API URLs at once, as GitHub asks. The "limit almost
  used up" warning comes below 10 % of the limit, once per hour (it fired on almost every
  request after the 10th without a token). The docs no longer say a `304` is free without
  a token: it is free only with one.
- One failing feed no longer delays its whole channel: a feed that fails backs off on its
  own, and only failed deliveries back off the channel. With 232 feeds in one channel, a
  single broken one made the others wait 2 to 8 times their interval (feed review F01, F10).
- A plain `404`, `410` or `500` is an error, not a Cloudflare challenge: it no longer starts
  the browser fallback (up to 3 tries) and its 30-minute cooldown. Feeds whose prolog has a
  comment or `<?xml-stylesheet?>` (Steam store RSS, World of Tanks) are recognised as feeds
  before any challenge check (feed review F10).
- Image checks before sending (feed review F08): each image is asked once per 6 hours
  instead of once per post and channel (a Steam game's header image was checked again for
  every post of that game), GitHub avatars are not checked at all (over half of all checks,
  always fine), and a `200` HTML page no longer passes as an image.

  Entry identities, entry counts and the Discord and Telegram output stay the same on 264 of
  the 278 feeds. The other 14 changed only through the fixes above.

## 3.0 - Rust Update (2026-11-21)

XFeeder is written in Rust now: one binary (`xfeeder`, `xfeeder dashboard`), no Node.js,
npm or JavaScript anywhere. `config.json` (2.x and schema v2), `.env`, `cache.json` and the
feed state are read as before, so an existing installation switches over in place.

### Added
- Ready-to-run release package `XFeeder.zip`: a static Linux x86_64 binary (`XFeeder`, no
  glibc version requirement), `Instruction.md` / `Instruction.pl.md`, `config.json.example`,
  `.env.example`, systemd units, `dashboard-tunnel.sh` and the Scrapling requirements. Built
  by the `Release` workflow (`scripts/package-release.sh`).
- Dashboard channel page (click a channel): destination, interval, posts in the last 7
  days, remembered entries, a posts-per-day chart, feeds and recent posts. **Check now**
  makes the worker check the channel on its next tick; **Delivery history** lists the
  entries the channel remembers, and **Forget** lets one of them be posted again. Both go
  to the running worker as small request files in `requests/` (applied every 30 s, never
  by editing `cache.json` from the dashboard).
- Dashboard Logs page: the last 200–5000 lines of the worker's journal
  (`journalctl -u xfeeder`, unit from `XFEEDER_SERVICE_UNIT`), newest first, with a
  warnings/errors filter and search; secrets are removed.
- Dashboard System section in Diagnostics: version and git commit (`build.rs`), worker PID
  and uptime, worker and dashboard memory, the GitHub API rate limit and data file sizes.
- Dashboard charts (posts per day for 30 days, posts per channel for 7 days, plain SVG),
  filters on Posts (channel, text) and Activity (channel, feed, text), and a read-only
  Discord webhook check (webhook name and channel; a deleted webhook is shown) on the
  channel list and channel page.
- `.env` editor in the dashboard's Advanced page, above `config.json`; the
  `XFEEDER_DASHBOARD_*` lines are hidden and kept, the previous file is saved as `.env.bak`.
- Dashboard guide (`docs/dashboard.md`, `docs/dashboard.pl.md`) and a table of every file
  in the data directory in the deployment guide.
- Dashboard: feed pages (where a feed is used, its real interval, health, browser use,
  saved clearance, last entries) with a "Test now" button, a Posts page with a per-post
  "Rebuild", feeds with problems on the overview, and Settings switches for adaptive
  polling, SteamMerge, ReuseClearance and Telegram defaults.
- `scripts/dashboard-tunnel.sh`: open a server's loopback-only dashboard through SSH in the
  foreground, leaving nothing running after Ctrl+C.
- Dashboard overview and activity: newest posts (from `sent.json`) and recent problems
  instead of routine events, channel and feed names instead of hashes, plain counter names,
  the systemctl command instead of buttons that cannot act on a systemd worker, one-click
  removal of an unsupported config section, and `config.json.bak` before every config
  write from the dashboard.
- Channel `Label`: a display name for logs and the dashboard that is not part of the
  history key. The channel list shows it, plus the real check interval (with
  `AdaptivePolling`), the last post and how many feeds are failing. Saving a channel of a
  list group from the dashboard pins its current history key (`CacheKey`), so editing its
  feeds, webhook or thread no longer starts its history over.
- Dashboard in English or Polish: an EN · PL switch in the header (cookie `xf_lang`, works
  on the login page too). Pages are still built in English and translated in one pass
  (whole text nodes and `placeholder`/`title`/`aria-label` only, with Polish plural forms);
  channel names, feed titles, URLs and the config JSON are never changed.
- Documentation in English and Polish: every page is `NAME.md` (English) with
  `NAME.pl.md` (Polish), linked to each other at the top. The configuration guide, until
  now only in Polish, has an English version; the Scrapling README and anti-bot guide,
  also Polish-only, are rewritten for the Rust worker in both languages.
- GitHub REST API URLs work as feeds: commits (also of private repos), issues and pull
  requests (one repo or all of yours via `/user/issues`), releases, new branches and tags.
  The account activity Atom feed comes from GitHub's events, which lagged two days in a
  test; the API is current. `Auth.GitHubToken` (`${GITHUB_TOKEN}`) is sent only to
  api.github.com (5000 requests/h instead of 60, private repos); requests are read-only,
  never go through the browser, and GitHub tokens are masked in logs.
- `Settings.SteamMerge` (off by default): one Discord post per game update. Whichever of
  the SteamDB build and the Steam announcement arrives first is posted at once; the other,
  within `WindowHours` (12) for the same app in the same channel, edits that post (announcement
  title, notes and picture, a build line and a SteamDB button) instead of posting again.
  Builds without an announcement stay separate; only update-like announcements join (not
  events or sales); a failed edit falls back to a normal post.
- `xfeeder rerender`: rebuilds Discord posts already sent in the current layout by editing
  them through their webhook (dry listing without `--apply`; `--channel`, `--hours`,
  `--limit`). Posts are known from `sent.json` (message id + entry, no webhook URLs, newest
  2000), written from this version on; older posts stay as they are.
- `Settings.AdaptivePolling` (off by default): every feed gets its own check interval
  from the dates of its entries. After a fresh entry (`BurstHours`, 6) the feed is checked
  every `MinMinutes` (5), because game updates come in series; otherwise every average
  gap / `Divisor` (8). Always between `MinMinutes` and the channel's `TimeChecker`, so no
  feed is checked less often than before (a game updated twice a year stays at 30 min).
  On the production feeds: onet, boop, lowcygier and an active GitHub branch → 5 min,
  FMHY → 19 min, Steam, SteamDB, YouTube, Gitea → 30 min (unchanged). `false` (or a
  channel's `"AdaptivePolling": false`) is the previous scheduler; `xfeeder preview`
  shows the interval a feed would get.
- `Scrapling.ReuseClearance` (temporary, off by default): after a browser passes a
  Cloudflare check, the site's cookies (`cf_clearance`) and the browser's User-Agent are
  kept in `clearance.json` (0600, git-ignored) and the next checks try plain HTTP with
  them first. Measured on boop.pl from the VPS: 0.04 s with the saved clearance against
  26 s through the browser; the cookie was still accepted after 10 minutes and is issued
  for 365 days. A rejected clearance is deleted and the browser path runs as before;
  `false` restores the previous behaviour exactly.
- Feed profiles `news`, `games` and `dev` (`profiles/`): real production feeds with saved
  samples. `cargo test` parses every sample and compares the result field by field with
  the saved expectations, so a fix for one site cannot silently change another;
  `xfeeder preview --profile NAME` checks the same feeds live.
- `xfeeder preview <URL>…`: shows what XFeeder reads from a feed (title, author, date,
  image, link, text, hints such as "image: 3/10 entries") and how long download, parsing
  and the image check take, through the same path as the worker (Scrapling, solver,
  proxy from `config.json`) and without sending or saving anything. `--bench N` repeats
  the fetch and prints min/median/p95/max per stage; `--json` for scripts.
- Delivery history written by 2.x is reused (2.x and 3.0 compute the channel cache key
  differently; the existing key wins), so nothing is re-posted after the switch.
- First check of a feed no longer replays it: when a destination has no history for a feed
  (new feed, new channel, or a channel whose key changed after editing `Webhook`, `Thread`
  or feeds), the current entries are marked as seen and only the newest `FirstRunSend`
  (default 0) are sent.
- Channel `Filters`: `Include`/`Exclude` (text or `/regex/`), `Fields`, `CaseSensitive`,
  `MaxAgeHours` (also in `ChannelDefaults`).
- Feed autodiscovery: a web page URL is replaced by the feed it advertises
  (`<link rel="alternate">`, RSS > Atom > JSON Feed); history is kept under the found URL.
- Optional `Solver` for FlareSolverr-compatible services (FlareSolverr, Byparr, TRAWL), per
  feed or automatically on 403/503/challenge pages.
- Telegram: entries with an image are sent with `sendPhoto` (caption up to 1024 characters),
  with `sendMessage` as fallback; `SendPhoto: false` turns it off.
- Scrapling `PerUrlConfig["URL"].fallback: true`: plain HTTP first, the browser only when the
  site blocks it (`enabled: true` still uses the browser every time). Measured on the VPS
  with gry-wideo.pl, which no longer blocks plain requests:

  ```text
  ┌──────────────────────────────────────┬───────────┐
  │ gry-wideo.pl/rss                     │ per check │
  ├──────────────────────────────────────┼───────────┤
  │ Browser (stealthy-fetch, wait 8 s)   │ 10.5 s    │
  ├──────────────────────────────────────┼───────────┤
  │ Plain HTTP (XFeeder dry run)         │ 0.88 s    │
  └──────────────────────────────────────┴───────────┘
  ```

- 24/7 diagnostics (`Settings.Diagnostics` or `XFEEDER_DIAGNOSTICS=1`): every event and log
  line, without tokens or webhook URLs, in `diagnostics/events-YYYY-MM-DD.txt`, and a latency
  report every 15 minutes in `diagnostics/summary-YYYY-MM-DD.md`: publication → Discord per
  channel and stage, every HTTP request (queue, time to first byte, body, cache headers,
  Discord rate-limit headers, server clock), feed freshness and publishing rate, Discord 429
  waits, scheduler lateness, memory and CPU of XFeeder and the browser, anomalies (future
  dates, duplicate or missing ids, clock skew, panics) and hints. Writing runs on its own
  thread and never blocks the worker. First three days on production (10 channels, 32
  feeds, `TimeChecker` 60 min):

  ```text
  ┌──────────────────────────────┬────────────┬────────────┬────────────┐
  │ Publication → Discord        │ 2026-11-17 │ 2026-11-18 │ 2026-11-19 │
  ├──────────────────────────────┼────────────┼────────────┼────────────┤
  │ Median                       │ 33.4 min   │ 39.8 min   │ 28.1 min   │
  ├──────────────────────────────┼────────────┼────────────┼────────────┤
  │ 90th percentile              │ 54.9 min   │ 59.3 min   │ 55.7 min   │
  ├──────────────────────────────┼────────────┼────────────┼────────────┤
  │ Posts sent                   │ 170        │ 213        │ 197        │
  ├──────────────────────────────┼────────────┼────────────┼────────────┤
  │ Failed sends / Discord 429   │ 0 / 0      │ 0 / 0      │ 0 / 0      │
  └──────────────────────────────┴────────────┴────────────┴────────────┘
  ```

  Where the time went on 2026-11-19 (197 posts):

  ```text
  ┌──────────────────────────────────────────┬──────────┬──────────┐
  │ Stage                                    │  Median  │  90th    │
  ├──────────────────────────────────────────┼──────────┼──────────┤
  │ Waiting for the next check (TimeChecker) │ 27.9 min │ 55.7 min │
  ├──────────────────────────────────────────┼──────────┼──────────┤
  │ Inside XFeeder (fetched → sent)          │ 3.8 s    │ 10.9 s   │
  ├──────────────────────────────────────────┼──────────┼──────────┤
  │ Discord webhook request                  │ 0.74 s   │ 1.8 s    │
  ├──────────────────────────────────────────┼──────────┼──────────┤
  │ Slowest feed: boop.pl (browser)          │ 26.3 s   │ 34.6 s   │
  └──────────────────────────────────────────┴──────────┴──────────┘
  ```

  Almost the whole delay is the polling interval, not XFeeder; XFeeder itself used 35 MB
  of memory and 1.5 % CPU on average, with no leak over three days.
- Dashboard rewritten as server-rendered HTML in Rust: plain forms, no JavaScript
  (CSP `default-src 'none'`). Overview with worker control and metrics, channels
  (add/edit/duplicate/delete with filters), activity, diagnostics reports, settings
  (general, diagnostics, network, `.env` secrets; values are never shown) and the raw
  config editor. Every save is checked against the revision it was opened with; CRLF line
  endings are kept. The JSON API is unchanged.
- Discord webhook sends log the created message and channel id.

### Changed
- `config.json.example` starts with Telegram and Scrapling off, and `.env.example` has no
  active dashboard password, so the examples run as they are with only a webhook filled in.
- Dashboard look: black (AMOLED) theme, centred header and pages, status badges; the
  footer and the refresh link are gone.
- The `xfeeder-dashboard` systemd unit is tied to the worker (`PartOf=`,
  `WantedBy=xfeeder.service`): it starts at boot with `xfeeder` and stops and restarts
  with it. Reinstall the unit file and run `systemctl reenable xfeeder-dashboard` to switch.
- The dashboard accepts any port on `127.0.0.1`/`localhost`/`[::1]`, so an SSH tunnel can
  use another local port.
- Scheduler: due channels start at once, one after another (up to
  `MaxConcurrentChannels`), instead of one channel per 30-second tick. With 10 channels a
  due channel could wait up to 5 minutes; a full pass of all 10 now takes about 7 s.
- A shorter `TimeChecker` after a config reload applies to checks that are already
  planned (last check + new interval); before, the next check still waited for the old
  interval.
- Feed bodies in ISO-8859-2/windows-1250 (and any WHATWG encoding) are decoded from the
  `Content-Type` charset or the document's own declaration; valid UTF-8 stays UTF-8. 2.x
  garbled Polish characters.
- A destination that is gone or forbidden (Discord 401/403/404 or Unknown
  Channel/Webhook, Missing Access, locked thread; Telegram 401/403, chat not found) is
  skipped for the rest of the run instead of failing once per pending entry.
- HTTP: one retry with `Accept: */*` on 406/415; healthy XML/JSON responses are not
  scanned for anti-bot text (articles that mention "captcha" were treated as blocks).
- Scrapling: works with Scrapling 0.4.15 and 0.5.x, runs `get` in the persistent Python
  worker, passes `solve_cloudflare` and the other stealth options, keeps page resources
  for a Cloudflare solve (the Turnstile widget needs them) and uses one browser session
  at a time.
- `XFEEDER_*` flags and dashboard settings are also read from `.env`.
- Sharper images. Each site in production was checked to see how it builds its posts:

  ```
  ┌──────────────────────┬──────────────────────────┬──────────────────────────────┐
  │ Source               │ Image the feed gives     │ Image sent now               │
  ├──────────────────────┼──────────────────────────┼──────────────────────────────┤
  │ GitHub commits       │ avatar 30×30             │ avatar 460 px, as thumbnail  │
  │ lowcygier.pl (WP)    │ thumbnail 224×224        │ original 800×800             │
  │ YouTube              │ hqdefault 480×360        │ maxresdefault 1280×720       │
  │ Steam news (CS2)     │ none in 9 of 10 posts    │ game header 460×215          │
  │ gry-wideo, onet,     │ 1200–2400 px             │ unchanged                    │
  │ boop, SteamDB        │                          │                              │
  └──────────────────────┴──────────────────────────┴──────────────────────────────┘
  ```

  The larger image is checked with a 1 KB ranged request before sending; when it does
  not exist (some YouTube videos have no `maxresdefault`), the feed's own image is used.
  Avatars appear small next to the text (Section + Thumbnail) instead of as a large
  pixelated picture, and are not sent to Telegram as photos.
- Message text keeps paragraphs and list items (`• `) instead of one long line (Steam
  patch notes, FMHY changes, multi-line commits); invisible characters and Steam's
  `\[ ]` escapes are removed; a text that only repeats the title, or starts with the
  site name and the title (WordPress feeds), is trimmed.
- RSS `<author>` given as plain text is used as the author (Gitea feeds).
- GitHub cards: commit trailers (`Co-Authored-By`, `Signed-off-by`, `Claude-Session`…)
  are not shown; a commit whose e-mail is not linked to a GitHub account shows the name
  from the e-mail (`codex`, `release`) instead of "Anonymous"; long texts end at a whole
  word with `…`.
- Discord cards: the date is a Discord timestamp (`<t:…:f>`), shown in each reader's own
  time zone and language (was US format in the server's zone); feeds without an author
  (Steam, SteamDB, onet, boop) show the site (`🌐 steamdb.info`) instead of "Anonymous";
  "Czytaj więcej »", "Read more" and "The post … appeared first on …" are removed;
  YouTube Shorts use the vertical thumbnail (`oardefault`, 1080×1920) instead of a
  letterboxed 16:9 one.

### Fixed
- GitHub activity feeds (`github.com/<user>.atom`) showed one word per line (line
  breaks in the HTML source were kept; they are spaces outside `<pre>`) and no time
  (dates like `2026-11-19 12:58:18 UTC` were not parsed).
- Relative links in feeds (Gitea writes `/owner/repo/commit/…`) are made absolute, so
  "Open" works. The original link stays the delivery identity, so nothing is sent again
  (checked on all 220 entries of the 12 production sources).
- A feed returned after a solved challenge is accepted even though the headers still say
  `server: cloudflare` / `cf-mitigated`; a rejected challenge page is logged as a warning.
- A second browser session failed with "Sync API inside the asyncio loop".
- A valid but empty feed (e.g. a YouTube channel without videos) is no longer turned into
  a fake entry; 2.x posted the feed URL once per such feed.
- Dates with a wrong weekday name (`Mon, 02 Jan 2024`) are accepted.
- Diagnostics report: parse time no longer includes the download, browser memory is
  counted once (PSS instead of summed RSS: about 1.3 GB was reported for a few hundred
  MB), and "-0 ms" is no longer shown when Discord never rate-limited.

### Removed
- Node.js, npm and the JavaScript browser UI; Workshop plugins, Dockerfile/compose;
  Node-era documentation and test fixtures; the `include_dir` dependency.

## [2.2.0] - 2026-10-09

**XFeeder 2.2.0 — Final Big Tweaks Before 3.0**

### Network and reliability
- Added process-wide Network Usage Control with Potato (10 Kbps), Low (2 Mbps),
  Medium (10 Mbps), High (50 Mbps), Very High (100 Mbps), Unlimited and Custom presets.
- Added independent Custom download/upload budgets. Known buffered request bodies
  reserve upload credits before dispatch; streaming/multipart bodies and redirect
  replay are explicitly outside upload pacing. All managed HTTP consumers share
  download/concurrency policy. Unlimited remains the default for existing configs.
- Added opt-in Network Friendly Mode: bounded HTTP/browser concurrency, browser
  spacing and retry jitter. It is application throttling, not OS/router QoS.
- Added setup, idle and explicit total deadlines that distinguish network stalls
  from intentional bandwidth waits and downstream backpressure.
- Preserved conditional requests and per-destination delivery state. Bounded
  retries honor transient HTTP/network errors and Retry-After; cancellation stops waits.
- Added bounded graceful shutdown across channel work, queues, retry delays,
  HTTP streams and Scrapling child/browser processes.
- Fixed duplicate delivery-cache IDs introduced by recording successful sends
  both immediately and at batch completion. Successful sends now persist before
  the inter-message delay so shutdown retains completed delivery state.
- Added structured runtime network metrics with aggregated encoded HTTP body bytes,
  approximate rates and active/waiting work; browser byte totals remain unavailable.

### Scrapling and content safety
- Added `npm run scrapling:install` and `scrapling:check` for a locally generated
  virtualenv, pinned dependencies, Chromium installation and actual browser checks.
  Replaced shell-based detection with paired Python/CLI discovery and Windows paths;
  neither the virtualenv nor a third-party source checkout is shipped or required.
- Added native Scrapling Resource Saving (default on), per-URL overrides and shared
  browser admission policy. Pinned the tested Scrapling runtime to 0.4.15 and added
  reproducible Python requirements. Browser traffic is not shaped by the Node limiter.
- Reject recognized challenge/error/interstitial HTML (including One moment,
  Just a moment and Checking your browser) before entry parsing and delivery.
  Rejection works even with browser fallback disabled. Unresolved challenges neither
  replay cached entries nor replace validators/snapshots/delivery state.
- Respect disabled automatic/per-URL fallback; reject challenges returned by Scrapling
  itself and guard both HTML entry extractors. Added positive and negative fixtures.

### Dashboard, delivery and diagnostics
- Redesigned the dashboard into Overview, Channels, Settings, Advanced and Activity,
  including mobile layouts, independent saves, secret masking, dirty-state protection,
  revision conflicts and configuration validation.
- Added Network settings/API and a worker runtime bridge for applying changes without
  restart and displaying actual applied/offline status.
- Added Telegram Bot API delivery with HTML formatting, forum topics and channel
  overrides. Delivery destinations are Discord and Telegram.
- Retained generic config/retry/cache regression coverage; removed tests that only
  enforced retired integrations.
- Added Expert diagnostics and terminal capture with secret redaction; preserved
  dry-run, once, check-config and conditional-fetch behavior.
- Added explicit HTTPS reverse-proxy public origin support, Secure session/logout
  cookies and origin validation without trusting arbitrary forwarded headers.
  Validated login, Network updates and logout through a real local TLS proxy.

### Removed
- Removed legacy Matrix delivery support.
- Removed FreshRSS-specific compatibility/integration; standard RSS/Atom feeds remain supported through the generic feed pipeline.
- These removals are intentional scope decisions before 3.0, not accidental regressions.

### Release and tests
- Added a small runtime release asset with application/dashboard code, installation
  manifests, examples, an empty starter config and the MIT license. Development
  documentation, tests and commands are excluded; full source archives remain available.
- Audited tracked source and available Git history for credentials/runtime artifacts;
  strengthened ignore/archive guards and replaced the TLS fixture with an explicitly
  public test-only, non-CA certificate/key pair and documented its trust boundary.
- Extended regression coverage for network sharing, profiles, retries/429, timeout
  semantics, shutdown, dashboards, challenge pages and unsupported configuration warnings. Browser
  smoke suites cover real Scrapling resource policies and desktop/mobile workflows.
- Restored automatic discovery of every `tests/*.test.js`; removed a test's dependency
  on a private local config in favor of the distributed example.
- Updated package/lockfile/user-facing versions to 2.2.0. Corrected the runtime floor
  to Node 20.18.1, already required by locked Cheerio/Undici, rather than imposing Node 22.
- Hardened .gitignore for secrets, Python/Node environments, caches, runtime snapshots,
  debug logs, browser/test output and local benchmark/release artifacts. Retained the
  XFeeder Scrapling adapter, fixtures, example files and dependency lockfiles.
- Added a reproducible source archive builder and documented validation results,
  artifact contents and known measurement/upload/browser limitations.
- No XFeeder 3.0 tasks or automatic Adaptive Mode are implemented in this release.

## Earlier releases

[Core]
- Added safe run modes so you can test locally without posting anything live.
- Added a config check command to catch mistakes before deployment.
- Reloading now picks up changes from `.env` and `config.json` without restarting the worker.
- Message cache now tracks each destination separately, so one failed target does not cause duplicate posts in another target.

[Dashboard]
- Added password protection for the dashboard.
- Improved the edit flow for `.env` and `config.json` so routine changes are easier.
- Prevented unsafe public dashboard exposure unless a dashboard password is configured.

[Reliability]
- Fixed proxy handling for feed requests.
- Improved channel and delivery flow to be safer during partial failures.
- Added tests for config loading and channel execution behavior.

[Deployment]
- Added systemd examples for the worker and dashboard services.
- Added safer example environment and config files for public sharing.
- Cleaned the public repo so secrets, caches, local virtual environments, and temporary files stay out.
