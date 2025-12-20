# XFeeder 2.0 Workshop — How to Write Custom Plugins

This guide provides a simple, practical tutorial for creating XFeeder plugins. Starting with "Quick Start", followed by API explanation, ready-to-use templates, and common troubleshooting. Everything designed to get your first plugin running in 3-5 minutes.

---

## Table of Contents

- 0. Quick Start (3 minutes)
- 1. File Location and Loader Behavior
- 2. Plugin Structure and API
- 3. Registering a Parser (test + parse)
- 4. Item Object Format
- 5. Copy-Paste Templates
- 6. Plugin Configuration in config.json
- 7. KV Storage (Plugin Memory)
- 8. Sending to Discord (When and How)
- 9. Best Practices and Debugging
- 10. Advanced: Custom URL Schemes (e.g., apix://)
- 11. FAQ and Common Issues

---

## 0. Quick Start (3 minutes)

1. Create a file in directory:
   src/workshop/hello.plugin.js

2. Paste this template:

module.exports = {
  id: "hello",
  enabled: true,
  init(api) {
    api.registerParser({
      name: "hello-parser",
      priority: 55, // before RSS(60), after JSON(40-50)
      test: (url) => url.includes("example.com/hello"),
      parse: async (url, ctx) => {
        const res = await ctx.get(url);
        const data = res.data || {};
        const title = data.title || "No title";
        return [{
          title,
          link: data.url || url,
          contentSnippet: (api.utils.stripHtml(data.description || "").result || "").slice(0, 500),
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

3. In config.json add a URL matching your test:

{
  "channels": [
    {
      "Webhook": "https://discord.com/api/webhooks/XXX/YYY",
      "RSS": ["https://example.com/hello"],
      "TimeChecker": 1,
      "RequestSend": 1
    }
  ],
  "Workshop": { "Enabled": true }
}

4. Run: node main.js
   In logs you'll see plugin loading and URL parsing attempts.

That's it — you have a working plugin.

---

## 1. File Location and Loader Behavior

### Location:
All plugins go in: src/workshop

### Naming:
Loader only loads files ending with: .plugin.js
Examples: twitter.plugin.js, apix-custom.plugin.js

### Helper Files:
You can have helper modules alongside (parser.js, utils.js) and import them:
require("./parser")

Loader only auto-loads .plugin.js files.

### How It Works:
- Doesn't create directories, doesn't scan recursively (only one level: src/workshop)
- Logs: [Workshop] Plugin loaded: <id> (<file>)
- Disable a plugin by setting: module.exports.enabled = false

### Parser Queue:
Plugin parsers run first (sorted by priority), then built-in:
YouTube(10), Atom(20), XML(30), JSON(40), ApiX(50), RSS(60), Fallback(90)

---

## 2. Plugin Structure and API

A plugin exports an object or function. Simplest form:

module.exports = {
  id: "my-plugin-id",
  enabled: true,       // optional; default true
  init(api) {          // or: register(api), or export function returning parser
    // register parsers here
  }
};

### In init(api) you receive:

| Property | Description |
|----------|-------------|
| api.id | Plugin identifier (from id or filename) |
| api.http.get(url) | HTTP GET with shared headers/proxy/fallbacks |
| api.utils.parseDate(input) | Parse to ISO 8601 or null |
| api.utils.stripHtml(html) | Returns { result: "clean text" } |
| api.send(webhookUrl, threadId, entry) | Manual Discord send (see section 8) |
| api.config | Full config.json (read-only) |
| api.log / api.warn / api.error | Namespaced logging [WS:<pluginId>] |
| api.kv | Simple per-plugin storage (file: src/workshop/workshop-cache.json) |
| api.kv.get(key, default?) | Get value |
| api.kv.set(key, value) | Set value |
| api.kv.push(key, value, limit) | Prepend with limit (default 1000) |
| api.registerParser(def) | Register parser (see below) |

### Supported Plugin Forms (any of these):

- { id, init(api) { ... } }
- { id, register(api) { ... } }
- { id, parsers: [ { parse()... }, ... ] }
- module.exports = (api) => ({ name, parse, ... }) — function returning parser definition

---

## 3. Registering a Parser (test + parse)

Register a parser like this:

api.registerParser({
  name: "name-for-logs",
  priority: 50,          // lower number = earlier in queue
  test: (url, ctx) => true or false (optional),
  parse: async (url, ctx) => [Item, Item, ...]
});

### Priority:
Use to "jump ahead" of built-in parsers:
- < 60 runs before RSS
- > 90 becomes super-fallback

### test(url, ctx):
Quick filter. Return false when URL doesn't apply (saves time).
Tip: Use try/catch with new URL(url) — not every RSS entry is a valid URL.

### parse(url, ctx):
Do HTTP here and map data to Items.
- ctx.get — same as api.http.get (HTTP GET with shared headers/proxy)
- ctx.post — HTTP POST (for APIs)
- ctx.api — full XFeeder API if needed (kv/utils/send/config)
- ctx.body — body from Downloader (if HTTP/HTTPS, already fetched)
- ctx.headers — headers from Downloader
- ctx.status — status from Downloader

### When Your Parser Returns Items:
- XFeeder deduplicates them (by link for feeds; by guid for Discord)
- Sends up to RequestSend items to channel's Webhook and Thread
- Saves to cache (won't send same item twice)

---

## 4. Item Object Format

Each array element is an object:

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

### Guidelines:

| Field | Notes |
|-------|-------|
| title | If missing, use "No title" |
| link | REQUIRED (feeds deduplicate by link) |
| contentSnippet | No HTML (use stripHtml), truncate to ~500-800 chars |
| isoDate | Normalize via parseDate (handles ISO/RFC/Unix) |
| guid | Stable ID from API, or fallback to link |
| enclosure | Thumbnail/image (optional) |
| categories | Tags (optional) |

---

## 5. Copy-Paste Templates

### A) Minimal Plugin (JSON with items list)

module.exports = {
  id: "my-custom",
  init(api) {
    api.registerParser({
      name: "my-custom-parser",
      priority: 55,
      test: (url) => url.includes("/feed.json"),
      parse: async (url, ctx) => {
        const res = await ctx.get(url);
        const list = Array.isArray(res.data?.items) ? res.data.items : [];
        return list.map((it) => ({
          title: it.title || "No title",
          link: it.url || it.link,
          contentSnippet: api.utils.stripHtml(it.description || it.content || "").result.slice(0, 500),
          isoDate: api.utils.parseDate(it.date || it.published_at),
          enclosure: it.image || null,
          author: it.author || null,
          guid: it.id || it.url || it.link,
          categories: it.tags || []
        })).filter(x => x && x.link);
      }
    });
  }
};

### B) Parser with Custom URL Scheme (apix://)

module.exports = {
  id: "apix-custom",
  init(api) {
    api.registerParser({
      name: "apix-custom",
      priority: 48,
      test: (url) => url.startsWith("apix://"),
      parse: async (url, ctx) => {
        let target = decodeURIComponent(url.replace("apix://", ""));
        if (!/^https?:\/\//i.test(target)) target = "https://" + target;
        const res = await ctx.get(target);
        const data = res.data || {};
        const items = Array.isArray(data.items) ? data.items : [];
        return items.map(entry => ({
          title: entry.title || entry.name || "No title",
          link: entry.url || entry.link,
          contentSnippet: api.utils.stripHtml(entry.description || entry.summary || "").result.slice(0, 500),
          isoDate: api.utils.parseDate(entry.published_at || entry.updated_at),
          enclosure: entry.image || entry.thumbnail || null,
          author: entry.author?.name || entry.author || null,
          guid: entry.id || entry.url || entry.link,
          categories: entry.tags || entry.categories || []
        })).filter(x => x && x.link);
      }
    });
  }
};

### C) One Plugin — Multiple Parsers

module.exports = {
  id: "multi",
  init(api) {
    api.registerParser({
      name: "posts",
      priority: 45,
      test: (url) => url.includes("/posts"),
      parse: async (url, ctx) => { /* ... */ return []; }
    });
    api.registerParser({
      name: "comments",
      priority: 46,
      test: (url) => url.includes("/comments"),
      parse: async (url, ctx) => { /* ... */ return []; }
    });
  }
};

### D) Logic in Separate File

File: src/workshop/my-parser.js

module.exports.build = (api) => ({
  name: "my-separated-parser",
  priority: 52,
  test: (url) => url.includes("separated.example"),
  parse: async (url, ctx) => {
    const res = await ctx.get(url);
    const data = res.data || {};
    const list = Array.isArray(data.items) ? data.items : [];
    return list.map((it) => ({
      title: it.title || "No title",
      link: it.url || it.link,
      contentSnippet: api.utils.stripHtml(it.description || "").result.slice(0, 500),
      isoDate: api.utils.parseDate(it.date),
      enclosure: it.image || null,
      author: it.author || null,
      guid: it.id || it.url,
      categories: it.tags || []
    })).filter(x => x.link);
  }
});

File: src/workshop/my-separated.plugin.js

const builder = require("./my-parser");
module.exports = {
  id: "my-separated",
  init(api) {
    api.registerParser(builder.build(api));
  }
};

---

## 6. Plugin Configuration in config.json

### Store custom settings in:
config.Workshop.Plugins.<pluginId>

### Read in plugin:
const myCfg = api.config?.Workshop?.Plugins?.["my-custom"] || {};

### Example (config.json fragment):

{
  "Workshop": {
    "Enabled": true,
    "Plugins": {
      "my-custom": {
        "baseUrl": "https://api.example.com",
        "token": "abc123"
      }
    }
  }
}

---

## 7. KV Storage (Plugin Memory)

### Automatic storage in file:
src/workshop/workshop-cache.json

### Usage:

const lastRun = api.kv.get("last_run_at");          // read
api.kv.set("last_run_at", Date.now());              // write
api.kv.push("recent_ids", someId, 500);             // FIFO with limit

### When to Use:
- GUID/ID history
- Micro-locks
- Timers
- Small metadata

Don't store large datasets.

---

## 8. Sending to Discord (When and How)

### Standard Flow:
Parser ONLY returns Items — XFeeder handles sending (respects cache, RequestSend, Thread).

### Manual Sending (rare cases: "watcher" outside queue, e.g., cs2-blog-watcher):

await api.send(webhookUrl, threadIdOrNull, entryObject);

- entryObject should have same fields as Item (title/link/contentSnippet/...)

### Warning:
Using user tokens (self-bot) and Discord API calls outside webhooks violates ToS — do this at your own risk.

---

## 9. Best Practices and Debugging

### Performance:
- Filter aggressively in test(url) (faster pipeline)
- Always return array: [] even on error (use try/catch)

### Deduplication:
- Stable link/guid is key (avoid random query params; set fixed guid if needed)

### Content:
- contentSnippet: no HTML (stripHtml), truncate to ~500-800
- isoDate: use parseDate

### HTTP:
- Use ctx.get instead of raw axios — gets proxy, UA fallback, per-host handling
- Use ctx.body if Downloader already fetched (fewer requests)

### Logging:
- Use api.log/warn/error with meaningful descriptions — easier debugging

### Items:
- Don't return thousands at once (50-200 is enough)

### Priority:
- < 60 to intercept feed before RSS
- > 90 as last resort (after Fallback)

### Debug Tips:
- Check if config URL hits your test(url)
- Log list length after fetch: api.log("items:", list.length)
- If nothing comes through — test feed in browser/curl and check raw data

---

## 10. Advanced: Custom URL Schemes (e.g., apix://)

### You can force specific parser via custom scheme:

test: url.startsWith("apix://")
parse: decode to https:// then ctx.get

### Example:

test: (url) => url.startsWith("apix://"),
parse: async (url, ctx) => {
  let target = decodeURIComponent(url.replace("apix://", ""));
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  const res = await ctx.get(target);
  // ...
}

---

## 11. FAQ and Common Issues

### Plugin Doesn't Load

- Does file end with .plugin.js?
- Is it directly in src/workshop (no subdirectory scanning)?
- Is exports.enabled not false?
- Check logs: [Workshop] Plugin loaded: ...

### test(url) Never Matches

- Did you add exact URL to channels[*].RSS in config.json?
- Use try/catch with new URL(url) — some entries aren't full URLs
- Add temporary api.log("url", url) to see what's coming in

### Deduplication Not Working

- Feeds deduplicate by link — ensure link is stable (remove utm_* on your side if possible)
- For critical cases, set a stable guid

### How to Add Plugin-Only Config?

const cfg = api.config?.Workshop?.Plugins?.["your-plugin-id"] || {};

### Can I Have Multiple Parsers in One Plugin?

Yes — call api.registerParser(...) multiple times.

### Can I Send Manually (Without Returning Items)?

You can, but it's an exception (e.g., continuous "watchers"). Normally return Items — core handles the rest.

---

## Quick Reference: Parser Priority

| Priority | Parser |
|----------|--------|
| 10 | YouTube |
| 20 | Atom |
| 30 | XML |
| 40 | JSON |
| 50 | ApiX |
| 55 | Your Plugin (recommended) |
| 60 | RSS |
| 90 | Fallback |

---

## Quick Reference: Item Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | Entry title |
| link | string | Yes | Entry URL (dedup key) |
| contentSnippet | string | No | Plain text description |
| isoDate | string/null | No | ISO 8601 date |
| enclosure | string/null | No | Image/thumbnail URL |
| author | string/null | No | Author name |
| guid | string | Yes | Unique identifier |
| categories | array | No | Tags/categories |

---

That's everything — good luck! Check existing built-in parsers (src/parsers/*) and plugins in src/workshop to see how various data types map to the common Item format.