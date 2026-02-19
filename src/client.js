// src/client.js - HTTP Client with proxy support and UA fallbacks
const axios = require("axios");
const { loadConfig } = require("./config-loader");

let proxyEnabled = false;
let proxyUrl = null;

// Load proxy configuration
try {
  const config = loadConfig("./config.json");
  if (config.Proxy && config.Proxy.Enabled && config.Proxy.Url) {
    proxyEnabled = true;
    proxyUrl = config.Proxy.Url;
  }
} catch {
  console.warn("[HTTP] Missing or invalid config.json → Proxy skipped.");
}

// Base client configuration
const agentConfig = {
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "application/rss+xml,application/atom+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
  },
};

// Configure proxy if enabled
if (proxyEnabled && proxyUrl) {
  agentConfig.proxy = false;
  agentConfig.httpsAgent = require("https-proxy-agent")(proxyUrl);
  agentConfig.httpAgent = require("http-proxy-agent")(proxyUrl);
  console.log(`[HTTP] Proxy enabled: ${proxyUrl}`);
} else {
  console.log("[HTTP] Proxy disabled.");
}

const httpClient = axios.create(agentConfig);

// User-Agent fallback list for retry attempts
const UA_FALLBACKS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "FeedFetcher-Google",
];

/**
 * GET request with automatic UA fallback on failure.
 * Returns 304 as valid response (not error).
 * 
 * @param {string} url - URL to fetch
 * @param {object} opts - Optional axios config overrides
 * @param {number} attempt - Current retry attempt (internal)
 * @returns {Promise<object>} Axios response object
 */
async function getWithFallback(url, opts = {}, attempt = 0) {
  const maxAttempts = UA_FALLBACKS.length + 1;

  // Validate URL protocol
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
      validateStatus: (s) => s === 304 || (s >= 200 && s < 300),
    });
    return res;
  } catch (err) {
    const status = err?.response?.status;
    
    // Return 304 as valid response
    if (status === 304 && err.response) return err.response;

    // Retry with different User-Agent
    if (attempt < maxAttempts - 1) {
      const newUA = UA_FALLBACKS[attempt];
      console.warn(
        `[HTTP] Fallback UA attempt: ${newUA} for ${url} (attempt ${attempt + 1})`
      );
      const headers = { ...(opts.headers || {}), "User-Agent": newUA };
      return getWithFallback(url, { ...opts, headers }, attempt + 1);
    } else {
      console.error(
        `[HTTP] ❌ All attempts failed for ${url}: ${err.message}`
      );
      throw err;
    }
  }
}

/**
 * POST request (for Fever API and others).
 * 
 * @param {string} url - URL to post to
 * @param {any} data - Request body data
 * @param {object} opts - Optional axios config overrides
 * @returns {Promise<object>} Axios response object
 */
async function postWithFallback(url, data, opts = {}) {
  try {
    const res = await httpClient.post(url, data, {
      ...opts,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return res;
  } catch (err) {
    console.error(`[HTTP POST] Error for ${url}: ${err.message}`);
    throw err;
  }
}

module.exports = { getWithFallback, postWithFallback };
