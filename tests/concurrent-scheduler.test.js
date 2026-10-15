"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startChannelQueue } = require("../src/app/runtime");
const { loadConfig } = require("../src/config-loader");
const { tempDir } = require("./helpers/temp-dir.cjs");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settled = () => new Promise(resolve => setImmediate(resolve));

async function clock(t, channels, run, options = {}) {
  let now = 1000000;
  const timers = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(global, "setTimeout", (callback, delay) => {
    const token = { callback, delay };
    timers.push(token);
    return token;
  });
  t.mock.method(global, "clearTimeout", token => {
    const index = timers.indexOf(token);
    if (index >= 0) timers.splice(index, 1);
  });
  const queue = startChannelQueue({
    getChannels: () => channels,
    checkFeedsForChannel: run,
    delayBetweenChannels: 10,
    maxConcurrentChannels: 2,
    ...options,
  });
  t.after(() => queue?.stop());
  await settled();
  return {
    queue,
    current: () => now,
    async tick(ms = 10) {
      assert.equal(timers.length, 1, "only one scheduler polling timer is allowed");
      const timer = timers.shift();
      assert.equal(timer.delay, 10);
      now += ms;
      timer.callback();
      await settled();
    },
    timers,
  };
}

test("X3-20: two distinct channels overlap while a third waits for capacity", async t => {
  const channels = ["alpha", "bravo", "charlie"].map(cacheKey => ({ cacheKey, TimeChecker: 1 }));
  const a = deferred(), b = deferred(), c = deferred();
  const gates = { alpha: a, bravo: b, charlie: c };
  const active = new Set(), launched = [];
  const q = await clock(t, channels, async (_index, channel) => {
    active.add(channel.cacheKey);
    launched.push(channel.cacheKey);
    await gates[channel.cacheKey].promise;
    active.delete(channel.cacheKey);
  });
  t.after(() => { a.resolve(); b.resolve(); c.resolve(); });
  assert.deepEqual(launched, ["alpha"]);
  await q.tick();
  assert.deepEqual(launched, ["alpha", "bravo"]);
  assert.equal(active.size, 2);
  assert.deepEqual(q.queue.getState().activeKeys, ["alpha", "bravo"]);
  await q.tick();
  assert.equal(launched.length, 2, "full capacity must not dispatch a third");
  a.resolve();
  await settled();
  assert.equal(active.size, 1);
  // Walk the cursor past the channels that are cooling down or still active.
  for(let i = 0; i < 4 && !launched.includes("charlie"); i++) await q.tick();
  assert.deepEqual(launched, ["alpha", "bravo", "charlie"]);
  assert.equal(active.size, 2);
  b.resolve(); c.resolve();
  await q.queue.idle();
  assert.deepEqual(q.queue.getState().activeKeys, []);
});

test("X3-20: duplicate channel cache keys never launch overlapping tasks", async t => {
  const channels = [{ cacheKey: "shared" }, { cacheKey: "shared" }, { cacheKey: "unique" }];
  const first = deferred(), second = deferred();
  const starts = [];
  const q = await clock(t, channels, async (_index, channel) => {
    starts.push(channel.cacheKey);
    await (channel.cacheKey === "shared" ? first.promise : second.promise);
  });
  t.after(() => { first.resolve(); second.resolve(); });
  await q.tick(); // Second config entry with same key
  await q.tick(); // New unique channel
  assert.deepEqual(starts, ["shared", "unique"]);
  assert.deepEqual(q.queue.getState().activeKeys, ["shared", "unique"]);
  for (let i = 0; i < 4; i++) await q.tick();
  assert.deepEqual(starts, ["shared", "unique"]);
  first.resolve(); second.resolve();
  await q.queue.idle();
});

test("X3-20: per-channel Retry-After never delays unrelated channel", async t => {
  const channels = [{ cacheKey: "blocked", TimeChecker: 1 }, { cacheKey: "healthy", TimeChecker: 1 }];
  const calls = [];
  const q = await clock(t, channels, async (_index, channel) => {
    calls.push(channel.cacheKey);
    if (channel.cacheKey === "blocked")
      throw Object.assign(new Error("rate limited"), {
        response: { status: 429, headers: { "retry-after": "600" } },
      });
  });
  assert.deepEqual(calls, ["blocked"]);
  assert.equal(q.queue.getState().scheduleByCacheKey.blocked.nextRunAt, 1600000);
  await q.tick();
  assert.deepEqual(calls, ["blocked", "healthy"]);
  for (let i = 0; i < 8; i++) await q.tick();
  assert.equal(calls.filter(x => x === "blocked").length, 1);
  assert.equal(q.queue.getState().scheduleByCacheKey.healthy.failures, 0);
});

test("X3-20: stop clears admission timer and waits for running channels", async t => {
  const hold = deferred(), started = deferred();
  const q = await clock(t, [{ cacheKey: "slow" }, { cacheKey: "other" }],
    async () => { started.resolve(); await hold.promise; });
  t.after(() => hold.resolve());
  await started.promise;
  assert.equal(q.queue.getState().activeKeys.length, 1);
  const waiting = q.queue.idle();
  let finished = false;
  void waiting.then(() => { finished = true; });
  q.queue.stop();
  q.queue.stop();
  assert.equal(q.timers.length, 0);
  await settled();
  assert.equal(finished, false, "stop must not report completion before in-flight work");
  hold.resolve();
  await waiting;
  assert.equal(finished, true);
  assert.equal(q.queue.getState().activeKeys.length, 0);
});

test("X3-20: failed persistent state stops parallel scheduler, not merely one channel", async t => {
  const channels = [{ cacheKey: "damaged" }, { cacheKey: "other" }];
  const calls = [];
  const q = await clock(t, channels, async (_index, channel) => {
    calls.push(channel.cacheKey);
    throw Object.assign(new Error("cache unsafe"), { code: "CACHE_UNSAFE" });
  });
  assert.deepEqual(calls, ["damaged"]);
  assert.equal(q.timers.length, 0);
  assert.deepEqual(q.queue.getState().activeKeys, []);
});

test("X3-20: invalid concurrency fails before queue starts and serial remains the default", async t => {
  const channels = [{ cacheKey: "only" }];
  for (const value of [0, 9, -1, 1.5, "2", Infinity, null]) {
    assert.throws(() => startChannelQueue({
      getChannels: channels, checkFeedsForChannel: async () => {},
      maxConcurrentChannels: value,
    }), /maxConcurrentChannels must be an integer/);
  }
  const q = startChannelQueue({
    getChannels: channels, checkFeedsForChannel: async () => {},
    delayBetweenChannels: 1000,
  });
  t.after(() => q.stop());
  await settled();
  assert.equal(q.getState().activeKeys, undefined,
    "the backwards-compatible serial scheduler remains the default");
});

test("X3-20: Settings.MaxConcurrentChannels is strictly validated", t => {
  const dir = tempDir(t), file = path.join(dir, "config.json");
  for (const value of [0, 9, "2", 2.5, -1, false]) {
    fs.writeFileSync(file, JSON.stringify({ Settings: { MaxConcurrentChannels: value }, channels: {} }));
    assert.throws(() => loadConfig(file), /Settings.MaxConcurrentChannels/);
  }
  fs.writeFileSync(file, JSON.stringify({ Settings: { MaxConcurrentChannels: 2 }, channels: {} }));
  assert.equal(loadConfig(file).Settings.MaxConcurrentChannels, 2);
});
