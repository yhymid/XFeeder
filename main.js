// main.js - Główna logika XFeeder
const fs = require("fs");
const axios = require("axios");
const { sendMessage } = require("./src/message");
const { refetchAllFeeds } = require("./src/fetch");

// ----------------------------------------------------------------------
// IMPORT WSZYSTKICH PARSERÓW
// ----------------------------------------------------------------------
const { parseRSS } = require("./src/parsers/rss");
const { parseAtom } = require("./src/parsers/atom");
const { parseYouTube } = require("./src/parsers/youtube");
const { parseXML } = require("./src/parsers/xml");
const { parseJSON } = require("./src/parsers/json");
const { parseApiX } = require("./src/parsers/api_x");
const { parseFallback } = require("./src/parsers/fallback");
const { parseDiscord } = require("./src/parsers/discord");

// --- KONFIGURACJA I CACHE ---
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

let cache = {};
const cacheFile = "./cache.json";
if (fs.existsSync(cacheFile)) {
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    console.log(`[Cache] Załadowano plik (${Object.keys(cache).length} kanałów)`);
  } catch (e) {
    console.warn("[Cache] Błąd przy wczytywaniu cache.json, tworzę pusty. Błąd:", e.message);
    cache = {};
  }
}

function saveCache() {
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
}

// ----------------------------------------------------------------------
// 🏆 GLOBALNA KONFIGURACJA AXIOS
// ----------------------------------------------------------------------
axios.defaults.timeout = 15000;
axios.defaults.headers.common["User-Agent"] =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
axios.defaults.headers.common["Accept"] =
  "application/rss+xml,application/atom+xml,application/xml,text/xml,application/json,text/html;q=0.9,*/*;q=0.8";
axios.defaults.headers.common["Accept-Language"] = "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7";
axios.defaults.headers.common["Accept-Encoding"] = "gzip, deflate, br";
axios.defaults.headers.common["Connection"] = "keep-alive";
axios.defaults.headers.common["Cache-Control"] = "no-cache";
axios.defaults.headers.common["Pragma"] = "no-cache";

// ----------------------------------------------------------------------
// FUNKCJA: FETCH FEED
// ----------------------------------------------------------------------
async function fetchFeed(url) {
  let items = [];

  const parsers = [
    parseYouTube,
    parseAtom,
    parseApiX,
    parseXML,
    parseJSON,
    parseRSS,
    parseFallback,
  ];

  for (const parser of parsers) {
    try {
      items = await parser(url, axios);
      if (items.length) {
        console.log(`[Parser] Sukces: ${parser.name} dla ${url}`);
        return items;
      }
    } catch (err) {
      console.error(`[Parser] Błąd w ${parser.name} dla ${url}:`, err.message);
    }
  }

  return items;
}

