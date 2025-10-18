// src/parsers/xml.js — Uniwersalny parser XML (RSS + Atom)
const xml2js = require("xml2js");
const { stripHtml } = require("string-strip-html");
const { parseDate } = require("./utils");

/**
 * Pomocnicza funkcja do znajdowania pierwszego URL obrazka w HTML.
 */
function extractImageFromHTML(html) {
  if (!html) return null;
  const imgMatch = html.match(/<img\s+[^>]*src=["']([^"']+)["']/i);
  return imgMatch ? imgMatch[1] : null;
}

// Konfiguracja xml2js
const parser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  attrkey: "ATTR",
  charkey: "VALUE",
  valueProcessors: [xml2js.processors.parseNumbers, xml2js.processors.parseBooleans],
});

/**
 * Parsuje kanały RSS/Atom/XML — automatycznie wykrywa strukturę.
 * @param {string} feedUrl
 * @param {object} httpClient (axios)
 * @returns {Promise<Array>}
 */
async function parseXML(feedUrl, httpClient) {
  try {
    const res = await httpClient.get(feedUrl, {
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 15000,
    });

    const xml = res.data;
    const data = await parser.parseStringPromise(xml);

    // --- WYKRYWANIE STRUKTURY ---
    let entries = [];
    let type = "unknown";

    if (data?.rss?.channel?.item) {
      // RSS 2.0
      type = "RSS";
      entries = Array.isArray(data.rss.channel.item)
        ? data.rss.channel.item
        : [data.rss.channel.item];
    } else if (data?.feed?.entry) {
      // Atom
      type = "Atom";
      entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
    } else if (data?.channel?.item) {
      // Niektóre serwisy pomijają <rss>
      type = "RSS (no-root)";
      entries = Array.isArray(data.channel.item)
        ? data.channel.item
        : [data.channel.item];
    }

    if (!entries.length) {
      console.warn(`[XML Parser] Nie wykryto elementów w ${feedUrl}`);
      return [];
    }

    // --- MAPOWANIE WPISÓW ---
    const items = entries.map((entry) => {
      const title = stripHtml(entry.title?.VALUE || entry.title || "Brak tytułu").result;
      const link =
        entry.link?.ATTR?.href || entry.link?.VALUE || entry.link || feedUrl;
      const author =
        entry.author?.name ||
        entry.author?.VALUE ||
        entry["dc:creator"] ||
        entry.creator ||
        null;
      const pubDate =
        entry.pubDate || entry.published || entry.updated || entry.created || null;

      // Priorytet treści
      const rawContent =
        entry["content:encoded"]?.VALUE ||
        entry["content:encoded"] ||
        entry.content?.VALUE ||
        entry.content ||
        entry.summary?.VALUE ||
        entry.summary ||
        entry.description?.VALUE ||
        entry.description ||
        "";

      // Obrazek — kolejność priorytetu
      let image =
        entry.enclosure?.ATTR?.url ||
        entry["media:content"]?.ATTR?.url ||
        entry["media:thumbnail"]?.ATTR?.url ||
        extractImageFromHTML(rawContent) ||
        null;

      // Kategorie (jeśli występują)
      const categories = Array.isArray(entry.category)
        ? entry.category
        : entry.category
        ? [entry.category]
        : [];

      const contentSnippet = stripHtml(rawContent).result
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 500);

      return {
        title,
        link,
        contentSnippet,
        isoDate: parseDate(pubDate || new Date().toISOString()),
        enclosure: image,
        author,
        guid: entry.guid?.VALUE || entry.guid || link,
        categories,
      };
    });

    console.log(`[XML Parser] Sukces (${items.length}) [${type}] → ${feedUrl}`);
    return items;
  } catch (error) {
    console.warn(`[XML Parser] Błąd przy pobieraniu ${feedUrl}: ${error.message}`);
    return [];
  }
}

module.exports = { parseXML };