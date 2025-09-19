const axios = require("axios");

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseFallback(feedUrl) {
  try {
    const res = await axios.get(feedUrl);
    const data = res.data;

    const items = [...data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    if (!items.length) return [];

    return items.map((match) => {
      const block = match[1];

      const getTag = (tag) => {
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
        const found = block.match(regex);
        return found ? cleanCDATA(found[1].trim()) : "";
      };

      const getAttr = (tag, attr) => {
        const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]+)"[^>]*>`, "i");
        const found = block.match(regex);
        return found ? found[1] : null;
      };

      return {
        title: getTag("title"),
        link: getTag("link"),
        contentSnippet: getTag("description"),
        isoDate: getTag("pubDate"),
        enclosure: getAttr("enclosure", "url"),
        author: getTag("author"),
        guid: getTag("guid"),
        categories: [],
      };
    });
  } catch {
    return [];
  }
}

module.exports = { parseFallback };
