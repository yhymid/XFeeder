// main.js - Główny plik aplikacji XFeeder (Workshop → Moduły → Axios → RSSParser → Error)
const fs = require("fs");
const { sendMessage } = require("./src/message");
const { download } = require("./src/parsers/downloader");
const { getWithFallback } = require("./src/client");

// Import parserów
const { parseRSS } = require("./src/parsers/rss");
const { parseAtom } = require("./src/parsers/atom");
const { parseYouTube } = require("./src/parsers/youtube");
const { parseXML } = require("./src/parsers/xml");
const { parseJSON } = require("./src/parsers/json");
const { parseApiX } = require("./src/parsers/api_x");
const { parseFallback } = require("./src/parsers/fallback");
const { parseDiscord } = require("./src/parsers/discord");

// ------------------------------------------------------------
// KONFIGURACJA
// ------------------------------------------------------------
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

// ------------------------------------------------------------
// WORKSHOP (opcjonalnie)
// ------------------------------------------------------------
let workshopParsers = [];
try {
  const { loadWorkshop } = require("./src/workshop/loader");
  const workshopEnabled = config.Workshop?.Enabled !== false;
  if (workshopEnabled) {
    const loaded = loadWorkshop(
      { get: getWithFallback, send: sendMessage, utils: {}, config },
      "src/workshop"
    );
    workshopParsers = loaded.parsers || [];
    console.log(`[Workshop] Parserów: ${workshopParsers.length}`);
  } else {
    console.log("[Workshop] Wyłączony w configu.");
  }
} catch {
  console.log("[Workshop] Loader niedostępny – pomijam.");
}

// ------------------------------------------------------------
// CACHE
// ------------------------------------------------------------
let cache = {};
const cacheFile = "./cache.json";
if (fs.existsSync(cacheFile)) {
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    console.log(`[Cache] Załadowano (${Object.keys(cache).length} kanałów)`);
  } catch {
    console.warn("[Cache] Błąd przy wczytywaniu cache.json – tworzę nowy.");
    cache = {};
  }
}
function saveCache() {
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
}

// ------------------------------------------------------------
// HELPERY: normalizacja + limit cache + throttle wysyłki
// ------------------------------------------------------------
function normalizeLink(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const rm = new Set(["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_name","fbclid","gclid","yclid","mc_cid","mc_eid","ref"]);
    for (const k of Array.from(url.searchParams.keys())) {
      if (k.toLowerCase().startsWith("utm_") || rm.has(k)) url.searchParams.delete(k);
    }
    return url.toString();
  } catch {
    return u;
  }
}
function pushCache(list, ids, limit = 2000) {
  const prev = Array.isArray(list) ? list : [];
  const merged = [...ids, ...prev];
  if (merged.length > limit) merged.length = limit;
  return merged;
}
const SEND_DELAY_MS = 350; // mikro-opóźnienie anty-429

// ------------------------------------------------------------
// FUNKCJA GŁÓWNA: Pobieranie feeda (Workshop → Moduły → Axios → RSSParser → Error)
// ------------------------------------------------------------
const Parser = require("rss-parser");
const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win32; x64) XFeeder/1.2",
    "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});

