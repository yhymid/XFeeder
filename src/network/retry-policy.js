"use strict";

// Shared, transport-independent retry decisions for *safe* GET operations
// and the pre-existing Discord 429 policy. The policies intentionally differ:
// never infer POST idempotency or silently replay provider deliveries.
const { isCancelled } = require("./abort");
const { getNetwork } = require("./service");

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_NETWORK",
]);
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 8000;


function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((headerName) => headerName.toLowerCase() === target);
  return key ? headers[key] : undefined;
}

function getRetryAfterMs(headers, now = Date.now()) {
  const value = getHeader(headers, "retry-after");
  if (value === undefined || value === null || String(value).trim() === "") return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1000;
    return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : null;
  }

  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

function isRetryableRequestError(error) {
  if (isCancelled(error) || error?.phase === "deadline") return false;
  const status = Number(error?.response?.status);
  if (Number.isFinite(status)) return RETRYABLE_HTTP_STATUS.has(status);
  return RETRYABLE_NETWORK_CODES.has(String(error?.code || ""));
}

function getRetryDelayMs(error, attempt, baseDelayMs, maxDelayMs) {
  const [minJitter, maxJitter] = getNetwork().policy.retryJitterMs;
  const friendlyDelay = minJitter + (maxJitter > minJitter ? Math.round(Math.random() * (maxJitter - minJitter)) : 0);
  const status = Number(error?.response?.status);
  if (status === 429 || status === 503) {
    const retryAfterMs = getRetryAfterMs(error?.response?.headers);
    if (retryAfterMs !== null) return retryAfterMs + friendlyDelay;
  }

  const exponentialDelay = baseDelayMs * (2 ** attempt);
  const boundedDelay = Math.min(maxDelayMs, exponentialDelay);
  return Math.round(boundedDelay * (0.8 + Math.random() * 0.4)) + friendlyDelay;
}

const MIN_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 15000;

function getDiscordRetryDelayMs(response, attempt) {
  const fromBody = Number(response?.data?.retry_after);
  if (Number.isFinite(fromBody) && fromBody > 0) {
    // Discord usually gives retry_after in seconds (float).
    return clampDelay(fromBody * 1000);
  }

  const fromResetAfter = Number(response?.headers?.["x-ratelimit-reset-after"]);
  if (Number.isFinite(fromResetAfter) && fromResetAfter > 0) {
    return clampDelay(fromResetAfter * 1000);
  }

  const fromRetryAfter = Number(response?.headers?.["retry-after"]);
  if (Number.isFinite(fromRetryAfter) && fromRetryAfter > 0) {
    return clampDelay(fromRetryAfter < 100 ? fromRetryAfter * 1000 : fromRetryAfter);
  }

  return clampDelay(MIN_RETRY_DELAY_MS * Math.pow(2, attempt));
}

function clampDelay(ms) {
  return Math.max(MIN_RETRY_DELAY_MS, Math.min(MAX_RETRY_DELAY_MS, Math.ceil(ms)));
}


module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  getHeader,
  getRetryAfterMs,
  getRetryDelayMs,
  isRetryableRequestError,
  getDiscordRetryDelayMs,
};
