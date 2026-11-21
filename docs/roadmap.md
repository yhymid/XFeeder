# Roadmap: ideas from comparable projects (2026-11)

**English** · [Polski](roadmap.pl.md)

Forty-three related projects (two rounds) were reviewed for features worth bringing into
XFeeder. This page records what was taken, what is a candidate and what was
rejected, so the review does not have to be repeated.

## Implemented in 3.0.0-alpha.1

| Feature | Source of the idea | Notes |
|---|---|---|
| `Solver` (FlareSolverr `/v1` API) | FlareSolverr, Byparr, TRAWL, byparr-proxy, fu_cloudflare | Opt-in per feed or `Auto`. |
| Feed autodiscovery from web pages | Easy-to-RSS, morss | History kept under the discovered URL. |
| Telegram photo with caption, text fallback | RSS-to-Telegram-Bot, rss-to-telegram-worker | `SendPhoto: false` to disable. |
| First-check baseline (`FirstRunSend`) | rss-to-telegram-worker ("first fetch establishes a baseline"), FeedCord (only posts newer than start), rss-discord-bot (`lastPubDate`) | Without it a new feed, a new destination or an edited channel (new cache key) replayed the whole feed. |
| Channel `Filters` (include/exclude, regex, fields, case, max age) | FeedCord `PostFilters` (substring + `label:`), RSSHub `filter`/`filterout`/`filter_case_sensitive`/`filter_time` | Category matching covers FeedCord's `label:`. |
| Charset detection (header, `<?xml encoding>`, `<meta charset>`) | feedparser `encodings.py` | Fixed garbled ISO-8859-2/windows-1250 text. |
| Scrapling 0.5 compatibility, `solve_cloudflare` forwarded | Scrapling `docs/migrating-to-v0.5.md` | 0.5 removed `DynamicSession`; CDP moved to `RemoteSession`. |

## Candidates

| Feature | Source | Why / cost |
|---|---|---|
| Split long Telegram posts; media groups for several images; Telegraph pages | RSS-to-Telegram-Bot, flowerss-bot | Photo with caption is done; long posts are still trimmed. Medium. |
| Per-channel message templates (Discord and Telegram) | TheLovinator1/discord-rss-bot | Custom layout per feed. Medium (Components V2). |
| Site extensions: Steam, YouTube details, WordPress API | TheLovinator1/discord-rss-bot | Richer posts for common sources. Medium per source. |
| Bluesky source | DiscordNewsBot, Tausendsassa | Public AT Protocol API, no login needed for public posts. Medium. |
| Quiet hours and digest mode | MultiNotify | Collect entries at night and post one summary. Medium. |
| Slack/Mattermost/generic webhooks | MultiNotify | Mattermost accepts Slack-style payloads. Small–medium. |
| Full-text content (fetch the article) | morss, rss-proxy | Better snippets and images for feeds with only titles. Medium; one request per entry. |
| TLS-impersonating HTTP client | curl-impersonate-rs, warpsock, cuimp | Only if `Solver`/Scrapling are not enough; adds native dependencies. |
| Image proxy for hotlink-protected images | rsstt-img-relay | Only needed if Telegram/Discord fail to load images from some sites. Optional `ImageProxy` URL prefix. Small. |
| OPML import/export in the dashboard | rss-to-telegram-worker, FreshRSS | Bulk add feeds (e.g. from plenaryapp/awesome-rss-feeds). Medium (dashboard UI). |
| `og:image` lookup for entries without an image | FeedCord `ImageParserService` | One extra request per entry; opt-in per channel. Small. |
| Disable a feed after N consecutive failures and report it in the dashboard | rss-to-telegram-worker (10 failures), FeedCord `EnableAutoRemove` | XFeeder already has a circuit breaker; a visible "failing feeds" list is the missing part. Small. |
| `rsshub://route` shorthand with a configurable instance | RSSHub, RSSWorker | Convenience for sites without feeds. Small. |
| Reddit as a source (OAuth, `.json`) | discord-feed-bot | Reddit RSS is rate-limited for anonymous clients. Medium. |
| Mastodon/Misskey timelines | cf-fedi-timeline-rss-worker | Public Mastodon accounts already have `/@user.rss`; only home timelines need the API. Low priority. |
| Skip parsing when the body hash is unchanged | ifnmg-news-bot (`content_hash`) | Saves CPU for feeds without ETag/Last-Modified. Small, measure first. |

### Second review (26 more projects)

Implemented from it: FlareSolverr-compatible `Solver` (FlareSolverr, Byparr,
TRAWL; using the returned page instead of replaying cookies follows
byparr-proxy, per-feed opt-in follows the fu_cloudflare TT-RSS plugin), feed
autodiscovery (Easy-to-RSS, morss) and Telegram photos (RSS-to-Telegram-Bot).

Not useful for XFeeder: legitbot (server-side bot verification), quality-
playbook (AI review method, not a feature), Major-project-list (exercise
list), vinted-bot (marketplace scraper; its silent first pass matches
`FirstRunSend`), Cloudflare proxy workers (framer-proxy-worker,
cloudflare-rss-feed-proxy, rss-proxy-aggregator: hosting-side), bimp
(closed runtime), simoniz0r/discord-rss-bot (shell script).

## Not planned

| Project | Reason |
|---|---|
| RSS-Bridge, RSSHub (self-hosting), RSSWorker | Feed *generators*; run them next to XFeeder and add their URLs as feeds. |
| FreshRSS | Full reader. WebSub needs a public callback endpoint, which a worker behind NAT does not have. |
| jpmonette/feed | Go library for *generating* feeds. |
| Jackett | Torrent indexer proxy (Torznab), unrelated. |
| plenaryapp/awesome-rss-feeds | Feed list, useful only together with OPML import. |
| Cloudflare Workers ports (cf-fedi-timeline, rss-cloudflare, rss-discord-bot, ifnmg-news-bot) | Different runtime (D1/KV/Queues/cron); their per-chat rate limiting is covered by the 500 ms send pacing and 429 handling. |
| Discord slash commands for managing feeds (ifnmg-news-bot, rss-discord-bot) | XFeeder posts through webhooks and is managed via `config.json`/dashboard; a bot application would be a new component. |
