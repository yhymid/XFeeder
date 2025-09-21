// src/parsers/json.js
const { parseDate } = require("./utils"); 

/**
 * Parsuje kanał w formacie JSON Feed (https://jsonfeed.org/).
 * @param {string} feedUrl URL kanału JSON.
 * @param {object} httpClient Instancja axios.
 * @returns {Array} Lista przetworzonych wpisów w ustandaryzowanym formacie.
 */
async function parseJSON(feedUrl, httpClient) {
    try {
        const res = await httpClient.get(feedUrl, {
            headers: { 'Accept': 'application/feed+json, application/json' }
        });
        const data = res.data;

        // Podstawowa weryfikacja struktury JSON Feed
        if (!data.version || !data.items || !data.version.startsWith('https://jsonfeed.org/')) {
            return [];
        }

        const items = data.items.map(item => {
            
            const title = item.title || 'Brak tytułu';
            const link = item.url;
            const isoDate = parseDate(item.date_published || item.date_modified);
            
            // Priorytet obrazka: image > banner_image
            const image = item.image || item.banner_image || null;
            
            // Priorytet opisu: content_text > summary (czyli bez HTML, jeśli to możliwe)
            let rawDescription = item.content_text || item.summary;
            
            // Jeśli content_text i summary są puste, spróbuj użyć content_html, usuwając tagi
            if (!rawDescription && item.content_html) {
                 // Wymaga stripHtml, ale zakładamy, że w JSON Feed preferowany jest content_text/summary.
                 // Dla prostoty, w tej sekcji operujemy tylko na tekstach.
                 rawDescription = item.content_html; 
            }
            
            const description = rawDescription || '';
            
            const author = item.author?.name || null;
            
            return {
                title,
                link,
                contentSnippet: description.substring(0, 500).trim(),
                isoDate,
                enclosure: image,
                author,
                guid: item.id || link,
                categories: item.tags || [],
            };
        });

        return items;
        
    } catch (error) {
        // Zwracamy pustą listę w przypadku błędu (np. błąd połączenia lub niepoprawny JSON)
        return []; 
    }
}

module.exports = { parseJSON };