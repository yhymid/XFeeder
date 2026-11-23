# Game development: engines and tools

[← Index](README.md)

Checked **2026-11-23**. Every source below is official, and all but Unity work with XFeeder today, at most with a `Filters` entry.

## Summary

| Tool | Best official source | Format | Status | Split / filter | Fallback |
|---|---|---|---|---|---|
| Unreal Engine | https://www.unrealengine.com/rss | **Atom** (sent as `text/html`) | ✅ 200 | title `/Unreal Engine \d+\.\d+(\.\d+)? is now available/`, `/Preview/`; titles are wrapped in `<p>` | https://forums.unrealengine.com/c/general/announcements/49.rss |
| Unity | https://services.api.unity.com/unity/editor/release/v1/releases?limit=5&order=RELEASE_DATE_DESC&stream=LTS | JSON (needs an adapter) | ✅ 200 | `stream` = `LTS` / `SUPPORTED` / `BETA` / `ALPHA` / `TECH` | — |
| Roblox | https://devforum.roblox.com/c/updates/release-notes/62.rss | **RSS** | ✅ 200 | "Release Notes for NNN", weekly | announcements: https://devforum.roblox.com/c/updates/announcements/36.rss, Include `/^\[(Full Release\|Beta\|Studio Beta\|Client Beta)\]/` |
| Blender | https://www.blender.org/feed/ | **RSS** | ✅ 200 | category `release`; `/LTS/` in the title | builds JSON https://builder.blender.org/download/daily/?format=json&v=2; dev blog https://code.blender.org/feed/ |
| OBS Studio | https://github.com/obsproject/obs-studio/releases.atom | **Atom** | ✅ 200 | stable: Exclude `/beta\|rc\|release candidate/` | GitHub API |
| Godot | https://github.com/godotengine/godot-builds/releases.atom | **Atom** | ✅ 200 | see below | blog https://godotengine.org/rss.xml (category `Pre-release`); stable only: https://github.com/godotengine/godot/releases.atom |
| s&box | https://sbox.game/rss/news | **RSS** + `media:thumbnail` | ✅ 200 (50 items) | — (all dev-blog posts) | — (`/news` needs JS; `/news/rss` returns HTML) |

## Godot: the four update types

Titles in `godot-builds/releases.atom` are exact version tags (`4.8-beta4`, `3.6.3-stable`, `3.7-dev1`):

| Type | Include on the title |
|---|---|
| 4.x | `/^4\.[\d.]+-stable$/` |
| 4.x pre-release | `/^4\..*-(dev\|beta\|rc)\d+$/` |
| 3.x (LTS) | `/^3\.[\d.]+-stable$/` |
| 3.x pre-release | `/^3\..*-(dev\|beta\|rc)\d+$/` |

The release body is a short template with no image. The matching blog post is `https://godotengine.org/article/dev-snapshot-godot-<version-with-dashes>/`. All versions with dates: https://raw.githubusercontent.com/godotengine/godot-website/master/_data/versions.yml.

## Unity: response fields

- `results[]` entries have:
  - `version` (`6000.3.29f1`): use it as the id
  - `releaseDate` (ISO)
  - `releaseNotes.url`: a Markdown file
  - `stream`, `recommended`, `unityHubDeepLink`
  - `downloads`: large
- Each release is about 100 KB because of `downloads`, so keep `limit=5`.
- The link `https://unity.com/releases/editor/whats-new/<version without suffix>` is a guess and not verified.
- **Avoid:** `unity.com/releases/editor/archive` needs JavaScript.

## Notes

- **Unreal:**
  - The feed is Atom served as `text/html`, so detect the format from the body, not the header.
  - `forums.unrealengine.com/c/announcements-and-releases/5.rss` is 404.
  - The docs release notes page is JS-only.
- **Blender:** `blender.org/download/releases/` is behind a Cloudflare challenge (403) and isn't needed.
- **s&box:** dates use a non-standard `Z` time zone ("Tue, 10 Nov 2026 21:00:00 Z").
