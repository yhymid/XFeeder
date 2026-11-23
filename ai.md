# AI tools

[← Index](README.md)

Checked **2026-11-23**. No source here needs a headless browser.

- **RSS / Atom:** XFeeder reads it today; split it with `Filters` where noted.
- **MD:** a plain Markdown changelog.
- **HTML:** a server-rendered page that needs selectors.

## Summary

| Tool | Best official source | Format | Status | Split / filter | Fallback |
|---|---|---|---|---|---|
| Claude (API / platform) | https://platform.claude.com/docs/en/release-notes/feed.xml | **RSS** | ✅ 200 (173 items) | one item per date + anchor | overview page |
| Claude (apps) | https://support.claude.com/en/articles/12138966-release-notes | HTML | ✅ 200 | `h2` month → `h3` date → `p > b` title | — (no RSS) |
| Claude Code | https://github.com/anthropics/claude-code/releases.atom | **Atom** | ✅ 200 | — (bodies ~29 KB, cut them) | https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md (1.4 MB, do not poll often) |
| ChatGPT | https://help.openai.com/en/articles/6825453-chatgpt-release-notes | HTML | ✅ 200 | `h1` date → `h2` title → `p` body | — |
| OpenAI models | https://help.openai.com/en/articles/9624314-model-release-notes | HTML | ✅ 200 | same structure | — |
| OpenAI news | https://openai.com/news/rss.xml | **RSS** | ✅ 200 (~1400 items, 865 KB) | categories `Product\|Release\|API\|ChatGPT` | — |
| OpenAI API changelog | https://developers.openai.com/api/docs/changelog.md | MD | ✅ 200 | `## Month` → `### Nov 19` | HTML page |
| Gemini (app) | https://gemini.google/us/release-notes/?hl=en | HTML | ✅ 200 | cards `[class*=_releaseNoteCard_]`: `h2` date `YYYY.MM.DD`, `h3` feature | — |
| Gemini (blog) | https://blog.google/products-and-platforms/products/gemini/rss/ | **RSS** + `media:content` | ✅ 200 | — | — |
| Gemini API | https://aistudio.google.com/docs/changelog.md | MD | ✅ 200 | `## November 19, 2026 {% id="11-19-2026" %}`, where the id is a stable anchor | HTML page |
| GitHub Copilot | https://github.blog/changelog/label/copilot/feed/ | **RSS** | ✅ 200 | category `changelog-type`: Release / Improvement / Retired | https://github.blog/changelog/feed/ + Include `copilot` on categories |
| Cursor | https://cursor.com/changelog/rss.xml | **RSS** | ✅ 200 (50 items) | — | `/changelog` HTML |
| Ollama | https://github.com/ollama/ollama/releases.atom | **Atom** | ✅ 200 | stable: Exclude `/-rc\d+/` | GitHub API |
| OpenClaw | https://github.com/openclaw/openclaw/releases.atom | **Atom** | ✅ 200 | **Include `/^openclaw \d/`** (the feed contains `release-publish/...` noise); beta: `/-beta\.\d+/` | GitHub API (`prerelease` flag) |
| Grok / xAI (API) | https://docs.x.ai/developers/release-notes.md | MD | ✅ 200 | `## November` → `### title` (**no day, no year**) | — |
| Grok / xAI (news) | https://x.ai/news | HTML | ✅ 200 | cards `a[href^="/news/"]` | https://x.ai/sitemap.xml (`/news/<slug>` + `lastmod`) |
| Artificial Analysis | https://artificialanalysis.ai/articles | HTML | ✅ 200 | cards `a[href^="/articles/"]` | `/changelog` (very noisy); old API = 410, new API needs a key |

## Notes

- **ChatGPT, OpenAI models and Claude apps** are Intercom help articles: one long page, no per-entry links seen, and `.rss` returns the same HTML. Use the date heading as the entry id.
- **Gemini app page**: the language follows the visitor's IP (a Polish page came back), so always add `?hl=en`. Class names are hashed CSS modules, so match with `[class*=…]`.
- **Copilot / GitHub changelog** feeds hold only 10 items, so poll at least hourly.
- **GitHub `releases.atom`** holds 10 entries. Repos with many release candidates (Ollama, OpenClaw) can push a stable release out of the feed between polls, so poll every 15–30 min.
- **OpenAI news** is the cleanest official feed but less detailed than the help-center notes. It has no images.
- **Artificial Analysis** has no feed. Its sitemap is 3.5 MB, too big to poll often.
