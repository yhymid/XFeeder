# XFeeder sources: where game, driver and app updates come from

**English** · [Polski](README.pl.md)

This branch holds **no bot code**. It is a sorted database of links for following updates: patch notes, driver releases, free games, engine and AI tool changelogs. Each entry says where the data comes from, in what format, how to filter it, and whether it worked when it was last checked.

The code of the bot is on the [`main`](https://github.com/yhymid/XFeeder/tree/main) and [`Beta`](https://github.com/yhymid/XFeeder/tree/Beta) branches.

## Contents

| File | What is inside | Entries |
|---|---|---|
| [games/steam.md](games/steam.md) | PC games on Steam: how Steam's three sources work, how to tell patches from news, images, and every game with a checked AppID | 195 games |
| [games/publishers.md](games/publishers.md) | Games outside Steam, or with a better source than Steam: Riot, Blizzard, Mojang, HoYoverse, EA, Ubisoft, Activision, Epic, Bungie, Jagex, GGG, Wargaming, Square Enix and others | 49 games |
| [free-stuff.md](free-stuff.md) | Free games: Epic, Steam (free to keep and free weekends), GOG, Xbox PC Game Pass (added / coming / leaving / EA Play) | 4 stores |
| [drivers.md](drivers.md) | NVIDIA Game Ready / Studio / Linux, AMD Radeon and chipset, Intel Arc and Arc Pro, Mesa | 9 sources |
| [ai.md](ai.md) | Claude, ChatGPT / OpenAI, Gemini, GitHub Copilot, Cursor, Ollama, OpenClaw, Grok, Artificial Analysis | 17 sources |
| [game-dev.md](game-dev.md) | Unreal Engine, Unity, Roblox, Blender, OBS Studio, Godot (4.x / 3.x, stable / pre-release), s&box | 7 tools |
| [notes/feed-quirks.md](notes/feed-quirks.md) | Odd behaviour found in real feeds (formats, dates, blocking, polling limits) | — |

## Rules for this database

1. **Official sources first.** The publisher's own feed, API or page always comes before anything else. Community feeds can disappear at any time, so they are listed only as a fallback and marked as such.
2. **Every link was opened.** A row shows the HTTP status it got and the date it was checked. Unchecked guesses are marked ❓ or "not tested".
3. **No data copied from other bots.** Similar Discord bots exist; nothing here comes from their sites, catalogs, texts or icons. Every source is the publisher's own.
4. **Only public GET requests.** No logins, no API keys, no private APIs, no bypassing of paywalls.

## Legend

| Mark | Meaning |
|---|---|
| ✅ 200 | opened on the check date and returned what is described |
| ⚠️ | works, but fragile (format changes often, or the data is incomplete) |
| ❌ | no usable official source, or blocked |
| ❓ | not researched yet |
| ↪ | redirect: follow it and use the new address |
| **RSS / Atom** | XFeeder can read it today. At most a `Filters` entry is needed. |
| JSON / NEXT / HTML / MD | needs an adapter in XFeeder (planned): plain JSON, JSON inside `__NEXT_DATA__`, a server-rendered HTML list, or a Markdown changelog |

## Using a link with XFeeder today

Any row marked **RSS** or **Atom** goes straight into a channel's feed list in `config.json`, with a filter when the row names one:

```json
{
  "Webhook": "${DISCORD_WEBHOOK_MAIN}",
  "RSS": ["https://github.com/ollama/ollama/releases.atom"],
  "Filters": { "Exclude": ["/-rc\\d+/"], "Fields": ["title"] }
}
```

Every Steam game works the same way through its store RSS, `https://store.steampowered.com/feeds/news/app/<AppID>/`.

The JSON, HTML and Markdown sources are documented here so the planned XFeeder trackers can use them.

## Keeping it up to date

- Last full check: **2026-11-23**.
- When a link breaks, add the new status and date to its row instead of deleting it, so the history stays visible.
- When adding a source, write down: the URL, the format, how to tell patches from other posts, the stable id to dedupe on, the status code you got, and a fallback.
