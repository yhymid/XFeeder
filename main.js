// main.js - XFeeder 2.1 Main Application
// Pipeline: Workshop → Modules → Axios → RSSParser → Error

const fs = require("fs");
const { sendMessage } = require("./src/message");
const { download } = require("./src/parsers/downloader");
const { getWithFallback, postWithFallback } = require("./src/client");
const { loadConfig } = require("./src/config-loader");

// Parser imports
const { parseRSS } = require("./src/parsers/rss");
const { parseAtom } = require("./src/parsers/atom");
const { parseYouTube } = require("./src/parsers/youtube");
const { parseXML } = require("./src/parsers/xml");
const { parseJSON } = require("./src/parsers/json");
const { parseApiX } = require("./src/parsers/api_x");
const { parseFallback } = require("./src/parsers/fallback");
const { parseDiscord } = require("./src/parsers/discord");

// ------------------------------------------------------------
// CONFIGURATION
// ------------------------------------------------------------
const config = loadConfig("./config.json");

// ------------------------------------------------------------
// WORKSHOP (optional)
// ------------------------------------------------------------
let workshopParsers = [];
try {
  const { loadWorkshop } = require("./src/workshop/loader");
  const workshopEnabled = config.Workshop?.Enabled !== false;
  const workshopDir = config.Workshop?.Dir || "src/workshop";
  if (workshopEnabled) {
    const loaded = loadWorkshop(
      { get: getWithFallback, send: sendMessage, utils: {}, config },
      workshopDir
    );
    workshopParsers = loaded.parsers || [];
    console.log(`[Workshop] Parsers loaded: ${workshopParsers.length}`);
  } else {
    console.log("[Workshop] Disabled in config.");
  }
} catch {
  console.log("[Workshop] Loader not available — skipping.");
}

// ------------------------------------------------------------
// CACHE
// ------------------------------------------------------------
let cache = {};
const cacheFile = "./cache.json";
if (fs.existsSync(cacheFile)) {
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    console.log(`[Cache] Loaded (${Object.keys(cache).length} channels)`);
  } catch {
    console.warn("[Cache] Error reading cache.json — creating new.");
    cache = {};
  }
}

function saveCache() {
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
}

// ------------------------------------------------------------
// HELPERS: normalization + cache limit + send throttle
// ------------------------------------------------------------

/**
 * Normalizes link by removing tracking parameters (utm_*, fbclid, etc.)
 */
function normalizeLink(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const removeParams = new Set([
      "utm_source", "utm_medium", "utm_campaign", "utm_term",
      "utm_content", "utm_name", "fbclid", "gclid", "yclid",
      "mc_cid", "mc_eid", "ref"
    ]);
    for (const k of Array.from(url.searchParams.keys())) {
      if (k.toLowerCase().startsWith("utm_") || removeParams.has(k)) {
        url.searchParams.delete(k);
      }
    }
    return url.toString();
  } catch {
    return u;
  }
}

/**
 * Generates cache key for entry
 */
function getCacheKey(item) {
  return normalizeLink(item.link || item.guid || "");
}

/**
 * Adds new IDs to cache with limit
 */
function pushCache(list, ids, limit = 2000) {
  const prev = Array.isArray(list) ? list : [];
  const merged = [...ids, ...prev];
  if (merged.length > limit) merged.length = limit;
  return merged;
}

// Anti-429 micro-delay
const SEND_DELAY_MS = 350;

// ------------------------------------------------------------
// MAIN FUNCTION: Fetch feed (Workshop → Modules → Axios → RSSParser → Error)
// ------------------------------------------------------------
const Parser = require("rss-parser");
const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) XFeeder/2.1",
    "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});

