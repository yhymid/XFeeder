"use strict";

const { createHash } = require("node:crypto");

// Only recognized domain events are admitted. Arbitrary expert-debug payloads,
// stack traces, URLs and provider responses never enter the activity file.
const EVENTS = Object.freeze({
  "app.start": "worker.started",
  "app.shutdown": "worker.stopped",
  "queue.channel.selected": "channel.started",
  "queue.channel.complete": "channel.completed",
  "queue.channel.failed": "channel.failed",
  "channel.process.begin": "channel.started",
  "channel.process.complete": "channel.completed",
  "channel.feed.failed": "feed.processing.failed",
  "feed.begin": "feed.fetch.started",
  "feed.download.complete": "feed.fetch.completed",
  "feed.not_modified": "feed.not_modified",
  "feed.parsed": "feed.parse.completed",
  "delivery.complete": "delivery.sent",
  "delivery.failed": "delivery.failed",
  "scrapling.attempt.begin": "scrapling.used",
  "config.loaded": "config.reloaded",
});
const LEVELS = new Set(["info", "warn", "error"]);
const MAX_EVENTS = 2000;
const TYPES = new Set([...Object.values(EVENTS), "feed.failed"]);

function safeNumber(value, max = 86400000) {
  return Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), max) : null;
}
function channelId(value) {
  if (typeof value !== "string" || !value) return null;
  // Stable pseudonym for within-process activity correlation. Do not emit
  // channel names, source addresses or delivery credentials.
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function makeEvent(type, details = {}, id, now = Date.now()) {
  if (!TYPES.has(type)) return null;
  const level = LEVELS.has(details.level) ? details.level
    : /\.failed$/.test(type) ? "error" : type === "scrapling.used" ? "warn" : "info";
  const target = ["webhook", "telegram"].includes(details.target) ? details.target : null;
  const event = {
    id,
    time: new Date(now).toISOString(),
    level,
    type,
    channelId: channelId(details.channel),
    sourceId: channelId(details.url || details.source),
    destination: target,
    durationMs: safeNumber(details.durationMs ?? details.elapsedMs),
    httpStatus: Number.isInteger(details.status) && details.status >= 100 && details.status <= 599
      ? details.status : null,
    itemCount: safeNumber(details.itemCount, 1000000),
    errorCode: typeof details.error?.code === "string" && /^[A-Z0-9_-]{1,48}$/.test(details.error.code)
      ? details.error.code : null,
    dryRun: details.dryRun === true,
    // Fixed producer classification; no free-form names or labels.
    origin: details.__eventOrigin === "queue" ? "queue" : details.__eventOrigin === "channel" ? "channel" : null,
  };
  return Object.freeze(event);
}

function createEventBus({ capacity = MAX_EVENTS, now = Date.now } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000)
    throw new RangeError("Event capacity must be between 1 and 10000");
  const events = [];
  const listeners = new Set();
  let sequence = 0;
  function emit(type, details = {}) {
    // An event should never break delivery. No raw details are retained.
    // Provider errors and parser payloads may include throwing getters.
    // Event collection must never change the delivery control flow.
    let event;
    try {
      event = makeEvent(type, details, sequence + 1, now());
    } catch {
      return null;
    }
    if (!event) return null;
    sequence++;
    if (events.length >= capacity) events.shift();
    events.push(event);
    for (const listener of listeners) {
      try { listener(event); } catch { /* Observability cannot alter provider operations. */ }
    }
    return event;
  }
  return Object.freeze({
    emit,
    fromExpert(name, details) {
      const type = name === "feed.download.complete" && details?.ok === false
        ? "feed.failed" : EVENTS[name];
      if (!type) return null;
      const origin = name.startsWith("queue.channel.") ? "queue"
        : name.startsWith("channel.") ? "channel" : null;
      return emit(type, origin ? { ...details, __eventOrigin: origin } : details);
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Expected event listener");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot({ limit = capacity } = {}) {
      return events.slice(-Math.max(0, Math.min(capacity, Number(limit) || 0)))
        .map(event => ({ ...event }));
    },
    get size() { return events.length; },
  });
}

module.exports = { createEventBus, makeEvent, MAX_EVENTS, EVENTS };
