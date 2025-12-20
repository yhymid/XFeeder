# XFeeder 2.0 — Complete Documentation

Modern, modular RSS/Atom/JSON/API feed reader and Discord message forwarder with sequential pipeline, stable HTTP client, plugin extensions (Workshop), and clean configuration.

This document describes XFeeder 2.0: how it works, configuration, plugin development, and troubleshooting.

## Table of Contents

- 0. What's New in 2.0
- 1. What is XFeeder and What Can It Do
- 2. Architecture and Data Flow
- 3. Installation and Running
- 4. Directory Structure
- 5. config.json Full Specification
- 6. Network and Stability (client.js)
- 7. Pipeline and Item Format
- 8. Discord Delivery (Components V2)
- 9. Cache and Deduplication
- 10. Workshop (Plugins)
- 11. Scheduling and Performance
- 12. Logging and Error Handling
- 13. Security and Sensitive Data
- 14. Troubleshooting (FAQ)
- 15. Best Practices and Tuning
- 16. Appendix: Example config.json

---

## 0. What's New in 2.0

- **Downloader (src/parsers/downloader.js)** at the beginning of the pipeline:
  - Single unified HTTP fetch (proxy/UA/If-None-Match/If-Modified-Since)
  - Data (body + headers) passed to downstream parsers and plugins

