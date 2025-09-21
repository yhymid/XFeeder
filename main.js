// main.js - Główna logika XFeeder
const fs = require("fs");
const axios = require("axios");
const { sendMessage } = require("./src/message");
// ----------------------------------------------------------------------
// IMPORT WSZYSTKICH PARSERÓW
// ----------------------------------------------------------------------
const { parseAtom } = require("./src/parsers/atom");
const { parseYouTube } = require("./src/parsers/youtube");
const { parseXML } = require("./src/parsers/xml"); 
const { parseRSS } = require("./src/parsers/rss"); 
const { parseJSON } = require("./src/parsers/json"); 
const { parseApiX } = require("./src/parsers/api_x"); // Niestandardowe API
const { parseFallback } = require("./src/parsers/fallback"); // Ostatni Web Scraper

// Plik utils.js jest implikowany, jeśli używasz parseDate w logice sendMessage lub innych miejscach,
// ale w logice main.js nie jest potrzebny, więc zostawiamy go poza importem głównym.

// --- KONFIGURACJA HTTP CLIENT ---
const httpClient = axios.create({
    timeout: 15000, 
    headers: {
        'User-Agent': 'Mozilla/5.0 (XFeeder Bot; compatible; Google-Bot/2.1; +https://github.com/YourRepo)',
        'Accept': 'application/rss+xml,application/atom+xml,application/xml,application/json,text/xml,text/html;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    }
});

// --- KONFIGURACJA I CACHE ---
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

let cache = {};
const cacheFile = "./cache.json";
if (fs.existsSync(cacheFile)) {
    try {
        cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        console.log(`[Cache] Załadowano plik (${Object.keys(cache).length} kanałów)`);
    } catch (e) {
        console.warn("[Cache] Błąd przy wczytywaniu cache.json, tworzę pusty. Błąd:", e.message);
        cache = {};
    }
}

function saveCache() {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
}

// --- GŁÓWNA LOGIKA PARSOWANIA ---

/**
 * Wywołuje kolejno parsery do momentu, aż jeden zwróci dane.
 * @param {string} url Adres URL feeda.
 * @param {object} client Instancja klienta HTTP (axios).
 * @returns {Array} Lista sparsowanych elementów.
 */
async function fetchFeed(url, client) {
    let items = [];
    
    // UZUPELNIONA I POSORTOWANA LISTA PARSERÓW
    const parsers = [
        parseYouTube,   // 1. Najbardziej specyficzny (YouTube Atom)
        parseAtom,      // 2. Standard Atom (GitHub, Blogi Atom)
        parseApiX,      // 3. Niestandardowe API (np. Steam JSON)
        parseXML,       // 4. Zaawansowany RSS/XML (xml2js, content:encoded)
        parseJSON,      // 5. JSON Feed (Standard)
        parseRSS,       // 6. Regex Fallback (Ostatnia szansa dla źle sformatowanych feedów)
        parseFallback,  // 7. Web Scraper (Ostateczna deska ratunku - HTML meta tagi)
    ];

    for (const parser of parsers) {
        items = await parser(url, client); 
        if (items.length) {
            console.log(`[Parser] Sukces: ${parser.name} dla ${url}`);
            return items;
        }
    }
    
    return items;
}

// --- LOGIKA KANAŁU ---

async function checkFeedsForChannel(channelIndex, channelConfig) {
    if (!cache[channelIndex]) cache[channelIndex] = {};

    for (const feedUrl of channelConfig.RSS) {
        try {
            // WPROWADZENIE JITTERA (Losowe Opóźnienie)
            const baseDelay = feedUrl.includes('youtube.com') ? 2000 : 500;
            const jitter = Math.floor(Math.random() * 500); 
            await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
            
            const items = await fetchFeed(feedUrl, httpClient);
            if (!items.length) continue;

            if (!cache[channelIndex][feedUrl]) cache[channelIndex][feedUrl] = [];

            // Elementy z feeda są zazwyczaj posortowane od NAJNOWSZEGO do NAJSTARSZEGO
            const newItems = [];
            for (const item of items) {
                // Wykorzystaj 'guid' jako fallback dla linku, jeśli link nie istnieje
                const uniqueId = item.guid || item.link;
                // Weryfikacja: Jeśli unikalny ID jest pusty LUB jest już w cache, przerwij pętlę.
                if (!uniqueId || cache[channelIndex][feedUrl].includes(uniqueId)) break; 
                
                // Dodatkowa weryfikacja daty: Upewnij się, że element ma datę
                // (choć parseDate w utils.js powinien to zapewnić, to dodatkowa weryfikacja nie zaszkodzi)
                if (!item.isoDate) {
                    // Pominięcie elementu, jeśli data jest pusta po parsowaniu
                    console.warn(`[Cache] Pominięto wpis bez daty dla ${feedUrl}`);
                    continue;
                }

                newItems.push(item);
            }

            if (newItems.length > 0) {
                // 1. Zbieramy linki/guidy do cache
                const newIdsToCache = newItems.map((i) => i.guid || i.link);
                
                // 2. Wiadomości do wysłania (bierzemy NAJNOWSZE 'RequestSend' elementów)
                newItems.reverse(); // Odwracamy: [Najstarszy_Nowy, ..., Najnowszy_Nowy]
                const toSend = newItems.slice(-channelConfig.RequestSend); 

                // 3. Wysyłamy w poprawnej CHRONOLOGICZNEJ kolejności
                for (const entry of toSend) {
                    await sendMessage(channelConfig.Webhook, channelConfig.Thread, entry);
                }

                // 4. Aktualizacja cache (dodajemy nowe ID od najnowszego)
                cache[channelIndex][feedUrl] = [
                    ...newIdsToCache, 
                    ...cache[channelIndex][feedUrl],
                ];
                saveCache();
                console.log(`[Kanał ${channelIndex + 1}] Znaleziono i wysłano ${toSend.length} nowych wpisów z ${feedUrl}.`);
            }
        } catch (err) {
            console.error(`[Kanał ${channelIndex + 1}] Błąd feeda ${feedUrl}:`, err); 
        }
    }
}

// --- URUCHAMIANIE I ZARZĄDZANIE ---

config.channels.forEach((channelConfig, index) => {
    const intervalMs = channelConfig.TimeChecker * 60 * 1000;
    console.log(`[Kanał ${index + 1}] Start. Sprawdzanie co ${channelConfig.TimeChecker} minut.`);
    setInterval(() => checkFeedsForChannel(index, channelConfig), intervalMs);
    checkFeedsForChannel(index, channelConfig);
});

// Obsługa shutdown
process.on('SIGINT', () => {
    console.log('\n[Shutdown] Zapisuję cache i zamykam...');
    saveCache();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('[Critical Error] Nieoczekiwany błąd, zapisuję cache:', error);
    saveCache();
});