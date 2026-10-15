"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createCacheStore } = require("../src/core/cache-store");
const { getCacheKey } = require("../src/core/normalize");
const { runContext } = require("../src/network/context");
const { cancelled, throwIfAborted } = require("../src/network/abort");
const { tempDir } = require("./helpers/temp-dir.cjs");
const { deferred } = require("./fixtures/network.cjs");

// Keep production cancellation checks, but avoid the fixed per-delivery delay.
function loadRunnerWithoutDelay() {
  const abort = require("../src/network/abort");
  const runnerPath = require.resolve("../src/app/channel-runner");
  const previous = require.cache[runnerPath];
  const sleep = abort.sleep;
  try {
    abort.sleep = async (_ms, signal) => throwIfAborted(signal);
    delete require.cache[runnerPath];
    return require(runnerPath).createChannelRunner;
  } finally {
    abort.sleep = sleep;
    if (previous) require.cache[runnerPath] = previous;
    else delete require.cache[runnerPath];
  }
}
const createChannelRunner = loadRunnerWithoutDelay();
const feed = "https://feeds.example.invalid/rss";
const cacheKey = "delivery-fixture";
const entry = { title: "Fixture entry", guid: "fixture-guid", link: "https://articles.example.invalid/one" };
const bounded = { timeout: 5000 };

beforeEach((t) => {
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, () => {});
});

function harness(t, { source = "feed", items = [entry], initial = {}, requestSend = 5, hooks = {} } = {}) {
  const file = path.join(tempDir(t), "cache.json");
  const store = createCacheStore(file);
  store.replaceState(structuredClone(initial));
  store.save();
  const writes = [], calls = [], fetched = [];
  const save = store.save;
  t.mock.method(store, "save", () => {
    save();
    writes.push(JSON.parse(fs.readFileSync(file, "utf8")));
  });
  const bucket = t.mock.method(store, "getChannelBucket");
  const channel = {
    cacheKey, name: "delivery-fixture", RequestSend: requestSend,
    Webhook: "https://delivery.example.invalid/test-hook", Thread: null,
    Telegram: { BotToken: "synthetic-test-token", ChatID: "test-chat" },
    RSS: source === "discord" ? [] : [feed],
    Discord: source === "feed" ? null : { ChannelIDs: ["test-source"], Token: "test-source-token" },
  };
  const send = async (target, item) => {
    calls.push({ target, key: getCacheKey(item) });
    return hooks[target]?.({ item, store, file });
  };
  function runner(dryRun = false) {
    return createChannelRunner({
      cacheStore: store, dryRun,
      fetchFeed: async () => { fetched.push("feed"); return items; },
      parseDiscord: async () => { fetched.push("discord"); return items; },
      sendMessage: async (_url, _thread, item) => send("webhook", item),
      sendTelegramMessage: async (_config, item) => send("telegram", item),
    });
  }
  return { store, file, channel, writes, calls, fetched, bucket,
    run: (dryRun = false) => runner(dryRun).checkFeedsForChannel(0, channel) };
}

