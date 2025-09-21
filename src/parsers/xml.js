// src/parsers/xml.js
const xml2js = require('xml2js');
const { stripHtml } = require("string-strip-html"); 
const { parseDate } = require("./utils"); 

/**
 * Funkcja pomocnicza do znajdowania pierwszego URL obrazka w treści HTML.
 * @param {string} htmlContent Kod HTML do przeszukania.
 * @returns {string|null} Znaleziony URL obrazka lub null.
 */
function extractImageFromHTML(htmlContent) {
    if (!htmlContent) return null;
    
    // Szukanie pierwszego tagu <img> z atrybutem src
    const imgMatch = htmlContent.match(/<img\s+(?:[^>]*?\s+)?src=(["'])(.*?)\1/i);
    if (imgMatch && imgMatch[2]) {
        return imgMatch[2];
    }
    
    return null;
}

// Konfiguracja dla xml2js
const parser = new xml2js.Parser({ 
    explicitArray: false, // Konwertuj tablice jednoelementowe na obiekty
    ignoreAttrs: false,   // Atrybuty są potrzebne dla enclosure, media:content
    attrkey: "ATTR",      // Klucz dla atrybutów
    charkey: "VALUE",     // Klucz dla wartości tekstowych w tagach
    valueProcessors: [xml2js.processors.parseNumbers, xml2js.processors.parseBooleans]
});


/**
 * Parsuje kanały w formacie RSS 2.0 i ogólne XML przy użyciu xml2js.
 * @param {string} feedUrl URL feeda.
 * @param {object} httpClient Instancja axios.
 * @returns {Array} Lista przetworzonych wpisów.
 */
async function parseXML(feedUrl, httpClient) {
    try {
        const res = await httpClient.get(feedUrl);
        const xml = res.data;
        
        const data = await parser.parseStringPromise(xml);
        
        // Weryfikacja struktury RSS 2.0
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

            // --- EKSTRAKCJA OBRAZKA (4-stopniowa hierarchia) ---
            let image = null;

            // 1. enclosure (prosty standard RSS)
            if (item.enclosure && item.enclosure.ATTR && item.enclosure.ATTR.url && item.enclosure.ATTR.type?.startsWith('image/')) {
                image = item.enclosure.ATTR.url;
            }
            
            // 2. media:content lub media:thumbnail
            if (!image && item['media:content'] && item['media:content'].ATTR && item['media:content'].ATTR.url && item['media:content'].ATTR.type?.startsWith('image/')) {
                 image = item['media:content'].ATTR.url;
            }
            if (!image && item['media:thumbnail'] && item['media:thumbnail'].ATTR && item['media:thumbnail'].ATTR.url) {
                 image = item['media:thumbnail'].ATTR.url;
            }

            // --- Ekstrakcja treści do szukania obrazka/opisu ---
            const contentEncodedValue = item['content:encoded'] 
                ? (item['content:encoded'].VALUE || item['content:encoded'])
                : '';
            const descriptionValue = item.description 
                ? (item.description.VALUE || item.description) 
                : '';

            // 3. content:encoded (szukamy obrazka w pełnej treści HTML)
            if (!image && contentEncodedValue) {
                image = extractImageFromHTML(contentEncodedValue);
            }
            
            // 4. description (ostatnia próba znalezienia obrazka)
            if (!image && descriptionValue) {
                image = extractImageFromHTML(descriptionValue);
            }

            // --- EKSTRAKCJA OPISU (priorytet content:encoded) ---
            const rawDescription = contentEncodedValue || descriptionValue;
            const contentSnippet = stripHtml(rawDescription).result.trim();
            
            // Konwersja kategorii na tablicę, jeśli to konieczne
            const categories = item.category 
                ? (Array.isArray(item.category) ? item.category : [item.category]) 
                : [];

            return {
                title,
                link,
                contentSnippet: contentSnippet.substring(0, 500),
                isoDate,
                enclosure: image,
                author,
                guid: item.guid,
                categories,
            };
        });

        return items;
        
    } catch (error) {
        // Ignorujemy błędy i zwracamy pustą tablicę, by uruchomił się kolejny parser (np. regex fallback)
        return []; 
    }
}

module.exports = { parseXML };