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
 * getWithFallback(url, opts?, attempt?)
 *  - opts.headers, opts.timeout, opts.responseType, ...
 */
async function getWithFallback(url, opts = {}, attempt = 0) {
  const maxAttempts = UA_FALLBACKS.length + 1;

  // Non-HTTP/HTTPS → od razu błąd czytelny (obsłużą to ewentualnie pluginy)
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      const e = new Error(`Unsupported protocol ${u.protocol}`);
      e.code = "UNSUPPORTED_PROTOCOL";
      throw e;
    }
  } catch (e) {
    if (e?.code === "UNSUPPORTED_PROTOCOL") throw e;
  }

  try {
    const res = await httpClient.get(url, {
      ...opts,
      // 304 jako "sukces", żeby nie wywoływać fallbacków UA
      validateStatus: (s) => s === 304 || (s >= 200 && s < 300),
    });
    return res;
  } catch (err) {
    const st = err?.response?.status;
    if (st === 304 && err.response) return err.response;

    if (attempt < maxAttempts - 1) {
      const newUA = UA_FALLBACKS[attempt];
      console.warn(
        `[HTTP] Próba fallback UA: ${newUA} dla ${url} (attempt ${attempt + 1})`
      );
      const headers = { ...(opts.headers || {}), "User-Agent": newUA };
      return getWithFallback(url, { ...opts, headers }, attempt + 1);
    } else {
      console.error(
        `[HTTP] ❌ Wszystkie próby nieudane dla ${url}: ${err.message}`
      );
      throw err;
    }
  }
}

module.exports = { getWithFallback };