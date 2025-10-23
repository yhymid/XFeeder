// src/client.js
"use strict";

const axios = require("axios");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");

// ============ CONFIG / PREFERENCJE ============

let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync("./config.json", "utf8"));
} catch {
  console.warn("[HTTP] Brak lub błąd w config.json – używam domyślnych.");
}

// ============ PROXY + KEEP-ALIVE ============

let proxyEnabled = !!(CONFIG.Proxy && CONFIG.Proxy.Enabled && CONFIG.Proxy.Url);
let proxyUrl = proxyEnabled ? CONFIG.Proxy.Url : null;

// Bazowa konfiguracja axios
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const agentConfig = {
  timeout: 15000,
  headers: {
    "User-Agent": DEFAULT_UA,
    Accept:
      "application/rss+xml,application/atom+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Encoding": CONFIG?.Http?.AcceptEncoding || "gzip, deflate, br",
  },
  // Keep-Alive dla non-proxy
  httpAgent: proxyEnabled ? undefined : new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 100 }),
  httpsAgent: proxyEnabled ? undefined : new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 100 }),
};

// Proxy jeśli włączony (v7 API)
if (proxyEnabled && proxyUrl) {
  agentConfig.proxy = false;
  agentConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
  agentConfig.httpAgent = new HttpProxyAgent(proxyUrl);
  console.log(`[HTTP] Proxy włączony: ${proxyUrl}`);
} else {
  console.log("[HTTP] Proxy wyłączone.");
}

const httpClient = axios.create(agentConfig);

// ============ FALLBACK UA ============

const UA_FALLBACKS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "FeedFetcher-Google"
];

// ============ PER-HOST COOLDOWN (circuit breaker) ============

/*
  Map host -> {
    until: number (ms epoch),
    strikes: number,
    status?: number,
    reason?: string,
    lastErrorAt: number
  }
*/
const hostCooldowns = new Map();

function getHostFromUrl(url) {
  try { return new URL(url).host; } catch { return null; }
}

function isHostOnCooldown(hostOrUrl) {
  const host = (typeof hostOrUrl === "string" && hostOrUrl.includes("://")) ? getHostFromUrl(hostOrUrl) : hostOrUrl;
  const cd = host ? hostCooldowns.get(host) : null;
  return !!(cd && cd.until > Date.now());
}

function getHostCooldown(hostOrUrl) {
  const host = (typeof hostOrUrl === "string" && hostOrUrl.includes("://")) ? getHostFromUrl(hostOrUrl) : hostOrUrl;
  return host ? hostCooldowns.get(host) || null : null;
}

function clearCooldown(hostOrUrl) {
  const host = (typeof hostOrUrl === "string" && hostOrUrl.includes("://")) ? getHostFromUrl(hostOrUrl) : hostOrUrl;
  if (host) hostCooldowns.delete(host);
}

function parseRetryAfter(header) {
  if (!header) return null;
  if (/^\d+$/.test(String(header))) return parseInt(header, 10) * 1000; // sekundy
  const t = Date.parse(header);
  return isNaN(t) ? null : Math.max(0, t - Date.now());
}

function computeBaseCooldownMs(status, err) {
  if (status === 401 || status === 403) return 10 * 60 * 1000; // 10 min
  if (status === 429) return parseRetryAfter(err?.response?.headers?.["retry-after"] || err?.response?.headers?.["Retry-After"]) ?? 2 * 60 * 1000;
  if (status === 502 || status === 503 || status === 504) return 2 * 60 * 1000; // 2 min
  if (status >= 500 && status < 600) return 60 * 1000; // 1 min
  if (status >= 400 && status < 500) return 5 * 60 * 1000; // 5 min

  const code = err?.code;
  if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return 30 * 1000;

  return 30 * 1000;
}

