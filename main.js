// main.js - Główna logika XFeeder
const fs = require("fs");
const axios = require("axios"); // Import axios dla globalnej konfiguracji
const { sendMessage } = require("./src/message");

// ----------------------------------------------------------------------
// IMPORT WSZYSTKICH PARSERÓW
// ----------------------------------------------------------------------
const { parseRSS } = require("./src/parsers/rss");
const { parseAtom } = require("./src/parsers/atom");
const { parseYouTube } = require("./src/parsers/youtube");
const { parseXML } = require("./src/parsers/xml");
const { parseJSON } = require("./src/parsers/json"); 
const { parseApiX } = require("./src/parsers/api_x"); 
const { parseFallback } = require("./src/parsers/fallback");

// ----------------------------------------------------------------------
// 🏆 GLOBALNA KONFIGURACJA AXIOS DLA WSZYSTKICH PARSERÓW
// ----------------------------------------------------------------------
axios.defaults.timeout = 15000; // 15 sekund timeout
axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
axios.defaults.headers.common['Accept'] = 'application/rss+xml,application/atom+xml,application/xml,text/xml,application/json,text/html;q=0.9,*/*;q=0.8';
axios.defaults.headers.common['Accept-Language'] = 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7';
axios.defaults.headers.common['Accept-Encoding'] = 'gzip, deflate, br';
axios.defaults.headers.common['Connection'] = 'keep-alive';
axios.defaults.headers.common['Cache-Control'] = 'no-cache';
axios.defaults.headers.common['Pragma'] = 'no-cache';

// Wersja customAxios z Twojego starego kodu (nieużywana, ale zostawiona jako referencja)
const customAxios = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml',
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
 * Wszystkie parsery muszą używać globalnego obiektu 'axios' z jego defaults.
 * @param {string} url Adres URL feeda.
 * @returns {Array} Lista sparsowanych elementów.
 */
async function fetchFeed(url) {
    let items = [];

    // Poprawna i kompletna lista parserów
    const parsers = [
        parseYouTube,   
        parseAtom,      
        parseApiX,      
        parseXML,       
        parseJSON,      
        parseRSS,       
        parseFallback,  
    ];

    // Przekazujemy GLOBALNY AXIOS do wszystkich parserów
    for (const parser of parsers) {
        items = await parser(url, axios); 
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

            // W fetchFeed przekazujemy GLOBALNY AXIOS
            const items = await fetchFeed(feedUrl, axios); 
            if (!items.length) continue;

            if (!cache[channelIndex][feedUrl]) cache[channelIndex][feedUrl] = [];

            const newItems = [];
            
            // --- PRZYWRÓCONA, CZYTELNA LOGIKA CACHE ---
            for (const item of items) {
                // Do cache używamy zawsze 'link', jak w Twojej oryginalnej wersji, 
                // choć 'guid' jest lepsze, to 'link' gwarantuje wsteczną kompatybilność
                // i prostotę Twojego systemu.
                if (cache[channelIndex][feedUrl].includes(item.link)) break; 
                newItems.push(item);
            }

            if (newItems.length > 0) {
                // Cięcie do wysłania (nowe elementy są na końcu po odwróceniu)
                const toSend = newItems.slice(0, channelConfig.RequestSend); 

                for (const entry of toSend.reverse()) { // Wysłanie od najstarszego do najnowszego
                    await sendMessage(channelConfig.Webhook, channelConfig.Thread, entry);
                }

                // dopisz linki do cache
                cache[channelIndex][feedUrl] = [
                    ...newItems.map((i) => i.link),
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