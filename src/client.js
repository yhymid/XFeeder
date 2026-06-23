// src/client.js - HTTP Client with proxy support and UA fallbacks
"use strict";

const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

const { loadConfig } = require("./config-loader");

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "application/rss+xml,application/atom+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
};

let clientCache = {
  signature: null,
  client: null,
};

function resolveProxySettings(configPath = "./config.json") {
  try {
    const config = loadConfig(configPath);
    const enabled = config?.Proxy?.Enabled === true;
    const url = typeof config?.Proxy?.Url === "string" ? config.Proxy.Url.trim() : "";
    return {
      enabled: enabled && Boolean(url),
      url,
    };
  } catch {
    console.warn("[HTTP] Missing or invalid config.json -> Proxy skipped.");
    return {
      enabled: false,
      url: "",
    };
  }
}

function buildClientSignature(settings) {
  return JSON.stringify({
    proxyEnabled: settings.enabled,
    proxyUrl: settings.url,
  });
}

function createHttpClient(settings) {
  const agentConfig = {
    timeout: 15000,
    headers: {
      ...BASE_HEADERS,
    },
  };

  if (settings.enabled && settings.url) {
    agentConfig.proxy = false;
    agentConfig.httpsAgent = new HttpsProxyAgent(settings.url);
    agentConfig.httpAgent = new HttpProxyAgent(settings.url);
    console.log(`[HTTP] Proxy enabled: ${settings.url}`);
  } else {
    console.log("[HTTP] Proxy disabled.");
  }

  return axios.create(agentConfig);
}

function getHttpClient(configPath = "./config.json") {
  const settings = resolveProxySettings(configPath);
  const signature = buildClientSignature(settings);
  if (clientCache.client && clientCache.signature === signature) {
    return clientCache.client;
  }

  clientCache = {
    signature,
    client: createHttpClient(settings),
  };

  return clientCache.client;
}

// User-Agent fallback list for retry attempts
const UA_FALLBACKS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "FeedFetcher-Google",
];

function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const error = new Error(`Invalid URL: ${url}`);
    error.code = "INVALID_URL";
    throw error;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const error = new Error(`Unsupported protocol ${parsed.protocol}`);
    error.code = "UNSUPPORTED_PROTOCOL";
    throw error;
  }
}

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
  assertHttpUrl(url);

  try {
    const res = await getHttpClient().get(url, {
      ...opts,
      validateStatus: (s) => s === 304 || (s >= 200 && s < 300),
    });
    return res;
  } catch (err) {
    const status = err?.response?.status;

    if (status === 304 && err.response) return err.response;

    if (attempt < maxAttempts - 1) {
      const newUA = UA_FALLBACKS[attempt];
      console.warn(
        `[HTTP] Fallback UA attempt: ${newUA} for ${url} (attempt ${attempt + 1})`
      );
      const headers = { ...(opts.headers || {}), "User-Agent": newUA };
      return getWithFallback(url, { ...opts, headers }, attempt + 1);
    }

    console.error(`[HTTP] All attempts failed for ${url}: ${err.message}`);
    throw err;
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
  assertHttpUrl(url);

  try {
    const res = await getHttpClient().post(url, data, {
      ...opts,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return res;
  } catch (err) {
    console.error(`[HTTP POST] Error for ${url}: ${err.message}`);
    throw err;
  }
}

module.exports = {
  getHttpClient,
  getWithFallback,
  postWithFallback,
};
