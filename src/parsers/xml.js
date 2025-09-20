const axios = require("axios");
const xml2js = require("xml2js");

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseXML(feedUrl) {
  try {
    const res = await axios.get(feedUrl);
    const parser = new xml2js.Parser({
      explicitArray: false,
      explicitCharkey: true,
      explicitRoot: false,
      ignoreAttrs: false
    });
    
    const data = await parser.parseStringPromise(res.data);

    const channel = data.rss?.channel || data.channel;
    const items = channel?.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];

    if (!items.length) return [];

    return items.map((item) => {
      // Pobierz obrazek z różnych źródeł
      let imageUrl = null;
      
      // enclosure
      if (item.enclosure?.['$']?.url && item.enclosure['$']?.type?.startsWith('image/')) {
        imageUrl = item.enclosure['$'].url;
      }
      // media:thumbnail
      else if (item['media:thumbnail']?.['$']?.url) {
        imageUrl = item['media:thumbnail']['$'].url;
      }
      // media:content
      else if (item['media:content']?.['$']?.url && item['media:content']?.['$']?.type?.startsWith('image/')) {
        imageUrl = item['media:content']['$'].url;
      }
      // og:image w description
      else if (item.description) {
        const ogImageMatch = item.description.match(/<img[^>]+src="([^">]+)"/);
        if (ogImageMatch) imageUrl = ogImageMatch[1];
      }

      return {
        title: cleanCDATA(item.title || ""),
        link: cleanCDATA(item.link || ""),
        contentSnippet: cleanCDATA(item.description || ""),
        isoDate: cleanCDATA(item.pubDate || item.date || ""),
        enclosure: imageUrl,
        author: item['dc:creator'] || item.author || null,
        guid: item.guid || null,
        categories: item.category ? (Array.isArray(item.category) ? item.category : [item.category]) : [],
      };
    });
  } catch (error) {
    console.error(`[XML] Błąd parsowania ${feedUrl}:`, error.message);
    return [];
  }
}

module.exports = { parseXML };