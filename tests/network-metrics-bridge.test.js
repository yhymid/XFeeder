"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const { createEventBus } = require("../src/core/event-bus");
const { createMetricsRegistry, networkMetricSnapshot } = require("../src/core/metrics-registry");
const { publicMetrics } = require("../src/dashboard/observability");
const { getNetwork, resetNetwork } = require("../src/network/service");
const { getWithFallback } = require("../src/client");
const { offline, serve, requestOptions } = require("./fixtures/network.cjs");

beforeEach(t => {
  offline(t);
  resetNetwork();
  t.after(() => resetNetwork());
});

test("NET-10: HTTP retries and compressed responses count transferred bytes, not decoded bytes", { timeout: 10000 }, async t => {
  const payload = Buffer.from("Repeated content ".repeat(5000));
  const zipped = gzipSync(payload);
  const fail = Buffer.from("unavailable");
  const server = await serve(t, (_req, res, requests) => {
    if (requests.length === 1) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end(fail);
    } else {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(zipped);
    }
  });
  const response = await getWithFallback(server.url, {
    ...requestOptions, retryBaseDelayMs: 0, maxAttempts: 2,
    responseType: "arraybuffer",
  });
  assert.deepEqual(response.data, payload);
  assert.equal(server.requests.length, 2);
  const network = getNetwork().metricsSnapshot();
  assert.equal(network.downloadedBytes, zipped.length + fail.length,
    "count each actual HTTP response once, before decompression");
  const eventBus = createEventBus();
  const registry = createMetricsRegistry(eventBus, {
    getNetworkMetrics: () => getNetwork().metricsSnapshot(),
  });
  const one = registry.snapshot();
  const two = registry.snapshot();
  assert.equal(one.network.downloadedBytes, zipped.length + fail.length);
  assert.equal(two.network.downloadedBytes, one.network.downloadedBytes,
    "reading the registry cannot count network bytes twice");
  assert.equal(one.network.scraplingBytes.status, "unavailable");
  assert.equal(one.network.scraplingBytes.downloadedBytes, null);
  registry.close();
});

test("NET-10: snapshots expose fixed finite values and never arbitrary data from runtime", () => {
  const raw = {
    downloadedBytes: 202, uploadedBytes: 50, unshapedUploadBytes: 5,
    downloadBytesPerSecond: 200.5, uploadBytesPerSecond: 55,
    rateWindowSeconds: 5, activeHttpRequests: 2, waitingHttpRequests: 1,
    activeScraplingTasks: 1, waitingScraplingTasks: 3,
    downloadLimitBytesPerSecond: 1000, uploadLimitBytesPerSecond: null,
    profile: "low", friendlyMode: true,
    accessToken: "synthetic-private-token", scraplingBytes: {
      status: "estimated", downloadedBytes: 999999,
    },
  };
  const result = networkMetricSnapshot(raw);
  assert.equal(result.available, true);
  assert.equal(result.downloadedBytes, 202);
  assert.equal(result.bandwidthProfile, "low");
  assert.equal(result.downloadLimitBytesPerSecond, 1000);
  assert.equal(result.uploadLimitBytesPerSecond, null);
  assert.equal(result.scraplingBytes.status, "unavailable");
  assert.equal(result.scraplingBytes.downloadedBytes, null);
  assert.ok(!JSON.stringify(result).includes("synthetic-private-token"));
  assert.equal(result.accessToken, undefined);
  assert.deepEqual(publicMetrics({ network: result }).network, result,
    "dashboard sanitizer must preserve only the documented network schema");
  const polluted = publicMetrics({ network: {
    ...raw, available: true, downloadedBytes: Infinity,
    profile: "injected-value",
  } }).network;
  assert.equal(polluted.downloadedBytes, 0);
  assert.equal(polluted.bandwidthProfile, "unlimited");
  assert.equal(polluted.accessToken, undefined);
  assert.equal(polluted.scraplingBytes.status, "unavailable");
  assert.deepEqual(publicMetrics({}).network, { available: false });
});

test("NET-10: network callback errors are nonfatal and snapshots never generate per-chunk events", () => {
  const bus = createEventBus();
  const registry = createMetricsRegistry(bus, { getNetworkMetrics() {
    throw new Error("synthetic read error");
  } });
  assert.deepEqual(registry.snapshot().network, { available: false });
  assert.equal(bus.size, 0);
  registry.close();
});
