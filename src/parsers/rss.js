// src/parsers/rss.js - Hybrid RSS/Atom parser (Regex + heuristics)
const { parseDate } = require("./utils");
const { stripHtml } = require("string-strip-html");

/**
 * Removes CDATA wrappers and trims string
 * 
 * @param {string} str - Input string
 * @returns {string} Cleaned string
 */
function cleanCDATA(str) {
  if (!str) return "";
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

/**
 * Extracts content from XML tag, handling CDATA
 * 
 * @param {string} block - XML block to search in
 * @param {string} tag - Tag name to find
 * @returns {string} Tag content or empty string
 */
function getTag(block, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(regex);
  return match ? cleanCDATA(match[1]) : "";
}

/**
 * Extracts attribute value from XML tag
 * 
 * @param {string} block - XML block to search in
 * @param {string} tag - Tag name
 * @param {string} attr - Attribute name
 * @returns {string|null} Attribute value or null
 */
function getAttr(block, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]+)"[^>]*>`, "i");
  const match = block.match(regex);
  return match ? match[1] : null;
}

/**
 * Parses RSS/Atom feeds using simple regex fallback.
 * 
 * @param {string} feedUrl - Feed URL
 * @param {object} httpClient - HTTP client with get method
 * @returns {Promise<Array>} Array of parsed items
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
      console.warn(`[RSS Parser] No data or invalid format: ${feedUrl}`);
      return [];
    }

    // 1) Try RSS (<item>) first
    let blocks = [...data.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
    let type = "RSS";

    // 2) If no <item>, try Atom (<entry>)
    if (blocks.length === 0) {
      blocks = [...data.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
      type = "Atom";
    }

    if (blocks.length === 0) {
      console.warn(`[RSS Parser] No <item> or <entry> elements found for ${feedUrl}`);
      return [];
    }

    const items = blocks.map((match) => {
      const block = match[1];

      const title = getTag(block, "title") || "No title";
      const link = getTag(block, "link") || getAttr(block, "link", "href") || feedUrl;
      const description =
        getTag(block, "content:encoded") ||
        getTag(block, "description") ||
        getTag(block, "summary") ||
        "";

      // Find image: enclosure, media, img in HTML
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

    console.log(`[RSS Parser] Success (${items.length}) [${type}] → ${feedUrl}`);
    return items;
  } catch (error) {
    console.warn(`[RSS Parser] Error fetching ${feedUrl}: ${error.message}`);
    return [];
  }
}

module.exports = { parseRSS };