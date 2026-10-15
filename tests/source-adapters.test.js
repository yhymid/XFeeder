"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_FEED_ADAPTERS, createSourceAdapters } = require("../src/core/source-adapters");
const { parseYouTube } = require("../src/parsers/youtube");
const { parseAtom } = require("../src/parsers/atom");
const { parseXML } = require("../src/parsers/xml");
const { parseJSON } = require("../src/parsers/json");
const { parseApiX } = require("../src/parsers/api_x");
const { parseRSS } = require("../src/parsers/rss");
const { parseFallback } = require("../src/parsers/fallback");

test("X3-15: source adapters preserve production parser identity and priority", () => {
  const sources = createSourceAdapters({ getDiscordHttpClient: () => ({ get() {} }) });
  assert.deepEqual(sources.feed.map(a => a.id), [
    "youtube", "atom", "xml", "json", "api-x", "rss", "fallback",
  ]);
  const existingOrder = [
    parseYouTube, parseAtom, parseXML, parseJSON, parseApiX, parseRSS, parseFallback,
  ];
  assert.deepEqual(sources.feedParsers, existingOrder);
  for (const [index, adapter] of sources.feed.entries()) {
    assert.equal(adapter.parse, existingOrder[index], "no parser wrapper or rename");
    assert.equal(adapter.kind, "feed");
    assert.equal(adapter.parse.name, existingOrder[index].name);
    assert.ok(Object.isFrozen(adapter));
  }
  assert.equal(DEFAULT_FEED_ADAPTERS[0].parse, parseYouTube);
  assert.ok(Object.isFrozen(sources.feed));
  assert.ok(Object.isFrozen(sources.feedParsers));
  assert.ok(Object.isFrozen(sources));
});

test("X3-15: Discord source resolves its managed HTTP client lazily on each read", async () => {
  const one = { get: async () => [] };
  const two = { get: async () => [] };
  const clients = [one, two];
  let selections = 0;
  const calls = [];
  const parseDiscordSource = async (config, client) => {
    calls.push({ config, client });
    return [{ title: "synthetic", guid: "fixture" }];
  };
  const adapters = createSourceAdapters({
    getDiscordHttpClient: () => clients[selections++],
    parseDiscordSource,
  });
  assert.equal(selections, 0, "registry creation must not initialize the transport");
  const first = { Token: "synthetic", ChannelIDs: ["first"] };
  const second = { Token: "synthetic", ChannelIDs: ["second"] };
  assert.deepEqual(await adapters.discord.read(first), [{ title: "synthetic", guid: "fixture" }]);
  assert.deepEqual(await adapters.discord.read(second), [{ title: "synthetic", guid: "fixture" }]);
  assert.deepEqual(calls, [
    { config: first, client: one }, { config: second, client: two },
  ]);
  assert.equal(adapters.discord.kind, "discord");
});

test("X3-15: custom feed source adapters can extend the pipeline without global state", async () => {
  const parsed = [{ title: "New source", guid: "feed-id", link: "https://example.invalid/1" }];
  const custom = async (_url, client) => {
    assert.equal(client.marker, "managed");
    return parsed;
  };
  const registry = createSourceAdapters({
    feedAdapters: [{ id: "custom", parse: custom }],
    parseDiscordSource: async () => [],
    getDiscordHttpClient: () => ({ get() {} }),
  });
  assert.deepEqual(registry.feed.map(a => a.id), ["custom"]);
  assert.strictEqual(registry.feedParsers[0], custom);
  assert.strictEqual(await registry.feedParsers[0]("https://example.invalid/feed", { marker: "managed" }), parsed);
});

test("X3-15: reject duplicate names and unmanaged Discord source HTTP", () => {
  assert.throws(() => createSourceAdapters(), /managed HTTP client/);
  const defaults = { getDiscordHttpClient: () => ({ get() {} }) };
  assert.throws(() => createSourceAdapters({ ...defaults, feedAdapters: [
    { id: "duplicate", parse() {} },
    { id: "duplicate", parse() {} },
  ] }), /Invalid or duplicate/);
  assert.throws(() => createSourceAdapters({ ...defaults, feedAdapters: [
    { id: "broken", parse: null },
  ] }), /Invalid or duplicate/);
  assert.throws(() => createSourceAdapters({ ...defaults, feedAdapters: null }), /array and a Discord parser/);
});
