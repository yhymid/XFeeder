// src/parsers/downloader.js - HTTP downloader with Scrapling fallback
"use strict";

const { getWithFallback } = require("../client");
const { getScrapling } = require("../extensions/Scrapling");
const { loadConfig } = require("../config-loader");

function buildAccept(accept) {
  switch ((accept || "auto").toLowerCase()) {
    case "xml":
    case "rss":
    case "atom":
      return "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8";
    case "json":
      return "application/feed+json,application/json,text/json;q=0.9,*/*;q=0.8";
    case "html":
      return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    case "auto":
    default:
      return "application/rss+xml,application/atom+xml,application/xml,application/json;q=0.9,*/*;q=0.8";
  }
}

function normalizeSource(responseLike = {}) {
  return {
    status: responseLike?.status || responseLike?.response?.status || null,
    headers: responseLike?.headers || responseLike?.response?.headers || {},
    body: responseLike?.data || responseLike?.response?.data || "",
  };
}

function analyzeSource(scrapling, url, responseLike, antiBotOverrides = {}) {
  const src = normalizeSource(responseLike);
  const anti = scrapling.config.getAntiBotConfig(url, antiBotOverrides);
  return {
    anti,
    ...scrapling.utils.analyzeAntiBotSignals({
      status: src.status,
      headers: src.headers,
      body: typeof src.body === "string" ? src.body : "",
      statusCodes: anti.statusCodes,
      headerKeys: anti.headerKeys,
      bodySignatures: anti.bodySignatures,
      titleSignatures: anti.titleSignatures,
      minBodyBytes: anti.minBodyBytes,
      minConfidence: anti.minConfidence,
      treatCloudflareAsSignal: anti.treatCloudflareAsSignal,
    }),
  };
}

function evaluateScraplingNeed(scrapling, responseLike, url, opts = {}) {
  if (!scrapling.enabled) return { use: false, analysis: null, status: null };
  const src = normalizeSource(responseLike);
  const status = src.status;
  const antiOverrides = opts?.scrapling?.antiBot || {};
  const analysis = analyzeSource(scrapling, url, responseLike, antiOverrides);

  if (scrapling.config.shouldUseScrapling(url, status)) {
    return { use: true, analysis, status };
  }

  if (analysis.anti.enabled && analysis.blocked) {
    if (analysis.anti.logDecisions) {
      console.warn(
        `[Scrapling AntiBot] HTTP challenge detected for ${url}: score=${analysis.score} reasons=${analysis.reasons.join(", ")}`
      );
    }
    return { use: true, analysis, status };
  }
  return { use: false, analysis, status };
}

function prioritizeModeSequence(modeSequence = [], seedAnalysis = null, antiConfig = null) {
  const sequence = Array.isArray(modeSequence) ? [...modeSequence] : [];
  if (antiConfig && antiConfig.preferStealthOnSignals === false) return sequence;
  if (!seedAnalysis || typeof seedAnalysis !== "object") return sequence;

  const preferStealth = Boolean(
    seedAnalysis.cloudflare ||
    seedAnalysis.statusBlocked ||
    seedAnalysis.headerBlocked ||
    seedAnalysis.bodyBlocked ||
    seedAnalysis.titleBlocked
  );
  if (!preferStealth) return sequence;

  const preferred = ["stealthy-fetch", "fetch"];
  const out = [];
  for (const mode of preferred) {
    if (sequence.includes(mode) && !out.includes(mode)) out.push(mode);
  }
  for (const mode of sequence) {
    if (!out.includes(mode)) out.push(mode);
  }
  return out;
}

