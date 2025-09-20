const axios = require("axios");
const xml2js = require("xml2js");

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseXML(feedUrl) {
  try {
    const res = await axios.get(feedUrl, { timeout: 10000 });
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
      
      // 1. enclosure (najpierw sprawdzamy obiekt, potem tablicę)
      if (item.enclosure) {
        // enclosure jako obiekt z atrybutami
        if (item.enclosure.$ && item.enclosure.$.url) {
          if (!item.enclosure.$.type || item.enclosure.$.type.startsWith('image/')) {
            imageUrl = item.enclosure.$.url;
          }
        } 
        // enclosure jako tablica obiektów
        else if (Array.isArray(item.enclosure)) {
          const imageEnclosure = item.enclosure.find(enc => 
            enc.$ && enc.$.url && (!enc.$.type || enc.$.type.startsWith('image/'))
          );
          if (imageEnclosure) imageUrl = imageEnclosure.$.url;
        }
      }
      
      // 2. media:thumbnail (oryginalny kod)
      else if (item['media:thumbnail']?.['$']?.url) {
        imageUrl = item['media:thumbnail']['$'].url;
      }
      
      // 3. media:content (oryginalny kod)
      else if (item['media:content']?.['$']?.url && item['media:content']?.['$']?.type?.startsWith('image/')) {
        imageUrl = item['media:content']['$'].url;
      }
      
      // 4. og:image w description (oryginalny kod)
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
        guid: item.guid || item.link || null, // Dodany fallback na link
        categories: item.category ? (Array.isArray(item.category) ? item.category : [item.category]) : [],
      };
    });
  } catch (error) {
    console.error(`[XML] Błąd parsowania ${feedUrl}:`, error.message);
    return [];
  }
}

module.exports = { parseXML };