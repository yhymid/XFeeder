// src/parsers/youtube.js - Dedicated YouTube Atom Feed parser
const xml2js = require("xml2js");
const { stripHtml } = require("string-strip-html");
const { parseDate } = require("./utils");

// xml2js configuration for Atom/YouTube
const parser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  attrkey: "ATTR",
  charkey: "VALUE",
  valueProcessors: [xml2js.processors.parseNumbers, xml2js.processors.parseBooleans],
});

/**
 * Parses YouTube Atom feeds (feeds/videos.xml)
 * 
 * @param {string} feedUrl - YouTube feed URL
 * @param {object} httpClient - HTTP client with get method
 * @returns {Promise<Array>} Array of parsed items
 */
async function parseYouTube(feedUrl, httpClient) {
  // Verify this is a YouTube feed
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
      const title = stripHtml(entry.title?.VALUE || entry.title || "No title").result;
      const isoDate = parseDate(entry.published || entry.updated || new Date());
      const author = entry.author?.name || entry["author"]?.VALUE || "Unknown author";

      // Video ID and link
      const videoId = entry["yt:videoId"];
      const link =
        entry.link?.ATTR?.href ||
        (videoId ? `https://www.youtube.com/watch?v=${videoId}` : feedUrl);

      // Description - prefer media:description
      const mediaGroup = entry["media:group"];
      const rawDescription =
        mediaGroup?.["media:description"] ||
        entry.summary?.VALUE ||
        entry.summary ||
        "";

      // Thumbnail (YouTube always has multiple resolutions)
      let image = null;
      if (mediaGroup?.["media:thumbnail"]) {
        const thumb = mediaGroup["media:thumbnail"];
        if (Array.isArray(thumb)) {
          // Take highest resolution (last element)
          image = thumb[thumb.length - 1].ATTR?.url || thumb[0].ATTR?.url;
        } else if (thumb.ATTR?.url) {
          image = thumb.ATTR.url;
        }
      }
      // Fallback to static link
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

    console.log(`[YouTube Parser] Success (${items.length}) → ${feedUrl}`);
    return items;
  } catch (error) {
    console.warn(`[YouTube Parser] Error fetching ${feedUrl}: ${error.message}`);
    return [];
  }
}

module.exports = { parseYouTube };