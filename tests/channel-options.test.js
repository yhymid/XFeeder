"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { collectConfiguredChannels } = require("../src/core/channel-config");

// The runner captures sleep at require time. Replace only that dependency while
// loading it, then restore both modules so dispatch assertions need no timers.
function loadRunnerWithoutDelay() {
  const abort = require("../src/network/abort");
  const runnerPath = require.resolve("../src/app/channel-runner");
  const previousRunner = require.cache[runnerPath];
  const previousSleep = abort.sleep;
  try {
    abort.sleep = async () => {};
    delete require.cache[runnerPath];
    return require(runnerPath).createChannelRunner;
  } finally {
    abort.sleep = previousSleep;
    if (previousRunner) require.cache[runnerPath] = previousRunner;
    else delete require.cache[runnerPath];
  }
}

const createChannelRunner = loadRunnerWithoutDelay();
const webhook = "https://example.test/webhook";
const telegram = { Enabled: true, BotToken: "fixture-token", ChatID: "fixture-chat" };
const feedA = "https://example.test/feed-a";
const feedB = "https://example.test/feed-b";

function entries(source, count) {
  return Array.from({ length: count }, (_, index) => ({
    title: `${source}-${index + 1}`,
    link: `https://example.test/${source}/${index + 1}`,
  }));
}

function harness(t, { feeds = {}, discord = [], state = {} } = {}) {
  const deliveries = [];
  const fetched = [];
  const parsed = [];
  let saves = 0;
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const runner = createChannelRunner({
    cacheStore: {
      getState: () => state,
      getChannelBucket: (key) => (state[key] ||= {}),
      save: () => { saves += 1; },
    },
    fetchFeed: async (url) => {
      fetched.push(url);
      return feeds[url] || [];
    },
    parseDiscord: async (config) => {
      parsed.push(config);
      return discord;
    },
    sendMessage: async (url, thread, entry) => {
      deliveries.push({ target: "webhook", url, thread, entry });
    },
    sendTelegramMessage: async (config, entry) => {
      deliveries.push({ target: "telegram", config, entry });
    },
  });
  return { ...runner, deliveries, fetched, parsed, state, getSaves: () => saves };
}

function deliveryOrder(deliveries) {
  return deliveries.map(({ target, entry }) => [target, entry.title]);
}

function bothTargets(items) {
  return items.flatMap(({ title }) => [["webhook", title], ["telegram", title]]);
}

test("RequestSend limits pending entries after cached entries are filtered", async (t) => {
  const items = entries("cached-feed", 4);
  const [channel] = collectConfiguredChannels({
    ChannelDefaults: { RequestSend: 1 },
    Telegram: telegram,
    channels: { limited: { Webhook: webhook, Feeds: [feedA], RequestSend: 2 } },
  });
  const state = {
    [channel.cacheKey]: {
      [`${feedA}::webhook`]: [items[0].link],
      [`${feedA}::telegram`]: [items[0].link],
    },
  };
  const run = harness(t, { feeds: { [feedA]: items }, state });

  await run.checkFeedsForChannel(channel.index, channel);

  assert.deepEqual(run.fetched, [feedA]);
  assert.deepEqual(deliveryOrder(run.deliveries), bothTargets([items[2], items[1]]));
  for (const target of ["webhook", "telegram"]) {
    assert.ok(state[channel.cacheKey][`${feedA}::${target}`].includes(items[0].link));
    assert.ok(!state[channel.cacheKey][`${feedA}::${target}`].includes(items[3].link));
  }
});

test("RequestSend applies independently to each feed and Discord source with both destinations", async (t) => {
  const first = entries("first-feed", 3);
  const second = entries("second-feed", 3);
  const discord = entries("discord-source", 3);
  const [channel] = collectConfiguredChannels({
    ChannelDefaults: { RequestSend: 2 },
    Auth: { Token: "fixture-source-token" },
    Telegram: telegram,
    channels: {
      multiple: {
        Webhook: webhook,
        Feeds: [feedA, feedB],
        Discord: { ChannelIDs: ["fixture-source-channel"] },
      },
    },
  });
  const run = harness(t, { feeds: { [feedA]: first, [feedB]: second }, discord });

  await run.checkFeedsForChannel(channel.index, channel);

  assert.deepEqual(run.fetched, [feedA, feedB]);
  assert.deepEqual(run.parsed, [channel.Discord]);
  assert.deepEqual(deliveryOrder(run.deliveries), bothTargets([
    discord[1], discord[0], first[1], first[0], second[1], second[0],
  ]));
  for (const delivery of run.deliveries) {
    if (delivery.target === "webhook") {
      assert.equal(delivery.url, channel.Webhook);
      assert.equal(delivery.thread, channel.Thread);
    } else {
      assert.equal(delivery.config, channel.Telegram);
    }
  }
});

test("Telegram-only configuration dispatches to the inherited and overridden Telegram target", async (t) => {
  const items = entries("telegram-only", 1);
  const [channel] = collectConfiguredChannels({
    Telegram: telegram,
    channels: {
      telegramOnly: {
        Feeds: [feedA],
        Telegram: { ChatID: "local-chat", MessageThreadID: 12 },
      },
    },
  });
  const run = harness(t, { feeds: { [feedA]: items } });

  await run.checkFeedsForChannel(channel.index, channel);

  assert.deepEqual(deliveryOrder(run.deliveries), [["telegram", items[0].title]]);
  assert.equal(run.deliveries[0].config, channel.Telegram);
  assert.equal(run.deliveries[0].config.BotToken, telegram.BotToken);
  assert.equal(run.deliveries[0].config.ChatID, "local-chat");
  assert.equal(run.deliveries[0].config.MessageThreadID, 12);
  assert.deepEqual(run.parsed, []);
});

test("Telegram Enabled:false prevents dispatch while the webhook remains active", async (t) => {
  const items = entries("disabled-telegram", 1);
  const [channel] = collectConfiguredChannels({
    Telegram: telegram,
    channels: {
      webhookOnly: { Webhook: webhook, Feeds: [feedA], Telegram: { Enabled: false } },
    },
  });
  const run = harness(t, { feeds: { [feedA]: items } });

  await run.checkFeedsForChannel(channel.index, channel);

  assert.deepEqual(deliveryOrder(run.deliveries), [["webhook", items[0].title]]);
  assert.equal(run.deliveries[0].url, webhook);
  assert.ok(!Object.hasOwn(run.state[channel.cacheKey], `${feedA}::telegram`));
});

test("disabled Telegram without a webhook fetches the feed but dispatches nothing", async (t) => {
  const items = entries("no-destination", 1);
  const [channel] = collectConfiguredChannels({
    Telegram: telegram,
    channels: { disabled: { Feeds: [feedA], Telegram: { Enabled: false } } },
  });
  const run = harness(t, { feeds: { [feedA]: items } });

  await run.checkFeedsForChannel(channel.index, channel);

  assert.deepEqual(run.fetched, [feedA]);
  assert.deepEqual(run.deliveries, []);
  assert.deepEqual(run.state, {});
  assert.equal(run.getSaves(), 0);
});
