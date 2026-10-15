"use strict";

// Intentionally fixed metric dimensions: neither URLs nor channel IDs nor
// error messages are ever metric labels (cardinality/privacy protection).
const BUCKETS = Object.freeze([100, 500, 1000, 5000, 30000]);
const COUNTER_NAMES = Object.freeze([
  "feed_fetch_total", "feed_fetch_error_total", "feed_not_modified_total",
  "items_parsed_total", "scrapling_fallback_total",
]);
const GAUGE_NAMES = Object.freeze(["active_jobs", "failing_feeds", "queue_due_channels"]);
const DURATION_NAMES = Object.freeze([
  "feed_fetch_duration_ms", "channel_run_duration_ms", "delivery_duration_ms",
]);

function durationSeries() {
  return { count: 0, sum: 0, min: null, max: null,
    buckets: Object.fromEntries([...BUCKETS.map(String), "+Inf"].map(bound => [bound, 0])) };
}

function createMetricsRegistry(bus, { getGauges = () => ({}) } = {}) {
  const counters = Object.fromEntries(COUNTER_NAMES.map(name => [name, 0]));
  const delivery = {
    webhook: { success: 0, error: 0 },
    telegram: { success: 0, error: 0 },
  };
  const durations = Object.fromEntries(DURATION_NAMES.map(name => [name, durationSeries()]));
  const failingSources = new Set();
  const MAX_FAILING_SOURCES = 256;

  function observe(name, duration) {
    if (!Number.isFinite(duration) || duration < 0) return;
    const series = durations[name];
    if (!series) return;
    const ms = Math.min(duration, 86400000);
    series.count++;
    series.sum += ms;
    series.min = Math.min(series.min ?? ms, ms);
    series.max = Math.max(series.max ?? ms, ms);
    const bucket = BUCKETS.find(bound => ms <= bound);
    series.buckets[String(bucket ?? "+Inf")]++;
  }
  const unsubscribe = bus.subscribe(event => {
    switch (event.type) {
      case "feed.fetch.completed":
        counters.feed_fetch_total++;
        observe("feed_fetch_duration_ms", event.durationMs);
        if (event.sourceId) failingSources.delete(event.sourceId);
        break;
      case "feed.failed":
        counters.feed_fetch_total++;
        counters.feed_fetch_error_total++;
        if (event.sourceId) {
          if (failingSources.size >= MAX_FAILING_SOURCES)
            failingSources.delete(failingSources.values().next().value);
          failingSources.add(event.sourceId);
        }
        observe("feed_fetch_duration_ms", event.durationMs);
        break;
      case "feed_not_modified":
        counters.feed_not_modified_total++;
        if (event.sourceId) failingSources.delete(event.sourceId);
        break;
      case "feed.parse.completed":
        counters.items_parsed_total += event.itemCount ?? 0;
        if (event.sourceId) failingSources.delete(event.sourceId);
        break;
      case "delivery.sent":
      case "delivery.failed":
        if (event.destination) delivery[event.destination][
          event.type === "delivery.sent" ? "success" : "error"]++;
        observe("delivery_duration_ms", event.durationMs);
        break;
      case "channel.completed":
      case "channel.failed":
        observe("channel_run_duration_ms", event.durationMs);
        break;
      case "scrapling.used":
        counters.scrapling_fallback_total++;
        break;
      default:
        break;
    }
  });

  function snapshot() {
    let gauges = {};
    try { gauges = getGauges() || {}; } catch { /* Default to safe zero. */ }
    const resultGauges = Object.fromEntries(GAUGE_NAMES.map(name => {
      const input = name === "failing_feeds" ? failingSources.size : gauges[name];
      return [name, Number.isSafeInteger(input) && input >= 0 ? Math.min(input, 1000000) : 0];
    }));
    return {
      counters: { ...counters, delivery_total: {
        webhook: { ...delivery.webhook }, telegram: { ...delivery.telegram },
      } },
      gauges: resultGauges,
      durations: Object.fromEntries(
        Object.entries(durations).map(([name, series]) => [name, {
          ...series, buckets: { ...series.buckets },
        }]),
      ),
    };
  }
  return Object.freeze({ snapshot, close: unsubscribe });
}

module.exports = { createMetricsRegistry, BUCKETS, COUNTER_NAMES, DURATION_NAMES };
