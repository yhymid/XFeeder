// src/parsers/api_x.js
const { parseDate } = require("./utils"); 

/**
 * Konwertuje pojedynczy wpis z dowolnego surowego formatu JSON na ustandaryzowany format.
 * Ta funkcja wymaga dostosowania do konkretnego API.
 * @param {object} rawEntry Surowy obiekt wpisu z API.
 * @returns {object} Ustandaryzowany obiekt wpisu.
 */
function standardizeEntry(rawEntry) {
    // --- KLUCZOWE: DOSTOSUJ TE POLA DO STRUKTURY ZWRAĆANEJ PRZEZ TWOJE API ---
    // Poniższe pola są typowe dla wielu prostych API (np. Steam, Reddit, niestandardowe blogi JSON)
    
    // Używamy bezpiecznego dostępu do pól (?.), aby uniknąć błędów, jeśli pole nie istnieje
    const title = rawEntry.title || rawEntry.name || 'Brak tytułu';
    const link = rawEntry.url || rawEntry.link || `#${rawEntry.id}`; 
    const description = rawEntry.summary || rawEntry.content || rawEntry.text || rawEntry.body;
    const dateString = rawEntry.date || rawEntry.published_at || rawEntry.updated_at;
    const image = rawEntry.image || rawEntry.thumbnail || rawEntry.media_url;

    const contentSnippet = description 
        ? (typeof description === 'string' ? description.substring(0, 500).trim() + '...' : 'Brak opisu tekstowego')
        : 'Brak opisu.';
    
    // --- USTANDARYZOWANY OBIEKT ---
    return {
        title: title,
        link: link,
        contentSnippet: contentSnippet,
        isoDate: parseDate(dateString || new Date().toISOString()),
        enclosure: image || null,
        author: rawEntry.author || rawEntry.user || null,
        guid: rawEntry.id || link,
        categories: rawEntry.tags || [],
    };
}


/**
 * Próbuje sparsować niestandardowe API JSON.
 * @param {string} feedUrl URL API.
 * @param {object} httpClient Instancja axios.
 * @returns {Array} Lista przetworzonych wpisów w ustandaryzowanym formacie.
 */
async function parseApiX(feedUrl, httpClient) {
    // Prosta heurystyka: jeśli URL nie wygląda jak API JSON, pomiń.
    // Zostawiamy tę logikę jako opcjonalną.

    try {
        const res = await httpClient.get(feedUrl);
        const rawData = res.data;
        
        let rawItems = [];
        
        // --- KLUCZOWE: LOKALIZACJA LISTY WPISÓW W ODPOWIEDZI API ---
        
        // 1. Jeśli rawData jest tablicą, to jest to lista wpisów.
        if (Array.isArray(rawData)) {
            rawItems = rawData;
        } 
        // 2. Jeśli rawData jest obiektem, szukamy typowych kluczy zawierających listę (np. data.items, data.posts, data.feed.entries)
        else if (typeof rawData === 'object' && rawData !== null) {
            rawItems = rawData.items || rawData.posts || rawData.data || rawData.entries || [];
            
            // W przypadku braku sukcesu, możemy sprawdzić zagnieżdżone obiekty:
            if (!rawItems.length && rawData.feed && Array.isArray(rawData.feed.entries)) {
                rawItems = rawData.feed.entries;
            }
        }
        
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
            return [];
        }
        
        // Konwersja znalezionych wpisów na ustandaryzowany format
        const items = rawItems.map(standardizeEntry);
        
        return items;

    } catch (error) {
        // Jeśli błąd to np. błąd parsowania JSON, logujemy i kontynuujemy.
        return [];
    }
}

module.exports = { parseApiX };