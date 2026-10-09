const assert = require("node:assert/strict");
const test = require("node:test");

const { createChannelRunner } = require("../src/app/channel-runner");

function createCacheStoreMock() {
  const state = {};
  let saves = 0;

  return {
    getState() {
      return state;
    },
    getChannelBucket(key) {
      if (!state[key]) state[key] = {};
      return state[key];
    },
    save() {
      saves += 1;
    },
    getSaveCount() {
      return saves;
    },
  };
}

test("channel runner retries only the failed target on the next pass", async () => {
  const cacheStore = createCacheStoreMock();
  let webhookCalls = 0;
  let telegramCalls = 0;
  let failTelegramOnce = true;

  const { checkFeedsForChannel } = createChannelRunner({
    cacheStore,
    dryRun: false,
    fetchFeed: async () => [{
      title: "Example entry",
      link: "https://example.com/post",
      guid: "https://example.com/post",
      isoDate: "2026-01-01T00:00:00.000Z",
    }],
    parseDiscord: async () => [],
    sendMessage: async () => {
      webhookCalls += 1;
    },
    sendTelegramMessage: async () => {
      telegramCalls += 1;
      if (failTelegramOnce) {
        failTelegramOnce = false;
        throw new Error("temporary telegram error");
      }
    },
  });

  const channelConfig = {
    cacheKey: "channel:test",
    name: "test",
    sourceKey: "channels",
    Webhook: "https://discord.com/api/webhooks/test",
    Thread: null,
    Telegram: {
      Enabled: true,
      BotToken: "token",
      ChatID: "!room:telegram.example.org",
    },
    RSS: ["https://example.com/feed.xml"],
    RequestSend: 5,
  };

  await checkFeedsForChannel(0, channelConfig);
  await checkFeedsForChannel(0, channelConfig);

  const channelCache = cacheStore.getChannelBucket("channel:test");
  assert.equal(webhookCalls, 1);
  assert.equal(telegramCalls, 2);
  assert.deepEqual(channelCache["https://example.com/feed.xml::webhook"], ["https://example.com/post"]);
  assert.deepEqual(channelCache["https://example.com/feed.xml::telegram"], ["https://example.com/post"]);
  assert.equal(cacheStore.getSaveCount(), 2);
});

test("channel runner handles webhook-only feeds when Telegram config is null", async () => {
  const cacheStore = createCacheStoreMock();
  let webhookCalls = 0;

  const { checkFeedsForChannel } = createChannelRunner({
    cacheStore,
    dryRun: false,
    fetchFeed: async () => [{
      title: "Webhook only entry",
      link: "https://example.com/webhook-only",
      guid: "https://example.com/webhook-only",
      isoDate: "2026-01-01T00:00:00.000Z",
    }],
    parseDiscord: async () => [],
    sendMessage: async () => {
      webhookCalls += 1;
    },
    sendTelegramMessage: async () => {
      throw new Error("Telegram should not be called for webhook-only channels");
    },
  });

  await checkFeedsForChannel(0, {
    cacheKey: "channel:webhook-only",
    name: "webhook-only",
    sourceKey: "channels",
    Webhook: "https://discord.com/api/webhooks/test",
    Thread: null,
    Telegram: null,
    RSS: ["https://example.com/feed.xml"],
    RequestSend: 5,
  });

  const channelCache = cacheStore.getChannelBucket("channel:webhook-only");
  assert.equal(webhookCalls, 1);
  assert.deepEqual(channelCache["https://example.com/feed.xml::webhook"], ["https://example.com/webhook-only"]);
  assert.equal(cacheStore.getSaveCount(), 1);
});
