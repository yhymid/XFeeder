// src/parsers/youtube.js
const xml2js = require('xml2js');
const { stripHtml } = require("string-strip-html"); 
const { parseDate } = require("./utils"); 

// Konfiguracja dla xml2js (specjalna dla Atom/YouTube)
const parser = new xml2js.Parser({ 
    explicitArray: false, 
    ignoreAttrs: false, 
    attrkey: "ATTR", 
    charkey: "VALUE", 
    valueProcessors: [xml2js.processors.parseNumbers, xml2js.processors.parseBooleans]
});


/**
 * Parsuje kanały Atom od YouTube.
 * @param {string} feedUrl URL feeda YouTube.
 * @param {object} httpClient Instancja axios.
 * @returns {Array} Lista przetworzonych wpisów.
 */
async function parseYouTube(feedUrl, httpClient) {
    // 1. Szybkie sprawdzenie, czy to jest URL feeda YouTube
    if (!feedUrl.includes("youtube.com/feeds/") && !feedUrl.includes("yt:")) {
        return [];
    }

    try {
        const res = await httpClient.get(feedUrl);
        const xml = res.data;
        
        const data = await parser.parseStringPromise(xml);
        
        if (!data.feed || !data.feed.entry) {
            return [];
        }

        const rawEntries = Array.isArray(data.feed.entry) 
            ? data.feed.entry 
            : [data.feed.entry];

        const items = rawEntries.map(entry => {
            
            const title = entry.title ? stripHtml(entry.title).result : 'Brak tytułu';
            const isoDate = parseDate(entry.published || entry.updated);
            const author = entry.author?.name || null;
            
            // Linki i identyfikatory
            const videoId = entry['yt:videoId'];
            // Link musi być linkiem "alternate" lub skonstruowanym
            const link = entry.link?.ATTR?.href || `https://www.youtube.com/watch?v=${videoId}`;
            
            // --- EKSTRAKCJA OBRAZKA (specyficzna dla YouTube) ---
            let image = null;

            // 1. Szukaj w media:group
            const mediaGroup = entry['media:group'];
            if (mediaGroup && mediaGroup['media:thumbnail'] && mediaGroup['media:thumbnail'].ATTR && mediaGroup['media:thumbnail'].ATTR.url) {
                image = mediaGroup['media:thumbnail'].ATTR.url;
            }
            // 2. Fallback na standardowe formaty URL miniatur (jeśli videoId jest dostępne)
            else if (videoId) {
                image = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
            }

            // Opis (z media:group, ponieważ entry.summary jest często puste)
            const rawDescription = mediaGroup && mediaGroup['media:description'] 
                ? mediaGroup['media:description'] 
                : entry.summary;
                
            const contentSnippet = stripHtml(rawDescription || '').result.trim();
            
            return {
                title,
                link,
                contentSnippet: contentSnippet.substring(0, 500),
                isoDate,
                enclosure: image,
                author,
                guid: entry.id || videoId,
                categories: [],
            };
        });

        return items;
        
    } catch (error) {
        // Zwracamy pustą listę, aby kolejny parser (np. parseAtom) mógł spróbować.
        return []; 
    }
}

module.exports = { parseYouTube };