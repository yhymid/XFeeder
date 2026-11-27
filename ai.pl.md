# Narzędzia AI

[← Spis](README.pl.md) · [English](ai.md)

Sprawdzone **2026-11-23**. Żadne źródło tutaj nie wymaga przeglądarki bez interfejsu.

- **RSS / Atom:** XFeeder czyta je już dziś; tam, gdzie to zaznaczono, podziel je przez `Filters`.
- **MD:** zwykły changelog w Markdownie.
- **HTML:** strona renderowana po stronie serwera, potrzebne selektory.

## Podsumowanie

| Narzędzie | Najlepsze oficjalne źródło | Format | Stan | Podział / filtr | Zapasowe |
|---|---|---|---|---|---|
| Claude (API / platforma) | https://platform.claude.com/docs/en/release-notes/feed.xml | **RSS** | ✅ 200 (173 wpisy) | jeden wpis na datę + kotwica | strona przeglądu |
| Claude (aplikacje) | https://support.claude.com/en/articles/12138966-release-notes | HTML | ✅ 200 | `h2` miesiąc → `h3` data → `p > b` tytuł | — (bez RSS) |
| Claude Code | https://github.com/anthropics/claude-code/releases.atom | **Atom** | ✅ 200 | — (treści ~29 KB, przycinaj je) | https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md (1,4 MB, nie sprawdzaj często) |
| ChatGPT | https://help.openai.com/en/articles/6825453-chatgpt-release-notes | HTML | ✅ 200 | `h1` data → `h2` tytuł → `p` treść | — |
| Modele OpenAI | https://help.openai.com/en/articles/9624314-model-release-notes | HTML | ✅ 200 | ta sama struktura | — |
| Newsy OpenAI | https://openai.com/news/rss.xml | **RSS** | ✅ 200 (~1400 wpisów, 865 KB) | kategorie `Product\|Release\|API\|ChatGPT` | — |
| Changelog API OpenAI | https://developers.openai.com/api/docs/changelog.md | MD | ✅ 200 | `## Month` → `### Nov 19` | strona HTML |
| Gemini (aplikacja) | https://gemini.google/us/release-notes/?hl=en | HTML | ✅ 200 | karty `[class*=_releaseNoteCard_]`: `h2` data `YYYY.MM.DD`, `h3` funkcja | — |
| Gemini (blog) | https://blog.google/products-and-platforms/products/gemini/rss/ | **RSS** + `media:content` | ✅ 200 | — | — |
| Gemini API | https://aistudio.google.com/docs/changelog.md | MD | ✅ 200 | `## November 19, 2026 {% id="11-19-2026" %}`, gdzie id to stała kotwica | strona HTML |
| GitHub Copilot | https://github.blog/changelog/label/copilot/feed/ | **RSS** | ✅ 200 | kategoria `changelog-type`: Release / Improvement / Retired | https://github.blog/changelog/feed/ + Include `copilot` na kategoriach |
| Cursor | https://cursor.com/changelog/rss.xml | **RSS** | ✅ 200 (50 wpisów) | — | HTML `/changelog` |
| Ollama | https://github.com/ollama/ollama/releases.atom | **Atom** | ✅ 200 | stabilne: Exclude `/-rc\d+/` | GitHub API |
| OpenClaw | https://github.com/openclaw/openclaw/releases.atom | **Atom** | ✅ 200 | **Include `/^openclaw \d/`** (feed zawiera szum `release-publish/...`); beta: `/-beta\.\d+/` | GitHub API (flaga `prerelease`) |
| Grok / xAI (API) | https://docs.x.ai/developers/release-notes.md | MD | ✅ 200 | `## November` → `### title` (**bez dnia i roku**) | — |
| Grok / xAI (newsy) | https://x.ai/news | HTML | ✅ 200 | karty `a[href^="/news/"]` | https://x.ai/sitemap.xml (`/news/<slug>` + `lastmod`) |
| Artificial Analysis | https://artificialanalysis.ai/articles | HTML | ✅ 200 | karty `a[href^="/articles/"]` | `/changelog` (bardzo dużo szumu); stare API = 410, nowe API wymaga klucza |

## Uwagi

- **ChatGPT, modele OpenAI i aplikacje Claude** to artykuły pomocy w Intercomie: jedna długa strona, nie widać linków do pojedynczych wpisów, a `.rss` zwraca ten sam HTML. Jako id wpisu używaj nagłówka z datą.
- **Strona aplikacji Gemini**: język zależy od IP odwiedzającego (wróciła polska strona), więc zawsze dodawaj `?hl=en`. Nazwy klas to zahashowane moduły CSS, więc dopasowuj przez `[class*=…]`.
- **Feedy Copilota / changelogu GitHuba** mają tylko 10 wpisów, więc sprawdzaj je co najmniej co godzinę.
- **`releases.atom` na GitHubie** ma 10 wpisów. Repozytoria z wieloma kandydatami do wydania (Ollama, OpenClaw) mogą wypchnąć stabilne wydanie z feedu między sprawdzeniami, więc sprawdzaj co 15–30 min.
- **Newsy OpenAI** to najczystszy oficjalny feed, ale mniej szczegółowy niż notatki w centrum pomocy. Nie ma obrazków.
- **Artificial Analysis** nie ma feedu. Jego sitemap ma 3,5 MB, za dużo, żeby sprawdzać go często.
