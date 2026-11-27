<div align="center">

# XFeeder

**English** · [Polski](README.pl.md)

**News, game updates, commits and videos delivered to Discord and Telegram the moment they are found.**

</div>

XFeeder is one program that runs on your server. Every channel in `config.json` lists
feeds (RSS, Atom, JSON Feed, YouTube, GitHub, Steam) and where to post them (a Discord
webhook, a Telegram chat). XFeeder checks each feed at its interval, keeps what passes the
channel's filters, posts entries it has not posted before, and remembers them on disk, so
nothing comes twice after a restart. Changes to `config.json` and `.env` apply without a
restart; the web dashboard shows and edits the same settings.

<div align="center">

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

## Quick Install

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

Upgrading from 2.x: keep `config.json`, `.env` and `cache.json` and start `xfeeder` in the
same folder; nothing is posted again.

## Docker Install

```sh
git clone https://github.com/yhymid/XFeeder && cd XFeeder
mkdir -p data
cp config.json.example data/config.json   # then edit it
cp .env.example data/.env                 # webhooks, tokens
sudo chown -R 65532:65532 data            # the images run as UID 65532
docker compose build && docker compose up -d
```

Three images: `slim` (~17 MB), `scrapling` (with a browser for Cloudflare sites) and `full`
(with SteamCMD for `steampics://`). Details: [docs/docker.md](docs/docker.md).

## Cloudflare Bypass

Every feed is first fetched with a plain request. Only when a site answers with a block or a
challenge page ("Just a moment…") does XFeeder open a real browser through
[Scrapling](scrapling/README.md), or ask FlareSolverr, and it can reuse the cookie it got for
plain requests. Measured in production: boop.pl takes about 26 s through the browser and
8–11 ms with the reused cookie. It passes Cloudflare's automatic check, not a CAPTCHA that
needs a person. How it works: [docs/architecture.md](docs/architecture.md#how-sites-behind-cloudflare-are-fetched);
setup step by step: [configuration guide, level 3](docs/configuration.md#level-3-hard-sites-that-block-bots-cloudflare).

## No Duplicate Feeds

Each entry gets an identity: a key from the source, else its link without tracking
parameters, else its guid, else a hash of its content. Identities of confirmed sends are
saved per channel and destination right after each send, so a restart, a crash, an edited
post or a link with `?utm_source=` does not post anything again. A new feed posts none of
its old entries, or only the newest `FirstRunSend`. Examples and limits:
[docs/architecture.md](docs/architecture.md#how-never-posts-twice-works).

## Documentation

| | |
|---|---|
| [Configuration guide](docs/configuration.md) | Easy → medium → hard (Cloudflare) setup, and every setting explained |
| [Dashboard](docs/dashboard.md) | Every page of the web dashboard, access over SSH, security |
| [Docker](docs/docker.md) | The three images, data folder, dashboard and Steam builds in Docker |
| [Deployment](docs/deployment.md) | Building on a server and running under systemd ([unit files](deploy/systemd)) |
| [Scrapling](scrapling/README.md) | Installing the browser for sites that block bots |
| [Architecture](docs/architecture.md) | How the code is organised, how duplicates are prevented, how Cloudflare sites are fetched |
| [Roadmap](docs/roadmap.md) | What was taken from similar projects and what may come next |
| [Changelog](CHANGELOG.md) | What changed, with measurements |

## License

[MIT](LICENSE)
