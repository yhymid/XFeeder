const fs = require("fs");
const { sendMessage } = require("./src/message");
const { parseRSS } = require("./src/parsers/rss");
const { parseAtom } = require("./src/parsers/atom");
const { parseYouTube } = require("./src/parsers/youtube");
const { parseXML } = require("./src/parsers/xml");
const { parseFallback } = require("./src/parsers/fallback");

// Config
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

// Cache
let cache = {};
const cacheFile = "./cache.json";
if (fs.existsSync(cacheFile)) {
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    console.log(`[Cache] Załadowano plik (${Object.keys(cache).length} kanałów)`);
  } catch {
    console.warn("[Cache] Błąd przy wczytywaniu cache.json, tworzę pusty.");
    cache = {};
  }
}
function saveCache() {
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
}

// Główna logika parsowania feedu
async function fetchFeed(url) {
  let items = [];

  items = await parseRSS(url);
  if (items.length) return items;

  items = await parseAtom(url);
  if (items.length) return items;

  items = await parseYouTube(url);
  if (items.length) return items;

  items = await parseXML(url);
  if (items.length) return items;

  items = await parseFallback(url);
  return items;
}

// Sprawdzenie dla kanału
async function checkFeedsForChannel(channelIndex, channelConfig) {
  if (!cache[channelIndex]) cache[channelIndex] = {};

  for (const feedUrl of channelConfig.RSS) {
    try {
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

        // dopisz linki do cache
        cache[channelIndex][feedUrl] = [
          ...newItems.map((i) => i.link),
          ...cache[channelIndex][feedUrl],
        ];
        saveCache();
      }
    } catch (err) {
      console.error(`[Kanał ${channelIndex + 1}] Błąd feeda ${feedUrl}:`, err.message);
    }
  }
}

// Uruchamianie
config.channels.forEach((channelConfig, index) => {
  const intervalMs = channelConfig.TimeChecker * 60 * 1000;
  console.log(`[Kanał ${index + 1}] Start. Sprawdzanie co ${channelConfig.TimeChecker} minut.`);

  setInterval(() => checkFeedsForChannel(index, channelConfig), intervalMs);

  checkFeedsForChannel(index, channelConfig);
});
