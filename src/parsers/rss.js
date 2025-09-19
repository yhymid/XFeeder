const Parser = require("rss-parser");
const axios = require("axios");

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseRSS(feedUrl) {
  try {
    const parser = new Parser();
    const parsed = await parser.parseURL(feedUrl);

    if (!parsed?.items?.length) return [];

    return parsed.items.map((i) => ({
      title: cleanCDATA(i.title || ""),
      link: cleanCDATA(i.link || ""),
      contentSnippet: cleanCDATA(i.contentSnippet || i.content || i.description || ""),
      isoDate: cleanCDATA(i.isoDate || i.pubDate || ""),
      enclosure: i.enclosure?.url || null,
      author: i.creator || i.author || null,
      guid: i.guid || null,
      categories: i.categories || [],
    }));
  } catch {
    return [];
  }
}

module.exports = { parseRSS };
