"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  collectChannelGroupEntries,
  collectConfiguredChannels,
  getChannelLabel,
  isChannelConfigGroup,
  summarizeChannel,
  validateChannels,
} = require("../src/core/channel-config");
const { ScraplingConfig } = require("../src/extensions/Scrapling/config");
const groupsFixture = require("./fixtures/config/channel-groups.json");

const feed = "https://feeds.example.invalid/feed.xml";
const webhook = "https://delivery.example.invalid/test-hook";
const telegram = { BotToken: "synthetic-test-token", ChatID: "test-chat" };

function channel(options = {}, root = {}) {
  return collectConfiguredChannels({
    ...root,
    channels: { news: { Feeds: [feed], ...options } },
  })[0];
}

function freezeTree(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

test("channel defaults preserve the 30-minute interval and five-entry limit", () => {
  const normalized = channel();
  assert.deepEqual(summarizeChannel(normalized), {
    label: "news", feeds: 1, hasWebhook: false, hasDiscord: false,
    hasTelegram: false, interval: 30, burst: 5, cacheKey: "channels:news",
  });
  assert.equal(normalized.Webhook, "");
  assert.equal(normalized.Thread, null);
  assert.equal(normalized.Discord, null);
  assert.equal(normalized.Telegram, null);
});

test("array, named and custom channel groups retain order, labels and independent options", () => {
  const channels = collectConfiguredChannels(groupsFixture);
  assert.deepEqual(collectChannelGroupEntries(groupsFixture).map(([key]) => key),
    ["channels", "channels2", "community"]);
  assert.deepEqual(channels.map((item) => [item.index, item.sourceKey, getChannelLabel(item)]), [
    [0, "channels", "channels#1"], [1, "channels", "channels#2"],
    [2, "channels2", "slower"], [3, "community", "news"],
  ]);
  assert.deepEqual(channels.map((item) => [item.TimeChecker, item.RequestSend, item.RSS.length]),
    [[60, 2, 1], [60, 2, 2], [120, 3, 1], [60, 2, 3]]);
  assert.ok(channels.every((item) => item.Webhook === webhook));
  assert.equal(channels[3].Thread, "test-thread");
  assert.equal(channels[2].cacheKey, "channels2:slower");
  assert.equal(channels[3].cacheKey, "community:news");
  assert.deepEqual(validateChannels(channels), []);
});

test("reserved root sections are never discovered as channel groups", () => {
  const reserved = ["Settings", "network", "Auth", "Proxy", "Scrapling",
    "ChannelDefaults", "DefaultChannel", "Telegram"];
  const candidate = { looksLikeAChannel: { Feeds: [feed] } };
  for (const key of reserved) assert.equal(isChannelConfigGroup(key, candidate), false, key);
  assert.equal(isChannelConfigGroup("custom", candidate), true);
  assert.deepEqual(collectConfiguredChannels(null), []);
  assert.deepEqual(collectConfiguredChannels({}), []);
});

test("empty groups are recognized only for channels-prefixed names", () => {
  for (const value of [[], {}]) {
    for (const key of ["channels", "channels2", "CHANNELSArchive"]) {
      assert.equal(isChannelConfigGroup(key, value), true);
    }
    assert.equal(isChannelConfigGroup("community", value), false);
    assert.deepEqual(collectConfiguredChannels({ channels: value }), []);
  }
});

test("a malformed member excludes its whole group without hiding another valid group", () => {
  for (const bad of [null, false, 12, {}, "not-a-url", [feed, 12]]) {
    for (const group of [[{ Feeds: [feed] }, bad], { valid: { Feeds: [feed] }, bad }]) {
      const channels = collectConfiguredChannels({
        channels: group,
        channels2: { survivor: { Feeds: [feed], Webhook: webhook } },
      });
      assert.deepEqual(channels.map(getChannelLabel), ["survivor"], JSON.stringify(group));
      assert.deepEqual(validateChannels(channels), []);
    }
  }
  for (const value of [null, false, 12, feed]) {
    assert.deepEqual(collectConfiguredChannels({ channels: value }), []);
  }
});

test("shorthand requires HTTP(S) before trimming, while object feeds are only trimmed", () => {
  assert.equal(isChannelConfigGroup("channels", ["HTTPS://feeds.example.invalid/rss"]), true);
  assert.equal(isChannelConfigGroup("channels", [` ${feed}`]), false);
  assert.equal(isChannelConfigGroup("channels", ["ftp://feeds.example.invalid/rss"]), false);
  assert.deepEqual(channel({ Feeds: [` ${feed} `, "not-a-url"] }).RSS, [feed, "not-a-url"]);
});

test("ChannelDefaults takes precedence over DefaultChannel, including an empty object", () => {
  const root = { DefaultChannel: { TimeChecker: 80, RequestSend: 8, Webhook: webhook } };
  assert.equal(channel({}, root).TimeChecker, 80);
  assert.equal(channel({}, root).RequestSend, 8);
  const preferred = channel({}, { ...root, ChannelDefaults: { TimeChecker: 45 } });
  assert.equal(preferred.TimeChecker, 45);
  assert.equal(preferred.RequestSend, 5);
  assert.equal(preferred.Webhook, "");
  assert.equal(channel({}, { ...root, ChannelDefaults: {} }).TimeChecker, 30);
  assert.equal(channel({}, { ...root, ChannelDefaults: null }).TimeChecker, 80);
});

test("local feed aliases replace matching defaults and accumulate across other aliases", () => {
  const normalized = channel({
    RSS: [" https://feeds.example.invalid/local ", feed, null, 123, ""],
    Feeds: [feed, { url: "https://feeds.example.invalid/object" }],
    Sources: "https://feeds.example.invalid/source",
  }, { ChannelDefaults: {
    RSS: "https://feeds.example.invalid/replaced",
    URLs: [feed, "https://feeds.example.invalid/default"],
  } });
  assert.deepEqual(normalized.RSS, [
    "https://feeds.example.invalid/local", feed,
    "https://feeds.example.invalid/default", "https://feeds.example.invalid/source",
  ]);
});

test("per-feed objects are unsupported and cannot supply the missing source URL", () => {
  const normalized = channel({
    Webhook: webhook, Feeds: [{ url: feed, TimeChecker: 1, RequestSend: 1 }],
  });
  assert.deepEqual(normalized.RSS, []);
  assert.equal(normalized.TimeChecker, 30);
  assert.equal(normalized.RequestSend, 5);
  assert.deepEqual(validateChannels([normalized]), [
    "[Config] news: missing feed sources or Discord source.",
  ]);
});

test("nested defaults merge with local options without mutating the input or siblings", () => {
  const config = {
    Auth: { Token: " root-source-token ", cookie: " test-cookie " },
    Telegram: { ...telegram, TimeoutMs: 9000 },
    ChannelDefaults: {
      Webhook: webhook, RequestSend: 2,
      Discord: { ChannelIDs: [" source-id "], GuildID: " test-guild " },
      Telegram: { MessageThreadID: "7", DisableWebPagePreview: true },
    },
    channels: {
      overridden: { Feeds: [feed], RequestSend: 1,
        Discord: { Token: " local-source-token " }, Telegram: { ChatID: -100123 } },
      inherited: { Feeds: [feed] },
    },
  };
  const before = structuredClone(config);
  const [local, inherited] = collectConfiguredChannels(freezeTree(config));
  assert.deepEqual(local.Discord, {
    Token: "local-source-token", cookie: "test-cookie", ChannelIDs: ["source-id"],
    GuildID: "test-guild", Thread: null,
  });
  assert.deepEqual(local.Telegram, {
    BotToken: telegram.BotToken, ChatID: "-100123", TimeoutMs: 9000,
    MessageThreadID: 7, DisableWebPagePreview: true,
  });
  assert.equal(local.RequestSend, 1);
  assert.equal(inherited.RequestSend, 2);
  assert.equal(inherited.Discord.Token, "root-source-token");
  assert.equal(inherited.Telegram.ChatID, "test-chat");
  assert.deepEqual(validateChannels([local, inherited]), []);
  assert.deepEqual(config, before);
});

for (const { name, options, targets, warnings } of [
  { name: "Discord webhook only", options: { Webhook: webhook }, targets: [true, false], warnings: [] },
  { name: "Telegram only", options: { Telegram: telegram }, targets: [false, true], warnings: [] },
  { name: "both destinations", options: { Webhook: webhook, Telegram: telegram }, targets: [true, true], warnings: [] },
  { name: "disabled Telegram with a webhook", options: { Webhook: webhook, Telegram: { Enabled: false } },
    targets: [true, false], warnings: [] },
  { name: "disabled sole destination", options: { Telegram: { ...telegram, Enabled: false } },
    targets: [false, false], warnings: ["missing delivery target"] },
  { name: "incomplete Telegram", options: { Telegram: { BotToken: telegram.BotToken } },
    targets: [false, false], warnings: ["missing delivery target", "BotToken or ChatID is missing"] },
]) {
  test(`channel destination configuration: ${name}`, () => {
    const normalized = channel(options);
    const summary = summarizeChannel(normalized);
    assert.deepEqual([summary.hasWebhook, summary.hasTelegram], targets);
    const actual = validateChannels([normalized]);
    assert.equal(actual.length, warnings.length);
    warnings.forEach((message, index) => assert.ok(actual[index].includes(message), actual[index]));
  });
}

test("Telegram inheritance requires a boolean Enabled override to disable it", () => {
  const root = { Telegram: { ...telegram, Enabled: true } };
  for (const local of [undefined, null, false, { Enabled: "false" }]) {
    assert.equal(summarizeChannel(channel({ Telegram: local }, root)).hasTelegram, true);
  }
  assert.equal(summarizeChannel(channel({ Telegram: { Enabled: false } }, root)).hasTelegram, false);
  assert.equal(summarizeChannel(channel({ Telegram: { Enabled: true } }, {
    Telegram: { ...telegram, Enabled: false },
  })).hasTelegram, true);
  const blank = channel({ Telegram: { BotToken: " ", ChatID: "" } }, root);
  assert.equal(blank.Telegram.BotToken, telegram.BotToken);
  assert.equal(blank.Telegram.ChatID, telegram.ChatID);
});

test("channel and Discord Enabled fields are preserved but do not disable a source", () => {
  const normalized = channel({ Enabled: false, Webhook: webhook,
    Discord: { Enabled: false, Token: "synthetic-source-token", ChannelID: " source-id " } });
  assert.equal(normalized.raw.Enabled, false);
  assert.equal(normalized.Discord.Enabled, false);
  assert.equal(summarizeChannel(normalized).hasDiscord, true);
  assert.deepEqual(validateChannels([normalized]), []);
});

test("Telegram thread IDs and timeout values keep their existing numeric rules", () => {
  for (const invalid of [undefined, null, "", 0, -1, "invalid", "Infinity"]) {
    const normalized = channel({ Telegram: { ...telegram, MessageThreadID: invalid, TimeoutMs: invalid } });
    assert.equal(normalized.Telegram.MessageThreadID, null);
    assert.equal(normalized.Telegram.TimeoutMs, 15000);
  }
  for (const invalidThread of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(channel({ Telegram: { MessageThreadID: invalidThread } }).Telegram.MessageThreadID, null);
  }
  const normalized = channel({ Telegram: { MessageThreadID: "12", TimeoutMs: "1234.9" } });
  assert.equal(normalized.Telegram.MessageThreadID, 12);
  assert.equal(normalized.Telegram.TimeoutMs, 1234);
  assert.equal(channel({ Telegram: { TimeoutMs: 0.5 } }).Telegram.TimeoutMs, 1);
});

test("a missing feed source warns while a complete Discord source needs no feed URL", () => {
  const missing = channel({ Webhook: webhook, Feeds: [] });
  assert.deepEqual(validateChannels([missing]), ["[Config] news: missing feed sources or Discord source."]);
  const discordOnly = channel({ Webhook: webhook, Feeds: [], Discord: { ChannelID: " source-id " } },
    { Auth: { Token: " synthetic-source-token ", "x-super-properties": " test-properties " } });
  assert.deepEqual(discordOnly.RSS, []);
  assert.equal(discordOnly.Discord.ChannelID, "source-id");
  assert.equal(discordOnly.Discord.Token, "synthetic-source-token");
  assert.equal(discordOnly.Discord["x-super-properties"], "test-properties");
  assert.deepEqual(validateChannels([discordOnly]), []);
});

test("incomplete Discord sources warn about IDs and token, including a blank local override", () => {
  const normalized = channel({ Webhook: webhook, Feeds: [],
    Discord: { ChannelIDs: [123, null, " "], Token: "" } },
  { Auth: { Token: "synthetic-root-token" } });
  assert.deepEqual(normalized.Discord.ChannelIDs, []);
  assert.equal(normalized.Discord.Token, "");
  assert.deepEqual(validateChannels([normalized]), [
    "[Config] news: Discord source is enabled but ChannelIDs are missing.",
    "[Config] news: Discord source is enabled but Token is missing (global Auth also counts).",
  ]);
  const duplicates = channel({ Discord: { ChannelIDs: [" id ", "id", 123] } });
  assert.deepEqual(duplicates.Discord.ChannelIDs, ["id", "id"]);
});

test("invalid scalar destination configs do not create delivery targets", () => {
  for (const value of [null, false, 0, "", []]) {
    const normalized = channel({ Discord: value, Telegram: value, Webhook: 123 });
    const summary = summarizeChannel(normalized);
    assert.equal(summary.hasWebhook, false);
    assert.equal(summary.hasTelegram, false);
  }
});

test("interval and RequestSend values use numeric conversion and positive fallbacks", () => {
  for (const invalid of [undefined, null, false, "", " ", 0, -1, "bad", "Infinity"]) {
    const normalized = channel({ TimeChecker: invalid, RequestSend: invalid });
    assert.equal(normalized.TimeChecker, 30, String(invalid));
    assert.equal(normalized.RequestSend, 5, String(invalid));
  }
  for (const [value, expected] of [["12", 12], [3.8, 3], [" 9.2 ", 9], [true, 1], [0.5, 0]]) {
    const normalized = channel({ TimeChecker: value, RequestSend: value });
    assert.equal(normalized.TimeChecker, expected);
    assert.equal(normalized.RequestSend, expected);
  }
});

test("top-level threads preserve null sentinels and stringify other identifiers", () => {
  for (const value of [undefined, null, "", "null"]) assert.equal(channel({ Thread: value }).Thread, null);
  assert.equal(channel({ Thread: 123 }).Thread, "123");
  assert.equal(channel({ Thread: " test-thread " }).Thread, " test-thread ");
});

test("explicit cache identity precedence and collisions remain visible to validation", () => {
  assert.equal(channel({ CacheKey: " cache ", Key: "key", ID: "id" }).cacheKey, "cache");
  assert.equal(channel({ CacheKey: " ", Key: " key ", ID: "id" }).cacheKey, "key");
  assert.equal(channel({ ID: " id " }).cacheKey, "id");
  const channels = collectConfiguredChannels({ channels: {
    first: { Feeds: [feed], Webhook: webhook, ID: "shared" },
    second: { Feeds: [feed], Webhook: webhook, CacheKey: "shared" },
  } });
  assert.deepEqual(validateChannels(channels), [
    "[Config] second: cache key collision with first. Set explicit ID/CacheKey for one of them.",
  ]);
});

test("anonymous cache identities survive channel reordering and token/interval changes", () => {
  const first = { Feeds: [feed], Telegram: telegram, TimeChecker: 60, RequestSend: 2 };
  const second = { Feeds: ["https://feeds.example.invalid/another"], Webhook: webhook };
  const original = collectConfiguredChannels({ channels: [first, second] });
  const reordered = collectConfiguredChannels({ channels: [second, {
    ...first, TimeChecker: 120, RequestSend: 4, Telegram: { ...telegram, BotToken: "replacement-test-token" },
  }] });
  assert.equal(original[0].cacheKey, reordered[1].cacheKey);
  assert.equal(original[1].cacheKey, reordered[0].cacheKey);
  assert.notEqual(original[0].cacheKey, original[1].cacheKey);
});

test("root Scrapling per-URL options stay separate from channel defaults and feed lists", () => {
  const config = freezeTree({
    Scrapling: { DefaultOptions: { timeout: 20 }, PerUrlConfig: { [feed]: { timeout: 45, disableResources: false } } },
    channels: [{ Feeds: [feed], Webhook: webhook }],
  });
  const channels = collectConfiguredChannels(config);
  assert.equal(channels.length, 1);
  assert.deepEqual(channels[0].RSS, [feed]);
  const scrapling = new ScraplingConfig(config);
  assert.deepEqual(scrapling.defaultOptions, { timeout: 20 });
  assert.deepEqual(scrapling.getUrlConfig(feed), { timeout: 45, disableResources: false });
  assert.deepEqual(scrapling.getUrlConfig(`${feed}?other`), {});
});
