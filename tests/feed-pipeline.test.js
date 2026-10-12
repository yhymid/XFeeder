"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createFeedPipeline } = require("../src/core/feed-pipeline");
const { createCacheStore } = require("../src/core/cache-store");
const { runContext } = require("../src/network/context");
const { tempDir } = require("./helpers/temp-dir.cjs");
const { parseYouTube } = require("../src/parsers/youtube");
const { parseAtom } = require("../src/parsers/atom");
const { parseXML } = require("../src/parsers/xml");
const { parseJSON } = require("../src/parsers/json");
const { parseApiX } = require("../src/parsers/api_x");
const { parseRSS } = require("../src/parsers/rss");
const { parseFallback } = require("../src/parsers/fallback");

const source = "https://feeds.example.invalid/feed";
// The current bootstrap order, recorded explicitly before source adapters.
const parsers = [parseYouTube, parseAtom, parseXML, parseJSON, parseApiX, parseRSS, parseFallback];
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures/feed-pipeline", name), "utf8");
const entry = { title: "Pending fixture", link: `${source}/entry`, guid: "pending-fixture" };

beforeEach((t) => {
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, () => {});
});

function recordedParsers(attempts) {
  return parsers.map((parse) => async (url, client) => {
    attempts.push(parse.name);
    return parse(url, client);
  });
}

for (const [file, winner, title, guid] of [
  ["rss.xml", "parseXML", "First RSS article", "rss-first"],
  ["atom.xml", "parseAtom", "First Atom article", "urn:fixture:atom:first"],
  ["json-feed.json", "parseJSON", "First JSON article", "json-first"],
  ["youtube.xml", "parseYouTube", "First fixture video", "yt:video:fixture-one"],
]) {
  test(`pipeline dispatch: ${file} selects ${winner} and reuses the initial response`, async () => {
    // This URL only selects the adapter; the injected download supplies all bytes.
    const feedUrl = file === "youtube.xml"
      ? "https://www.youtube.com/feeds/videos.xml?channel_id=fixture-channel" : source;
    const raw = fixture(file);
    const data = file.endsWith(".json") ? JSON.parse(raw) : raw;
    const attempts = [], snapshots = [];
    let downloads = 0, extraGets = 0;
    const pipeline = createFeedPipeline({
      download: async () => { downloads++; return { ok: true, status: 200, data, headers: { ETag: '"fixture-v1"' } }; },
      getWithFallback: async () => { extraGets++; return { status: 200, data }; },
      builtInParsers: recordedParsers(attempts),
      setFeedSnapshot: (...args) => snapshots.push(args),
    });
    const items = await pipeline.fetchFeed(feedUrl);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, title);
    assert.equal(items[0].guid, guid);
    assert.deepEqual(attempts, parsers.slice(0, parsers.findIndex((parse) => parse.name === winner) + 1).map((parse) => parse.name));
    assert.equal(downloads, 1);
    assert.equal(extraGets, 0);
    assert.deepEqual(snapshots, [[feedUrl, { etag: '"fixture-v1"', lastModified: "" }, items]]);
  });
}

test("parser errors and no-match results fall through in order without downloading again", async () => {
  const stages = [], snapshots = [];
  let downloads = 0;
  const pipeline = createFeedPipeline({
    download: async () => { downloads++; return { ok: true, status: 200, data: "opaque fixture" }; },
    builtInParsers: [
      async () => { stages.push("throws"); throw new Error("fixture parser error"); },
      async () => { stages.push("empty"); return []; },
      async () => { stages.push("match"); return [entry]; },
      async () => { stages.push("unused"); return [entry]; },
    ],
    setFeedSnapshot: (...args) => snapshots.push(args),
  });
  assert.deepEqual(await pipeline.fetchFeed(source), [entry]);
  assert.deepEqual(stages, ["throws", "empty", "match"]);
  assert.equal(downloads, 1);
  assert.equal(snapshots.length, 1);
});

