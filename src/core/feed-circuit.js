"use strict";

// X3-23: A feed-specific, persisted cooldown. No permanent disable,
// global circuit, or automatic retry of an ambiguous outbound POST.
const { expert } = require("./diagnostics");

const FAILURE_THRESHOLD = 3;
const BROWSER_FAILURE_THRESHOLD = 2;
const BASE_POLL_DELAY_MS = 5 * 60 * 1000;
const MAX_POLL_DELAY_MS = 6 * 60 * 60 * 1000;
const BROWSER_COOLDOWN_MS = 30 * 60 * 1000;

function boundedNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function classify(health, at) {
  if (health.nextRetryAt > at) return "Paused";
  if (health.consecutiveFailures >= FAILURE_THRESHOLD) return "Failing";
  if (health.consecutiveFailures) return "Degraded";
  return "Healthy";
}
function normalizeHealth(raw) {
  const h = raw && typeof raw === "object" ? raw : {};
  return {
    consecutiveFailures: Math.min(1000, boundedNumber(h.consecutiveFailures)),
    browserFailures: Math.min(1000, boundedNumber(h.browserFailures)),
    nextRetryAt: boundedNumber(h.nextRetryAt),
    scraplingCooldownUntil: boundedNumber(h.scraplingCooldownUntil),
    lastFailureAt: boundedNumber(h.lastFailureAt),
    lastSuccessAt: boundedNumber(h.lastSuccessAt),
  };
}
function pollDelayMs(streak) {
  if (streak < FAILURE_THRESHOLD) return 0;
  return Math.min(MAX_POLL_DELAY_MS,
    BASE_POLL_DELAY_MS * 2 ** Math.min(16, streak - FAILURE_THRESHOLD));
}
function isBrowserFailure(reason, { scrapling = false } = {}) {
  return scrapling || /(?:SCRAPLING|ANTIBOT|CHALLENGE|BLOCKED_PAGE)/i.test(String(reason || ""));
}

function createFeedCircuitBreaker({ getFeedState, setFeedStateAsync,
  now = Date.now,
} = {}) {
  if (typeof getFeedState !== "function" ||
      typeof setFeedStateAsync !== "function")
    throw new TypeError("Feed circuit requires a persistent feed-state interface");
  const probes = new Set();
  function state(url) {
    const record = getFeedState(url) || {};
    return { record, health: normalizeHealth(record.health) };
  }
  function status(url) {
    const { health } = state(url);
    const at = now();
    return {
      ...health,
      status: classify(health, at),
      scraplingAllowed: health.scraplingCooldownUntil <= at,
      probeInFlight: probes.has(url),
    };
  }
  function beforeFetch(url) {
    const info = status(url), at = now();
    if (info.nextRetryAt > at || probes.has(url)) {
      expert("feed.circuit.suppressed", {
        url, status: "Paused", retryAt: info.nextRetryAt || null,
      });
      return { allowed: false, status: "Paused", retryAt: info.nextRetryAt };
    }
    const probe = info.consecutiveFailures >= FAILURE_THRESHOLD;
    if (probe) probes.add(url);
    return { allowed: true, probe, allowScrapling: info.scraplingAllowed };
  }
  function release(url, admission) {
    if (admission?.probe) probes.delete(url);
  }
  async function store(url, record, health) {
    await setFeedStateAsync(url, { ...record, health });
  }
  async function succeeded(url) {
    const { record, health } = state(url);
    if (!health.consecutiveFailures && !health.browserFailures &&
        !health.nextRetryAt && !health.scraplingCooldownUntil) return;
    const updated = { ...health,
      consecutiveFailures: 0, browserFailures: 0, nextRetryAt: 0,
      scraplingCooldownUntil: 0, lastSuccessAt: now(),
    };
    await store(url, record, updated);
    expert("feed.circuit.recovered", { url, status: "Healthy" });
  }
  async function failed(url, { reason, scrapling = false } = {}) {
    const { record, health } = state(url), at = now();
    const consecutiveFailures = Math.min(1000, health.consecutiveFailures + 1);
    const browserFailures = isBrowserFailure(reason, { scrapling })
      ? Math.min(1000, health.browserFailures + 1) : health.browserFailures;
    const delay = pollDelayMs(consecutiveFailures);
    const cooldownUntil = browserFailures >= BROWSER_FAILURE_THRESHOLD
      ? at + BROWSER_COOLDOWN_MS : 0;
    const updated = { ...health, consecutiveFailures, browserFailures,
      nextRetryAt: delay ? at + delay : 0,
      scraplingCooldownUntil: Math.max(health.scraplingCooldownUntil, cooldownUntil),
      lastFailureAt: at,
    };
    await store(url, record, updated);
    if (delay) expert("retry.scheduled", { url, delayMs: delay, retryAt: updated.nextRetryAt });
    expert("feed.circuit.failed", {
      url, status: classify(updated, at), streak: consecutiveFailures,
      scraplingCooldownUntil: updated.scraplingCooldownUntil,
    });
    return status(url);
  }
  async function retryNow(url) {
    const { record, health } = state(url);
    const updated = { ...health, nextRetryAt: 0, scraplingCooldownUntil: 0 };
    await store(url, record, updated);
    expert("feed.circuit.retry_now", { url });
    return status(url);
  }
  return Object.freeze({ beforeFetch, release, status, succeeded, failed, retryNow });
}

module.exports = {
  createFeedCircuitBreaker, pollDelayMs, normalizeHealth,
  FAILURE_THRESHOLD, BROWSER_FAILURE_THRESHOLD, MAX_POLL_DELAY_MS,
};