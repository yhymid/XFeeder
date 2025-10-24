// src/parsers/atom.js
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
 * Parser Atom 1.0 (GitHub, Steam, Feedburner, StackOverflow, etc.)
 * @param {string} feedUrl - URL kanału Atom
 * @param {object} httpClient - instancja axios
 * @returns {Promise<Array>} Lista wpisów
 */
async function parseAtom(feedUrl, httpClient) {
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
        : "Brak tytułu";

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

      // --- MEDIA / OBRAZKI ---
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

      // --- OPIS / TREŚĆ ---
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
    console.warn(`[Atom Parser] Błąd dla ${feedUrl}: ${err.message}`);
    return [];
  }
}

module.exports = { parseAtom };