for (const source of ["feed", "discord"]) {
  const sourceBucket = source === "feed" ? feed : "discord";
  for (const failed of ["webhook", "telegram"]) {
    test(`${source}: ${failed} failure persists only the successful destination and retry skips it`, bounded, async (t) => {
      const successful = failed === "webhook" ? "telegram" : "webhook";
      const providerError = Object.assign(new Error("synthetic provider failure"), {
        response: { status: failed === "webhook" ? 503 : 429 },
      });
      let failOnce = true;
      const failures = [];
      const run = harness(t, { source, hooks: {
        [failed]: async () => {
          if (failOnce) { failOnce = false; throw providerError; }
        },
      } });
      await runContext({ onFailure: (error) => failures.push(error) }, () => run.run());
      assert.deepEqual(run.calls.map(({ target }) => target), ["webhook", "telegram"]);
      assert.deepEqual(failures, [providerError]);
      assert.equal(run.writes.length, 1);
      assert.deepEqual(run.writes[0][cacheKey][`${sourceBucket}::${successful}`], [entry.link]);
      assert.deepEqual(run.writes[0][cacheKey][`${sourceBucket}::${failed}`], []);

      // Restore state from disk before retry: the successful target survives a restart.
      run.store.replaceState(JSON.parse(fs.readFileSync(run.file, "utf8")));
      await run.run();
      await run.run();
      assert.deepEqual(run.calls.map(({ target }) => target), ["webhook", "telegram", failed]);
      assert.equal(run.writes.length, 2);
      for (const target of ["webhook", "telegram"]) {
        assert.deepEqual(run.store.getState()[cacheKey][`${sourceBucket}::${target}`], [entry.link]);
      }
    });
  }

  test(`${source}: duplicate items send once per destination within a batch and across passes`, bounded, async (t) => {
    const items = [entry, { ...entry, guid: "other-guid", link: `${entry.link}?utm_source=fixture#section` },
      { ...entry, title: "Different link", link: "https://articles.example.invalid/two" }];
    const run = harness(t, { source, items });
    await run.run();
    await run.run();
    assert.deepEqual(run.calls, [
      { target: "webhook", key: items[2].link }, { target: "telegram", key: items[2].link },
      { target: "webhook", key: entry.link }, { target: "telegram", key: entry.link },
    ]);
    assert.equal(run.writes.length, 4);
    for (const target of ["webhook", "telegram"]) {
      assert.deepEqual(run.store.getState()[cacheKey][`${sourceBucket}::${target}`], [entry.link, items[2].link]);
    }
  });

  test(`${source}: RequestSend counts a partially delivered item once and leaves later entries pending`, bounded, async (t) => {
    const later = { ...entry, title: "Later entry", link: "https://articles.example.invalid/later" };
    const run = harness(t, { source, requestSend: 1, items: [entry, later], initial: {
      [cacheKey]: { [`${sourceBucket}::webhook`]: [entry.link], [`${sourceBucket}::telegram`]: [] },
    } });
    await run.run();
    assert.deepEqual(run.calls, [{ target: "telegram", key: entry.link }]);
    for (const target of ["webhook", "telegram"]) {
      assert.deepEqual(run.store.getState()[cacheKey][`${sourceBucket}::${target}`], [entry.link]);
    }
    await run.run();
    await run.run();
    assert.deepEqual(run.calls, [
      { target: "telegram", key: entry.link },
      { target: "webhook", key: later.link }, { target: "telegram", key: later.link },
    ]);
    assert.equal(run.writes.length, 3);
  });

  test(`${source}: abort after webhook success retains that success and leaves Telegram pending`, bounded, async (t) => {
    const controller = new AbortController();
    const error = cancelled("synthetic cancellation");
    const failures = [];
    let abortOnce = true;
    const run = harness(t, { source, hooks: { telegram: async () => {
      if (abortOnce) { abortOnce = false; controller.abort(error); throw error; }
    } } });
    await assert.rejects(runContext({ signal: controller.signal, onFailure: (failure) => failures.push(failure) },
      () => run.run()), (failure) => failure === error);
    assert.deepEqual(failures, [], "Cancellation is not a provider failure");
    assert.equal(run.writes.length, 1);
    assert.deepEqual(run.writes[0][cacheKey][`${sourceBucket}::webhook`], [entry.link]);
    assert.deepEqual(run.writes[0][cacheKey][`${sourceBucket}::telegram`], []);
    await run.run();
    assert.deepEqual(run.calls.map(({ target }) => target), ["webhook", "telegram", "telegram"]);
    assert.equal(run.writes.length, 2);
  });
}

test("a provider request still in flight cannot create a delivered key or persist a success", bounded, async (t) => {
  const started = deferred(), release = deferred();
  const run = harness(t, { hooks: { webhook: async () => { started.resolve(); await release.promise; } } });
  const diskBefore = fs.readFileSync(run.file, "utf8");
  const pending = run.run();
  t.after(async () => { release.resolve(); await pending; });
  await started.promise;
  assert.equal(run.writes.length, 0);
  assert.equal(fs.readFileSync(run.file, "utf8"), diskBefore);
  assert.deepEqual(run.store.getState()[cacheKey][`${feed}::webhook`], []);
  assert.deepEqual(run.store.getState()[cacheKey][`${feed}::telegram`], []);
  release.resolve();
  await pending;
  assert.equal(run.writes.length, 2);
  assert.deepEqual(run.writes[0][cacheKey][`${feed}::webhook`], [entry.link]);
  assert.deepEqual(run.writes[0][cacheKey][`${feed}::telegram`], []);
  assert.deepEqual(run.writes[1][cacheKey][`${feed}::telegram`], [entry.link]);
});

