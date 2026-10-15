// src/parsers/downloader.js - HTTP downloader with Scrapling fallback
"use strict";

const { isBlockedPage } = require("../core/blocked-page");
const { getWithFallback } = require("../client");
const { getNetwork } = require("../network/service");
const { isCancelled, throwIfAborted } = require("../network/abort");
const { context } = require("../network/context");
const { getScrapling } = require("../extensions/Scrapling");
const { loadConfig } = require("../config-loader");
const { expert, sanitizeText, sanitizeUrl } = require("../core/diagnostics");

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
  const pageBlocked = isBlockedPage(normalizeSource(responseLike).body, normalizeSource(responseLike));
  if (!scrapling.enabled || scrapling.config.getUrlConfig(url).enabled === false)
    return { use: false, analysis: { blocked: pageBlocked }, status: normalizeSource(responseLike).status };
  const src = normalizeSource(responseLike);
  const status = src.status;
  const antiOverrides = opts?.scrapling?.antiBot || {};
  const analysis = analyzeSource(scrapling, url, responseLike, antiOverrides);
  analysis.blocked ||= pageBlocked;

  if (scrapling.config.shouldUseScrapling(url, status)) {
    return { use: true, analysis, status };
  }

  if (scrapling.config.autoFallback && analysis.anti.enabled && analysis.blocked) {
    if (analysis.anti.logDecisions) {
      console.warn(
        `[Scrapling AntiBot] HTTP challenge detected for ${sanitizeUrl(url)}: score=${analysis.score} reasons=${analysis.reasons.join(", ")}`
      );
      expert("scrapling.challenge.detected", {
        url,
        status,
        score: analysis.score,
        reasons: analysis.reasons,
      });
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
      `[Scrapling AntiBot] Prioritized modes for ${sanitizeUrl(url)}: ${rawModeSequence.join(" -> ")} => ${modeSequence.join(" -> ")}`
    );
  }
  const attempts = modeSequence.slice(0, Math.max(1, anti.maxAttempts));
  let lastError = null;
  let lastBlocked = null;

  for (const mode of attempts) {
    const attemptStartedAt = Date.now();
    expert("scrapling.attempt.begin", { url, mode });
    const attemptOptions = {
      ...requestOptions,
      signal: opts.signal || requestOptions.signal,
      includeResponseMetadata: true,
      mode,
      extractMode: mode,
      fetchMode: mode,
    };
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
        status: response?.status ?? null,
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

      if (analysis.blocked || isBlockedPage(html, response)) {
        lastBlocked = { mode, analysis };
        expert("scrapling.attempt.blocked", {
          url,
          mode,
          status: response?.status ?? null,
          score: analysis.score,
          reasons: analysis.reasons,
          durationMs: Date.now() - attemptStartedAt,
        });
        if (anti.logDecisions) {
          console.warn(
            `[Scrapling AntiBot] Mode ${mode} looks blocked for ${sanitizeUrl(url)}: score=${analysis.score} reasons=${analysis.reasons.join(", ")}`
          );
        }
        continue;
      }

      expert("scrapling.attempt.complete", {
        url,
        mode: response?.fetchMode || mode,
        runtime: response?.runtime || response?.resolvedRuntime || null,
        status: response?.status ?? null,
        bodyBytes: typeof html === "string" ? Buffer.byteLength(html) : null,
        durationMs: response?.elapsed || Date.now() - attemptStartedAt,
        antiBot: { blocked: false, score: analysis.score, reasons: analysis.reasons },
      });
      return {
        ok: true,
        status: response?.status ?? null,
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
      if (error?.name === "AbortError" || opts.signal?.aborted || requestOptions.signal?.aborted) throw error;
      lastError = error;
      expert("scrapling.attempt.failed", {
        url,
        mode,
        durationMs: Date.now() - attemptStartedAt,
        error,
      });
      if (anti.logDecisions) {
        console.warn(`[Scrapling AntiBot] Mode ${mode} failed for ${sanitizeUrl(url)}: ${sanitizeText(error.message)}`);
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
  opts = { ...opts, signal: opts.signal || context().signal };
  throwIfAborted(opts.signal);
  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, reason: "UNSUPPORTED_PROTOCOL" };
  } catch (error) {
    return { ok: false, error, reason: "INVALID_URL" };
  }

  const configPath = opts.configPath || "./config.json";
  const rootConfig = opts.config && typeof opts.config === "object"
    ? opts.config
    : loadConfig(configPath);
  const network = getNetwork(rootConfig);
  const publicOnly = network.config.outboundPolicy === "public-only";
  const scrapling = getScrapling(rootConfig);

  const urlConfig = scrapling.config.getUrlConfig(url);
  const forceScrapling = scrapling.enabled && urlConfig.enabled !== false && (
    scrapling.config.raw.ForceGlobal === true || urlConfig.enabled === true
  );
  expert("download.begin", {
    url,
    forcedScrapling: forceScrapling,
    scraplingEnabled: scrapling.enabled,
    configuredUrl: urlConfig.enabled === true,
    conditionalRequest: { etag: Boolean(opts.etag), lastModified: Boolean(opts.lastModified) },
  });
  if (forceScrapling && publicOnly) {
    // Browser/Python networking bypasses Node's protected socket lookup.
    // Never silently bypass public-only mode via a forced browser session.
    return { ok: false, reason: "SCRAPLING_DISALLOWED_BY_PUBLIC_ONLY" };
  }
  if (forceScrapling) {
    const result = await fetchWithScrapling(scrapling, url, opts);
    if (result.ok) {
      expert("download.complete", { url, ok: true, source: "scrapling-forced", status: result.status, mode: result.scraplingMode });
      return result;
    }
    const failed = {
      ...result,
      ok: false,
      reason: result.reason === "SCRAPLING_BLOCKED"
        ? "ANTIBOT_CHALLENGE_UNRESOLVED"
        : "SCRAPLING_FORCED_FAILED",
    };
    expert("download.failed", { url, ok: false, reason: failed.reason, status: failed.status, source: "scrapling-forced" });
    return failed;
  }

  const headers = { Accept: buildAccept(opts.accept), ...(opts.headers || {}) };
  if (opts.etag) headers["If-None-Match"] = opts.etag;
  if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;
  const requestContext = { configPath, config: rootConfig };

  try {
    const res = await getWithFallback(url, {
      ...requestContext,
      headers,
      timeout: opts.timeout,
      signal: opts.signal,
      deadlineMs: opts.deadlineMs,
      setupTimeoutMs: opts.setupTimeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
      maxContentLength: opts.maxContentLength,
      responseType: opts.responseType,
    });
    if (res?.status === 304) return { ok: true, status: 304, headers: res.headers || {}, data: "", notModified: true };

    const decision = publicOnly
      ? { use: false }
      : evaluateScraplingNeed(scrapling, res, url, opts);
    if (decision.use) {
      expert("download.scrapling.fallback", {
        url,
        status: res?.status ?? null,
        score: decision.analysis?.score,
        reasons: decision.analysis?.reasons,
      });
      const s = await fetchWithScrapling(scrapling, url, opts, decision.analysis);
      if (s.ok) {
        expert("download.complete", { url, ok: true, source: "scrapling-fallback", status: s.status, mode: s.scraplingMode });
        return s;
      }
      if (decision.analysis?.blocked) {
        const failed = {
          ok: false,
          status: res?.status,
          headers: res?.headers || {},
          data: res?.data,
          contentType: (res?.headers?.["content-type"] || res?.headers?.["Content-Type"] || "").toString(),
          error: s.error,
          reason: "ANTIBOT_CHALLENGE_UNRESOLVED",
          antiBotSignals: decision.analysis,
          scraplingReason: s.reason,
        };
        expert("download.failed", { url, ok: false, reason: failed.reason, scraplingReason: s.reason, status: failed.status });
        return failed;
      }
    }

    if (isBlockedPage(res.data, res)) {
      expert("download.failed", { url, reason: "ANTIBOT_CHALLENGE_UNRESOLVED", status: res.status });
      return { ok: false, status: res.status, reason: "ANTIBOT_CHALLENGE_UNRESOLVED" };
    }

    const ct = (res?.headers?.["content-type"] || res?.headers?.["Content-Type"] || "").toString();
    const result = { ok: true, status: res?.status, headers: res?.headers || {}, data: res?.data, contentType: ct };
    expert("download.complete", {
      url,
      ok: true,
      source: "http",
      status: result.status,
      contentType: ct,
      bodyBytes: typeof result.data === "string" ? Buffer.byteLength(result.data) : null,
    });
    return result;
  } catch (err) {
    if (isCancelled(err) || opts.signal?.aborted) throw err;
    if (Number(err?.response?.status) === 429) {
      const limited = {
        ok: false,
        error: err,
        status: 429,
        headers: err?.response?.headers || {},
        data: err?.response?.data,
        contentType: (err?.response?.headers?.["content-type"] || "").toString(),
        reason: "HTTP_RATE_LIMITED",
      };
      expert("download.failed", {
        url,
        ok: false,
        reason: limited.reason,
        status: limited.status,
        retryAfter: limited.headers?.["retry-after"] || limited.headers?.["Retry-After"] || null,
      });
      return limited;
    }

    const decision = publicOnly
      ? { use: false }
      : evaluateScraplingNeed(scrapling, err, url, opts);
    if (decision.use) {
      const s = await fetchWithScrapling(scrapling, url, opts, decision.analysis);
      if (s.ok) {
        expert("download.complete", { url, ok: true, source: "scrapling-after-http-error", status: s.status, mode: s.scraplingMode });
        return s;
      }
      if (decision.analysis?.blocked) {
        const failed = {
          ok: false,
          error: s.error || err,
          status: err?.response?.status,
          headers: err?.response?.headers || {},
          data: err?.response?.data,
          contentType: (err?.response?.headers?.["content-type"] || "").toString(),
          reason: "ANTIBOT_CHALLENGE_UNRESOLVED",
          antiBotSignals: decision.analysis,
          scraplingReason: s.reason,
        };
        expert("download.failed", { url, ok: false, reason: failed.reason, scraplingReason: s.reason, status: failed.status });
        return failed;
      }
    }
    const failed = {
      ok: false,
      error: err,
      status: err?.response?.status,
      headers: err?.response?.headers || {},
      data: err?.response?.data,
      contentType: (err?.response?.headers?.["content-type"] || "").toString(),
      reason: "HTTP_ERROR",
    };
    expert("download.failed", { url, ok: false, reason: failed.reason, status: failed.status, error: err });
    return failed;
  }
}

module.exports = { buildAccept, download };
