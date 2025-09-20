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

      const getTagWithAttr = (tag, attrName, attrValue) => {
        const regex = new RegExp(`<${tag}[^>]*${attrName}="${attrValue}"[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
        const found = block.match(regex);
        return found ? cleanCDATA(found[1].trim()) : "";
      };

      // Szukanie obrazka w różnych formatach
      let imageUrl = null;
      
      // enclosure
      imageUrl = getAttr('enclosure', 'url');
      if (imageUrl) {
        const type = getAttr('enclosure', 'type');
        if (type && !type.startsWith('image/')) imageUrl = null; // Tylko obrazki
      }
      
      // media:thumbnail
      if (!imageUrl) {
        imageUrl = getAttr('media:thumbnail', 'url');
      }
      
      // og:image w description
      if (!imageUrl) {
        const description = getTag('description');
        const imgMatch = description.match(/<img[^>]+src="([^">]+)"/);
        if (imgMatch) imageUrl = imgMatch[1];
      }

      return {
        title: getTag("title"),
        link: getTag("link"),
        contentSnippet: getTag("description"),
        isoDate: getTag("pubDate"),
        enclosure: imageUrl,
        author: getTag("author"),
        guid: getTag("guid"),
        categories: [],
      };
    });
  } catch (error) {
    console.error(`[Fallback] Błąd parsowania ${feedUrl}:`, error.message);
    return [];
  }
}

module.exports = { parseFallback };