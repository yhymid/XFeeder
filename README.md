<div align="center">

# XFeeder

**English** · [Polski](README.pl.md)

**News, game updates, commits and videos delivered to Discord and Telegram the moment they are found.**

![Rust](https://img.shields.io/badge/Rust-1.88%2B-orange?logo=rust)
![Version](https://img.shields.io/badge/version-3.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

<table>
  <tr>
    <td align="center"><img src="docs/showcase/blogs-v2.jpg" width="260" height="411" alt="News blog entries in Discord"><br><sub>Blogs</sub></td>
    <td align="center"><img src="docs/showcase/github-commits-v2.jpg" width="260" height="411" alt="GitHub commit feed in Discord"><br><sub>GitHub commits</sub></td>
    <td align="center"><img src="docs/showcase/valve-tracker-v2.jpg" width="260" height="411" alt="Valve / Counter-Strike 2 updates in Discord"><br><sub>Valve tracker</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/showcase/facepunch-tracker-v2.jpg" width="260" height="411" alt="Facepunch s&amp;box updates in Discord"><br><sub>Facepunch tracker</sub></td>
    <td align="center"><img src="docs/showcase/steam-v2.jpg" width="260" height="411" alt="Steam announcements in Discord"><br><sub>Steam news</sub></td>
    <td align="center"><img src="docs/showcase/youtube-v2.jpg" width="260" height="411" alt="YouTube uploads in Discord"><br><sub>YouTube</sub></td>
  </tr>
</table>

## Why XFeeder

- **One small binary.** Written in Rust: no Node.js, nothing to install next to it. Docker images are optional ([docs/docker.md](docs/docker.md)).
- **Light.** About 35 MB of memory and 1.5 % CPU with 10 channels and 32 feeds.
- **Never posts twice.** Delivery history is kept per destination and survives crashes and
  restarts; a new feed does not flood the channel with old entries.
- **Gets through Cloudflare.** Sites that block bots are fetched with a real browser
  (Scrapling) or FlareSolverr, and only when they actually block.
- **Looks good in Discord.** Cards with image, author and date (Components V2), posts into
  forum threads; Telegram with photos as well.
- **You decide what is posted.** Per-channel filters (words or regex, maximum age) and
  check intervals.
- **No restarts.** Changes to `config.json` and `.env` apply on their own.
- **Shows what is slow.** 24/7 diagnostics measure the delay from publication to Discord and
  suggest what to change.
- **Web dashboard** with no JavaScript: channels, posts, logs, charts and diagnostics;
  edit settings, check a channel now or let an entry be posted again.

**Sources:** RSS, Atom, JSON Feed, YouTube channels, GitHub (commits, issues, pull requests,
releases, branches), Steam and SteamDB news, any page that links its feed, Discord channels.
**Destinations:** Discord webhooks (channels and forum threads), Telegram (chats, channels,
topics).

### How "never posts twice" works

Every entry gets an identity, the first of these that exists:

1. a key the source gives it (Steam builds, Minecraft patch notes);
2. its link, cleaned of `utm_*` and other tracking parameters and of `#…`, so
   `https://site.com/post?utm_source=rss` and `https://site.com/post` are the same entry;
3. its guid;
4. a hash of title, date, author and text, for entries with neither.

The identities already sent are kept per channel and per destination (Discord, Telegram) in
`cache.json`, up to 2000 per feed, and the file is rewritten right after each successful
send (written to a temporary file and renamed, so a crash never leaves it half written).
Only one worker can use a `cache.json` at a time.

Examples:

- **A new feed** with 50 old entries: the first check marks them all as seen and posts none,
  or only the newest `FirstRunSend` of them. The channel is not flooded.
- **An edited post** (new title or text, same link): not posted again.
- **A feed that lists two entries under one link** (kernel.org, release notes pages): each
  keeps its own identity (`link#guid`) from then on, so neither is posted again when the
  other one disappears.
- **A restart or a crash**: history is on disk, so after the restart only really new
  entries are sent.

Limits:

- A site that changes the links of its old entries (a new address scheme, a new domain)
  makes them new entries.
- History belongs to the feed URL: changing a feed's address starts a new history, and only
  the first-check rule (`FirstRunSend`) keeps the old entries from being posted.
- A feed that shows more than 2000 entries at a time can repost entries that fell out of
  the history.
- If the worker is killed in the moment between Discord accepting a post and the history
  being saved, that one post can come again.

### How sites behind Cloudflare are fetched

1. Every feed is first fetched with a plain request (a fraction of a second).
2. Only when the site answers 403/429/503 or with a challenge page ("Just a moment…"),
   XFeeder opens a real browser through [Scrapling](scrapling/README.md) (Chromium with
   Patchright), which passes Cloudflare's check like a visitor would, or asks
   FlareSolverr. Feeds that never block never start a browser.
3. With `Scrapling.ReuseClearance`, the cookie the browser got is reused for plain
   requests until it expires.

Example from production: boop.pl takes about 26 s per check through the browser and 8–11 ms
when the cookie is reused; gry-wideo.pl stopped blocking, and with `"fallback": true` went
from 10.5 s back to 0.3 s on its own.

Limits:

- Scrapling must be installed next to XFeeder (or the `scrapling` Docker image used): about
  1.6 GB with Chromium, and a few hundred MB of memory while a browser runs.
- It passes Cloudflare's automatic check. A page that wants a person to solve a CAPTCHA,
  a firewall rule against your server's IP (403 without `cf-mitigated`), or other services
  (DataDome, Akamai) may still block.
- It is meant for public feeds that a browser can open; it does not log in or get around
  paywalls. Mind the site's terms.

Step by step: [configuration guide, level 3](docs/configuration.md#level-3-hard-sites-that-block-bots-cloudflare).

## Quick start

The easiest way: download `XFeeder.zip` from [Releases](https://github.com/yhymid/XFeeder/releases/latest),
unzip it and follow `Instruction.md` inside (a ready-to-run Linux x86_64 binary). From source:

```sh
cargo build --release
cp target/release/xfeeder .
cp config.json.example config.json
cp .env.example .env                  # webhook URLs and tokens go here
./xfeeder --check-config              # validate
./xfeeder --dry-run --once            # test run: fetch everything, post nothing
./xfeeder                             # run
```

The smallest working `config.json`:

```json
{
  "channels": {
    "news": {
      "Webhook": "${DISCORD_WEBHOOK}",
      "RSS": ["https://example.com/feed.xml"]
    }
  }
}
```

## Documentation

| | |
|---|---|
| [Configuration guide](docs/configuration.md) | Easy → medium → hard (Cloudflare) setup, and every setting explained |
| [Dashboard](docs/dashboard.md) | Every page of the web dashboard, access over SSH, security |
| [Deployment](docs/deployment.md) | Building on a server and running under systemd ([unit files](deploy/systemd)) |
| [Scrapling](scrapling/README.md) | Installing the browser for sites that block bots |
| [Architecture](docs/architecture.md) | How the code is organised |
| [Roadmap](docs/roadmap.md) | What was taken from similar projects and what may come next |
| [Changelog](CHANGELOG.md) | What changed, with measurements |

Upgrading from 2.x: keep `config.json`, `.env` and `cache.json` and start `xfeeder` in the
same folder; nothing is posted again.

## License

[MIT](LICENSE)
