"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createEventBus } = require("../src/core/event-bus");
const { createMetricsRegistry } = require("../src/core/metrics-registry");
const { startActivityRuntime, activityPath } = require("../src/core/activity-runtime");
const { expert, subscribeActivity, setExpertDebug } = require("../src/core/diagnostics");
const { startTestDashboard } = require("./helpers/dashboard.cjs");
const { tempDir } = require("./helpers/temp-dir.cjs");
const sessionCookie = headers => (Array.isArray(headers["set-cookie"])
  ? headers["set-cookie"][0] : headers["set-cookie"]).split(";")[0];

test("X3-24: records bounded allowlisted event fields without secrets or URLs", () => {
  const bus = createEventBus({ capacity: 3, now: () => Date.parse("2026-10-15T12:00:00Z") });
  const secret = "synthetic-provider-secret";
  for (let i = 0; i < 5; i++) bus.fromExpert("delivery.complete", {
    channel: "channel " + secret,
    target: "webhook",
    url: "https://user:password@feed.invalid/item?token=" + secret,
    headers: { Authorization: "Bearer " + secret },
    error: new Error("Bearer " + secret),
    durationMs: 55,
    status: 204,
    itemCount: 3,
    dryRun: false,
  });
  const entries = bus.snapshot();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(x => x.id), [3, 4, 5]);
  assert.ok(entries.every(x => x.channelId && /^[a-f0-9]{16}$/.test(x.channelId)));
  assert.ok(!JSON.stringify(entries).includes(secret));
  assert.ok(!JSON.stringify(entries).includes("password"));
  assert.ok(!JSON.stringify(entries).includes("Authorization"));
  assert.equal(entries[0].destination, "webhook");
  assert.equal(entries[0].durationMs, 55);
  assert.equal(bus.fromExpert("unknown.debug.payload", { token: secret }), null);
  assert.equal(bus.size, 3);
});

test("X3-24: event observer failures cannot affect delivery and Expert Debug remains off", t => {
  setExpertDebug(false);
  t.after(() => setExpertDebug(false));
  const bus = createEventBus();
  let consoleLines = 0;
  t.mock.method(console, "log", () => consoleLines++);
  const unsubscribe = subscribeActivity((event, details) => bus.fromExpert(event, details));
  t.after(unsubscribe);
  bus.subscribe(() => { throw Error("listener failed"); });
  expert("feed.download.complete", { ok: true, url: "https://feed.invalid/rss", elapsedMs: 123 });
  assert.equal(bus.snapshot()[0].type, "feed.fetch.completed");
  assert.equal(consoleLines, 0, "normal event recording should not turn on Expert Debug");
});

test("X3-25: metrics have fixed dimensions and accurate counters/histograms", () => {
  const bus = createEventBus();
  const registry = createMetricsRegistry(bus, {
    getGauges: () => ({ active_jobs: 2, queue_due_channels: 1 }),
  });
  bus.fromExpert("feed.download.complete", { ok: true, url: "https://feed.invalid/1", elapsedMs: 150 });
  bus.fromExpert("feed.parsed", { url: "https://feed.invalid/1", itemCount: 7 });
  bus.fromExpert("feed.not_modified", { url: "https://feed.invalid/1" });
  bus.fromExpert("feed.download.complete", { ok: false, url: "https://feed.invalid/2", status: 503, elapsedMs: 800 });
  bus.fromExpert("delivery.complete", { channel: "secret", target: "webhook", durationMs: 120 });
  bus.fromExpert("delivery.failed", { channel: "secret", target: "telegram", durationMs: 55 });
  bus.fromExpert("scrapling.attempt.begin", {});
  bus.fromExpert("channel.process.complete", { durationMs: 350 });
  const metrics = registry.snapshot();
  assert.equal(metrics.counters.feed_fetch_total, 2);
  assert.equal(metrics.counters.feed_fetch_error_total, 1);
  assert.equal(metrics.counters.feed_not_modified_total, 1);
  assert.equal(metrics.counters.items_parsed_total, 7);
  assert.equal(metrics.counters.delivery_total.webhook.success, 1);
  assert.equal(metrics.counters.delivery_total.telegram.error, 1);
  assert.equal(metrics.counters.scrapling_fallback_total, 1);
  assert.equal(metrics.gauges.active_jobs, 2);
  assert.equal(metrics.gauges.queue_due_channels, 1);
  assert.equal(metrics.gauges.failing_feeds, 1);
  assert.equal(metrics.durations.feed_fetch_duration_ms.count, 2);
  assert.equal(metrics.durations.feed_fetch_duration_ms.buckets["500"], 1);
  assert.equal(metrics.durations.feed_fetch_duration_ms.buckets["1000"], 1);
  assert.equal(metrics.durations.channel_run_duration_ms.count, 1);
  assert.equal(JSON.stringify(metrics).includes("secret"), false);
  registry.close();
});

