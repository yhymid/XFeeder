// src/parsers/atom.js - Atom 1.0 parser (GitHub, Steam, Feedburner, etc.)
const xml2js = require("xml2js");
const { stripHtml } = require("string-strip-html");
const { parseDate } = require("./utils");

const parser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  attrkey: "ATTR",
  charkey: "VALUE",
  valueProcessors: [xml2js.processors.parseNumbers, xml2js.processors.parseBooleans],
});

/**
 * Parses Atom 1.0 feeds
 * 
 * @param {string} feedUrl - Feed URL
 * @param {object} httpClient - HTTP client with get method
 * @returns {Promise<Array>} Array of parsed items
 */
async function parseAtom(feedUrl, httpClient) {
  // Skip YouTube feeds (handled by dedicated parser)
  if (feedUrl.includes("youtube.com") || feedUrl.includes("yt:")) return [];

  try {
    const res = await httpClient.get(feedUrl, { timeout: 15000 });
    if (res?.status === 304) return [];
    
    const xml = res.data;
    const data = await parser.parseStringPromise(xml);

    if (!data.feed || !data.feed.entry) return [];

    const entries = Array.isArray(data.feed.entry)
      ? data.feed.entry
      : [data.feed.entry];

    const items = entries.map((entry) => {
      const title = entry.title
        ? stripHtml(entry.title.VALUE || entry.title).result.trim()
        : "No title";

      const isoDate = parseDate(entry.updated || entry.published);
      const author =
        entry.author?.name?.VALUE || entry.author?.name || data.feed?.author?.name || null;

      // --- LINK ---
      let link = null;
      if (Array.isArray(entry.link)) {
        const alt = entry.link.find((l) => l.ATTR?.rel === "alternate");
        if (alt) link = alt.ATTR.href;
      } else if (entry.link?.ATTR?.href) {
        link = entry.link.ATTR.href;
      }

      // --- MEDIA / IMAGES ---
      let image = null;

      if (entry["media:thumbnail"]?.ATTR?.url) {
        image = entry["media:thumbnail"].ATTR.url;
      } else if (entry["media:content"]?.ATTR?.url) {
        image = entry["media:content"].ATTR.url;
      } else if (Array.isArray(entry.link)) {
        const imgLink = entry.link.find(
          (l) =>
            l.ATTR?.rel === "enclosure" &&
            l.ATTR?.type?.startsWith("image/")
        );
        if (imgLink) image = imgLink.ATTR.href;
      }

      // --- DESCRIPTION / CONTENT ---
      const rawDescription =
        entry.summary?.VALUE ||
        entry.summary ||
        entry.content?.VALUE ||
        entry.content ||
        "";

      const contentSnippet = stripHtml(rawDescription).result.trim().substring(0, 500);

      return {
        title,
        link,
        contentSnippet,
        isoDate,
        enclosure: image,
        author,
        guid: entry.id || link || title,
        categories: entry.category
          ? Array.isArray(entry.category)
            ? entry.category
            : [entry.category]
          : [],
      };
    });

    return items.filter((i) => i.link || i.title);
  } catch (err) {
    console.warn(`[Atom Parser] Error for ${feedUrl}: ${err.message}`);
    return [];
  }
}

module.exports = { parseAtom };