async function fetchFeed(url) {
  let items = [];

  // 0) Downloader — jedna próba pobrania (re-użyjemy body w dalszych krokach)
  //    - dla non-http/https: ok:false, reason: UNSUPPORTED_PROTOCOL
  //    - dla 304: ok:true, notModified:true
  const dl = await download(url, { accept: "auto" });
  if (dl.ok && dl.notModified) {
    // brak zmian
    return [];
  }

  // 1⃣ Workshop — jeśli masz pluginy; body i nagłówki dostępne w ctx.body/ctx.headers dla chętnych
  const ctx = { get: getWithFallback, api: { config }, body: dl.ok ? dl.data : undefined, headers: dl.headers, status: dl.status };
  if (!/^https?:\/\//i.test(url)) {
    // Schemat nie-http/https → tylko Workshop
    for (const p of workshopParsers) {
      try {
        if (typeof p.test === "function") {
          const ok = await p.test(url, ctx);
          if (!ok) continue;
        }
        const parsed = await p.parse(url, ctx);
        if (parsed && parsed.length) {
          console.log(`[Parser:${p.name || "workshop"}] Sukces (${parsed.length}) → ${url}`);
          return parsed;
        }
        return [];
      } catch (err) {
        console.warn(`[Parser:${p.name || "workshop"}] Błąd: ${err.message}`);
      }
    }
    return [];
  }

  for (const p of workshopParsers) {
    try {
      if (typeof p.test === "function") {
        const ok = await p.test(url, ctx);
        if (!ok) continue;
      }
      const parsed = await p.parse(url, ctx);
      if (parsed && parsed.length) {
        console.log(`[Parser:${p.name || "workshop"}] Sukces (${parsed.length}) → ${url}`);
        return parsed;
      }
    } catch (err) {
      console.warn(`[Parser:${p.name || "workshop"}] Błąd: ${err.message}`);
    }
  }

  // 2⃣ Moduły (wbudowane) — sekwencyjnie, bez równoległości
  const parsersList = [parseYouTube, parseAtom, parseXML, parseJSON, parseApiX, parseRSS, parseFallback];
  for (const p of parsersList) {
    try {
      const parsed = await p(url, { get: getWithFallback });
      if (parsed && parsed.length) {
        console.log(`[Parser:${p.name}] Sukces (${parsed.length}) → ${url}`);
        return parsed;
      }
    } catch (err) {
      console.warn(`[Parser:${p.name}] Błąd: ${err.message}`);
    }
  }

  // 3⃣ “Axios/regex” — wykorzystaj body z Downloadera jeśli jest
  try {
    if (dl.ok && typeof dl.data === "string" && dl.data.includes("<item")) {
      const matches = [...dl.data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      items = matches.map((m) => {
        const getTag = (tag) =>
          (m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "").trim();
        return {
          title: getTag("title") || "Brak tytułu",
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
        console.log(`[Downloader/regex] Sukces (${items.length}) → ${url}`);
        return items;
      }
    } else if (!dl.ok) {
      // Downloader nie przyniósł body — zrób klasyczny fallback (1 żądanie)
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
            title: getTag("title") || "Brak tytułu",
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
          console.log(`[Axios-regex] Sukces (${items.length}) → ${url}`);
          return items;
        }
      }
    }
  } catch (err) {
    console.warn(`[Axios-regex] Błąd dla ${url}: ${err.message}`);
  }

  // 4⃣ RSSParser — użyj body z Downloadera jeśli jest, inaczej pobierz
  try {
    if (dl.ok && typeof dl.data === "string" && dl.data.trim()) {
      const feed = await parser.parseString(dl.data);
      if (feed?.items?.length) {
        items = feed.items.map((entry) => ({
          title: entry.title || "Brak tytułu",
          link: entry.link,
          contentSnippet: entry.contentSnippet || entry.content || "",
          isoDate: entry.isoDate || entry.pubDate || null,
          enclosure: entry.enclosure?.url || null,
          author: entry.creator || entry.author || null,
          guid: entry.guid || entry.link,
          categories: entry.categories || [],
        }));
        console.log(`[RSSParser] Sukces (${items.length}) → ${url}`);
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
            title: entry.title || "Brak tytułu",
            link: entry.link,
            contentSnippet: entry.contentSnippet || entry.content || "",
            isoDate: entry.isoDate || entry.pubDate || null,
            enclosure: entry.enclosure?.url || null,
            author: entry.creator || entry.author || null,
            guid: entry.guid || entry.link,
            categories: entry.categories || [],
          }));
          console.log(`[RSSParser] Sukces (${items.length}) → ${url}`);
          return items;
        }
      }
    }
  } catch (err) {
    console.warn(`[RSSParser] Błąd dla ${url}: ${err.message}`);
  }

  // 5⃣ Error
  console.error(`⚠️ Brak danych z ${url}`);
  return [];
}

// ------------------------------------------------------------
// SPRAWDZANIE KANAŁU
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
          `[Kanał ${index + 1}] Wysłano ${toSend.length} (Discord).`
        );
      }
    } catch (err) {
      console.error(`[Kanał ${index + 1}] Discord Error:`, err.message);
    }
  }

  // --- RSS/ATOM/YT (sekwencyjnie) ---
  if (channelConfig.RSS && Array.isArray(channelConfig.RSS)) {
    for (const feedUrl of channelConfig.RSS) {
      try {
        const items = await fetchFeed(feedUrl);
        if (!items.length) continue;

        if (!cache[index][feedUrl]) cache[index][feedUrl] = [];
        const newItems = items.filter((i) => {
          const key = normalizeLink(i.link || "");
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

          cache[index][feedUrl] = pushCache(
            cache[index][feedUrl],
            newItems.map((i) => normalizeLink(i.link || ""))
          );
          saveCache();
          console.log(
            `[Kanał ${index + 1}] Wysłano ${toSend.length} wpisów z ${feedUrl}.`
          );
        }
      } catch (err) {
        console.error(
          `[Kanał ${index + 1}] Błąd RSS ${feedUrl}:`,
          err.message
        );
      }
    }
  }
}

// ------------------------------------------------------------
// KOLEJKOWANIE (30s przerwy między kanałami — bez zmian)
// ------------------------------------------------------------
let allChannels = [];
for (const key of Object.keys(config)) {
  if (key.startsWith("channels")) allChannels = allChannels.concat(config[key]);
}
console.log(`[System] Kanałów do obsługi: ${allChannels.length}`);

let lastCheck = new Array(allChannels.length).fill(0);
let currentIndex = 0;
const delayBetweenChannels = 30000;

async function processNextChannel() {
  const channel = allChannels[currentIndex];
  const now = Date.now();
  const minutes = channel.TimeChecker || 30;
  const minDelay = minutes * 60 * 1000;

  if (now - lastCheck[currentIndex] >= minDelay) {
    console.log(
      `[Kolejka] Sprawdzam kanał ${currentIndex + 1}/${allChannels.length}`
    );
    try {
      await checkFeedsForChannel(currentIndex, channel);
      lastCheck[currentIndex] = Date.now();
    } catch (err) {
      console.error(
        `[Kolejka] Błąd kanału ${currentIndex + 1}:`,
        err.message
      );
    }
  }

  currentIndex = (currentIndex + 1) % allChannels.length;
  setTimeout(processNextChannel, delayBetweenChannels);
}
processNextChannel();

// ------------------------------------------------------------
// ZAMYKANIE
// ------------------------------------------------------------
process.on("SIGINT", () => {
  console.log("\n[Shutdown] Zapisuję cache i zamykam...");
  saveCache();
  process.exit(0);
});
process.on("uncaughtException", (error) => {
  console.error("[Critical Error]", error);
  saveCache();
});
console.log(`🚀 XFeeder v${require("./package.json").version} uruchomiony!`);