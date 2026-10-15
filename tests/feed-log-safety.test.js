"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFeedPipeline } = require("../src/core/feed-pipeline");

test("X3-12: parser exception with credentials cannot escape into operator logs", async t => {
  const secret = "synthetic-feed-parser-secret";
  const logged = [];
  t.mock.method(console, "warn", (...parts) => logged.push(parts.join(" ")));
  t.mock.method(console, "log", () => {});
  const item = { title: "safe entry", link: "https://example.invalid/entry" };
  const pipeline = createFeedPipeline({
    download: async () => ({ ok: true, status: 200, data: "fixture data" }),
    builtInParsers: [
      async () => { throw new Error("Bearer " + secret); },
      async () => [item],
    ],
  });
  const entries = await pipeline.fetchFeed("https://feeds.example.invalid/feed");
  assert.deepEqual(entries, [item], "a failed parser must not block later parsers");
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes(secret), "secret cannot be logged");
  assert.match(logged[0], /\[REDACTED\]/);
});

test("X3-12: download error and URL query secrets are sanitized while snapshot replay stays intact", async t => {
  const secret = "synthetic-feed-download-secret";
  const logs = [];
  t.mock.method(console, "warn", (...parts) => logs.push(parts.join(" ")));
  const saved = [{ title: "pending", link: "https://example.invalid/pending" }];
  const failure = Object.assign(new Error("Bearer " + secret), { code: "ECONNRESET" });
  const pipeline = createFeedPipeline({
    download: async () => ({ ok: false, reason: "HTTP_ERROR", error: failure }),
    getFeedItems: () => saved,
    builtInParsers: [async () => assert.fail("parsing must not run on failed fetch")],
  });
  const results = await pipeline.fetchFeed("https://feeds.example.invalid/feed?token=" + secret);
  assert.deepEqual(results, saved);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes(secret));
  assert.match(logs[0], /"category":"network"/);
});