test("parser HTTP clients forward extra GET/POST with the current config and request signal", async () => {
  const configPath = "synthetic-config.json";
  const firstConfig = { Scrapling: { Enabled: false } };
  const nextConfig = { Scrapling: { Enabled: true } };
  let current = firstConfig;
  const inherited = new AbortController().signal;
  const explicit = new AbortController().signal;
  const downloads = [], requests = [];
  const pipeline = createFeedPipeline({
    configPath, getConfig: () => current,
    download: async (url, opts) => { downloads.push(opts); return { ok: true, status: 200, data: "fixture response" }; },
    getWithFallback: async (...args) => { requests.push(["get", ...args]); return { data: "secondary" }; },
    postWithFallback: async (...args) => { requests.push(["post", ...args]); return { data: "secondary" }; },
    builtInParsers: [async (url, client) => {
      assert.equal((await client.http.get(url)).data, "fixture response");
      await client.get(`${url}/other`, { timeout: 123, config: { unwanted: true } });
      await client.http.post(`${url}/query`, { query: "fixture" }, { headers: { "x-fixture": "yes" } });
      return [entry];
    }],
  });
  await runContext({ signal: inherited }, () => pipeline.fetchFeed(source));
  current = nextConfig;
  await runContext({ signal: inherited }, () => pipeline.fetchFeed(source, { signal: explicit }));
  for (const [index, config, signal] of [[0, firstConfig, inherited], [1, nextConfig, explicit]]) {
    assert.equal(downloads[index].config, config);
    assert.equal(downloads[index].signal, signal);
    assert.equal(downloads[index].configPath, configPath);
    const get = requests[index * 2], post = requests[index * 2 + 1];
    assert.deepEqual(get, ["get", `${source}/other`, { timeout: 123, config, configPath, signal }]);
    assert.deepEqual(post, ["post", `${source}/query`, { query: "fixture" }, {
      headers: { "x-fixture": "yes" }, config, configPath, signal,
    }]);
  }
  assert.equal(downloads.length, 2);
  assert.equal(requests.length, 4);
});

test("304 replays persisted pending entries without parsing or rewriting the snapshot", async (t) => {
  const file = path.join(tempDir(t), "cache.json");
  const cache = createCacheStore(file);
  const modified = "Thu, 01 Jan 2026 10:30:00 GMT";
  let requests = 0, parses = 0;
  const pipeline = createFeedPipeline({
    getFeedValidator: cache.getFeedValidator,
    getFeedItems: cache.getFeedItems,
    setFeedSnapshot: cache.setFeedSnapshot,
    download: async (url, opts) => {
      requests++;
      if (requests === 1) return { ok: true, status: 200, data: "fixture", headers: { eTaG: '"v1"', "LAST-MODIFIED": modified } };
      assert.equal(url, source);
      assert.equal(opts.etag, '"v1"');
      assert.equal(opts.lastModified, modified);
      return { ok: true, status: 304, notModified: true, data: "", headers: { ETag: '"ignored-v2"' } };
    },
    builtInParsers: [async () => { parses++; return [entry]; }],
  });
  assert.deepEqual(await pipeline.fetchFeed(source), [entry]);
  const diskBefore = fs.readFileSync(file, "utf8");
  assert.deepEqual(await pipeline.fetchFeed(source), [entry]);
  assert.equal(requests, 2);
  assert.equal(parses, 1);
  assert.equal(fs.readFileSync(file, "utf8"), diskBefore);
  assert.deepEqual(createCacheStore(file).getFeedItems(source), [entry]);
});

test("304 with no snapshot returns no entries and never enters parsing", async () => {
  let parses = 0, snapshots = 0;
  const pipeline = createFeedPipeline({
    download: async () => ({ ok: true, status: 304, notModified: true, data: "" }),
    builtInParsers: [async () => { parses++; return [entry]; }],
    setFeedSnapshot: () => { snapshots++; },
  });
  assert.deepEqual(await pipeline.fetchFeed(source), []);
  assert.equal(parses, 0);
  assert.equal(snapshots, 0);
});

test("a transport timeout can replay pending entries but cannot replace their validators", async () => {
  const error = Object.assign(new Error("fixture timeout"), { code: "ECONNABORTED" });
  const failures = [];
  let parses = 0, snapshots = 0;
  const pipeline = createFeedPipeline({
    download: async () => ({ ok: false, reason: "HTTP_ERROR", error }),
    getFeedItems: () => [entry],
    builtInParsers: [async () => { parses++; return []; }],
    setFeedSnapshot: () => { snapshots++; },
  });
  assert.deepEqual(await runContext({ onFailure: (failure) => failures.push(failure) }, () => pipeline.fetchFeed(source)), [entry]);
  assert.deepEqual(failures, [error]);
  assert.equal(parses, 0);
  assert.equal(snapshots, 0);
});

