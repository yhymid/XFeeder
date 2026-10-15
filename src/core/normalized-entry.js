"use strict";

const { getCacheKey } = require("./normalize");

// Internal domain envelope. It is deliberately NOT a new cache or parser
// schema: legacy cache keys and original provider payloads must survive 3.0.
function normalizeEntry(entry, { sourceType = "feed" } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("NormalizedEntry requires an entry object");
  }
  if (sourceType !== "feed" && sourceType !== "discord") {
    throw new TypeError("Unsupported NormalizedEntry source type");
  }

  // Keep the established link > guid > stable-content-hash precedence.
  // Discord historically falls back to the raw guid if no key is available.
  const identity = getCacheKey(entry) ||
    (sourceType === "discord" ? entry.guid || "" : "");

  return Object.freeze({
    sourceType,
    identity,
    title: entry.title ?? null,
    link: entry.link ?? null,
    guid: entry.guid ?? null,
    contentSnippet: entry.contentSnippet ?? null,
    isoDate: entry.isoDate ?? null,
    author: entry.author ?? null,
    enclosure: entry.enclosure ?? null,
    categories: entry.categories ?? [],
    // Intentionally pass the untouched source object to delivery adapters.
    // Discord-only metadata, attachments and other feed extensions remain valid.
    raw: entry,
  });
}

function normalizeEntries(entries, options = {}) {
  return entries.map((entry) => normalizeEntry(entry, options));
}

module.exports = { normalizeEntry, normalizeEntries };
