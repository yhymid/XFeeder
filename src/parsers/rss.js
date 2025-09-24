// src/parsers/rss.js - Ostateczny Fallback Parser oparty na Regex
const { parseDate } = require("./utils"); 

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseRSS(feedUrl, httpClient) {
  try {
    const res = await httpClient.get(feedUrl);
    const data = res.data;

    const items = [...data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    if (!items.length) {
      const entries = [...data.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
      if (!entries.length) return [];
      return parseEntries(entries); 
    }

    return items.map((match) => {
      const block = match[1];

      const getTagContent = (tag) => {
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
        const found = block.match(regex);
        return found ? cleanCDATA(found[1].trim()) : "";
      };

      const getAttr = (tag, attr) => {
        const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]+)"[^>]*>`, "i");
        const found = block.match(regex);
        return found ? found[1] : null;
      };

      // Specjalna obsługa obrazków z <description> (np. Nitter)
      let imageUrl = getAttr('enclosure', 'url');
      if (!imageUrl) {
        const description = getTagContent('description') || getTagContent('content:encoded');
        const imgMatch = description.match(/<img[^>]+src="([^">]+)"/i);
        if (imgMatch) imageUrl = imgMatch[1];
      }

      const descriptionContent = getTagContent('content:encoded') || getTagContent('description');

      return {
        title: getTagContent("title"),
        link: getTagContent("link"),
        contentSnippet: descriptionContent.replace(/<[^>]+>/g, "").substring(0, 500).trim(),
        isoDate: parseDate(getTagContent("pubDate") || getTagContent("published") || getTagContent("updated")),
        enclosure: imageUrl,
        author: getTagContent("author") || getTagContent("dc:creator") || "", // ← Nitter
        guid: getTagContent("guid") || getTagContent("id"),
        categories: [],
      };
    });
  } catch (error) {
    return [];
  }
}

function parseEntries(entries) {
  return []; 
}

module.exports = { parseRSS };