for (const reason of ["INVALID_URL", "UNSUPPORTED_PROTOCOL", "ANTIBOT_CHALLENGE_UNRESOLVED", "SCRAPLING_BLOCKED"]) {
  test(`${reason} never replays the previous feed snapshot`, async () => {
    let cachedReads = 0, parses = 0, snapshots = 0;
    const pipeline = createFeedPipeline({
      download: async () => ({ ok: false, reason }),
      getFeedItems: () => { cachedReads++; return [entry]; },
      builtInParsers: [async () => { parses++; return [entry]; }],
      setFeedSnapshot: () => { snapshots++; },
    });
    assert.deepEqual(await pipeline.fetchFeed(source), []);
    assert.deepEqual([cachedReads, parses, snapshots], [0, 0, 0]);
  });
}

test("cancellation before download or during parsing cannot persist a partial result", async () => {
  const controller = new AbortController();
  const error = Object.assign(new Error("fixture cancelled"), { name: "AbortError" });
  let downloads = 0, snapshots = 0;
  const pipeline = createFeedPipeline({
    download: async () => { downloads++; return { ok: true, data: "fixture" }; },
    builtInParsers: [async () => { controller.abort(error); return [entry]; }],
    setFeedSnapshot: () => { snapshots++; },
  });
  await assert.rejects(pipeline.fetchFeed(source, { signal: controller.signal }), (failure) => failure === error);
  assert.equal(downloads, 1);
  assert.equal(snapshots, 0);
  await assert.rejects(pipeline.fetchFeed(source, { signal: controller.signal }), (failure) => failure === error);
  assert.equal(downloads, 1);
});

test("the feed pipeline preserves duplicate entries; identity filtering is a separate stage", async () => {
  const snapshots = [];
  const pipeline = createFeedPipeline({
    download: async () => ({ ok: true, status: 200, data: fixture("duplicates.xml"), headers: { ETag: '"duplicates"' } }),
    builtInParsers: [parseXML], setFeedSnapshot: (...args) => snapshots.push(args),
  });
  const items = await pipeline.fetchFeed(source);
  assert.deepEqual(items.map(({ title, guid, link }) => [title, guid, link]), [
    ["Original", "shared-guid", "https://feeds.example.invalid/duplicate/one"],
    ["Same GUID", "shared-guid", "https://feeds.example.invalid/duplicate/two"],
    ["Same link", "different-guid", "https://feeds.example.invalid/duplicate/one"],
  ]);
  assert.deepEqual(snapshots[0][2], items);
});

test("ordinary HTML returned by a feed URL reaches the existing metadata fallback", async () => {
  const attempts = [];
  const pipeline = createFeedPipeline({
    download: async () => ({ ok: true, status: 200, data: fixture("html.html") }),
    builtInParsers: recordedParsers(attempts),
  });
  const items = await pipeline.fetchFeed(source);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Ordinary HTML page");
  assert.equal(items[0].link, source);
  assert.equal(items[0].contentSnippet, "This is HTML, not an RSS or Atom document.");
  assert.equal(attempts.at(-1), "parseFallback");
});

for (const [file, title] of [["empty.xml", "Empty fixture"], ["invalid.xml", "Malformed fixture"]]) {
  test(`legacy limitation: ${file} reaches permissive HTML fallback in the full chain`, async () => {
    const attempts = [];
    const pipeline = createFeedPipeline({
      download: async () => ({ ok: true, status: 200, data: fixture(file) }),
      builtInParsers: recordedParsers(attempts),
    });
    const items = await pipeline.fetchFeed(source);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, title);
    assert.equal(items[0].guid, source);
    assert.equal(attempts.at(-1), "parseFallback");
  });
}

test("without an HTML fallback, empty and invalid feeds yield no snapshot", async () => {
  for (const file of ["empty.xml", "invalid.xml"]) {
    let snapshots = 0;
    const pipeline = createFeedPipeline({
      download: async () => ({ ok: true, status: 200, data: fixture(file) }),
      builtInParsers: [parseAtom, parseXML, parseRSS],
      setFeedSnapshot: () => { snapshots++; },
    });
    assert.deepEqual(await pipeline.fetchFeed(source), []);
    assert.equal(snapshots, 0);
  }
});
