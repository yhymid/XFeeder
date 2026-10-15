"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCacheStore } = require("../src/core/cache-store");
const { createStateStore, defaultFeedStatePath } = require("../src/core/state-store");
const { tempDir } = require("./helpers/temp-dir.cjs");

const url = "https://feeds.example.invalid/rss";
const entry = { title: "Pending article", guid: "fixture", link: "https://feeds.example.invalid/1" };

test("X3-21: migrated feed snapshots and delivery IDs live in separate JSON files", t => {
  const cachePath = path.join(tempDir(t), "cache.json");
  const original = createCacheStore(cachePath);
  original.getChannelBucket("channel-id")[`${url}::telegram`] = [entry.link];
  original.setFeedSnapshot(url, { etag: '"version-1"', lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" }, [entry]);
  original.save();

  const state = createStateStore({ cachePath });
  const feedPath = defaultFeedStatePath(cachePath);
  assert.equal(feedPath, path.join(path.dirname(cachePath), "cache.feeds.json"));
  assert.ok(fs.existsSync(feedPath));
  assert.deepEqual(state.feeds.getFeedItems(url), [entry]);
  assert.equal(state.feeds.getFeedValidator(url).etag, '"version-1"');
  const deliveryData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.deepEqual(deliveryData["channel-id"][`${url}::telegram`], [entry.link]);
  assert.equal(deliveryData.__xfeeder, undefined, "feed snapshots must not remain in delivery cache");
  const persisted = JSON.parse(fs.readFileSync(feedPath, "utf8"));
  assert.deepEqual(persisted.__xfeeder.feedSnapshots[url].items, [entry]);

  const reloaded = createStateStore({ cachePath });
  assert.deepEqual(reloaded.feeds.getFeedItems(url), [entry]);
  assert.deepEqual(reloaded.delivery.getState()["channel-id"], deliveryData["channel-id"]);
});

test("X3-21: existing delivery cache remains intact if feed migration cannot persist", t => {
  const cachePath = path.join(tempDir(t), "delivery.json");
  const original = createCacheStore(cachePath);
  original.getChannelBucket("channel-id").discord = ["already-sent-id"];
  original.setFeedSnapshot(url, { etag: '"persisted"' }, [entry]);
  original.save();
  const originalDisk = fs.readFileSync(cachePath, "utf8");
  const feedPath = defaultFeedStatePath(cachePath);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === feedPath) throw Object.assign(new Error("storage unavailable"), { code: "EACCES" });
    return rename(from, to);
  });
  assert.throws(() => createStateStore({ cachePath }), /storage unavailable/);
  assert.equal(fs.readFileSync(cachePath, "utf8"), originalDisk);
  mock.mock.restore();

  const retry = createStateStore({ cachePath });
  assert.deepEqual(retry.feeds.getFeedItems(url), [entry]);
  assert.deepEqual(retry.delivery.getState()["channel-id"].discord, ["already-sent-id"]);
});

test("X3-21: corrupted feed state blocks startup instead of resetting pending snapshots", t => {
  const cachePath = path.join(tempDir(t), "cache.json");
  const feedPath = defaultFeedStatePath(cachePath);
  fs.writeFileSync(feedPath, "{ invalid");
  assert.throws(() => createStateStore({ cachePath }), { code: "CACHE_UNSAFE" });
  assert.equal(fs.readFileSync(feedPath, "utf8"), "{ invalid");
  assert.ok(fs.readdirSync(path.dirname(feedPath)).some(name => name.startsWith("cache.feeds.json.corrupt-")));
});

test("X3-21: dry-run migration never writes either legacy delivery or separate feed files", t => {
  const cachePath = path.join(tempDir(t), "cache.json");
  const original = createCacheStore(cachePath);
  original.setFeedSnapshot(url, { etag: '"original"' }, [entry]);
  const before = fs.readFileSync(cachePath, "utf8");
  const feedsPath = defaultFeedStatePath(cachePath);
  const store = createStateStore({ cachePath, persistMigration: false });
  assert.deepEqual(store.feeds.getFeedItems(url), [entry]);
  assert.equal(store.feeds.getFeedValidator(url).etag, '"original"');
  store.feeds.setFeedSnapshot(url, { etag: '"dry-run"' }, [{ title: "new" }], { persist: false });
  assert.equal(store.feeds.getFeedValidator(url).etag, '"dry-run"');
  assert.equal(fs.existsSync(feedsPath), false);
  assert.equal(fs.readFileSync(cachePath, "utf8"), before);
});

test("X3-21: feed state is independent, has safe copy semantics and persists on save", t => {
  const cachePath = path.join(tempDir(t), "cache.json");
  const store = createStateStore({ cachePath });
  store.feeds.setFeedState(url, { etag: '"new"', items: [entry], consecutiveFailures: 2, lastHttpStatus: 503 }, { persist: false });
  const clone = store.feeds.getFeedState(url);
  clone.items[0].title = "mutated by caller";
  assert.deepEqual(store.feeds.getFeedItems(url), [entry]);
  assert.equal(fs.existsSync(defaultFeedStatePath(cachePath)), false);
  store.save();
  const reloaded = createStateStore({ cachePath });
  assert.deepEqual(reloaded.feeds.getFeedState(url), {
    etag: '"new"', items: [entry], consecutiveFailures: 2, lastHttpStatus: 503,
  });
  assert.equal(reloaded.delivery.getState().__xfeeder, undefined);
});

test("X3-21: ephemeral scheduler state and events do not contaminate either persisted store", t => {
  const cachePath = path.join(tempDir(t), "cache.json");
  const state = createStateStore({ cachePath });
  const payload = { nextRunAt: 123, counters: { success: 2 } };
  state.runtime.set("scheduler", payload);
  payload.counters.success = 99;
  const snapshot = state.runtime.snapshot();
  snapshot.scheduler.counters.success = 0;
  assert.deepEqual(state.runtime.get("scheduler"), { nextRunAt: 123, counters: { success: 2 } });
  for (let id = 0; id < 1200; id++) state.runtime.appendEvent({ id });
  const events = state.runtime.events();
  assert.equal(events.length, 1000);
  assert.deepEqual([events[0].id, events.at(-1).id], [200, 1199]);
  state.runtime.prune();
  assert.deepEqual(state.runtime.events(), []);
  state.save();
  assert.ok(!fs.readFileSync(cachePath, "utf8").includes("scheduler"));
  assert.ok(!fs.readFileSync(defaultFeedStatePath(cachePath), "utf8").includes("scheduler"));
  assert.equal(createStateStore({ cachePath }).runtime.get("scheduler"), undefined);
});

test("X3-21: bootstrap preserves its cacheStore API while using separate feed persistence", async t => {
  const dir = tempDir(t);
  const cachePath = path.join(dir, "cache.json");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ channels: {} }));
  const { createApp } = require("../src/app/bootstrap");
  const app = createApp({ cachePath, configPath, autostart: false });
  t.after(() => require("../src/network/service").resetNetwork());
  app.cacheStore.setFeedSnapshot(url, { etag: '"bootstrap"' }, [entry]);
  assert.equal(app.cacheStore.getFeedValidator(url).etag, '"bootstrap"');
  assert.deepEqual(app.cacheStore.getFeedItems(url), [entry]);
  assert.equal(app.cacheStore.getState().__xfeeder, undefined);
  assert.ok(fs.existsSync(defaultFeedStatePath(cachePath)));
  // Finish persisted writes while the fixture directory still exists.
  await app.shutdown({ exit: false });
});