test("X3-24/X3-25: authenticated dashboard reads first-class activity and metrics, not terminal log", async t => {
  const fixture = await startTestDashboard(t);
  const configPath = path.join(fixture.dir, "config.json");
  const bus = createEventBus();
  const metrics = createMetricsRegistry(bus, { getGauges: () => ({ active_jobs: 1 }) });
  const secret = "synthetic-feed-secret";
  bus.fromExpert("feed.download.complete", {
    url: "https://user:password@feed.invalid/feed?token=" + secret,
    ok: false, status: 503, elapsedMs: 87,
  });
  bus.fromExpert("delivery.complete", { channel: "channel-secret", target: "telegram", durationMs: 43 });
  const stop = startActivityRuntime({ configPath, events: bus, metrics, intervalMs: 60000 });
  t.after(async () => { await stop(); metrics.close(); });
  await stop();
  assert.ok(fs.existsSync(activityPath(configPath)));
  if (process.platform !== "win32")
    assert.equal(fs.statSync(activityPath(configPath)).mode & 0o777, 0o600);

  fs.mkdirSync(path.join(fixture.dir, "debug"), { recursive: true });
  fs.writeFileSync(path.join(fixture.dir, "debug/terminal.txt"),
    '[Expert] {"time":"2026-10-15T12:00:00Z","event":"delivery.failed","channel":"legacy"}\n');
  assert.equal((await fixture.request("/api/metrics")).status, 401);
  assert.equal((await fixture.request("/api/activity")).status, 401);
  const login = await fixture.login();
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login.headers);
  const headers = { Cookie: cookie };
  const activity = await fixture.request("/api/activity", { headers });
  assert.equal(activity.status, 200);
  assert.equal(activity.data.source, "structured");
  assert.equal(activity.data.items.length, 2);
  assert.equal(activity.data.items[0].event, "delivery.sent");
  assert.equal(activity.data.items[1].event, "feed.failed");
  assert.ok(!activity.text.includes(secret));
  assert.ok(!activity.text.includes("channel-secret"));
  assert.ok(!activity.text.includes("legacy"));
  const report = await fixture.request("/api/metrics", { headers });
  assert.equal(report.status, 200);
  assert.equal(report.data.metrics.counters.delivery_total.telegram.success, 1);
  assert.equal(report.data.metrics.gauges.active_jobs, 1);
  assert.ok(!report.text.includes(secret));
  assert.ok(!report.text.includes("channel-secret"));
});

test("X3-25: metric payload cannot disclose extra fields from a tampered runtime file", async t => {
  const fixture = await startTestDashboard(t);
  const file = activityPath(path.join(fixture.dir, "config.json"));
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, updatedAt: new Date().toISOString(),
    events: [{ type: "worker.started", time: new Date().toISOString(), id: 1, message: "secret-string" }],
    metrics: {
      token: "secret-string",
      counters: { feed_fetch_total: 2, evil: "secret-string" },
      gauges: { active_jobs: 1, my_token: "secret-string" },
    },
  }));
  const login = await fixture.login();
  const headers = { Cookie: sessionCookie(login.headers) };
  const metrics = await fixture.request("/api/metrics", { headers });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.data.metrics.counters.feed_fetch_total, 2);
  assert.equal(metrics.text.includes("secret-string"), false);
  const activity = await fixture.request("/api/activity", { headers });
  assert.equal(activity.status, 200);
  assert.equal(activity.text.includes("secret-string"), false);
});

test("X3-25: queue and runner completion represent one channel duration", () => {
  const bus = createEventBus();
  const metrics = createMetricsRegistry(bus);
  const runner = bus.fromExpert("channel.process.complete", { channel: "fixture", durationMs: 800 });
  const scheduler = bus.fromExpert("queue.channel.complete", { channel: "fixture", durationMs: 820 });
  assert.equal(runner.origin, "channel");
  assert.equal(scheduler.origin, "queue");
  assert.equal(metrics.snapshot().durations.channel_run_duration_ms.count, 1);
  assert.equal(metrics.snapshot().durations.channel_run_duration_ms.sum, 800);
  metrics.close();
});
