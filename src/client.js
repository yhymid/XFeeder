// src/client.js
const axios = require("axios");
const fs = require("fs");

let proxyEnabled = false;
let proxyUrl = null;

// Wczytanie config.json
try {
  const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
  if (config.Proxy && config.Proxy.Enabled && config.Proxy.Url) {
    proxyEnabled = true;
    proxyUrl = config.Proxy.Url;
  }
} catch {
  console.warn("[HTTP] Brak lub błąd w config.json → Proxy pominięte.");
}

// Konfiguracja bazowa axios
const agentConfig = {
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "application/rss+xml,application/atom+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
  },
};

// Proxy jeśli włączony
if (proxyEnabled && proxyUrl) {
  agentConfig.proxy = false;
  agentConfig.httpsAgent = require("https-proxy-agent")(proxyUrl);
  agentConfig.httpAgent = require("http-proxy-agent")(proxyUrl);
  console.log(`[HTTP] Proxy włączony: ${proxyUrl}`);
} else {
  console.log("[HTTP] Proxy wyłączone.");
}

const httpClient = axios.create(agentConfig);

// Alternatywne UA do fallbacku
const UA_FALLBACKS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "FeedFetcher-Google",
];

/**
 * Główna funkcja pobierania z fallbackiem UA
 */
async function getWithFallback(url, attempt = 0) {
  const maxAttempts = UA_FALLBACKS.length + 1;

  try {
    const res = await httpClient.get(url);
    return res;
  } catch (err) {
    if (attempt < maxAttempts - 1) {
      // Zmiana UA
      const newUA = UA_FALLBACKS[attempt];
      console.warn(
        `[HTTP] Próba fallback UA: ${newUA} dla ${url} (attempt ${attempt + 1})`
      );

      httpClient.defaults.headers["User-Agent"] = newUA;
      return getWithFallback(url, attempt + 1);
    } else {
      console.error(
        `[HTTP] ❌ Wszystkie próby nieudane dla ${url}: ${err.message}`
      );
      throw err;
    }
  }
}

module.exports = { getWithFallback };