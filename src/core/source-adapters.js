"use strict";

const { parseYouTube } = require("../parsers/youtube");
const { parseAtom } = require("../parsers/atom");
const { parseXML } = require("../parsers/xml");
const { parseJSON } = require("../parsers/json");
const { parseApiX } = require("../parsers/api_x");
const { parseRSS } = require("../parsers/rss");
const { parseFallback } = require("../parsers/fallback");
const { parseDiscord } = require("../parsers/discord");

// Adapter identity and ordering are explicit. The feed pipeline still gets
// each ORIGINAL parser function, preserving response reuse and fallthrough.
const DEFAULT_FEED_ADAPTERS = Object.freeze([
  { id: "youtube", parse: parseYouTube },
  { id: "atom", parse: parseAtom },
  { id: "xml", parse: parseXML },
  { id: "json", parse: parseJSON },
  { id: "api-x", parse: parseApiX },
  { id: "rss", parse: parseRSS },
  { id: "fallback", parse: parseFallback },
].map((adapter) => Object.freeze(adapter)));

function createSourceAdapters({
  feedAdapters = DEFAULT_FEED_ADAPTERS,
  parseDiscordSource = parseDiscord,
  getDiscordHttpClient,
} = {}) {
  if (typeof getDiscordHttpClient !== "function") {
    throw new TypeError("Discord source requires a managed HTTP client provider");
  }
  if (!Array.isArray(feedAdapters) || typeof parseDiscordSource !== "function") {
    throw new TypeError("Source adapters require an array and a Discord parser function");
  }

  const ids = new Set();
  const feed = Object.freeze(feedAdapters.map((adapter) => {
    if (!adapter || typeof adapter.id !== "string" || !adapter.id ||
        typeof adapter.parse !== "function" || ids.has(adapter.id)) {
      throw new TypeError("Invalid or duplicate feed source adapter");
    }
    ids.add(adapter.id);
    return Object.freeze({ id: adapter.id, kind: "feed", parse: adapter.parse });
  }));

  return Object.freeze({
    feed,
    // Built-in parsers remain the same functions in the same order, so the
    // existing pipeline behavior and recorded parserName stay unchanged.
    feedParsers: Object.freeze(feed.map((adapter) => adapter.parse)),
    discord: Object.freeze({
      id: "discord",
      kind: "discord",
      read(config) {
        return parseDiscordSource(config, getDiscordHttpClient());
      },
    }),
  });
}

module.exports = { DEFAULT_FEED_ADAPTERS, createSourceAdapters };
