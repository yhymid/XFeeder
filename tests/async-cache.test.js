"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCacheStore } = require("../src/core/cache-store");
const { createStateStore } = require("../src/core/state-store");
const { createFeedPipeline } = require("../src/core/feed-pipeline");
const { tempDir } = require("./helpers/temp-dir.cjs");

test("X3-22: ordered async snapshots never overwrite the newest delivery ID", async t => {
  const dir = tempDir(t), file = path.join(dir, "cache.json");
  const store = createCacheStore(file);
  const beforeRename = fs.promises.rename;
  const persisted = [];
  t.mock.method(fs.promises, "rename", async (from, to) => {
    await beforeRename(from, to);
    persisted.push(JSON.parse(fs.readFileSync(to, "utf8")));
  });
  store.getChannelBucket("one").sent = ["id-a"];
  const first = store.saveAsync();
  store.getChannelBucket("one").sent.push("id-b");
  const second = store.saveAsync();
  await Promise.all([first, second, store.flush()]);
  assert.deepEqual(persisted, [
    { one: { sent: ["id-a"] } },
    { one: { sent: ["id-a", "id-b"] } },
  ]);
  assert.deepEqual(createCacheStore(file).getState(), persisted[1]);
  assert.deepEqual(fs.readdirSync(dir), ["cache.json"], "no stale temp file");
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("X3-22: interrupted async rename retains delivered IDs and fails closed", async t => {
  const dir = tempDir(t), file = path.join(dir, "cache.json");
  const store = createCacheStore(file);
  store.getChannelBucket("one").sent = ["confirmed"];
  store.save();
  const original = fs.readFileSync(file, "utf8");
  store.getChannelBucket("one").sent.push("unpersisted");
  const mock = t.mock.method(fs.promises, "rename", async () => {
    throw Object.assign(new Error("synthetic disk failure"), { code: "EACCES" });
  });
  await assert.rejects(store.saveAsync(), { code: "CACHE_UNSAFE" });
  await assert.rejects(store.flush(), { code: "CACHE_UNSAFE" });
  await assert.rejects(store.saveAsync(), { code: "CACHE_UNSAFE" });
  assert.throws(() => store.getState(), { code: "CACHE_UNSAFE" });
  assert.equal(fs.readFileSync(file, "utf8"), original, "atomic failure cannot replace a valid cache");
  assert.deepEqual(fs.readdirSync(dir), ["cache.json"]);
  mock.mock.restore();
  assert.deepEqual(createCacheStore(file).getState().one.sent, ["confirmed"]);
});

test("X3-22: delivery waits for async persistence before starting the next destination", { timeout: 8000 }, async t => {
  const abort = require("../src/network/abort");
  const runnerPath = require.resolve("../src/app/channel-runner");
  const old = require.cache[runnerPath], sleep = abort.sleep;
  let createChannelRunner;
  try {
    abort.sleep = async () => {};
    delete require.cache[runnerPath];
    createChannelRunner = require(runnerPath).createChannelRunner;
  } finally {
    abort.sleep = sleep;
    delete require.cache[runnerPath];
    if (old) require.cache[runnerPath] = old;
  }

  const file = path.join(tempDir(t), "cache.json");
  const original = createCacheStore(file);
  let releaseSave, saveStarted;
  const begun = new Promise(resolve => { saveStarted = resolve; });
  const saving = new Promise(resolve => { releaseSave = resolve; });
  const order = [];
  const cacheStore = {
    ...original,
    async save() {
      order.push("persist-start");
      saveStarted();
      await saving;
      await original.saveAsync();
      order.push("persist-complete");
    },
  };
  const channel = {
    cacheKey: "fixture", name: "fixture", RequestSend: 1,
    RSS: ["https://example.invalid/feed"], Discord: null,
    Webhook: "https://example.invalid/hook",
    Telegram: { BotToken: "synthetic-token", ChatID: "chat" },
  };
  const item = { title: "Article", link: "https://example.invalid/item" };
  const runner = createChannelRunner({
    cacheStore, fetchFeed: async () => [item],
    sendMessage: async () => { order.push("webhook"); },
    sendTelegramMessage: async () => { order.push("telegram"); },
  });
  const running = runner.checkFeedsForChannel(0, channel);
  t.after(async () => { releaseSave(); await running; });
  await begun;
  assert.deepEqual(order, ["webhook", "persist-start"]);
  assert.equal(fs.existsSync(file), false, "provider success alone is not yet durable");
  releaseSave();
  await running;
  assert.deepEqual(order, [
    "webhook", "persist-start", "persist-complete",
    "telegram", "persist-start", "persist-complete",
  ]);
  assert.deepEqual(createCacheStore(file).getState().fixture["https://example.invalid/feed::telegram"], [item.link]);
});

test("X3-22: async feed snapshots are awaited before a parser can return entries", async t => {
  const cachePath = path.join(tempDir(t), "cache.json");
  const store = createStateStore({ cachePath });
  const url = "https://feeds.example.invalid/feed";
  const entry = { title: "Fixture", guid: "fixture" };
  const pipeline = createFeedPipeline({
    download: async () => ({ ok: true, status: 200, data: "valid", headers: { ETag: '"v1"' } }),
    getFeedValidator: store.feeds.getFeedValidator,
    getFeedItems: store.feeds.getFeedItems,
    setFeedSnapshot: store.feeds.setFeedSnapshotAsync,
    builtInParsers: [async () => [entry]],
  });
  assert.deepEqual(await pipeline.fetchFeed(url), [entry]);
  const reloaded = createStateStore({ cachePath });
  assert.deepEqual(reloaded.feeds.getFeedItems(url), [entry]);
  assert.equal(reloaded.feeds.getFeedValidator(url).etag, '"v1"');
});

test("X3-22: async feed persistence errors cannot be swallowed as parser fallthrough", async t => {
  const url = "https://feeds.example.invalid/feed";
  const error = Object.assign(new Error("synthetic IO failure"), { code: "CACHE_UNSAFE" });
  let nextParser = false;
  const pipeline = createFeedPipeline({
    download: async () => ({ ok: true, status: 200, data: "fixture" }),
    builtInParsers: [
      async () => [{ title: "first" }],
      async () => { nextParser = true; return [{ title: "fallback" }]; },
    ],
    setFeedSnapshot: async () => { throw error; },
  });
  await assert.rejects(pipeline.fetchFeed(url), failure => failure === error);
  assert.equal(nextParser, false);
});

test("X3-22: a failed delivery save halts the channel before another destination POST", { timeout: 8000 }, async t => {
  const { createChannelRunner } = require("../src/app/channel-runner");
  const file = path.join(tempDir(t), "cache.json");
  const store = createCacheStore(file);
  store.save();
  const before = fs.readFileSync(file, "utf8");
  const calls = [];
  const mock = t.mock.method(fs.promises, "rename", async () => {
    throw Object.assign(new Error("synthetic storage failure"), { code: "EIO" });
  });
  const channel = {
    cacheKey: "fixture", name: "fixture", RequestSend: 1,
    RSS: ["https://example.invalid/rss"], Discord: null,
    Webhook: "https://example.invalid/webhook",
    Telegram: { BotToken: "test-token", ChatID: "test-chat" },
  };
  const runner = createChannelRunner({
    cacheStore: { ...store, save: store.saveAsync },
    fetchFeed: async () => [{ title: "test", link: "https://example.invalid/entry" }],
    sendMessage: async () => { calls.push("webhook"); },
    sendTelegramMessage: async () => { calls.push("telegram"); },
  });
  await assert.rejects(runner.checkFeedsForChannel(0, channel), { code: "CACHE_UNSAFE" });
  assert.deepEqual(calls, ["webhook"], "Telegram must not start before webhook success is durable");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.throws(() => store.getState(), { code: "CACHE_UNSAFE" });
  mock.mock.restore();
});