for (const stateKind of ["fresh", "existing", "legacy"]) {
  test(`dry-run with ${stateKind} state isolates both source paths and preserves the following real delivery`, bounded, async (t) => {
    const oldKey = "https://articles.example.invalid/old";
    const previous = stateKind === "legacy" ? { [feed]: [oldKey], discord: [oldKey] } : {
      [`${feed}::webhook`]: [oldKey], [`${feed}::telegram`]: [oldKey],
      "discord::webhook": [oldKey], "discord::telegram": [oldKey],
    };
    const initial = stateKind === "fresh" ? {} : { [cacheKey]: previous, unrelated: { entries: ["preserve"] } };
    const run = harness(t, { source: "both", initial });
    const diskBefore = fs.readFileSync(run.file, "utf8");
    const before = structuredClone(run.store.getState());
    assert.equal(await run.run(true), run.store.getState());
    await run.run(true);
    assert.deepEqual(run.store.getState(), before);
    assert.equal(fs.readFileSync(run.file, "utf8"), diskBefore);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.writes, []);
    assert.equal(run.bucket.mock.callCount(), 0, "Simulation must not create a live channel bucket");
    assert.deepEqual(run.fetched, ["discord", "feed", "discord", "feed"]);
    await run.run();
    assert.deepEqual(run.calls.map(({ target }) => target), ["webhook", "telegram", "webhook", "telegram"]);
    assert.equal(run.writes.length, 4);
  });
}

test("an already-aborted channel neither fetches nor sends nor changes delivery state", bounded, async (t) => {
  const run = harness(t, { source: "both" });
  const diskBefore = fs.readFileSync(run.file, "utf8");
  await assert.rejects(runContext({ signal: AbortSignal.abort() }, () => run.run()), { name: "AbortError" });
  assert.deepEqual(run.fetched, []);
  assert.deepEqual(run.calls, []);
  assert.deepEqual(run.writes, []);
  assert.deepEqual(run.store.getState(), {});
  assert.equal(fs.readFileSync(run.file, "utf8"), diskBefore);
});


for (const source of ["feed", "discord"]) {
  test(`X3-14: ${source} uses the original entry payload while storing the unchanged legacy identity`, bounded, async t => {
    const raw = {
      title: "Original post",
      link: "https://articles.example.invalid/preserved?utm_source=fixture#comments",
      guid: "permanent-feed-id",
      contentSnippet: "Do not change the payload",
      isoDate: "2026-10-15T00:00:00.000Z",
      enclosure: "https://example.invalid/asset.png",
      categories: ["discord"],
      attachments: ["https://example.invalid/attachment.png"],
      referenced: { author: "another user", content: "quoted reply" },
      discordData: { messageId: "123", channelId: "456" },
      customMetadata: { opaque: true },
    };
    const before = structuredClone(raw);
    const seen = [];
    const run = harness(t, {
      source,
      items: [raw],
      hooks: {
        webhook: ({ item }) => { assert.strictEqual(item, raw); seen.push("webhook"); },
        telegram: ({ item }) => { assert.strictEqual(item, raw); seen.push("telegram"); },
      },
    });
    await run.run();
    await run.run();
    assert.deepEqual(seen, ["webhook", "telegram"], "a second pass must not replay delivered entries");
    assert.deepEqual(raw, before, "normalization must not modify original provider data");
    const sourceBucket = source === "feed" ? feed : "discord";
    const state = run.store.getState()[cacheKey];
    const expectedKey = getCacheKey(raw);
    assert.equal(expectedKey, "https://articles.example.invalid/preserved");
    for (const target of ["webhook", "telegram"])
      assert.deepEqual(state[`${sourceBucket}::${target}`], [expectedKey]);
    assert.ok(!JSON.stringify(state).includes("NormalizedEntry"), "no cache schema upgrade");
  });

  test(`X3-14: ${source} honors already delivered legacy source keys without resending`, bounded, async t => {
    const sourceBucket = source === "feed" ? feed : "discord";
    const run = harness(t, { source, initial: {
      [cacheKey]: { [sourceBucket]: [entry.link] },
    } });
    await run.run();
    assert.deepEqual(run.calls, []);
    const cache = run.store.getState()[cacheKey];
    assert.deepEqual(cache[`${sourceBucket}::webhook`], [entry.link]);
    assert.deepEqual(cache[`${sourceBucket}::telegram`], [entry.link]);
  });
}
