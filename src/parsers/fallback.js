// src/parsers/xml.js
const xml2js = require('xml2js');
const { stripHtml } = require("string-strip-html"); 
const { parseDate } = require("./utils"); 

/**
 * Funkcja pomocnicza do znajdowania pierwszego obrazka w treści HTML.
 * @param {string} htmlContent Kod HTML do przeszukania.
 * @returns {string|null} Znaleziony URL obrazka lub null.
 */
function extractImageFromHTML(htmlContent) {
    if (!htmlContent) return null;
    
    // Proste wyszukiwanie pierwszego tagu <img> i atrybutu src
    const imgMatch = htmlContent.match(/<img\s+(?:[^>]*?\s+)?src=(["'])(.*?)\1/i);
    if (imgMatch && imgMatch[2]) {
        // Zwraca URL
        return imgMatch[2];
    }
    
    return null;
}

// Konfiguracja dla xml2js (obsługa przestrzeni nazw, np. content:encoded)
const parser = new xml2js.Parser({ 
    explicitArray: false, 
    ignoreAttrs: false, // Potrzebne do obsługi tagów takich jak <media:content>
    attrkey: "ATTR", 
    charkey: "VALUE", 
    valueProcessors: [xml2js.processors.parseNumbers, xml2js.processors.parseBooleans]
});


/**
 * Parsuje kanały w formacie RSS 2.0 i ogólne XML przy użyciu xml2js.
 * Priorytetowo traktuje content:encoded i media:content.
 * @param {string} feedUrl URL feeda.
 * @param {object} httpClient Instancja axios.
 * @returns {Array} Lista przetworzonych wpisów.
 */
async function parseXML(feedUrl, httpClient) {
    try {
        const res = await httpClient.get(feedUrl);
        const xml = res.data;
        
        const data = await parser.parseStringPromise(xml);
        
        // Sprawdzenie, czy to RSS 2.0
        if (!data.rss || !data.rss.channel || !data.rss.channel.item) {
            return []; 
        }

        const rawItems = Array.isArray(data.rss.channel.item) 
            ? data.rss.channel.item 
            : [data.rss.channel.item];

        const items = rawItems.map(item => {
            
            const title = item.title ? stripHtml(item.title).result : 'Brak tytułu';
            const link = item.link;
            const isoDate = parseDate(item.pubDate);
            const author = item['dc:creator'] || item.author || null;

            // --- EKSTRAKCJA OBRAZKA ---
            let image = null;

            // 1. enclosure (najprostszy standard)
            if (item.enclosure && item.enclosure.ATTR && item.enclosure.ATTR.url && item.enclosure.ATTR.type?.startsWith('image/')) {
                image = item.enclosure.ATTR.url;
            }
            
            // 2. media:content (często używane dla obrazków)
            if (!image && item['media:content'] && item['media:content'].ATTR && item['media:content'].ATTR.url && item['media:content'].ATTR.type?.startsWith('image/')) {
                 image = item['media:content'].ATTR.url;
            }

            // 3. content:encoded (WordPress, FitGirl - pełna treść z obrazkami)
            if (!image && item['content:encoded'] && item['content:encoded'].VALUE) {
                image = extractImageFromHTML(item['content:encoded'].VALUE);
            }
            
            // 4. description (ostatnia próba)
            if (!image && item.description && item.description.VALUE) {
                image = extractImageFromHTML(item.description.VALUE);
            }

            // --- EKSTRAKCJA OPISU ---
            // Używamy content:encoded jeśli jest, w przeciwnym razie description
            const rawDescription = item['content:encoded'] 
                ? (item['content:encoded'].VALUE || item['content:encoded'])
                : (item.description ? (item.description.VALUE || item.description) : '');
                
            const contentSnippet = stripHtml(rawDescription).result.trim();
            
            return {
                title,
                link,
                contentSnippet: contentSnippet.substring(0, 500),
                isoDate,
                enclosure: image,
                author,
                guid: item.guid,
                categories: item.category ? (Array.isArray(item.category) ? item.category : [item.category]) : [],
            };
        });

        return items;
        
    } catch (error) {
        // Ignorujemy błędy i zwracamy pustą tablicę
        return []; 
    }
}

module.exports = { parseXML };