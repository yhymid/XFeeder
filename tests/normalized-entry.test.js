"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getCacheKey, normalizeLink } = require("../src/core/normalize");
const { normalizeEntry, normalizeEntries } = require("../src/core/normalized-entry");

const base = "https://example.invalid/article";

test("X3-14: link-first identity is byte-for-byte compatible with delivery cache", () => {
  const variants = [
    { link: base + "?utm_source=news#comments", guid: "stable-guid", title: "Original" },
    { link: base, guid: "different-guid", title: "Edited title" },
    { link: "", guid: "opaque-guid", title: "Fallback" },
    { guid: "https://example.invalid/opaque?utm_medium=feed#part", title: "GUID link" },
    { title: "No link", contentSnippet: "Fallback hash", author: "News", isoDate: "2026-01-01" },
    { title: "  " },
    {},
  ];
  for (const raw of variants) {
    const normalized = normalizeEntry(raw);
    assert.equal(normalized.identity, getCacheKey(raw));
    assert.equal(normalized.raw, raw);
    assert.equal(normalized.link, raw.link ?? null);
    assert.equal(normalized.guid, raw.guid ?? null);
  }
  assert.equal(normalizeEntry(variants[0]).identity, base);
  assert.equal(normalizeEntry(variants[1]).identity, base);
  assert.equal(normalizeEntry(variants[2]).identity, "opaque-guid");
  assert.equal(normalizeEntry(variants[4]).identity.startsWith("hash:"), true);
  assert.equal(normalizeEntry(variants[5]).identity, "");
  assert.equal(normalizeLink(variants[0].link), base);
});

test("X3-14: source metadata and actual delivery object remain untouched", () => {
  const raw = {
    title: "Discord message", link: "https://discord.com/channels/g/c/m", guid: "m",
    contentSnippet: "message", author: "Test author", isoDate: "2026-10-15T01:00:00Z",
    enclosure: "https://cdn.example.invalid/image.png", categories: ["discord"],
    attachments: ["https://cdn.example.invalid/file.png"],
    referenced: { author: "Original", content: "Reply" },
    discordData: { guildId: "g", channelId: "c", messageId: "m" },
    extension: { kind: "new", value: 3 },
  };
  const before = structuredClone(raw);
  const record = normalizeEntry(raw, { sourceType: "discord" });
  assert.ok(Object.isFrozen(record), "internal descriptor must be stable");
  assert.equal(record.sourceType, "discord");
  assert.equal(record.raw, raw);
  for (const field of ["title", "link", "guid", "contentSnippet", "author", "isoDate", "enclosure", "categories"])
    assert.deepEqual(record[field], raw[field], field);
  assert.deepEqual(raw, before);
  assert.equal(Object.hasOwn(raw, "identity"), false, "do not mutate source or cache/snapshot shape");
});

test("X3-14: duplicate normalized entries retain ordering and source identity", () => {
  const first = { title: "One", link: base + "?utm_campaign=social" };
  const same = { title: "Same identity", link: base, guid: "second-guid" };
  const second = { title: "Second", link: base + "/two" };
  const list = [first, same, second];
  const before = [...list];
  const normalized = normalizeEntries(list);
  assert.deepEqual(list, before);
  assert.equal(normalized.length, list.length);
  assert.deepEqual(normalized.map(x => x.identity), [base, base, base + "/two"]);
  assert.deepEqual(normalized.map(x => x.raw), list);
  assert.notEqual(normalized[0], normalized[1], "do not collapse entries at parser boundary");
});

test("X3-14: no identity means pending delivery remains pending (not silently dropped)", () => {
  const raw = { title: " ", contentSnippet: "" };
  assert.equal(normalizeEntry(raw, { sourceType: "feed" }).identity, "");
  assert.equal(normalizeEntry(raw, { sourceType: "discord" }).identity, "");
});

test("X3-14: invalid envelopes are rejected, not converted into synthetic entries", () => {
  for (const entry of [undefined, null, "", 123, []])
    assert.throws(() => normalizeEntry(entry), { name: "TypeError" });
  assert.throws(() => normalizeEntry({}, { sourceType: "unknown" }), /Unsupported NormalizedEntry source type/);
});
