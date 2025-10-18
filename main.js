// main.js - Główny plik aplikacji XFeeder (Moduły → Axios → RSSParser → Error)
const fs = require("fs");
const { sendMessage } = require("./src/message");
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
// FUNKCJA GŁÓWNA: Pobieranie feeda (Moduły → Axios → RSSParser → Error)
// ------------------------------------------------------------
const Parser = require("rss-parser");
const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) XFeeder/1.2",
    "Accept":
      "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});

async function fetchFeed(url) {
  let items = [];

  // 1️⃣ Moduły
  const parsers = [
    parseYouTube,
    parseAtom,
    parseXML,
    parseJSON,
    parseApiX,
    parseRSS,
    parseFallback,
  ];

  for (const p of parsers) {
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

  // 2️⃣ Axios fallback (prosty regexowy parser RSS)
  try {
    const res = await getWithFallback(url);
    if (
      res &&
      res.status === 200 &&
      typeof res.data === "string" &&
      res.data.includes("<item")
    ) {
      const matches = [...res.data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      items = matches.map((m) => {
        const getTag = (tag) =>
          (
            m[1].match(
              new RegExp(
                `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
                "i"
              )
            )?.[1] || ""
          ).trim();
        return {
          title: getTag("title") || "Brak tytułu",
          link: getTag("link"),
          contentSnippet: getTag("description")
            .replace(/<[^>]+>/g, "")
            .substring(0, 400),
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
  } catch (err) {
    console.warn(`[Axios-regex] Błąd dla ${url}: ${err.message}`);
  }

  // 3️⃣ RSS Parser (ostatnia próba)
  try {
    const feed = await parser.parseURL(url);
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
  } catch (err) {
    console.warn(`[RSSParser] Błąd dla ${url}: ${err.message}`);
  }

  // 4️⃣ Error
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
        }

        cache[index].discord = [
          ...newMsgs.map((m) => m.guid),
          ...cache[index].discord,
        ];
        saveCache();
        console.log(
          `[Kanał ${index + 1}] Wysłano ${toSend.length} (Discord).`
        );
      }
    } catch (err) {
      console.error(`[Kanał ${index + 1}] Discord Error:`, err.message);
    }
  }

  // --- RSS/ATOM/YT ---
  if (channelConfig.RSS && Array.isArray(channelConfig.RSS)) {
    for (const feedUrl of channelConfig.RSS) {
      try {
        const items = await fetchFeed(feedUrl);
        if (!items.length) continue;

        if (!cache[index][feedUrl]) cache[index][feedUrl] = [];
        const newItems = items.filter(
          (i) => !cache[index][feedUrl].includes(i.link)
        );

        if (newItems.length > 0) {
          const toSend = newItems.slice(0, channelConfig.RequestSend || 5);
          for (const entry of toSend.reverse()) {
            await sendMessage(
              channelConfig.Webhook,
              channelConfig.Thread,
              entry
            );
          }

          cache[index][feedUrl] = [
            ...newItems.map((i) => i.link),
            ...cache[index][feedUrl],
          ];
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
// KOLEJKOWANIE
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