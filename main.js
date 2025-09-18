const axios = require("axios");
const Parser = require("rss-parser");
const FeedParser = require("feedparser");
const xml2js = require("xml2js");
const { XMLParser } = require("fast-xml-parser");
const fs = require("fs");
const { sendMessage } = require("./message");

// Wczytanie config.json
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

// Wczytanie/zainicjalizowanie cache.json
let cache = {};
const cacheFile = "./cache.json";

if (fs.existsSync(cacheFile)) {
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    console.log(`[Cache] Wczytano backup (${Object.keys(cache).length} kanałów)`);
  } catch (err) {
    console.error("[Cache] Błąd przy odczycie cache.json:", err.message);
    cache = {};
  }
}

// Zapis cache do pliku
function saveCache() {
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
}

// Pobieranie feedów (różne parsery)
async function fetchFeed(feedUrl) {
  let latestItems = [];

  try {
    const parser = new Parser();
    const feed = await parser.parseURL(feedUrl);
    if (feed.items && feed.items.length > 0) {
      latestItems = feed.items.map(item => ({
        title: item.title,
        link: item.link,
        contentSnippet: item.contentSnippet,
        isoDate: item.isoDate,
      }));
    }
  } catch (e) {}

  if (latestItems.length === 0) {
    try {
      const res = await axios.get(feedUrl, { responseType: "stream" });
      const feedparser = new FeedParser();
      latestItems = await new Promise((resolve, reject) => {
        const items = [];
        res.data.pipe(feedparser);
        feedparser.on("error", reject);
        feedparser.on("readable", function () {
          let item;
          while ((item = this.read())) {
            items.push({
              title: item.title,
              link: item.link,
              contentSnippet: item.description,
              isoDate: item.pubdate,
            });
          }
        });
        feedparser.on("end", () => resolve(items));
      });
    } catch (e) {}
  }

  if (latestItems.length === 0) {
    try {
      const res = await axios.get(feedUrl);
      const result = await xml2js.parseStringPromise(res.data);
      const items = result?.rss?.channel?.[0]?.item || [];
      latestItems = items.map(i => ({
        title: i.title[0],
        link: i.link[0],
        contentSnippet: i.description ? i.description[0] : "",
        isoDate: i.pubDate ? i.pubDate[0] : null,
      }));
    } catch (e) {}
  }

  if (latestItems.length === 0) {
    try {
      const res = await axios.get(feedUrl);
      const parser = new XMLParser();
      const jsonObj = parser.parse(res.data);
      const items = jsonObj?.rss?.channel?.item || [];
      latestItems = items.map(i => ({
        title: i.title,
        link: i.link,
        contentSnippet: i.description || "",
        isoDate: i.pubDate || null,
      }));
    } catch (e) {}
  }

  return latestItems;
}

async function checkFeedsForChannel(channelIndex, channelConfig) {
  if (!cache[channelIndex]) cache[channelIndex] = {};

  for (const feedUrl of channelConfig.RSS) {
    try {
      const items = await fetchFeed(feedUrl);
      if (items.length === 0) continue;

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

        // dopisz nowe linki do historii (BEZ kasowania starych)
        cache[channelIndex][feedUrl] = [
          ...newItems.map(i => i.link),
          ...cache[channelIndex][feedUrl]
        ];

        saveCache();
      }
    } catch (e) {
      console.error(`[Kanał ${channelIndex + 1}] Błąd RSS ${feedUrl}:`, e.message);
    }
  }
}

// Uruchamianie dla każdego kanału
config.channels.forEach((channelConfig, index) => {
  const intervalMs = channelConfig.TimeChecker * 60 * 1000;
  console.log(
    `[Kanał ${index + 1}] Start. Sprawdzanie co ${channelConfig.TimeChecker} minut.`
  );

  setInterval(() => checkFeedsForChannel(index, channelConfig), intervalMs);

  // pierwsze sprawdzenie zaraz po starcie
  checkFeedsForChannel(index, channelConfig);
});
