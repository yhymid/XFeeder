// src/parsers/atom.js
const xml2js = require('xml2js');
const { stripHtml } = require("string-strip-html"); 
const { parseDate } = require("./utils"); 

// Konfiguracja dla xml2js
const parser = new xml2js.Parser({ 
    explicitArray: false, 
    ignoreAttrs: false, 
    attrkey: "ATTR", 
    charkey: "VALUE", 
    valueProcessers: [xml2js.processors.parseNumbers, xml2js.processors.parseBooleans]
});

/**
 * Parsuje kanał w formacie Atom, włączając rozszerzenia Media RSS.
 * @param {string} feedUrl URL feeda.
 * @param {object} httpClient Instancja axios.
 * @returns {Array} Lista przetworzonych wpisów.
 */
async function parseAtom(feedUrl, httpClient) {
    // Specjalna obsługa YouTube jest w osobnym parserze
    if (feedUrl.includes("youtube.com") || feedUrl.includes("yt:")) return [];

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
            
            const title = entry.title ? stripHtml(entry.title.VALUE || entry.title).result : 'Brak tytułu';
            const isoDate = parseDate(entry.updated || entry.published);
            const author = entry.author?.name?.VALUE || entry.author?.name || null;
            
            const links = Array.isArray(entry.link) ? entry.link : (entry.link ? [entry.link] : []);
            
            // 1. Znajdź link główny (rel="alternate")
            let link = entry.link?.ATTR?.href || null; 
            const alternateLink = links.find(l => l.ATTR && l.ATTR.rel === 'alternate');
            if (alternateLink) {
                link = alternateLink.ATTR.href;
            } else if (links.length > 0 && links[0].ATTR.href) {
                link = links[0].ATTR.href;
            }

            // 2. Pobierz obrazek (Media RSS, enclosure)
            let image = null;
            
            // a) <media:thumbnail> (np. GitHub)
            if (entry['media:thumbnail'] && entry['media:thumbnail'].ATTR && entry['media:thumbnail'].ATTR.url) {
                image = entry['media:thumbnail'].ATTR.url;
            }
            // b) <link rel="enclosure" type="image/...">
            if (!image) {
                const enclosureLink = links.find(l => 
                    l.ATTR && 
                    l.ATTR.rel === 'enclosure' && 
                    l.ATTR.type && 
                    l.ATTR.type.startsWith('image/')
                );
                if (enclosureLink) image = enclosureLink.ATTR.href;
            }

            // 3. Wyczyść opis/treść
            const rawDescription = entry.summary 
                ? (entry.summary.VALUE || entry.summary)
                : (entry.content ? (entry.content.VALUE || entry.content) : '');
                
            const contentSnippet = stripHtml(rawDescription).result.trim();
            
            return {
                title,
                link,
                contentSnippet: contentSnippet.substring(0, 500),
                isoDate,
                enclosure: image,
                author,
                guid: entry.id,
                categories: [],
            };
        });

        return items;
        
    } catch (error) {
        return []; 
    }
}

module.exports = { parseAtom };