const Parser = require("rss-parser");
const axios = require("axios");

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseRSS(feedUrl) {
  try {
    const parser = new Parser({
      customFields: {
        item: [
          ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
          ['media:content', 'mediaContent', { keepArray: true }],
          ['enclosure', 'enclosure', { keepArray: true }],
          ['image', 'image'],
          ['og:image', 'ogImage'],
        ]
      }
    });
    
    const parsed = await parser.parseURL(feedUrl);

    if (!parsed?.items?.length) return [];

    return parsed.items.map((item) => {
      // Pobierz obrazek - priorytety: mediaThumbnail -> enclosure -> mediaContent -> image -> ogImage
      let imageUrl = null;
      
      if (item.mediaThumbnail?.[0]?.['$']?.url) {
        imageUrl = item.mediaThumbnail[0]['$'].url;
      } else if (item.enclosure?.[0]?.url && item.enclosure[0].type?.startsWith('image/')) {
        imageUrl = item.enclosure[0].url;
      } else if (item.mediaContent?.[0]?.['$']?.url && item.mediaContent[0]['$'].type?.startsWith('image/')) {
        imageUrl = item.mediaContent[0]['$'].url;
      } else if (item.image?.url) {
        imageUrl = item.image.url;
      } else if (item.ogImage) {
        imageUrl = item.ogImage;
      } else if (item.enclosure?.url && item.enclosure.type?.startsWith('image/')) {
        imageUrl = item.enclosure.url;
      }

      return {
        title: cleanCDATA(item.title || ""),
        link: cleanCDATA(item.link || ""),
        contentSnippet: cleanCDATA(item.contentSnippet || item.content || item.description || ""),
        isoDate: cleanCDATA(item.isoDate || item.pubDate || ""),
        enclosure: imageUrl, // Używamy znalezionego obrazka
        author: item.creator || item.author || null,
        guid: item.guid || null,
        categories: item.categories || [],
      };
    });
  } catch (error) {
    console.error(`[RSS] Błąd parsowania ${feedUrl}:`, error.message);
    return [];
  }
}

module.exports = { parseRSS };