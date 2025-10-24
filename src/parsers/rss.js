// src/parsers/rss.js - Hybrydowy parser RSS/Atom (Regex + heurystyki)
const { parseDate } = require("./utils");
const { stripHtml } = require("string-strip-html");

/**
 * Usuwa CDATA i niepotrzebne znaki.
 */
function cleanCDATA(str) {
  if (!str) return "";
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

/**
 * Pobiera zawartość z tagu XML, z uwzględnieniem CDATA.
 */
function getTag(block, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(regex);
  return match ? cleanCDATA(match[1]) : "";
}

/**
 * Pobiera wartość atrybutu z tagu (np. <enclosure url="...">)
 */
function getAttr(block, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]+)"[^>]*>`, "i");
  const match = block.match(regex);
  return match ? match[1] : null;
}

/**
 * Parsuje kanały RSS/Atom używając prostego regexowego fallbacka.
 * @param {string} feedUrl URL feeda
 * @param {object} httpClient axios
 * @returns {Promise<Array>} Lista wpisów
 */
async function parseRSS(feedUrl, httpClient) {
  try {
      const res = await httpClient.get(feedUrl, {
        headers: { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8" },
        timeout: 15000,
      });
      if (res?.status === 304) return [];
      const data = res.data;

    if (!data || typeof data !== "string") {
      console.warn(`[RSS Parser] Brak danych lub niepoprawny format: ${feedUrl}`);
      return [];
    }

    // 1️⃣ Najpierw spróbuj RSS (<item>)
    let blocks = [...data.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
    let type = "RSS";

    // 2️⃣ Jeśli nie ma <item>, spróbuj Atom (<entry>)
    if (blocks.length === 0) {
      blocks = [...data.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
      type = "Atom";
    }

    if (blocks.length === 0) {
      console.warn(`[RSS Parser] Nie znaleziono elementów <item> ani <entry> dla ${feedUrl}`);
      return [];
    }

    const items = blocks.map((match) => {
      const block = match[1];

      const title = getTag(block, "title") || "Brak tytułu";
      const link = getTag(block, "link") || getAttr(block, "link", "href") || feedUrl;
      const description =
        getTag(block, "content:encoded") ||
        getTag(block, "description") ||
        getTag(block, "summary") ||
        "";

      // 🖼️ Znajdź obrazek: enclosure, media, img w HTML
      let image =
        getAttr(block, "enclosure", "url") ||
        getAttr(block, "media:content", "url") ||
        getAttr(block, "media:thumbnail", "url") ||
        null;

      if (!image && description) {
        const imgMatch = description.match(/<img[^>]+src="([^">]+)"/i);
        if (imgMatch) image = imgMatch[1];
      }

      const author =
        getTag(block, "author") ||
        getTag(block, "dc:creator") ||
        getTag(block, "creator") ||
        "";

      const pubDate =
        getTag(block, "pubDate") ||
        getTag(block, "published") ||
        getTag(block, "updated") ||
        null;

      const contentSnippet = stripHtml(description)
        .result.replace(/\s+/g, " ")
        .trim()
        .substring(0, 500);

      return {
        title: stripHtml(title).result.trim(),
        link,
        contentSnippet,
        isoDate: parseDate(pubDate || new Date().toISOString()),
        enclosure: image,
        author,
        guid: getTag(block, "guid") || link,
        categories: [],
      };
    });

    console.log(`[RSS Parser] Sukces (${items.length}) [${type}] → ${feedUrl}`);
    return items;
  } catch (error) {
    console.warn(`[RSS Parser] Błąd przy pobieraniu ${feedUrl}: ${error.message}`);
    return [];
  }
}

module.exports = { parseRSS };