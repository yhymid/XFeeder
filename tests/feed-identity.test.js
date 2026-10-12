"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { getCacheKey, normalizeLink, pushCache } = require("../src/core/normalize");
const { parseXML } = require("../src/parsers/xml");

const baseUrl = "https://feeds.example.invalid/";

test("link normalization removes tracking parameters and fragments while preserving content identifiers", () => {
  const original = `${baseUrl}article?id=42&utm_source=feed&utm_medium=rss&utm_custom=value&UTM_Campaign=launch&fbclid=click&gclid=click&yclid=click&mc_cid=mail&mc_eid=reader&ref=feed&lang=pl#comments`;
  const normalized = `${baseUrl}article?id=42&lang=pl`;
  assert.equal(normalizeLink(original), normalized);
  assert.equal(normalizeLink(normalized), normalized);
  assert.equal(normalizeLink(`${baseUrl}article?tag=one&tag=two`), `${baseUrl}article?tag=one&tag=two`);
});

test("normalization preserves opaque GUIDs and unsupported relative links", () => {
  for (const value of ["opaque-entry-id", "/relative/article", "", null, undefined]) {
    assert.equal(normalizeLink(value), value);
  }
  assert.equal(getCacheKey({ guid: "opaque-entry-id" }), "opaque-entry-id");
  assert.equal(getCacheKey({ guid: `${baseUrl}guid?utm_source=feed#section` }), `${baseUrl}guid`);
});

test("entry identity prefers a normalized link over GUID and does not change with title edits", () => {
  const item = { title: "Original title", link: `${baseUrl}article?utm_source=feed`, guid: "original-guid" };
  assert.equal(getCacheKey(item), `${baseUrl}article`);
  assert.equal(getCacheKey({ ...item, title: "Updated title", guid: "new-guid" }), getCacheKey(item));
  assert.notEqual(getCacheKey({ ...item, link: `${baseUrl}another-article` }), getCacheKey(item));
});

test("duplicate fixture remains intact while equal links and equal GUIDs follow current identity rules", async () => {
  const data = fs.readFileSync(path.join(__dirname, "fixtures/feed-pipeline/duplicates.xml"), "utf8");
  const entries = await parseXML(`${baseUrl}duplicates.xml`, { async get() { return { data }; } });
  assert.deepEqual(entries.map((entry) => entry.title), ["Original", "Same GUID", "Same link"]);
  assert.equal(entries[0].guid, entries[1].guid);
  assert.notEqual(entries[0].guid, entries[2].guid);
  const keys = entries.map(getCacheKey);
  assert.deepEqual(keys, [
    `${baseUrl}duplicate/one`, `${baseUrl}duplicate/two`, `${baseUrl}duplicate/one`,
  ]);
  // Parsing is lossless here; cache identity alone is not a per-batch deduplicator.
  assert.equal(entries.length, 3);
  assert.equal(new Set(keys).size, 2);
});

test("entries without link or GUID use stable content identity and empty entries have no cache key", () => {
  const entry = {
    title: "Unlinked article", isoDate: "2026-01-01T10:30:00.000Z",
    author: "Fixture author", contentSnippet: "Article body.",
  };
  const key = getCacheKey(entry);
  assert.match(key, /^hash:[a-f0-9]{20}$/);
  assert.equal(getCacheKey({ ...entry }), key);
  assert.notEqual(getCacheKey({ ...entry, contentSnippet: "Updated body." }), key);
  assert.equal(getCacheKey({ ...entry, enclosure: `${baseUrl}image.png`, categories: ["news"] }), key);
  assert.equal(getCacheKey({}), "");
  assert.equal(getCacheKey({ title: "  ", contentSnippet: "" }), "");
});

test("cache list prepends and caps identifiers without mutating inputs or deduplicating them", () => {
  const previous = ["old-one", "duplicate", "old-two"];
  const current = ["new-one", "duplicate"];
  assert.deepEqual(pushCache(previous, current, 4), ["new-one", "duplicate", "old-one", "duplicate"]);
  assert.deepEqual(previous, ["old-one", "duplicate", "old-two"]);
  assert.deepEqual(current, ["new-one", "duplicate"]);
  assert.deepEqual(pushCache(null, current), current);
});