// ----------------------------------------------------------------------
// FUNKCJA: SPRAWDZANIE KANAŁU
// ----------------------------------------------------------------------
async function checkFeedsForChannel(channelIndex, channelConfig) {
  if (!cache[channelIndex]) cache[channelIndex] = {};

  // --- OBSŁUGA DISCORDA ---
  if (channelConfig.Discord) {
    try {
      const discordMsgs = await parseDiscord(channelConfig.Discord);

      if (!cache[channelIndex].discord) cache[channelIndex].discord = [];

      const newMsgs = [];
      for (const msg of discordMsgs) {
        if (cache[channelIndex].discord.includes(msg.guid)) break;
        newMsgs.push(msg);
      }

      if (newMsgs.length > 0) {
        const toSend = newMsgs.slice(0, channelConfig.RequestSend || 5);
        for (const entry of toSend.reverse()) {
          await sendMessage(
            channelConfig.Discord.Webhook,
            channelConfig.Discord.Thread,
            entry
          );
        }

        cache[channelIndex].discord = [
          ...newMsgs.map(m => m.guid),
          ...cache[channelIndex].discord,
        ];
        saveCache();

        console.log(
          `[Kanał ${channelIndex + 1}] Wysłano ${toSend.length} nowych wiadomości z Discorda.`
        );
      }
    } catch (err) {
      console.error(`[Kanał ${channelIndex + 1}] Błąd w Discord parserze:`, err.message);
    }
  }

  // --- OBSŁUGA RSS/ATOM/YT ---
  if (channelConfig.RSS && Array.isArray(channelConfig.RSS)) {
    for (const feedUrl of channelConfig.RSS) {
      try {
        const baseDelay = feedUrl.includes("youtube.com") ? 2000 : 500;
        const jitter = Math.floor(Math.random() * 500);
        await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));

        const items = await fetchFeed(feedUrl);
        if (!items.length) continue;

        if (!cache[channelIndex][feedUrl]) cache[channelIndex][feedUrl] = [];

        const newItems = [];

        for (const item of items) {
          if (cache[channelIndex][feedUrl].includes(item.link)) break;
          newItems.push(item);
        }

        if (newItems.length > 0) {
          const toSend = newItems.slice(0, channelConfig.RequestSend);

          for (const entry of toSend.reverse()) {
            await sendMessage(channelConfig.Webhook, channelConfig.Thread, entry);
          }

          cache[channelIndex][feedUrl] = [
            ...newItems.map(i => i.link),
            ...cache[channelIndex][feedUrl],
          ];
          saveCache();

          console.log(
            `[Kanał ${channelIndex + 1}] Wysłano ${toSend.length} nowych wpisów z ${feedUrl}.`
          );
        }
      } catch (err) {
        console.error(`[Kanał ${channelIndex + 1}] Błąd feeda ${feedUrl}:`, err.message);
      }
    }
  }
}

// ----------------------------------------------------------------------
// START SYSTEMU
// ----------------------------------------------------------------------

// Zbierz wszystkie kanały (channels, channels2, channels3 itd.)
let allChannels = [];
for (const key of Object.keys(config)) {
  if (key.startsWith("channels")) {
    allChannels = allChannels.concat(config[key]);
  }
}

console.log(`[System] Łącznie kanałów do obsługi: ${allChannels.length}`);

// Zapamiętujemy kiedy ostatni raz sprawdzano kanał
let lastCheck = new Array(allChannels.length).fill(0); // timestampy

let currentIndex = 0;
const delayBetweenChannels = 30000; // 30 sekund między kolejnymi kanałami

async function processNextChannel() {
  const channelConfig = allChannels[currentIndex];
  const now = Date.now();

  // Pobierz TimeChecker dla danego kanału (domyślnie 30 minut)
  const minutes = channelConfig.TimeChecker || channelConfig.Discord?.TimeChecker || 30;
  const minDelay = minutes * 60 * 1000;

  if (now - lastCheck[currentIndex] >= minDelay) {
    console.log(`[Kolejka] Sprawdzam kanał ${currentIndex + 1}/${allChannels.length} (co ${minutes} min)`);

    try {
      await checkFeedsForChannel(currentIndex, channelConfig);
      lastCheck[currentIndex] = Date.now(); // aktualizacja ostatniego sprawdzenia
    } catch (err) {
      console.error(`[Kolejka] Błąd w kanale ${currentIndex + 1}:`, err.message);
    }
  } else {
    console.log(`[Kolejka] Pomijam kanał ${currentIndex + 1}, jeszcze nie czas (czekam ${minutes} min)`);
  }

  currentIndex = (currentIndex + 1) % allChannels.length; // kolejny kanał

  setTimeout(processNextChannel, delayBetweenChannels);
}

// Start
processNextChannel();


// ----------------------------------------------------------------------
// ZAMYKANIE
// ----------------------------------------------------------------------
process.on("SIGINT", () => {
  console.log("\n[Shutdown] Zapisuję cache i zamykam...");
  saveCache();
  process.exit(0);
});

process.on("uncaughtException", error => {
  console.error("[Critical Error] Nieoczekiwany błąd, zapisuję cache:", error);
  saveCache();
});

console.log(`🚀 XFeeder v${require("./package.json").version} uruchomiony!`);