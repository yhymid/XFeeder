const Parser = require("rss-parser");
const axios = require("axios");

const parser = new Parser({
  // ... twoja obecna konfiguracja
  requestOptions: {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml',
    }
  }
});

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
      },
      timeout: 10000 // Dodaj timeout
    });
    
    const parsed = await parser.parseURL(feedUrl);

    if (!parsed?.items?.length) return [];

    return parsed.items.map((item) => {
      // Pobierz obrazek - priorytety: mediaThumbnail -> enclosure -> mediaContent -> image -> ogImage
      let imageUrl = null;
      
      // 1. media:thumbnail
      if (item.mediaThumbnail?.[0]?.['$']?.url) {
        imageUrl = item.mediaThumbnail[0]['$'].url;
      } else if (item.mediaThumbnail?.['$']?.url) {
        imageUrl = item.mediaThumbnail['$'].url;
      }
      
      // 2. enclosure (POPRAWIONE DLA BOOP.PL I INNYCH)
      if (!imageUrl && item.enclosure) {
        // Obsługa tablicy enclosure
        if (Array.isArray(item.enclosure)) {
          const imageEnclosure = item.enclosure.find(enc => 
            enc.type && enc.type.startsWith('image/') && enc.url
          );
          if (imageEnclosure) imageUrl = imageEnclosure.url;
        } 
        // Obsługa pojedynczego obiektu enclosure
        else if (item.enclosure.url && item.enclosure.type?.startsWith('image/')) {
          imageUrl = item.enclosure.url;
        }
        // Fallback: jeśli nie ma type, ale jest url (jak w boop.pl)
        else if (item.enclosure.url && !item.enclosure.type) {
          imageUrl = item.enclosure.url;
        }
      }
      
      // 3. media:content
      if (!imageUrl && item.mediaContent?.[0]?.['$']?.url && item.mediaContent[0]['$'].type?.startsWith('image/')) {
        imageUrl = item.mediaContent[0]['$'].url;
      } else if (!imageUrl && item.mediaContent?.['$']?.url && item.mediaContent['$'].type?.startsWith('image/')) {
        imageUrl = item.mediaContent['$'].url;
      }
      
      // 4. image
      if (!imageUrl && item.image?.url) {
        imageUrl = item.image.url;
      }
      
      // 5. og:image
      if (!imageUrl && item.ogImage) {
        imageUrl = item.ogImage;
      }
      
      // 6. Fallback: szukanie obrazka w description (HTML)
      if (!imageUrl && item.description) {
        const imgMatch = item.description.match(/<img[^>]+src="([^">]+)"/);
        if (imgMatch) imageUrl = imgMatch[1];
      }

      return {
        title: cleanCDATA(item.title || ""),
        link: cleanCDATA(item.link || ""),
        contentSnippet: cleanCDATA(item.contentSnippet || item.content || item.description || ""),
        isoDate: cleanCDATA(item.isoDate || item.pubDate || ""),
        enclosure: imageUrl,
        author: item.creator || item.author || null,
        guid: item.guid || item.link || null, // Fallback na link jeśli brak guid
        categories: item.categories || [],
      };
    });
  } catch (error) {
    console.error(`[RSS] Błąd parsowania ${feedUrl}:`, error.message);
    return [];
  }
}

module.exports = { parseRSS };