async function fetchFeed(url) {
  let items = [];

  // 0) Downloader — single fetch attempt (reuse body in later steps)
  //    - for non-http/https: ok:false, reason: UNSUPPORTED_PROTOCOL
  //    - for 304: ok:true, notModified:true
  const dl = await download(url, { accept: "auto" });
  if (dl.ok && dl.notModified) {
    // No changes
    return [];
  }

  // 1) Workshop — if you have plugins; body and headers available in ctx.body/ctx.headers
  const ctx = {
    get: getWithFallback,
    post: postWithFallback,
    api: { config },
    body: dl.ok ? dl.data : undefined,
    headers: dl.headers,
    status: dl.status
  };

  if (!/^https?:\/\//i.test(url)) {
    // Non-http/https scheme → Workshop only
    for (const p of workshopParsers) {
      try {
        if (typeof p.test === "function") {
          const ok = await p.test(url, ctx);
          if (!ok) continue;
        }
        const parsed = await p.parse(url, ctx);
        if (parsed && parsed.length) {
          console.log(`[Parser:${p.name || "workshop"}] Success (${parsed.length}) → ${url}`);
          return parsed;
        }
        return [];
      } catch (err) {
        console.warn(`[Parser:${p.name || "workshop"}] Error: ${err.message}`);
      }
    }
    return [];
  }

  // Workshop for HTTP/HTTPS
  for (const p of workshopParsers) {
    try {
      if (typeof p.test === "function") {
        const ok = await p.test(url, ctx);
        if (!ok) continue;
      }
      const parsed = await p.parse(url, ctx);
      if (parsed && parsed.length) {
        console.log(`[Parser:${p.name || "workshop"}] Success (${parsed.length}) → ${url}`);
        return parsed;
      }
    } catch (err) {
      console.warn(`[Parser:${p.name || "workshop"}] Error: ${err.message}`);
    }
  }

  // 2) Built-in modules — sequential, no parallelism
  const parsersList = [
    parseYouTube,
    parseAtom,
    parseXML,
    parseJSON,
    parseApiX,
    parseRSS,
    parseFallback
  ];

  for (const p of parsersList) {
    try {
      const parsed = await p(url, { get: getWithFallback });
      if (parsed && parsed.length) {
        console.log(`[Parser:${p.name}] Success (${parsed.length}) → ${url}`);
        return parsed;
      }
    } catch (err) {
      console.warn(`[Parser:${p.name}] Error: ${err.message}`);
    }
  }

  // 3) "Axios/regex" — use Downloader body if available
  try {
    if (dl.ok && typeof dl.data === "string" && dl.data.includes("<item")) {
      const matches = [...dl.data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      items = matches.map((m) => {
        const getTag = (tag) =>
          (m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "").trim();
        return {
          title: getTag("title") || "No title",
          link: getTag("link"),
          contentSnippet: (getTag("description") || "").replace(/<[^>]+>/g, "").substring(0, 400),
          isoDate: getTag("pubDate") || null,
          enclosure: null,
          author: getTag("author") || "",
          guid: getTag("guid") || getTag("link"),
          categories: [],
        };
      });
      if (items.length) {
        console.log(`[Downloader/regex] Success (${items.length}) → ${url}`);
        return items;
      }
    } else if (!dl.ok) {
      // Downloader didn't get body — do classic fallback (1 request)
      const res = await getWithFallback(url, {
        headers: {
          "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (res && res.status === 304) return [];
      if (res && res.status === 200 && typeof res.data === "string" && res.data.includes("<item")) {
        const matches = [...res.data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
        items = matches.map((m) => {
          const getTag = (tag) =>
            (m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "").trim();
          return {
            title: getTag("title") || "No title",
            link: getTag("link"),
            contentSnippet: (getTag("description") || "").replace(/<[^>]+>/g, "").substring(0, 400),
            isoDate: getTag("pubDate") || null,
            enclosure: null,
            author: getTag("author") || "",
            guid: getTag("guid") || getTag("link"),
            categories: [],
          };
        });
        if (items.length) {
          console.log(`[Axios-regex] Success (${items.length}) → ${url}`);
          return items;
        }
      }
    }
  } catch (err) {
    console.warn(`[Axios-regex] Error for ${url}: ${err.message}`);
  }

  // 4) RSSParser — use Downloader body if available, otherwise fetch
  try {
    if (dl.ok && typeof dl.data === "string" && dl.data.trim()) {
      const feed = await parser.parseString(dl.data);
      if (feed?.items?.length) {
        items = feed.items.map((entry) => ({
          title: entry.title || "No title",
          link: entry.link,
          contentSnippet: entry.contentSnippet || entry.content || "",
          isoDate: entry.isoDate || entry.pubDate || null,
          enclosure: entry.enclosure?.url || null,
          author: entry.creator || entry.author || null,
          guid: entry.guid || entry.link,
          categories: entry.categories || [],
        }));
        console.log(`[RSSParser] Success (${items.length}) → ${url}`);
        return items;
      }
    } else {
      const res = await getWithFallback(url, {
        headers: {
          "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (res && res.status === 304) return [];
      if (res && typeof res.data === "string" && res.data.trim()) {
        const feed = await parser.parseString(res.data);
        if (feed?.items?.length) {
          items = feed.items.map((entry) => ({
            title: entry.title || "No title",
            link: entry.link,
            contentSnippet: entry.contentSnippet || entry.content || "",
            isoDate: entry.isoDate || entry.pubDate || null,
            enclosure: entry.enclosure?.url || null,
            author: entry.creator || entry.author || null,
            guid: entry.guid || entry.link,
            categories: entry.categories || [],
          }));
          console.log(`[RSSParser] Success (${items.length}) → ${url}`);
          return items;
        }
      }
    }
  } catch (err) {
    console.warn(`[RSSParser] Error for ${url}: ${err.message}`);
  }

  // 5) Error
  console.error(`⚠️ No data from ${url}`);
  return [];
}

// ------------------------------------------------------------
// CHANNEL CHECKING
// ------------------------------------------------------------
async function checkFeedsForChannel(index, channelConfig) {
  if (!cache[index]) cache[index] = {};

  // --- Discord ---
  if (channelConfig.Discord) {
    try {
      const discordMsgs = await parseDiscord(channelConfig.Discord);
      if (!cache[index].discord) cache[index].discord = [];

      const newMsgs = discordMsgs.filter(
        (msg) => !cache[index].discord.includes(msg.guid)
      );

      if (newMsgs.length > 0) {
        const toSend = newMsgs.slice(0, channelConfig.RequestSend || 5);
        for (const entry of toSend.reverse()) {
          await sendMessage(
            channelConfig.Discord.Webhook,
            channelConfig.Discord.Thread,
            entry
          );
          await new Promise(r => setTimeout(r, SEND_DELAY_MS));
        }

        cache[index].discord = pushCache(
          cache[index].discord,
          newMsgs.map((m) => m.guid)
        );
        saveCache();
        console.log(
          `[Channel ${index + 1}] Sent ${toSend.length} (Discord).`
        );
      }
    } catch (err) {
      console.error(`[Channel ${index + 1}] Discord Error:`, err.message);
    }
  }

  // --- RSS/ATOM/YT (sequential) ---
  if (channelConfig.RSS && Array.isArray(channelConfig.RSS)) {
    for (const feedUrl of channelConfig.RSS) {
      try {
        const items = await fetchFeed(feedUrl);
        if (!items.length) continue;

        if (!cache[index][feedUrl]) cache[index][feedUrl] = [];

        // Use getCacheKey() for proper deduplication
        const newItems = items.filter((i) => {
          const key = getCacheKey(i);
          return key && !cache[index][feedUrl].includes(key);
        });

        if (newItems.length > 0) {
          const toSend = newItems.slice(0, channelConfig.RequestSend || 5);
          for (const entry of toSend.reverse()) {
            await sendMessage(
              channelConfig.Webhook,
              channelConfig.Thread,
              entry
            );
            await new Promise(r => setTimeout(r, SEND_DELAY_MS));
          }

          // Save to cache with proper key
          cache[index][feedUrl] = pushCache(
            cache[index][feedUrl],
            newItems.map((i) => getCacheKey(i))
          );
          saveCache();
          console.log(
            `[Channel ${index + 1}] Sent ${toSend.length} items from ${feedUrl}.`
          );
        }
      } catch (err) {
        console.error(
          `[Channel ${index + 1}] RSS Error ${feedUrl}:`,
          err.message
        );
      }
    }
  }
}

// ------------------------------------------------------------
// QUEUE (30s delay between channels)
// ------------------------------------------------------------
let allChannels = [];
for (const key of Object.keys(config)) {
  if (key.toLowerCase().startsWith("channels")) {
    if (Array.isArray(config[key])) {
      allChannels = allChannels.concat(config[key]);
    }
  }
}
allChannels = allChannels.filter((ch) => ch && typeof ch === "object");
console.log(`[System] Channels to process: ${allChannels.length}`);
if (allChannels.length === 0) {
  console.error("[System] No valid channels configured. Queue not started.");
} else {
  let lastCheck = new Array(allChannels.length).fill(0);
  let currentIndex = 0;
  const delayBetweenChannels = 30000;

  async function processNextChannel() {
    const channel = allChannels[currentIndex];
    if (!channel) {
      currentIndex = (currentIndex + 1) % allChannels.length;
      setTimeout(processNextChannel, delayBetweenChannels);
      return;
    }

    const now = Date.now();
    const minutes = channel.TimeChecker || 30;
    const minDelay = minutes * 60 * 1000;

    if (now - lastCheck[currentIndex] >= minDelay) {
      console.log(
        `[Queue] Checking channel ${currentIndex + 1}/${allChannels.length}`
      );
      try {
        await checkFeedsForChannel(currentIndex, channel);
        lastCheck[currentIndex] = Date.now();
      } catch (err) {
        console.error(
          `[Queue] Channel ${currentIndex + 1} error:`,
          err.message
        );
      }
    }

    currentIndex = (currentIndex + 1) % allChannels.length;
    setTimeout(processNextChannel, delayBetweenChannels);
  }
  processNextChannel();
}

// ------------------------------------------------------------
// SHUTDOWN
// ------------------------------------------------------------
process.on("SIGINT", () => {
  console.log("\n[Shutdown] Saving cache and exiting...");
  saveCache();
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error("[Critical Error]", error);
  saveCache();
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Unhandled Rejection]", reason);
});

console.log(`🚀 XFeeder v${require("./package.json").version} started!`);
