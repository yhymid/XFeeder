// src/client.js
"use strict";

const axios = require("axios");
const fs = require("fs");

// ============ PROXY ============

let proxyEnabled = false;
let proxyUrl = null;

// Wczytanie config.json w celu pobrania ustawień Proxy
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

// ============ FALLBACK UA ============

const UA_FALLBACKS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "FeedFetcher-Google",
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

function getHostFromUrl(url) { try { return new URL(url).host; } catch { return null; } }

function isHostOnCooldown(hostOrUrl) {
  const host = hostOrUrl.includes("://") ? getHostFromUrl(hostOrUrl) : hostOrUrl;
  const cd = host ? hostCooldowns.get(host) : null;
  return !!(cd && cd.until > Date.now());
}

function getHostCooldown(hostOrUrl) {
  const host = hostOrUrl.includes("://") ? getHostFromUrl(hostOrUrl) : hostOrUrl;
  return host ? hostCooldowns.get(host) || null : null;
}

function clearCooldown(hostOrUrl) {
  const host = hostOrUrl.includes("://") ? getHostFromUrl(hostOrUrl) : hostOrUrl;
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

  // sieć/time-outy
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

// ============ NAGŁÓWKI SPECJALNE PER-DOMENA/ŚCIEŻKA ============

function domainSpecificHeaders(url) {
  let u;
  try { u = new URL(url); } catch { return {}; }

  // lowcygier.pl → dla /rss i /feed/ używamy nagłówków podobnych do przeglądarki
  if (u.hostname === "lowcygier.pl" && (u.pathname === "/rss" || u.pathname.startsWith("/feed"))) {
    return {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Sec-GPC": "1",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
      Priority: "u=0, i",
      // Użyj naturalnego referera dla hosta
      Referer: `https://${u.hostname}/`,
    };
  }

  return {};
}

// ============ GŁÓWNA FUNKCJA GET Z FALLBACK UA + PER-HOST COOLDOWN ============

async function getWithFallback(url, attempt = 0, forcedUA = null) {
  const host = getHostFromUrl(url);

  // Jeśli host jest na cooldownie — przerwij od razu
  if (host && isHostOnCooldown(url)) {
    const cd = getHostCooldown(url);
    const sec = Math.ceil((cd.until - Date.now()) / 1000);
    const err = new Error(`[PerHostCooldown] ${host} zablokowany ~${sec}s (${cd.reason || cd.status})`);
    err.code = "PER_HOST_COOLDOWN";
    err.cooldown = { host, ...cd };
    console.warn(`[HTTP] Host ${host} na cooldownie ~${sec}s — pomijam ${url}`);
    throw err;
  }

  // Bazowe nagłówki per request
  const origin = (() => { try { return new URL(url).origin; } catch { return undefined; } })();
  const baseHeaders = {
    "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
    ...(origin ? { Referer: origin } : {}),
  };

  // Specjalne nagłówki dla niektórych domen/ścieżek
  const special = domainSpecificHeaders(url);

  // Ewentualny wymuszony UA (z fallbacków)
  const uaHdr = forcedUA ? { "User-Agent": forcedUA } : {};

  // Kolejność: bazowe → specjalne → forcedUA
  const headers = Object.keys(special).length
    ? { ...baseHeaders, ...special, ...uaHdr }
    : { ...baseHeaders, ...uaHdr };

  try {
    const res = await httpClient.get(url, { headers });
    if (host) clearCooldown(host); // sukces resetuje cooldown
    return res;
  } catch (err) {
    const status = err?.response?.status;

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
      return getWithFallback(url, attempt + 1, newUA);
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