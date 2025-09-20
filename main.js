const fs = require("fs");
const axios = require("axios"); // Import axios dla globalnej konfiguracji
const { sendMessage } = require("./src/message");
const { parseRSS } = require("./src/parsers/rss");
const { parseAtom } = require("./src/parsers/atom");
const { parseYouTube } = require("./src/parsers/youtube");
const { parseXML } = require("./src/parsers/xml");
const { parseFallback } = require("./src/parsers/fallback");

// 🔧 GLOBALNA KONFIGURACJA AXIOS DLA WSZYSTKICH PARSERÓW
axios.defaults.timeout = 15000; // 15 sekund timeout
axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
axios.defaults.headers.common['Accept'] = 'application/rss+xml,application/atom+xml,application/xml,text/xml,application/json,text/html;q=0.9,*/*;q=0.8';
axios.defaults.headers.common['Accept-Language'] = 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7';
axios.defaults.headers.common['Accept-Encoding'] = 'gzip, deflate, br';
axios.defaults.headers.common['Connection'] = 'keep-alive';
axios.defaults.headers.common['Cache-Control'] = 'no-cache';
axios.defaults.headers.common['Pragma'] = 'no-cache';

// Dodaj również customową instancję dla rss-parser jeśli będzie potrzebna
const customAxios = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml',
  }
});

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
      // Dodaj krótkie opóźnienie między requestami aby uniknąć blokady
      if (feedUrl.includes('youtube.com')) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
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

// Obsługa graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Zapisuję cache i zamykam...');
  saveCache();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('[Critical Error] Nieoczekiwany błąd:', error);
  saveCache();
});