# Tworzenie gier: silniki i narzędzia

[← Spis](README.pl.md) · [English](game-dev.md)

Sprawdzone **2026-11-23**. Każde źródło poniżej jest oficjalne i wszystkie poza Unity działają z XFeederem już dziś, najwyżej z wpisem w `Filters`.

## Podsumowanie

| Narzędzie | Najlepsze oficjalne źródło | Format | Stan | Podział / filtr | Zapasowe |
|---|---|---|---|---|---|
| Unreal Engine | https://www.unrealengine.com/rss | **Atom** (wysyłany jako `text/html`) | ✅ 200 | tytuł `/Unreal Engine \d+\.\d+(\.\d+)? is now available/`, `/Preview/`; tytuły są opakowane w `<p>` | https://forums.unrealengine.com/c/general/announcements/49.rss |
| Unity | https://services.api.unity.com/unity/editor/release/v1/releases?limit=5&order=RELEASE_DATE_DESC&stream=LTS | JSON (potrzebny adapter) | ✅ 200 | `stream` = `LTS` / `SUPPORTED` / `BETA` / `ALPHA` / `TECH` | — |
| Roblox | https://devforum.roblox.com/c/updates/release-notes/62.rss | **RSS** | ✅ 200 | „Release Notes for NNN”, co tydzień | ogłoszenia: https://devforum.roblox.com/c/updates/announcements/36.rss, Include `/^\[(Full Release\|Beta\|Studio Beta\|Client Beta)\]/` |
| Blender | https://www.blender.org/feed/ | **RSS** | ✅ 200 | kategoria `release`; `/LTS/` w tytule | JSON buildów https://builder.blender.org/download/daily/?format=json&v=2; blog deweloperski https://code.blender.org/feed/ |
| OBS Studio | https://github.com/obsproject/obs-studio/releases.atom | **Atom** | ✅ 200 | stabilne: Exclude `/beta\|rc\|release candidate/` | GitHub API |
| Godot | https://github.com/godotengine/godot-builds/releases.atom | **Atom** | ✅ 200 | zobacz niżej | blog https://godotengine.org/rss.xml (kategoria `Pre-release`); tylko stabilne: https://github.com/godotengine/godot/releases.atom |
| s&box | https://sbox.game/rss/news | **RSS** + `media:thumbnail` | ✅ 200 (50 wpisów) | — (wszystkie posty z bloga deweloperskiego) | — (`/news` wymaga JS; `/news/rss` zwraca HTML) |

## Godot: cztery rodzaje aktualizacji

Tytuły w `godot-builds/releases.atom` to dokładne tagi wersji (`4.8-beta4`, `3.6.3-stable`, `3.7-dev1`):

| Rodzaj | Include na tytule |
|---|---|
| 4.x | `/^4\.[\d.]+-stable$/` |
| 4.x przedpremierowe | `/^4\..*-(dev\|beta\|rc)\d+$/` |
| 3.x (LTS) | `/^3\.[\d.]+-stable$/` |
| 3.x przedpremierowe | `/^3\..*-(dev\|beta\|rc)\d+$/` |

Treść wydania to krótki szablon bez obrazka. Pasujący post na blogu to `https://godotengine.org/article/dev-snapshot-godot-<wersja-z-myślnikami>/`. Wszystkie wersje z datami: https://raw.githubusercontent.com/godotengine/godot-website/master/_data/versions.yml.

## Unity: pola odpowiedzi

- Wpisy `results[]` mają:
  - `version` (`6000.3.29f1`): używaj go jako id
  - `releaseDate` (ISO)
  - `releaseNotes.url`: plik Markdown
  - `stream`, `recommended`, `unityHubDeepLink`
  - `downloads`: duże
- Każde wydanie ma około 100 KB przez `downloads`, więc zostaw `limit=5`.
- Link `https://unity.com/releases/editor/whats-new/<wersja bez sufiksu>` to przypuszczenie, niezweryfikowane.
- **Unikaj:** `unity.com/releases/editor/archive` wymaga JavaScriptu.

## Uwagi

- **Unreal:**
  - Feed to Atom wysyłany jako `text/html`, więc format trzeba rozpoznać po treści, nie po nagłówku.
  - `forums.unrealengine.com/c/announcements-and-releases/5.rss` daje 404.
  - Strona release notes w dokumentacji działa tylko z JS.
- **Blender:** `blender.org/download/releases/` jest za wyzwaniem Cloudflare (403) i nie jest potrzebny.
- **s&box:** daty mają niestandardową strefę czasową `Z` („Tue, 10 Nov 2026 21:00:00 Z”).
