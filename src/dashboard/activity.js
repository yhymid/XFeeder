"use strict";

const fs = require("node:fs/promises");
const { sanitize, sanitizeText, sanitizeUrl } = require("../core/diagnostics");
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 1000;
const DAY = 86400000;
const VISIBLE =
  /^(delivery\.(complete|failed|simulated)|feed\.(download\.complete|parsed|skipped|empty|parser\.failed)|http\.request\.failed|scrapling\.attempt\.(begin|complete|failed)|queue\.(not_started|wait|channel\.(complete|failed))|channel\.(complete|failed|process\.complete|feed\.delivery_summary)|discord\.source\.(complete|failed|skipped))$/;

// Activity exposes a small allowlist, never arbitrary log payloads or error bodies.
function publicUrl(value) {
  try {
    const url = new URL(sanitizeUrl(value));
    if (!/^https?:$/.test(url.protocol)) return "";
    url.search = "";
    url.hash = "";
    if (/\/webhooks\//i.test(url.pathname))
      url.pathname = "/webhooks/[REDACTED]";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeEvent(raw, context = {}) {
  if (!VISIBLE.test(raw.event || "")) return null;
  const event = raw.event;
  const failed =
    /failed|empty/.test(event) || raw.ok === false || Number(raw.status) >= 400;
  const warning =
    /skipped|scrapling|not_started|queue\.wait/.test(event) ||
    Number(raw.partial) > 0;
  const type = /delivery/.test(event)
    ? "delivery"
    : /parsed|parser/.test(event)
      ? "parse"
      : /feed|http|scrapling/.test(event)
        ? "fetch"
        : "worker";
  const status = failed ? "error" : warning ? "warning" : "success";
  const messages = {
    "delivery.complete": "Entry delivered",
    "delivery.failed": "Delivery failed",
    "delivery.simulated": "Delivery simulated (dry run)",
    "feed.download.complete": failed
      ? "Feed download failed"
      : raw.notModified
        ? "Feed unchanged"
        : "Feed downloaded",
    "feed.parsed": `${Number(raw.itemCount) || 0} entries parsed`,
    "feed.skipped": "Feed skipped",
    "feed.empty": "No feed entries found",
    "feed.parser.failed": "Parser attempt failed",
    "http.request.failed": "Request failed",
    "scrapling.attempt.begin": "Anti-bot fallback started",
    "scrapling.attempt.complete": failed
      ? "Anti-bot fallback failed"
      : "Anti-bot fallback completed",
    "scrapling.attempt.failed": "Anti-bot fallback failed",
    "channel.feed.delivery_summary": `${Number(raw.completed) || 0} of ${Number(raw.selected) || 0} entries ${raw.dryRun ? "simulated" : "delivered"}`,
    "queue.channel.failed": "Channel check failed",
    "queue.channel.complete": "Channel check completed",
    "queue.not_started": "Worker has no channels to check",
    "queue.wait": "Worker is waiting for configured channels",
    "channel.process.complete": "Channel processing completed",
    "channel.complete": "Channel check completed",
    "channel.failed": "Channel check failed",
    "discord.source.complete": "Discord source checked",
    "discord.source.failed": "Discord source failed",
    "discord.source.skipped": "Discord source skipped",
  };
  const duration = Number(raw.durationMs ?? raw.elapsedMs);
  const item = {
    time: new Date(raw.time).toISOString(),
    event,
    type,
    status,
    channel: sanitizeText(
      String(raw.channel || raw.label || context.channel || ""),
    ).slice(0, 200),
    source: publicUrl(raw.url || raw.source || context.source || ""),
    target: ["webhook", "telegram"].includes(raw.target) ? raw.target : "",
    durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
    message: messages[event] || "Worker activity",
    dryRun:
      raw.dryRun === true ||
      context.dryRun === true ||
      event === "delivery.simulated",
  };
  item.details = sanitize({
    event,
    httpStatus: typeof raw.status === "number" ? raw.status : null,
    parser:
      typeof raw.parser === "string"
        ? sanitizeText(raw.parser).slice(0, 80)
        : null,
    itemCount: Number.isFinite(raw.itemCount) ? raw.itemCount : null,
    completed: Number.isFinite(raw.completed) ? raw.completed : null,
    selected: Number.isFinite(raw.selected) ? raw.selected : null,
    partial: Number.isFinite(raw.partial) ? raw.partial : null,
    fallback: raw.scrapling === true || event.startsWith("scrapling."),
  });
  return item;
}

function parseActivity(
  text,
  { limit = 100, now = Date.now(), truncated = false } = {},
) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (/\[dashboard\]/.test(line)) continue;
    const marker = line.indexOf("[Expert] ");
    if (marker < 0) continue;
    try {
      const raw = JSON.parse(line.slice(marker + 9));
      const time = Date.parse(raw.time);
      if (
        !raw ||
        typeof raw.event !== "string" ||
        !Number.isFinite(time) ||
        time > now + 60000
      )
        continue;
      records.push(raw);
    } catch {
      /* A partial, malformed, or interrupted log line is not an event. */
    }
  }
  const bounded = records.slice(-MAX_EVENTS);
  const items = [],
    channelStates = Object.create(null),
    deliveries = new Map();
  let context = {},
    lastActivityAt = null;
  for (const raw of bounded) {
    if (raw.event === "queue.cycle.begin") context = {};
    if (raw.dryRun === true || raw.event === "delivery.simulated") {
      context = { channel: raw.channel || context.channel, dryRun: true };
    }
    if (raw.event === "channel.process.begin") {
      context = {
        channel: sanitizeText(String(raw.channel || "")).slice(0, 200),
        dryRun: raw.dryRun === true,
      };
      if (!context.dryRun)
        channelStates[context.channel] = {
          status: "unknown",
          lastCheck: null,
          deliveries: 0,
        };
    }
    if (raw.event === "delivery.begin")
      deliveries.set(`${raw.channel}:${raw.target}`, {
        source: raw.source,
        dryRun: raw.dryRun === true,
      });
    const item = normalizeEvent(raw, {
      ...context,
      ...(deliveries.get(`${raw.channel}:${raw.target}`) || {}),
    });
    if (
      !context.dryRun &&
      raw.dryRun !== true &&
      (/^queue\./.test(raw.event) ||
        (context.channel &&
          context.dryRun === false &&
          /^channel\.process\./.test(raw.event)))
    )
      lastActivityAt = raw.time;
    if (item) {
      items.push(item);
      if (item.channel && !item.dryRun) {
        const state = (channelStates[item.channel] ||= {
          status: "unknown",
          lastCheck: null,
          deliveries: 0,
        });
        if (item.status === "error") state.status = "error";
        else if (item.status === "warning" && state.status !== "error")
          state.status = "warning";
        else if (state.status === "unknown") state.status = "healthy";
        if (/channel\.(complete|failed|process\.complete)$/.test(raw.event))
          state.lastCheck = item.time;
        if (raw.event === "delivery.complete") state.deliveries++;
      }
    }
    if (
      /^(queue\.channel\.(complete|failed)|channel\.(complete|failed))$/.test(
        raw.event,
      )
    )
      context = {};
  }
  const recent = items.filter(
    (e) => !e.dryRun && now - Date.parse(e.time) <= DAY,
  );
  const stale = !lastActivityAt || now - Date.parse(lastActivityAt) > 180000;
  const attention =
    recent.some(
      (e) =>
        !e.channel &&
        (e.status === "error" ||
          (e.type === "worker" && e.status === "warning")),
    ) ||
    Object.values(channelStates).some(
      (s) =>
        ["error", "warning"].includes(s.status) &&
        s.lastCheck &&
        now - Date.parse(s.lastCheck) < DAY,
    );
  return {
    items: items
      .reverse()
      .slice(0, Math.min(MAX_EVENTS, Math.max(1, Number(limit) || 100))),
    channels: channelStates,
    summary: {
      lastActivityAt,
      deliveries24h: bounded.length
        ? recent.filter((e) => e.event === "delivery.complete").length
        : null,
      errors24h: bounded.length
        ? recent.filter((e) => e.status === "error").length
        : null,
      health: attention ? "warning" : stale ? "unknown" : "healthy",
      observedSince: bounded[0]?.time || null,
      truncated: truncated || records.length > MAX_EVENTS,
      // These counts are observations in a bounded log tail, not guaranteed full-day totals.
      partialWindow:
        !bounded.length ||
        truncated ||
        records.length > MAX_EVENTS ||
        now - Date.parse(bounded[0].time) < DAY,
    },
  };
}

async function readActivity(filePath, options = {}) {
  let file;
  try {
    file = await fs.open(filePath, "r");
    const { size } = await file.stat();
    const bytes = Math.min(size, MAX_BYTES),
      buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, size - bytes);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (size > bytes)
      text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
    return {
      ...parseActivity(text, { ...options, truncated: size > bytes }),
      available: true,
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { ...parseActivity("", options), available: false };
  } finally {
    await file?.close();
  }
}

module.exports = {
  readActivity,
  parseActivity,
  normalizeEvent,
  publicUrl,
  MAX_BYTES,
  MAX_EVENTS,
};
