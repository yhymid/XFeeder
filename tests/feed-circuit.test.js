"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createStateStore } = require("../src/core/state-store");
const { createFeedCircuitBreaker, pollDelayMs } = require("../src/core/feed-circuit");
const { createFeedPipeline } = require("../src/core/feed-pipeline");
const { tempDir } = require("./helpers/temp-dir.cjs");

const url = "https://example.invalid/feed";
const entry = { title: "Fixture", link: "https://example.invalid/item", guid: "item" };

function fixture(t) {
  const cachePath = path.join(tempDir(t), "cache.json");
  let time = 1000000;
  const store = createStateStore({ cachePath });
  const makeBreaker = (stateStore = store) => createFeedCircuitBreaker({
    now: () => time,
    getFeedState: stateStore.feeds.getFeedState,
    setFeedStateAsync: stateStore.feeds.setFeedStateAsync,
  });
  return { store, cachePath, makeBreaker, get now() { return time; },
    advance(ms) { time += ms; } };
}

test("X3-23: three failures open a bounded per-feed cooldown, not a permanent disable", async t => {
  const f = fixture(t);
  const circuit = f.makeBreaker();
  assert.equal(circuit.status(url).status, "Healthy");
  for (let i = 1; i <= 3; i++) {
    const admission = circuit.beforeFetch(url);
    assert.equal(admission.allowed, true);
    await circuit.failed(url, { reason: "HTTP_503" });
    circuit.release(url, admission);
    assert.equal(circuit.status(url).consecutiveFailures, i);
    if (i < 3) assert.equal(circuit.status(url).status, "Degraded");
  }
  assert.equal(circuit.status(url).status, "Paused");
  assert.equal(circuit.beforeFetch(url).allowed, false);
  assert.equal(pollDelayMs(3), 300000);
  assert.equal(pollDelayMs(4), 600000);
  assert.equal(pollDelayMs(1000), 21600000);
  f.advance(300000);
  assert.equal(circuit.status(url).status, "Failing");
  const probe = circuit.beforeFetch(url);
  assert.equal(probe.allowed, true);
  assert.equal(probe.probe, true);
  assert.equal(circuit.beforeFetch(url).allowed, false, "only one recovery probe");
  await circuit.failed(url, { reason: "HTTP_503" });
  circuit.release(url, probe);
  assert.equal(circuit.status(url).nextRetryAt, f.now + 600000);
  f.advance(600000);
  const recovered = circuit.beforeFetch(url);
  await circuit.succeeded(url);
  circuit.release(url, recovered);
  assert.equal(circuit.status(url).status, "Healthy");
  assert.equal(circuit.status(url).consecutiveFailures, 0);
  assert.equal(circuit.status(url).nextRetryAt, 0);
});

test("X3-23: cooldown, failure streak and 304 validators survive process restart", async t => {
  const f = fixture(t);
  const feed = f.store.feeds;
  await feed.setFeedSnapshotAsync(url, { etag: '"v1"' }, [entry]);
  const circuit = f.makeBreaker();
  for (let i = 0; i < 3; i++) await circuit.failed(url, { reason: "HTTP_503" });
  assert.equal(feed.getFeedValidator(url).etag, '"v1"');
  const prior = feed.getFeedState(url);
  assert.deepEqual(prior.items, [entry]);
  const reloaded = createStateStore({ cachePath: f.cachePath });
  const circuit2 = f.makeBreaker(reloaded);
  assert.equal(circuit2.beforeFetch(url).allowed, false);
  assert.equal(circuit2.status(url).consecutiveFailures, 3);
  await reloaded.feeds.setFeedSnapshotAsync(url, { etag: '"v2"' }, [entry]);
  assert.equal(reloaded.feeds.getFeedState(url).health.consecutiveFailures, 3);
  assert.equal(reloaded.feeds.getFeedValidator(url).etag, '"v2"');
  assert.equal(reloaded.delivery.getState().__xfeeder, undefined);
});

