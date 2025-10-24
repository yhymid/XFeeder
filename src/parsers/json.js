// src/parsers/json.js - Parser JSON Feed / RSS2JSON / API
const { parseDate } = require("./utils");
const { stripHtml } = require("string-strip-html");

async function parseJSON(feedUrl, httpClient) {
  try {
      const res = await httpClient.get(feedUrl, {
        headers: {
          Accept: "application/feed+json, application/json, text/json;q=0.9,*/*;q=0.8",
          "User-Agent": "XFeeder/1.2 (JSON Parser)",
        },
        timeout: 15000,
      });
      if (res?.status === 304) return [];
      const data = res.data;
    if (!data) return [];

    let items = [];

    if (data.version && data.items && Array.isArray(data.items)) {
      items = data.items.map((item) => {
        const title = item.title || "Brak tytułu";
        const link = item.url || item.external_url || null;
        const isoDate = parseDate(item.date_published || item.date_modified);
        const image = item.image || item.banner_image || null;
        const author = item.author?.name || data.author?.name || null;

        let rawDescription =
          item.content_text ||
          item.summary ||
          (item.content_html ? stripHtml(item.content_html).result : "");

        const description = (rawDescription || "").replace(/\s+/g, " ").trim();

        return {
          title,
          link,
          contentSnippet: description.substring(0, 500),
          isoDate,
          enclosure: image,
          author,
          guid: item.id || link || `${feedUrl}#${Math.random().toString(36).substring(2, 8)}`,
          categories: item.tags || [],
        };
      });

      console.log(`[JSONFeed] Sukces (${items.length}) → ${feedUrl}`);
      return items;
    }

    const list =
      data.items ||
      data.entries ||
      data.posts ||
      data.articles ||
      data.data ||
      [];

    if (Array.isArray(list) && list.length > 0) {
      items = list.map((entry) => {
        const title = entry.title || entry.name || "Brak tytułu";
        const link = entry.link || entry.url || null;
        const isoDate = parseDate(entry.pubDate || entry.published || entry.updated);
        const image =
          entry.enclosure?.link ||
          entry.thumbnail ||
          entry.image_url ||
          entry.image ||
          null;
        const author = entry.author || entry.creator || entry.user || null;

        let rawDescription =
          entry.description ||
          entry.summary ||
          entry.content ||
          entry.snippet ||
          "";

        rawDescription = stripHtml(rawDescription).result;
        const description = rawDescription.replace(/\s+/g, " ").trim();

        return {
          title,
          link,
          contentSnippet: description.substring(0, 500),
          isoDate,
          enclosure: image,
          author,
          guid: entry.guid || link || `${feedUrl}#${Math.random().toString(36).slice(2, 8)}`,
          categories: entry.categories || entry.tags || [],
        };
      });

      console.log(`[JSON API] Sukces (${items.length}) → ${feedUrl}`);
      return items;
    }

    console.warn(`[JSON Parser] Nie rozpoznano struktury JSON dla ${feedUrl}`);
    return [];
  } catch (err) {
    console.warn(`[JSON Parser] Błąd przy pobieraniu ${feedUrl}: ${err.message}`);
    return [];
  }
}

module.exports = { parseJSON };