async function fetchWithScrapling(scrapling, url, opts = {}, initialAnalysis = null) {
  const requestOptions = opts.scrapling || {};
  const anti = scrapling.config.getAntiBotConfig(url, requestOptions.antiBot || {});
  const rawModeSequence = scrapling.config.buildModeSequence(url, requestOptions);
  const modeSequence = prioritizeModeSequence(rawModeSequence, initialAnalysis, anti);
  if (
    anti.logDecisions &&
    Array.isArray(rawModeSequence) &&
    rawModeSequence.join("|") !== modeSequence.join("|")
  ) {
    console.warn(
      `[Scrapling AntiBot] Prioritized modes for ${url}: ${rawModeSequence.join(" -> ")} => ${modeSequence.join(" -> ")}`
    );
  }
  const attempts = modeSequence.slice(0, Math.max(1, anti.maxAttempts));
  let lastError = null;
  let lastBlocked = null;

  for (const mode of attempts) {
    const attemptOptions = { ...requestOptions, mode, extractMode: mode, fetchMode: mode };
    if (mode === "stealthy-fetch" && attemptOptions.solveCloudflare == null && attemptOptions.solveCaptcha == null) {
      attemptOptions.solveCloudflare = true;
    }
    if (attemptOptions.solveCloudflare === true) {
      if (attemptOptions.timeoutMs == null || Number(attemptOptions.timeoutMs) < 60000) {
        attemptOptions.timeoutMs = 60000;
      }
      if (attemptOptions.timeout == null || Number(attemptOptions.timeout) < 60) {
        attemptOptions.timeout = 60;
      }
    }

    try {
      const response = await scrapling.fetch(url, attemptOptions);
      const html = response?.html || response?.data || "";
      const analysis = scrapling.utils.analyzeAntiBotSignals({
        status: response?.status || 200,
        headers: response?.headers || {},
        body: typeof html === "string" ? html : "",
        statusCodes: anti.statusCodes,
        headerKeys: anti.headerKeys,
        bodySignatures: anti.bodySignatures,
        titleSignatures: anti.titleSignatures,
        minBodyBytes: anti.minBodyBytes,
        minConfidence: anti.minConfidence,
        treatCloudflareAsSignal: anti.treatCloudflareAsSignal,
      });

      if (analysis.blocked) {
        lastBlocked = { mode, analysis };
        if (anti.logDecisions) {
          console.warn(
            `[Scrapling AntiBot] Mode ${mode} looks blocked for ${url}: score=${analysis.score} reasons=${analysis.reasons.join(", ")}`
          );
        }
        continue;
      }

      return {
        ok: true,
        status: response?.status || 200,
        headers: response?.headers || {},
        data: html,
        contentType: "text/html",
        scrapling: true,
        scraplingMode: response?.fetchMode || mode,
        scraplingRuntime: response?.runtime || response?.resolvedRuntime || null,
        scraplingRuntimeResolved: response?.resolvedRuntime || response?.runtime || null,
        scraplingRuntimeRequested: response?.requestedRuntime || null,
        scraplingRuntimeAutoSwitched: response?.runtimeAutoSwitched === true,
        elapsed: response?.elapsed || null,
        antiBotSignals: analysis,
      };
    } catch (error) {
      lastError = error;
      if (anti.logDecisions) {
        console.warn(`[Scrapling AntiBot] Mode ${mode} failed for ${url}: ${error.message}`);
      }
    }
  }

  if (lastError) {
    return { ok: false, error: lastError, reason: "SCRAPLING_ERROR" };
  }
  if (lastBlocked) {
    return { ok: false, reason: "SCRAPLING_BLOCKED", antiBotSignals: lastBlocked.analysis };
  }
  return { ok: false, reason: "SCRAPLING_NO_RESULT" };
}

async function download(url, opts = {}) {
  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, reason: "UNSUPPORTED_PROTOCOL" };
  } catch (error) {
    return { ok: false, error, reason: "INVALID_URL" };
  }

  const rootConfig = loadConfig("./config.json");
  const scrapling = getScrapling(rootConfig);

  const headers = { Accept: buildAccept(opts.accept), ...(opts.headers || {}) };
  if (opts.etag) headers["If-None-Match"] = opts.etag;
  if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;

  try {
    const res = await getWithFallback(url, { headers, timeout: opts.timeout, responseType: opts.responseType });
    if (res?.status === 304) return { ok: true, status: 304, headers: res.headers || {}, data: "", notModified: true };

    const decision = evaluateScraplingNeed(scrapling, res, url, opts);
    if (decision.use) {
      const s = await fetchWithScrapling(scrapling, url, opts, decision.analysis);
      if (s.ok) return s;
    }

    const ct = (res?.headers?.["content-type"] || res?.headers?.["Content-Type"] || "").toString();
    return { ok: true, status: res?.status, headers: res?.headers || {}, data: res?.data, contentType: ct };
  } catch (err) {
    const decision = evaluateScraplingNeed(scrapling, err, url, opts);
    if (decision.use) {
      const s = await fetchWithScrapling(scrapling, url, opts, decision.analysis);
      if (s.ok) return s;
    }
    return {
      ok: false,
      error: err,
      status: err?.response?.status,
      headers: err?.response?.headers || {},
      data: err?.response?.data,
      contentType: (err?.response?.headers?.["content-type"] || "").toString(),
      reason: "HTTP_ERROR",
    };
  }
}

module.exports = { buildAccept, download };
