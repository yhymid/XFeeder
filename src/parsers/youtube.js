// src/parsers/youtube.js — dedykowany parser YouTube Atom Feed
const xml2js = require("xml2js");
const { stripHtml } = require("string-strip-html");
const { parseDate } = require("./utils");

// Konfiguracja xml2js dla Atom/YouTube
const parser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  attrkey: "ATTR",
  charkey: "VALUE",
  valueProcessors: [xml2js.processors.parseNumbers, xml2js.processors.parseBooleans],
});

/**
 * Parsuje kanały Atom z YouTube (feeds/videos.xml)
 * @param {string} feedUrl URL feeda YouTube
 * @param {object} httpClient instancja axios
 * @returns {Array} lista przetworzonych wpisów
 */
async function parseYouTube(feedUrl, httpClient) {
  // Weryfikacja, czy to YouTube Feed
  if (!feedUrl.includes("youtube.com/feeds/") && !feedUrl.includes("youtu")) {
    return [];
  }

  try {
    const res = await httpClient.get(feedUrl, {
      headers: { Accept: "application/atom+xml, application/xml;q=0.9,*/*;q=0.8" },
      timeout: 15000,
    });

    const xml = res.data;
    const data = await parser.parseStringPromise(xml);

    if (!data?.feed?.entry) return [];

    const entries = Array.isArray(data.feed.entry)
      ? data.feed.entry
      : [data.feed.entry];

    const items = entries.map((entry) => {
      const title = stripHtml(entry.title?.VALUE || entry.title || "Brak tytułu").result;
      const isoDate = parseDate(entry.published || entry.updated || new Date());
      const author = entry.author?.name || entry["author"]?.VALUE || "Nieznany autor";

      // Identyfikator i link
      const videoId = entry["yt:videoId"];
      const link =
        entry.link?.ATTR?.href ||
        (videoId ? `https://www.youtube.com/watch?v=${videoId}` : feedUrl);

      // Opis — preferuj media:description
      const mediaGroup = entry["media:group"];
      const rawDescription =
        mediaGroup?.["media:description"] ||
        entry.summary?.VALUE ||
        entry.summary ||
        "";

      // Miniaturka (YouTube zawsze ma co najmniej kilka rozdzielczości)
      let image = null;
      if (mediaGroup?.["media:thumbnail"]) {
        const thumb = mediaGroup["media:thumbnail"];
        if (Array.isArray(thumb)) {
          // Weź najwyższą rozdzielczość (ostatni element)
          image = thumb[thumb.length - 1].ATTR?.url || thumb[0].ATTR?.url;
        } else if (thumb.ATTR?.url) {
          image = thumb.ATTR.url;
        }
      }
      // Fallback na statyczny link
      if (!image && videoId) {
        image = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
      }

      const contentSnippet = stripHtml(rawDescription).result
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 500);

      return {
        title,
        link,
        contentSnippet,
        isoDate,
        enclosure: image,
        author,
        guid: entry.id || videoId || link,
        categories: [],
      };
    });

    console.log(`[YouTube Parser] Sukces (${items.length}) → ${feedUrl}`);
    return items;
  } catch (error) {
    console.warn(`[YouTube Parser] Błąd przy pobieraniu ${feedUrl}: ${error.message}`);
    return [];
  }
}

module.exports = { parseYouTube };