function setCooldown(host, status, reason, err) {
  const now = Date.now();
  const prev = hostCooldowns.get(host);
  const strikes = (prev?.strikes || 0) + 1;

  const base = computeBaseCooldownMs(status, err);
  const maxMs = 60 * 60 * 1000; // max 60 min
  const ttl = Math.min(base * Math.pow(2, strikes - 1), maxMs); // eskalacja x2

  hostCooldowns.set(host, {
    until: now + ttl + Math.floor(Math.random() * 1000), // jitter
    strikes,
    status,
    reason,
    lastErrorAt: now,
  });

  const sec = Math.ceil(ttl / 1000);
  console.warn(`[HTTP] Cooldown hosta ${host} na ${sec}s (status: ${status || "n/a"}, reason: ${reason || "n/a"}, strikes: ${strikes})`);
}

// ============ CONDITIONAL (ETag / Last-Modified) CACHE ============

const COND_CACHE_FILE = "./http-meta.json";
let condCache = {};
try {
  if (fs.existsSync(COND_CACHE_FILE)) {
    condCache = JSON.parse(fs.readFileSync(COND_CACHE_FILE, "utf8")) || {};
  }
} catch {
  condCache = {};
}

let _metaSaveTimer = null;
function saveCondCache() {
  clearTimeout(_metaSaveTimer);
  _metaSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(COND_CACHE_FILE, JSON.stringify(condCache, null, 2), "utf8"); }
    catch (e) { console.warn("[HTTP] Nie mogę zapisać http-meta.json:", e?.message); }
  }, 300);
}

// ============ PREFERENCJE PER-DOMENA / NAGŁÓWKI ============

function getConfiguredCookie(host) {
  try {
    const jar = CONFIG?.Http?.Cookies || {};
    return jar[host] || null;
  } catch {
    return null;
  }
}

function getExtraHeadersForUrl(url) {
  const out = {};
  const map = CONFIG?.Http?.ExtraHeaders || {};
  try {
    for (const [pattern, headers] of Object.entries(map)) {
      if (typeof pattern !== "string" || !headers) continue;
      if (url.includes(pattern)) Object.assign(out, headers);
    }
  } catch {}
  return out;
}

function domainSpecificHeaders(url) {
  let u;
  try { u = new URL(url); } catch { return {}; }

  // boop.pl → symulacja przeglądarki dla /rss oraz /feed
  if (u.hostname === "boop.pl" && (u.pathname === "/rss" || u.pathname.startsWith("/feed"))) {
    const h = {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": CONFIG?.Http?.AcceptEncoding || "gzip, deflate, br",
      "Sec-GPC": "1",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
      Priority: "u=0, i",
      "Alt-Used": u.hostname,
      Referer: `https://${u.hostname}/`
    };
    const cookie = getConfiguredCookie(u.hostname);
    if (cookie) h["Cookie"] = cookie;
    return h;
  }

  // lowcygier.pl — “przeglądarkowe” dla /rss /feed
  if (u.hostname === "lowcygier.pl" && (u.pathname === "/rss" || u.pathname.startsWith("/feed"))) {
    return {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": CONFIG?.Http?.AcceptEncoding || "gzip, deflate, br",
      "Sec-GPC": "1",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
      Priority: "u=0, i",
      Referer: `https://${u.hostname}/`,
    };
  }

  return {};
}

