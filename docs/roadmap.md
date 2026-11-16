# Roadmap: ideas from comparable projects (2026-11)

Seventeen related projects were reviewed for features worth bringing into
XFeeder. This page records what was taken, what is a candidate and what was
rejected, so the review does not have to be repeated.

## Implemented in 3.0.0-alpha.1

| Feature | Source of the idea | Notes |
|---|---|---|
| First-check baseline (`FirstRunSend`) | rss-to-telegram-worker ("first fetch establishes a baseline"), FeedCord (only posts newer than start), rss-discord-bot (`lastPubDate`) | Without it a new feed, a new destination or an edited channel (new cache key) replayed the whole feed. |
| Channel `Filters` (include/exclude, regex, fields, case, max age) | FeedCord `PostFilters` (substring + `label:`), RSSHub `filter`/`filterout`/`filter_case_sensitive`/`filter_time` | Category matching covers FeedCord's `label:`. |
| Charset detection (header, `<?xml encoding>`, `<meta charset>`) | feedparser `encodings.py` | Fixed garbled ISO-8859-2/windows-1250 text. |
| Scrapling 0.5 compatibility, `solve_cloudflare` forwarded | Scrapling `docs/migrating-to-v0.5.md` | 0.5 removed `DynamicSession`; CDP moved to `RemoteSession`. |

## Candidates

| Feature | Source | Why / cost |
|---|---|---|
| Telegram `sendPhoto` with fallback to `sendMessage`; split long posts | rss-to-telegram-worker, RSS-to-Telegram (rsstt) | Posts with images look much better; Telegram rejects some image URLs, so the fallback is required. Medium. |
| Image proxy for hotlink-protected images | rsstt-img-relay | Only needed if Telegram/Discord fail to load images from some sites. Optional `ImageProxy` URL prefix. Small. |
| OPML import/export in the dashboard | rss-to-telegram-worker, FreshRSS | Bulk add feeds (e.g. from plenaryapp/awesome-rss-feeds). Medium (dashboard UI). |
| `og:image` lookup for entries without an image | FeedCord `ImageParserService` | One extra request per entry; opt-in per channel. Small. |
| Disable a feed after N consecutive failures and report it in the dashboard | rss-to-telegram-worker (10 failures), FeedCord `EnableAutoRemove` | XFeeder already has a circuit breaker; a visible "failing feeds" list is the missing part. Small. |
| `rsshub://route` shorthand with a configurable instance | RSSHub, RSSWorker | Convenience for sites without feeds. Small. |
| Reddit as a source (OAuth, `.json`) | discord-feed-bot | Reddit RSS is rate-limited for anonymous clients. Medium. |
| Mastodon/Misskey timelines | cf-fedi-timeline-rss-worker | Public Mastodon accounts already have `/@user.rss`; only home timelines need the API. Low priority. |
| Skip parsing when the body hash is unchanged | ifnmg-news-bot (`content_hash`) | Saves CPU for feeds without ETag/Last-Modified. Small, measure first. |

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