- **Guard for non-HTTP schemes** (e.g., quest://, freshrss://):
  - Non-HTTP URLs don't enter HTTP layer; Workshop plugins handle them first

- **RSSParser.parseURL → parseString**:
  - First fetch body via getWithFallback, then parseString on the same body (consistent HTTP client)

- **304 Not Modified = "no changes"**:
  - Treated as normal "no new items" (no exceptions, no UA fallbacks)

- **Link normalization and soft cache limit**:
  - Fewer duplicates (removes utm_* and hash), smaller cache.json (limit per key)

- **350ms micro-delay between sends**:
  - Lower risk of 429 on Discord webhooks

- **Maintained sequential pipeline and 30s delay between channels**:
  - No parallelism within a channel
  - Order: Downloader → Workshop → Modules → Axios/regex → RSSParser → Error

---

## 1. What is XFeeder and What Can It Do

### Reads and Publishes:
- RSS/Atom/XML/JSON/API (YouTube/Atom, JSONFeed, custom APIs)
- Discord channel messages (API; detects content, attachments, quotes)
- Custom sources via plugins (Workshop)

### Sends to Discord:
- Components V2 format (containers, text, galleries, buttons)
- Micro-delay between messages (default 350ms)

### Stability:
- Unified HTTP: proxy, UA fallbacks, conditional requests (ETag/Last-Modified), 304 as "OK"
- No parallelism in channels: order and lower 429 risk

### Extensibility:
- Workshop system: plugins with parsers (test/parse, priority), access to HTTP and config

---

## 2. Architecture and Data Flow

### Main Components

**main.js (core):**
- Channel scheduler (TimeChecker per channel, 30s between channels)
- Pipeline (sequential): Downloader → Workshop → Modules → Axios/regex → RSSParser → Error
- Deduplication and cache (link normalization, soft limit)
- Webhook delivery (Components V2) with micro-delay

**src/client.js:**
- Axios with proxy/UA fallback, Accept headers, If-None-Match/If-Modified-Since
- getWithFallback(url, opts?) returns 304 as "OK" (not modified)
- postWithFallback(url, data, opts?) for POST requests

**src/parsers/*:**
- Built-in parsers (YouTube, XML, Atom, JSON, RSS/regex, Fallback/HTML, Discord API, FreshRSS)

**src/parsers/downloader.js:**
- Initial HTTP GET (single location), returns status, body, headers (no temp files)

**src/message.js:**
- Building Components V2 payload
- No fallback to classic embeds in 2.0 (intentionally removed)

**src/workshop/*:**
- Loader (.plugin.js), plugins registering parsers

### Flow (RSS Channel)

1. Queue selects channel (every TimeChecker minutes); after processing: 30s delay to next
2. For each feed:
   - Downloader (GET, handles 304)
   - Workshop (plugins) — priority, can use ctx.body
   - Built-in parsers (sequential)
   - Axios/regex (uses Downloader body if available)
   - RSSParser.parseString (also uses body if available)
   - Send new items to webhook, update cache

### Flow (Discord Block)

1. parseDiscord fetches messages from ChannelIDs; dedup by guid
2. Sends messages (Components V2) with micro-delay
3. Updates cache

---

## 3. Installation and Running

### Requirements:
- Node.js 18+ (LTS recommended)
- npm/pnpm/yarn

### Installation:
npm install

### Running:
npm start
# or
node main.js

### Proxy (optional):
config.json → Proxy.Enabled: true, Proxy.Url: "http://127.0.0.1:8080"

### Environments:
- Systemd/Docker: ensure write permissions (cache/logs in project directory)

---

## 4. Directory Structure

xfeeder/
├── main.js                      # Core application
├── config.json                  # Your configuration (gitignored)
├── config.json.example          # Configuration template
├── package.json
├── LICENSE
├── README.md
├── documentation.md             # This file
│
├── src/
│   ├── client.js                # HTTP (proxy, UA fallback, ETag/Last-Modified)
│   ├── message.js               # Webhook delivery (Components V2)
│   │
│   ├── parsers/
│   │   ├── rss.js               # RSS 2.0 parser
│   │   ├── atom.js              # Atom parser
│   │   ├── xml.js               # Universal XML parser
│   │   ├── json.js              # JSON Feed parser
│   │   ├── youtube.js           # YouTube Atom parser
│   │   ├── api_x.js             # Generic API parser
│   │   ├── discord.js           # Discord messages parser
│   │   ├── freshrss.js          # FreshRSS (Fever API) parser
│   │   ├── fallback.js          # HTML scraping fallback
│   │   ├── downloader.js        # HTTP downloader
│   │   └── utils.js             # Shared utilities
│   │
│   └── workshop/
│       ├── loader.js            # Plugin loader
│       ├── documentation.md     # Plugin development guide
│       ├── workshop-cache.json  # KV storage for plugins (gitignored)
│       └── *.plugin.js          # Your custom plugins
│
├── cache.json                   # Deduplication cache (auto-generated, gitignored)
├── http-meta.json               # HTTP metadata cache (optional, gitignored)
│
└── Preview/                     # Screenshots for README
    ├── image.png
    ├── image2.png
    └── image3.png

---

## 5. config.json Full Specification

### Top-level Structure

{
  "Settings": { ... },
  "Auth": { ... },
  "Proxy": { ... },
  "Http": { ... },
  "FreshRSS": { ... },
  "Workshop": { ... },
  "channels": [ ... ],
  "channels2": [ ... ]
}

### Settings (optional)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| Logs | boolean | true | Enable file logging |
| MaxCachePerKey | number | 2000 | Soft cache limit per key |
| DelayBetweenSendsMs | number | 350 | Micro-delay between sends |
| ParserTimeoutMs | number | 15000 | Max time for single parser |
| DelayBetweenChannelsMs | number | 30000 | Delay between channels in queue |

### Auth (optional)

| Key | Type | Description |
|-----|------|-------------|
| Token | string | Discord user token (self-bot, violates ToS) |
| x-super-properties | string | Discord super properties header |
| cookie | string | Discord cookies |

### Proxy (optional)

| Key | Type | Description |
|-----|------|-------------|
| Enabled | boolean | Enable proxy |
| Url | string | Proxy URL (e.g., http://127.0.0.1:8080) |

### Http (optional)

| Key | Type | Description |
|-----|------|-------------|
| AcceptEncoding | string | Accept-Encoding header value |
| Cookies | object | Per-host cookies: { "host.com": "cookie=value;" } |
| ExtraHeaders | object | Per-URL pattern headers |

### FreshRSS (optional)

| Key | Type | Description |
|-----|------|-------------|
| Enabled | boolean | Enable FreshRSS support |
| Url | string | FreshRSS instance URL |
| Username | string | FreshRSS username |
| Password | string | FreshRSS password |
| feverKey | string | Fever API key (alternative to user/pass) |

### Workshop (optional)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| Enabled | boolean | true | Enable plugin system |
| Dir | string | src/workshop | Plugin directory |
| Plugins | object | {} | Per-plugin configuration |

### Channel Configuration

Each channel object:

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| Webhook | string | Yes | Discord webhook URL |
| Thread | string/null | No | Thread ID or null |
| RSS | array | Yes | Array of feed URLs |
| TimeChecker | number | No | Check interval in minutes (default: 30) |
| RequestSend | number | No | Max items to send per check (default: 5) |

### Discord Block (within channel)

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| GuildID | string | No | Guild ID for referer |
| Webhook | string | Yes | Webhook URL override |
| Thread | string/null | No | Thread ID override |
| ChannelIDs | array | Yes | Discord channel IDs to monitor |
| Limit | number | No | Messages to fetch (default: 50) |
| TimeChecker | number | No | Check interval override |
| RequestSend | number | No | Max items override |

### Notes:
- All keys starting with "channels" are loaded (case-insensitive)
- User token (self-bot) violates Discord ToS — use at your own risk

---

## 6. Network and Stability (client.js)

### Mechanisms

- **Proxy** (https-proxy-agent/http-proxy-agent v7)
- **Keep-Alive** (Node side, when not using proxy)
- **User-Agent fallbacks** (per request; don't modify global headers)
- **Conditional requests**:
  - ETag/If-None-Match and Last-Modified/If-Modified-Since
  - 304 returned as "OK" (not modified), no exception, no cooldown
- **Special headers** (can add via Http.ExtraHeaders)

### API

getWithFallback(url, opts?)
- opts.headers, opts.timeout, opts.responseType
- Returns response with status 304 as valid (not error)

postWithFallback(url, data, opts?)
- For POST requests (Fever API, etc.)

### Limitations
- Don't force "zstd" — Node won't decompress natively

---

## 7. Pipeline and Item Format

### Order (sequential)

1. Downloader (if HTTP/HTTPS)
2. Workshop (plugins; can use ctx.body from Downloader)
3. Modules (built-in): YouTube → Atom → XML → JSON → ApiX → RSS → Fallback
4. Axios/regex (simple RSS) — uses Downloader body if available
5. RSSParser.parseString — also uses Downloader body
6. Error (log "no data")

### Item (entry) — what parser returns

{
  "title": "string",
  "link": "string",
  "contentSnippet": "string",
  "isoDate": "string|null",
  "enclosure": "string|null",
  "author": "string|null",
  "guid": "string",
  "categories": ["string", "..."]
}

### Guidelines

- **link** — deduplication key (core normalizes: removes utm_* and hash)
- **isoDate** — use parseDate
- **contentSnippet** — clean with stripHtml and truncate to ~500-800 chars

---

## 8. Discord Delivery (Components V2)

### Layout:
- Container (type:17), text (type:10), galleries (type:12), buttons (type:1/2)
- **YouTube**: title + link + thumbnail + button
- **Discord messages**: card "💬" + content + attachments + quote + metadata
- **RSS/Atom/JSON**: title + snippet + media + author/date + button

### Notes:
- No fallback to classic embeds in 2.0 (intentional simplification)
- Delay between sends: DelayBetweenSendsMs (default 350ms)

---

## 9. Cache and Deduplication

### cache.json:
- Stores "seen" IDs/links per key (feed or Discord block)
- Soft limit: MaxCachePerKey (default 2000)

### Deduplication:
- **Feeds**: by normalized link
- **Discord**: by guid (message ID)
- **FreshRSS**: by guid (freshrss-{id})

### http-meta.json (optional):
- Stores ETag/Last-Modified metadata locally

---

## 10. Workshop (Plugins)

### Loading:
- src/workshop/loader.js — loads .plugin.js files from src/workshop directory
- Enabled by default (Workshop.Enabled !== false)
- Plugins run first in pipeline (HTTP/HTTPS or custom schemes)

### API Passed to Plugin:

| Property | Description |
|----------|-------------|
| api.id | Plugin identifier |
| api.http.get | getWithFallback function |
| api.utils.parseDate | Date parsing utility |
| api.utils.stripHtml | HTML stripping utility |
| api.send | Webhook delivery function |
| api.config | Full config.json (read-only) |
| api.log / api.warn / api.error | Namespaced logging |
| api.kv | Key-value storage per plugin |
| api.registerParser | Parser registration function |

### Context (ctx) in 2.0:

| Property | Description |
|----------|-------------|
| ctx.get | HTTP GET function |
| ctx.post | HTTP POST function |
| ctx.api | XFeeder API |
| ctx.body | Body from Downloader (if HTTP/HTTPS) |
| ctx.headers | Headers from Downloader |
| ctx.status | Status from Downloader |

### Minimal Plugin Example:

// src/workshop/hello.plugin.js
module.exports = {
  id: "hello",
  enabled: true,
  init(api) {
    api.registerParser({
      name: "hello-parser",
      priority: 55,
      test: (url) => url.includes("example.com/hello"),
      parse: async (url, ctx) => {
        const res = ctx.body ? { data: ctx.body } : await ctx.get(url);
        const data = res.data || {};
        return [{
          title: data.title || "No title",
          link: data.url || url,
          contentSnippet: api.utils.stripHtml(data.description || "").result.slice(0, 500),
          isoDate: api.utils.parseDate(data.date || new Date().toISOString()),
          enclosure: data.image || null,
          author: data.author || null,
          guid: data.id || data.url || url,
          categories: data.tags || []
        }];
      }
    });
  }
};

---

## 11. Scheduling and Performance

### Channel Queue:
- XFeeder merges channels*, channels2*, channels3* into one list
- For each channel: checks TimeChecker; after processing — DelayBetweenChannelsMs (default 30s)

### Within Channel:
- Sequential (one by one) feeds from RSS list
- No parallelism (intentional, lower 429 risk)
- Micro-throttle 350ms between sends

---

## 12. Logging and Error Handling

### Console (stdout/stderr):
- Success information and warnings/errors

### File Logging (if extended logger used):
- WarnLog.txt, ErrorLog.txt, CrashLog.txt (optional)
- Redacts sensitive data (tokens, cookies, webhooks)

### Shutdown:
- SIGINT: saves cache and exits
- uncaughtException / unhandledRejection: logs (if enabled), attempts cache save and exits

---

## 13. Security and Sensitive Data

### Discord User Token (self-bot):
- Violates Discord ToS — use at your own risk

### Webhooks:
- Treat as secrets (URL = secret)

### Cookies (e.g., cf_clearance):
- Keep only in config; avoid logging values
- Use Http.Cookies["host"] in config.json

---

## 14. Troubleshooting (FAQ)

### Nothing appears on Discord:
- Check Webhook and Thread
- Check logs "Parser:... Success (N)" — is pipeline returning anything?
- Deduplication: link might already be in cache (cache.json)

### Seeing 304 Not Modified:
- Not an error — means no new items (If-None-Match/If-Modified-Since working)

### 429 Too Many Requests:
- Wait (micro-delay already working), optionally increase DelayBetweenSendsMs
- Consider higher TimeChecker for channel

### 403/401 on feed:
- Check if feed requires cookies/headers
- Use Http.Cookies/Http.ExtraHeaders in config

### Custom scheme (e.g., quest://):
- Doesn't go to HTTP — only Workshop plugin handles it

### Discord parser returns 404:
- Provide correct ChannelIDs (GuildID is not channel ID)

---

## 15. Best Practices and Tuning

### TimeChecker:
- Adjust to source (e.g., 10-60 min)

### DelayBetweenSendsMs:
- 300-500ms (fewer 429s)

### MaxCachePerKey:
- 1000-5000 (depending on feed count)

### Link Normalization:
- Avoid links with variable query params

### Workshop:
- Aggressive test(url) (saves time)
- Don't return thousands of items at once
- Use ctx.body if Downloader already fetched content (fewer requests)

---

## 16. Appendix: Example config.json

{
  "Settings": {
    "Logs": true,
    "MaxCachePerKey": 2000,
    "DelayBetweenSendsMs": 350,
    "ParserTimeoutMs": 15000,
    "DelayBetweenChannelsMs": 30000
  },

  "Proxy": {
    "Enabled": false,
    "Url": "http://127.0.0.1:8080"
  },

  "Http": {
    "AcceptEncoding": "gzip, deflate, br",
    "Cookies": {
      "example.com": "cf_clearance=YOUR_CF_VALUE"
    },
    "ExtraHeaders": {
      "https://example.com/rss": {
        "If-Modified-Since": "Wed, 22 Oct 2025 17:00:09 +0000"
      }
    }
  },

  "Auth": {
    "Token": "YOUR_DISCORD_USER_TOKEN",
    "x-super-properties": "YOUR_BASE64_SUPER_PROPS",
    "cookie": "YOUR_COOKIE_STRING"
  },

  "FreshRSS": {
    "Enabled": false,
    "Url": "https://your-freshrss-instance.com",
    "Username": "your_username",
    "Password": "your_password",
    "feverKey": "your_fever_api_key"
  },

  "Workshop": {
    "Enabled": true,
    "Plugins": {
      "quest-tracking": {
        "MentionRole": "ROLE_ID_OPTIONAL"
      }
    }
  },

  "channels": [
    {
      "Webhook": "https://discord.com/api/webhooks/AAA/BBB",
      "Thread": null,
      "RSS": [
        "https://example.com/rss",
        "https://example.org/feed.xml",
        "quest://@me"
      ],
      "TimeChecker": 30,
      "RequestSend": 3,

      "Discord": {
        "GuildID": "YOUR_GUILD_ID",
        "Webhook": "https://discord.com/api/webhooks/CCC/DDD",
        "Thread": null,
        "ChannelIDs": ["CHANNEL_ID_1", "CHANNEL_ID_2"],
        "Limit": 5,
        "RequestSend": 1
      }
    }
  ],

  "channels2": [
    {
      "Webhook": "https://discord.com/api/webhooks/EEE/FFF",
      "RSS": [
        "https://github.com/user/repo/commits.atom",
        "freshrss://all"
      ],
      "TimeChecker": 60,
      "RequestSend": 2
    }
  ]
}

---

## Summary: Key Differences 2.0 vs 1.x

| Feature | 1.x | 2.0 |
|---------|-----|-----|
| HTTP handling | Multiple fetch points | Downloader at pipeline start |
| Non-HTTP schemes | Mixed handling | Workshop-only |
| RSSParser | parseURL | parseString on fetched body |
| 304 handling | Sometimes threw errors | Clean "no changes" |
| Link deduplication | Basic | Normalized (no utm_*, hash) |
| Cache limit | Unlimited | Soft limit per key |
| Send delay | None | 350ms micro-delay |
| Pipeline | Partially parallel | Fully sequential |
| Channel delay | Variable | Fixed 30s between channels |

---

Made with care for the RSS community.