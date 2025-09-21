// src/parsers/rss.js - Ostateczny Fallback Parser oparty na Regex
const { parseDate } = require("./utils"); 

/**
 * Usuwa tagi CDATA i przycina białe znaki.
 * @param {string} str Tekst do oczyszczenia.
 * @returns {string} Oczyszczony tekst.
 */
function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

/**
 * Parsuje feed za pomocą wyrażeń regularnych, jako ostatnia deska ratunku.
 * @param {string} feedUrl URL feeda.
 * @param {object} httpClient Instancja axios.
 * @returns {Array} Lista przetworzonych wpisów.
 */
async function parseRSS(feedUrl, httpClient) {
  try {
    const res = await httpClient.get(feedUrl);
    const data = res.data;

    // 1. Szukanie wszystkich bloków <item>
    const items = [...data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    if (!items.length) {
        // Próba dla Atom <entry>
        const entries = [...data.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
        if (!entries.length) return [];
        // Jeśli znajdziemy entry, traktujemy to jako item
        return parseEntries(entries); 
    }

    // 2. Mapowanie i parsowanie każdego bloku
    return items.map((match) => {
      const block = match[1];

      // Funkcja pomocnicza do pobierania zawartości tagu
      const getTagContent = (tag) => {
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
        const found = block.match(regex);
        return found ? cleanCDATA(found[1].trim()) : "";
      };

      // Funkcja pomocnicza do pobierania atrybutu tagu
      const getAttr = (tag, attr) => {
        const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]+)"[^>]*>`, "i");
        const found = block.match(regex);
        return found ? found[1] : null;
      };

      // Szukanie obrazka (priorytetowo w enclosure, potem w treści)
      let imageUrl = getAttr('enclosure', 'url');
      if (!imageUrl) {
        const description = getTagContent('description') || getTagContent('content:encoded');
        const imgMatch = description.match(/<img[^>]+src="([^">]+)"/);
        if (imgMatch) imageUrl = imgMatch[1];
      }

      // Używamy content:encoded jako pełniejszego opisu, jeśli jest dostępny
      const descriptionContent = getTagContent('content:encoded') || getTagContent('description');

      return {
        title: getTagContent("title"),
        link: getTagContent("link"),
        contentSnippet: descriptionContent.substring(0, 500).trim(),
        isoDate: parseDate(getTagContent("pubDate") || getTagContent("published") || getTagContent("updated")),
        enclosure: imageUrl,
        author: getTagContent("author") || getTagContent("dc:creator"),
        guid: getTagContent("guid") || getTagContent("id"),
        categories: [],
      };
    });
  } catch (error) {
    return [];
  }
}

/**
 * Funkcja pomocnicza do parsowania bloków <entry> (fallback dla źle sformatowanego Atom)
 * Używana wewnętrznie w parseRSS.
 */
function parseEntries(entries) {
    // Ta funkcja użyje tej samej logiki getTagContent co w parseRSS, ale dla bloków entry.
    // Z uwagi na złożoność regex dla Atom, domyślnie polegamy tu na Item.
    // Możesz później dodać tu bardziej skomplikowaną logikę Atom Regex, jeśli będzie potrzebna.
    return []; 
}

module.exports = { parseRSS };