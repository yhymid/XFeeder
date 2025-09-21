// src/parsers/fallback.js - Awaryjny parser HTML (Web Scraping)
const cheerio = require('cheerio'); 
const { parseDate } = require("./utils"); 

/**
 * Parsuje niestandardowe strony HTML (Web Scraping).
 * Używa Cheerio do ekstrakcji metadanych (Open Graph, title, description)
 * i zwraca całą stronę jako JEDEN WPIS.
 * @param {string} feedUrl URL strony HTML.
 * @param {object} httpClient Instancja axios.
 * @returns {Array} Lista przetworzonych wpisów (maksymalnie 1).
 */
async function parseFallback(feedUrl, httpClient) {
    try {
        // Dodajemy nagłówek, by serwer wiedział, że oczekujemy HTML
        const res = await httpClient.get(feedUrl, {
            headers: { 'Accept': 'text/html,application/xhtml+xml' } 
        });
        const html = res.data;
        
        // Wczytanie HTML do Cheerio
        const $ = cheerio.load(html);
        
        // --- EKSTRAKCJA METADANYCH (Open Graph i podstawowe tagi) ---
        
        const ogTitle = $('meta[property="og:title"]').attr('content') || $('title').text();
        const ogUrl = $('meta[property="og:url"]').attr('content') || feedUrl;
        const ogDescription = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content');
        const ogImage = $('meta[property="og:image"]').attr('content') || $('link[rel*="icon"]').attr('href');
        
        // Sprawdzamy, czy udało się znaleźć podstawowe dane
        if (!ogTitle || !ogUrl) {
            return [];
        }
        
        const description = ogDescription ? ogDescription.substring(0, 500).trim() + '...' : 'Brak opisu.';
        const author = $('meta[name="author"]').attr('content') || null;

        // Zwracamy JEDEN wpis reprezentujący stronę
        return [{
            title: ogTitle.trim(),
            link: ogUrl,
            contentSnippet: description,
            // Data bieżąca, ponieważ HTML zazwyczaj nie zawiera daty publikacji
            isoDate: parseDate(new Date().toISOString()), 
            enclosure: ogImage || null,
            author: author,
            guid: ogUrl, // GUID jako URL
            categories: [],
        }];
        
    } catch (error) {
        // W przypadku błędu (np. błąd HTTP, brak dostępu), zwracamy pustą listę
        return [];
    }
}

module.exports = { parseFallback };