// ============ GŁÓWNA FUNKCJA GET (rozszerzona) ============
//
// getWithFallback(url, options?)
// options.headers          → dodatkowe nagłówki
// options.timeout          → ms
// options.responseType     → np. "arraybuffer"
// options.method           → "GET" (domyślnie)
// options.conditionalKey   → klucz do ETag/Last-Modified (domyślnie url)
//
async function getWithFallback(url, options = {}) {
  const host = getHostFromUrl(url);
  const attempt = options.__attempt || 0;

  // Cooldown
  if (host && isHostOnCooldown(url)) {
    const cd = getHostCooldown(url);
    const sec = Math.ceil((cd.until - Date.now()) / 1000);
    const err = new Error(`[PerHostCooldown] ${host} zablokowany ~${sec}s (${cd.reason || cd.status})`);
    err.code = "PER_HOST_COOLDOWN";
    err.cooldown = { host, ...cd };
    console.warn(`[HTTP] Host ${host} na cooldownie ~${sec}s — pomijam ${url}`);
    throw err;
  }

  const origin = (() => { try { return new URL(url).origin; } catch { return undefined; } })();
  const baseHeaders = {
    "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": CONFIG?.Http?.AcceptEncoding || "gzip, deflate, br",
    ...(origin ? { Referer: origin } : {}),
  };

  const special = domainSpecificHeaders(url);
  const extras = getExtraHeadersForUrl(url);

  // Conditional headers (ETag / Last-Modified) – jeśli brak w extras
  const condKey = options.conditionalKey || url;
  const cond = condCache[condKey] || {};
  const condHeaders = {};
  if (!("If-None-Match" in extras) && cond.etag) {
    condHeaders["If-None-Match"] = cond.etag;
  }
  if (!("If-Modified-Since" in extras) && cond.lastModified) {
    condHeaders["If-Modified-Since"] = cond.lastModified;
  }

  const forcedUA = options.forceUA || (attempt > 0 ? UA_FALLBACKS[Math.min(attempt - 1, UA_FALLBACKS.length - 1)] : null);
  const uaHdr = forcedUA ? { "User-Agent": forcedUA } : {};
  const userHeaders = options.headers || {};

  // Finalne nagłówki (kolejność: base → special → cond → extras → UA → user)
  const headers = Object.assign({}, baseHeaders, special, condHeaders, extras, uaHdr, userHeaders);

  const reqConfig = {
    url,
    method: options.method || "GET",
    headers,
    timeout: options.timeout ?? agentConfig.timeout,
    responseType: options.responseType,
    httpAgent: httpClient.defaults.httpAgent,
    httpsAgent: httpClient.defaults.httpsAgent,
    validateStatus: (s) => s >= 200 && s < 300 // 304 pójdzie w catch
  };

  try {
    const res = await httpClient.request(reqConfig);

    // Sukces → wyczyść cooldown + aktualizuj ETag/Last-Modified
    if (host) clearCooldown(host);
    try {
      const etag = res.headers?.etag;
      const lm = res.headers?.["last-modified"];
      if (etag || lm) {
        condCache[condKey] = Object.assign({}, condCache[condKey] || {}, {
          ...(etag ? { etag } : {}),
          ...(lm ? { lastModified: lm } : {})
        });
        saveCondCache();
      }
    } catch {}

    return res;
  } catch (err) {
    const status = err?.response?.status;

    // 304 Not Modified — axios rzuca wyjątek → zwracamy response
    if (status === 304 && err.response) {
      if (host) clearCooldown(host);
      return err.response;
    }

    // Twarde odrzucenia → ustaw cooldown i zakończ
    if (host && (status === 401 || status === 403 || status === 429)) {
      setCooldown(host, status, "hard-reject", err);
      throw err;
    }

    // Próby fallbacku UA
    if (attempt < UA_FALLBACKS.length) {
      const newUA = UA_FALLBACKS[attempt];
      console.warn(`[HTTP] Próba fallback UA: ${newUA} dla ${url} (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
      return getWithFallback(url, Object.assign({}, options, { __attempt: attempt + 1, forceUA: newUA }));
    }

    // Wyczerpane próby → ustaw cooldown “miękki”
    if (host) setCooldown(host, status, "exhausted-fallbacks", err);
    console.error(`[HTTP] ❌ Wszystkie próby nieudane dla ${url}: ${err.message}`);
    throw err;
  }
}

module.exports = {
  getWithFallback,
  isHostOnCooldown,
  getHostCooldown,
  clearCooldown,
};