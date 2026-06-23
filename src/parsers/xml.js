// src/parsers/xml.js - Universal XML parser (RSS + Atom auto-detection)
const xml2js = require("xml2js");
const { stripHtml } = require("string-strip-html");
const { parseDate } = require("./utils");

/**
 * Helper function to find first image URL in HTML string
 * 
 * @param {string} html - HTML string to search
 * @returns {string|null} Image URL or null
 */
function extractImageFromHTML(html) {
  if (!html) return null;
  const imgMatch = html.match(/<img\s+[^>]*src=["']([^"']+)["']/i);
  return imgMatch ? imgMatch[1] : null;
}

// xml2js configuration
const parser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  attrkey: "ATTR",
  charkey: "VALUE",
  valueProcessors: [xml2js.processors.parseNumbers, xml2js.processors.parseBooleans],
});

/**
 * Parses RSS/Atom/XML feeds - auto-detects structure
 * 
 * @param {string} feedUrl - Feed URL
 * @param {object} httpClient - HTTP client with get method
 * @returns {Promise<Array>} Array of parsed items
 */
async function parseXML(feedUrl, httpClient) {
  try {
    const res = await httpClient.get(feedUrl, {
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 15000,
    });
    
    if (res?.status === 304) return [];
    
    const xml = res.data;
    const data = await parser.parseStringPromise(xml);

    // --- STRUCTURE DETECTION ---
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
      // Some services skip <rss> wrapper
      type = "RSS (no-root)";
      entries = Array.isArray(data.channel.item)
        ? data.channel.item
        : [data.channel.item];
    }

    if (!entries.length) {
      console.warn(`[XML Parser] No elements detected in ${feedUrl}`);
      return [];
    }

    // --- ITEM MAPPING ---
    const items = entries.map((entry) => {
      const title = stripHtml(entry.title?.VALUE || entry.title || "No title").result;
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

      // Content priority
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

      // Image - priority order
      let image =
        entry.enclosure?.ATTR?.url ||
        entry["media:content"]?.ATTR?.url ||
        entry["media:thumbnail"]?.ATTR?.url ||
        extractImageFromHTML(rawContent) ||
        null;

      // Categories (if present)
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

    console.log(`[XML Parser] Success (${items.length}) [${type}] → ${feedUrl}`);
    return items;
  } catch (error) {
    console.warn(`[XML Parser] Error fetching ${feedUrl}: ${error.message}`);
    return [];
  }
}

module.exports = { parseXML };