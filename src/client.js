// src/client.js - HTTP client with proxy support and bounded transient retries
"use strict";

const axios = require("axios");
const { finished } = require("node:stream");
const { validateTimeoutOptions } = require("./network/http-adapter");
const { createManagedClient } = require("./network/http-client");
const { getNetwork } = require("./network/service");
const {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  getHeader,
  getRetryAfterMs,
  getRetryDelayMs,
  isRetryableRequestError,
} = require("./network/retry-policy");
const { isCancelled } = require("./network/abort");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

const { loadConfig } = require("./config-loader");
const { expert, sanitizeText, sanitizeUrl } = require("./core/diagnostics");

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

function resolveProxySettings(configPath = "./config.json", configOverride = null) {
  try {
    const config = configOverride && typeof configOverride === "object"
      ? configOverride
      : loadConfig(configPath);
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
    xfeederDefaultTimeout: 15000,
    headers: {
      ...BASE_HEADERS,
    },
  };

  if (settings.enabled && settings.url) {
    agentConfig.proxy = false;
    agentConfig.httpsAgent = new HttpsProxyAgent(settings.url);
    agentConfig.httpAgent = new HttpProxyAgent(settings.url);
    console.log(`[HTTP] Proxy enabled: ${sanitizeUrl(settings.url)}`);
  } else {
    console.log("[HTTP] Proxy disabled.");
  }

  return createManagedClient(agentConfig);
}

function getHttpClient(configPath = "./config.json", configOverride = null) {
  const rootConfig = configOverride || loadConfig(configPath);
  getNetwork(rootConfig);
  const settings = resolveProxySettings(configPath, rootConfig);
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
 * GET request with bounded retries for transient failures.
 * Permanent client errors are returned immediately to the caller.
 *
 * @param {string} url - URL to fetch
 * @param {object} opts - Optional axios config overrides
 * @param {number} attempt - Current retry attempt (internal)
 * @returns {Promise<object>} Axios response object
 */
async function getAttempt(url, opts = {}, attempt = 0) {
  const {
    configPath = "./config.json",
    config = null,
    maxAttempts: requestedMaxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseDelayMs: requestedBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: requestedMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    ...requestOptions
  } = opts;
  const maxAttemptsValue = Number(requestedMaxAttempts);
  const maxAttempts = Number.isFinite(maxAttemptsValue)
    ? Math.min(5, Math.max(1, Math.floor(maxAttemptsValue)))
    : DEFAULT_MAX_ATTEMPTS;
  const baseDelayValue = Number(requestedBaseDelayMs);
  const baseDelayMs = Number.isFinite(baseDelayValue) ? Math.max(0, baseDelayValue) : DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayValue = Number(requestedMaxDelayMs);
  const maxDelayMs = Number.isFinite(maxDelayValue) ? Math.max(0, maxDelayValue) : DEFAULT_RETRY_MAX_DELAY_MS;
  assertHttpUrl(url);
  const startedAt = Date.now();
  expert("http.request.begin", { method: "GET", url, attempt: attempt + 1, maxAttempts });

  try {
    const res = await getHttpClient(configPath, config).get(url, {
      ...requestOptions,
      validateStatus: (s) => s === 304 || (s >= 200 && s < 300),
    });
    expert("http.request.complete", {
      method: "GET",
      url,
      attempt: attempt + 1,
      status: res.status,
      contentType: getHeader(res.headers, "content-type") || "",
      bodyBytes: typeof res.data === "string" ? Buffer.byteLength(res.data) : null,
      durationMs: Date.now() - startedAt,
    });
    return res;
  } catch (err) {
    const status = err?.response?.status;

    if (status === 304 && err.response) return err.response;

    if (isRetryableRequestError(err) && attempt < maxAttempts - 1) {
      const delayMs = getRetryDelayMs(err, attempt, baseDelayMs, maxDelayMs);
      expert("http.request.retry", {
        method: "GET",
        url,
        status: status || null,
        code: err?.code || null,
        nextAttempt: attempt + 2,
        maxAttempts,
        delayMs,
        retryAfter: getHeader(err?.response?.headers, "retry-after") || null,
      });
      console.warn(
        `[HTTP] Retrying ${sanitizeUrl(url)} in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts}, status=${status || "network"}).`
      );
      await getNetwork().wait(delayMs, requestOptions.signal, "retry");
      return getAttempt(url, {
        ...requestOptions,
        configPath,
        config,
        maxAttempts,
        retryBaseDelayMs: baseDelayMs,
        retryMaxDelayMs: maxDelayMs,
      }, attempt + 1);
    }

    expert("http.request.failed", {
      method: "GET",
      url,
      attempt: attempt + 1,
      maxAttempts,
      status: status || null,
      durationMs: Date.now() - startedAt,
      error: err,
    });
    console.error(`[HTTP] Request failed for ${sanitizeUrl(url)}: ${sanitizeText(err.message)}`);
    throw err;
  }
}

async function getWithFallback(url, opts = {}) {
  validateTimeoutOptions(opts);
  // Keep one logical operation alive across backoff and all transport attempts.
  getHttpClient(opts.configPath || "./config.json", opts.config || null);
  const network = getNetwork();
  let op, timer, streaming = false, detachFinished;
  const cleanup = () => { clearTimeout(timer); detachFinished?.(); op?.finish(); };
  try {
    const deadline = opts.deadlineMs ?? network.config.requestDeadlineMs;
    op = network.operation(opts.signal, { localAbort: deadline > 0 });
    if (deadline > 0) timer = setTimeout(() => {
      const error = new axios.AxiosError(`deadline timeout of ${deadline}ms exceeded`, "ECONNABORTED");
      error.phase = "deadline"; op.abort(error);
    }, deadline);
    const response = await getAttempt(url, { ...opts, signal: op.signal, deadlineMs: 0 });
    if (response.data && typeof response.data.pipe === "function") {
      streaming = true;
      detachFinished = finished(response.data, cleanup);
    }
    return response;
  } catch (error) {
    if (op?.signal.aborted && op.signal.reason?.phase) throw op.signal.reason;
    if (isCancelled(error) || opts.signal?.aborted) throw new axios.CanceledError("Request cancelled");
    throw error;
  } finally { if (!streaming) cleanup(); }
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

  const { configPath = "./config.json", config = null, ...requestOptions } = opts;
  const startedAt = Date.now();
  expert("http.request.begin", { method: "POST", url });

  try {
    const res = await getHttpClient(configPath, config).post(url, data, {
      ...requestOptions,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    expert("http.request.complete", {
      method: "POST",
      url,
      status: res.status,
      contentType: getHeader(res.headers, "content-type") || "",
      durationMs: Date.now() - startedAt,
    });
    return res;
  } catch (err) {
    expert("http.request.failed", {
      method: "POST",
      url,
      status: err?.response?.status || null,
      durationMs: Date.now() - startedAt,
      error: err,
    });
    console.error(`[HTTP POST] Error for ${sanitizeUrl(url)}: ${sanitizeText(err.message)}`);
    throw err;
  }
}

module.exports = {
  getHttpClient,
  getWithFallback,
  getRetryAfterMs,
  postWithFallback,
  resolveProxySettings,
};