test("X3-23: manual Retry-now bypasses cooldown without deleting previous failure history", async t => {
  const f = fixture(t), circuit = f.makeBreaker();
  for (let i = 0; i < 3; i++) await circuit.failed(url, { reason: "REQUEST_FAILED" });
  assert.equal(circuit.beforeFetch(url).allowed, false);
  await circuit.retryNow(url);
  assert.equal(circuit.status(url).consecutiveFailures, 3);
  const attempt = circuit.beforeFetch(url);
  assert.equal(attempt.allowed, true);
  await circuit.succeeded(url);
  circuit.release(url, attempt);
  assert.equal(circuit.status(url).status, "Healthy");
  const reloaded = createStateStore({ cachePath: f.cachePath });
  assert.equal(f.makeBreaker(reloaded).status(url).status, "Healthy");
});

test("X3-23: browser anti-bot failures cool Scrapling down while permitting ordinary HTTP", async t => {
  const f = fixture(t), circuit = f.makeBreaker();
  const options = [];
  let calls = 0;
  const pipeline = createFeedPipeline({
    circuit,
    download: async (_url, config) => {
      options.push(config);
      calls++;
      if (calls < 3) return { ok: false, reason: "SCRAPLING_FORCED_FAILED" };
      return { ok: true, status: 200, data: "valid feed" };
    },
    builtInParsers: [async () => [entry]],
  });
  assert.deepEqual(await pipeline.fetchFeed(url), []);
  assert.deepEqual(await pipeline.fetchFeed(url), []);
  assert.equal(circuit.status(url).scraplingAllowed, false);
  assert.equal(circuit.status(url).status, "Degraded");
  assert.deepEqual(await pipeline.fetchFeed(url), [entry]);
  assert.equal(options[2].allowScrapling, false,
    "browser cooldown must not suppress a normal HTTP source request");
  assert.equal(circuit.status(url).scraplingAllowed, true,
    "successful HTTP recovery resets failed browser streak");
  assert.equal(circuit.status(url).consecutiveFailures, 0);
});

test("X3-23: suppressed feed never touches downloader or replays cached items", async t => {
  const f = fixture(t), circuit = f.makeBreaker();
  await f.store.feeds.setFeedSnapshotAsync(url, { etag: '"cached"' }, [entry]);
  for (let i = 0; i < 3; i++) await circuit.failed(url, { reason: "HTTP_429" });
  let downloads = 0;
  const pipeline = createFeedPipeline({
    circuit,
    download: async () => { downloads++; return { ok: true, data: "unexpected" }; },
    getFeedItems: f.store.feeds.getFeedItems,
    builtInParsers: [async () => [entry]],
  });
  assert.deepEqual(await pipeline.fetchFeed(url), []);
  assert.equal(downloads, 0);
  assert.deepEqual(f.store.feeds.getFeedItems(url), [entry]);
});

test("X3-23: HTTP 304 means success, even with an empty cached snapshot", async t => {
  const f = fixture(t), circuit = f.makeBreaker();
  await circuit.failed(url, { reason: "HTTP_503" });
  const pipeline = createFeedPipeline({
    circuit,
    download: async () => ({ ok: true, status: 304, notModified: true }),
    getFeedItems: () => [],
  });
  assert.deepEqual(await pipeline.fetchFeed(url), []);
  assert.equal(circuit.status(url).status, "Healthy");
  assert.equal(circuit.status(url).consecutiveFailures, 0);
});

test("X3-23: cancellation and unsafe persistence do not create another failure streak", async t => {
  const f = fixture(t), circuit = f.makeBreaker();
  const controller = new AbortController();
  controller.abort();
  const pipeline = createFeedPipeline({
    circuit, download: async () => assert.fail("aborted request must not fetch"),
  });
  await assert.rejects(pipeline.fetchFeed(url, { signal: controller.signal }));
  assert.equal(circuit.status(url).consecutiveFailures, 0);
  const error = Object.assign(new Error("disk failure"), { code: "CACHE_UNSAFE" });
  const broken = createFeedPipeline({
    circuit, download: async () => { throw error; },
  });
  await assert.rejects(broken.fetchFeed(url), candidate => candidate === error);
  assert.equal(circuit.status(url).consecutiveFailures, 0);
});
