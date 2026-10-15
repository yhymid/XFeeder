"use strict";

// External dashboard boundary: never trust additional fields in the
// worker-published snapshot. The UI/API only sees fixed allowlisted fields.
const { readActivityRuntime } = require("../core/activity-runtime");
const { COUNTER_NAMES, DURATION_NAMES, BUCKETS, networkMetricSnapshot } = require("../core/metrics-registry");

const TYPES = new Set([
  "worker.started", "worker.stopped", "channel.started",
  "channel.completed", "channel.failed", "feed.fetch.started",
  "feed.fetch.completed", "feed.not_modified", "feed.parse.completed",
  "feed.failed", "feed.processing.failed", "delivery.sent", "delivery.failed",
  "retry.scheduled", "scrapling.used", "config.reloaded",
]);
function number(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : fallback;
}
function publicMetrics(input = {}) {
  return {
    counters: {
      ...Object.fromEntries(COUNTER_NAMES.map(n => [n, number(input.counters?.[n])])),
      delivery_total: Object.fromEntries(["webhook", "telegram"].map(dest => [dest,
        Object.fromEntries(["success", "error"].map(s => [s, number(input.counters?.delivery_total?.[dest]?.[s])]))])),
    },
    network: input.network?.available === true
      ? networkMetricSnapshot(input.network) : { available: false },
    gauges: Object.fromEntries(["active_jobs", "failing_feeds", "queue_due_channels"]
      .map(n => [n, number(input.gauges?.[n])])),
    durations: Object.fromEntries(DURATION_NAMES.map(n => {
      const source = input.durations?.[n];
      return [n, {
        count: number(source?.count),
        sum: number(source?.sum),
        min: source?.min === null ? null : number(source?.min),
        max: source?.max === null ? null : number(source?.max),
        buckets: Object.fromEntries([...BUCKETS.map(String), "+Inf"]
          .map(bound => [bound, number(source?.buckets?.[bound])])),
      }];
    })),
  };
}
function publicEvent(raw) {
  if (!raw || !TYPES.has(raw.type) || !Number.isFinite(Date.parse(raw.time))) return null;
  const fail = /\.failed$/.test(raw.type) || raw.level === "error";
  const warn = raw.type === "scrapling.used";
  const sourceType = raw.type.startsWith("delivery.") ? "delivery"
    : raw.type.startsWith("feed.") || raw.type === "scrapling.used" ? "fetch" : "worker";
  const duration = Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? number(raw.durationMs) : null;
  const code = /^[A-Z0-9_-]{1,48}$/.test(raw.errorCode || "") ? raw.errorCode : null;
  const destination = ["webhook", "telegram"].includes(raw.destination) ? raw.destination : "";
  const itemCount = Number.isFinite(raw.itemCount) ? number(raw.itemCount) : null;
  return {
    id: Number.isSafeInteger(raw.id) ? raw.id : 0,
    time: new Date(raw.time).toISOString(),
    event: raw.type,
    type: sourceType,
    status: fail ? "error" : warn ? "warning" : "success",
    channel: /^[a-f0-9]{16}$/.test(raw.channelId || "") ? "channel:" + raw.channelId : "",
    source: "",
    target: destination,
    durationMs: duration,
    message: raw.type.replaceAll(".", " "),
    dryRun: raw.dryRun === true,
    details: {
      event: raw.type,
      httpStatus: Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599
        ? raw.httpStatus : null,
      itemCount, errorCode: code,
    },
  };
}
function readStructuredActivity(configPath, { limit = 100, now = Date.now() } = {}) {
  const data = readActivityRuntime(configPath);
  if (!data) return null;
  const items = data.events.map(publicEvent).filter(Boolean);
  const byChannel = {};
  let lastActivityAt = null;
  for (const item of items) {
    if (item.dryRun) continue;
    lastActivityAt = item.time;
    if (item.channel) {
      const state = byChannel[item.channel] ||= { status: "unknown", lastCheck: null, deliveries: 0 };
      if (item.status === "error") state.status = "error";
      else if (state.status === "unknown") state.status = "healthy";
      if (item.event.startsWith("channel.") && /\.(completed|failed)$/.test(item.event))
        state.lastCheck = item.time;
      if (item.event === "delivery.sent") state.deliveries++;
    }
  }
  const recent = items.filter(item => !item.dryRun && now - Date.parse(item.time) <= 86400000);
  return {
    available: true,
    items: items.slice(-Math.max(1, Math.min(2000, Number(limit) || 100))).reverse(),
    channels: byChannel,
    summary: {
      lastActivityAt,
      deliveries24h: recent.filter(item => item.event === "delivery.sent").length,
      errors24h: recent.filter(item => item.status === "error").length,
      health: recent.some(item => item.status === "error") ? "warning"
        : !lastActivityAt || now - Date.parse(lastActivityAt) > 180000 ? "unknown" : "healthy",
      observedSince: items[0]?.time || null,
      truncated: data.events.length >= 2000,
      partialWindow: !items.length || now - Date.parse(items[0].time) < 86400000 || data.events.length >= 2000,
    },
    source: "structured",
  };
}

module.exports = { publicMetrics, publicEvent, readStructuredActivity };
