const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseAtom(feedUrl) {
  try {
    const res = await axios.get(feedUrl);
    const parser = new XMLParser({ 
      ignoreAttributes: false,
      isArray: (name) => name === "entry" || name === "link" || name === "media:thumbnail"
    });
    const data = parser.parse(res.data);

    const entries = data.feed?.entry || [];
    if (!entries.length) return [];

    return (Array.isArray(entries) ? entries : [entries]).map((entry) => {
      // Pobierz obrazek - szukamy w różnych miejscach
      let imageUrl = null;
      
      // Media thumbnail
      if (entry['media:thumbnail']?.['@_url']) {
        imageUrl = entry['media:thumbnail']['@_url'];
      } 
      // Media content
      else if (entry['media:content']?.['@_url'] && entry['media:content']?.['@_type']?.startsWith('image/')) {
        imageUrl = entry['media:content']['@_url'];
      }
      // Link z rel="enclosure"
      else if (entry.link) {
        const links = Array.isArray(entry.link) ? entry.link : [entry.link];
        const imageLink = links.find(link => 
          link['@_rel'] === 'enclosure' && 
          link['@_type']?.startsWith('image/')
        );
        if (imageLink) imageUrl = imageLink['@_href'];
      }

      return {
        title: cleanCDATA(entry.title || ""),
        link: entry.link ? (Array.isArray(entry.link) ? entry.link.find(l => l['@_rel'] === 'alternate')?.['@_href'] || entry.link[0]?.['@_href'] : entry.link['@_href']) : "",
        contentSnippet: cleanCDATA(entry.summary || entry.content || ""),
        isoDate: entry.updated || entry.published || "",
        enclosure: imageUrl,
        author: entry.author?.name || null,
        guid: entry.id || null,
        categories: entry.category ? [].concat(entry.category) : [],
      };
    });
  } catch (error) {
    console.error(`[Atom] Błąd parsowania ${feedUrl}:`, error.message);
    return [];
  }
}

module.exports = { parseAtom };