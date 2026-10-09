"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isBlockedPage } = require("../src/core/blocked-page");
const { download } = require("../src/parsers/downloader");
const { parseFallback } = require("../src/parsers/fallback");
const { htmlToFeedItems, getScrapling } = require("../src/extensions/Scrapling");
const { createFeedPipeline } = require("../src/core/feed-pipeline");
const { createCacheStore } = require("../src/core/cache-store");
const { createChannelRunner } = require("../src/app/channel-runner");
const { resetNetwork } = require("../src/network/service");
const { offline, serve, mockScraplingDetector } = require("./fixtures/network.cjs");
const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures/challenge-pages", `${name}.html`), "utf8");
beforeEach(t => { offline(t); mockScraplingDetector(t, true); resetNetwork(); });
for (const name of ["one-moment", "just-moment", "checking", "error"]) {
  test(`${name}: both HTML entry parsers reject the interstitial`, async () => {
    const html = fixture(name);
    assert.equal(isBlockedPage(html), true);
    assert.deepEqual(htmlToFeedItems(html), []);
    assert.deepEqual(await parseFallback("https://example.test/", { get: async () => ({status: 200, data: html}) }), []);
  });
  test(`${name}: real download never enters parsing/delivery or mutates persisted state`, async t => {
    const server = await serve(t, (_req, res) => res.end(fixture(name)));
    const config = { Proxy: { Enabled: false }, Scrapling: { Enabled: false } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfeeder-challenge-"));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const file = path.join(dir, "cache.json");
    const cache = createCacheStore(file);
    cache.replaceState({ "test-channel": { preserved: ["already-delivered"] } });
    cache.setFeedSnapshot(server.url, { etag: "old" }, [{title: "Pending old entry", guid: "old-entry"}]);
    const beforeFile = fs.readFileSync(file, "utf8"), beforeState = JSON.stringify(cache.getState());
    let parsed = 0, deliveries = 0;
    const pipeline = createFeedPipeline({config, download,
      getFeedItems: cache.getFeedItems, getFeedValidator: cache.getFeedValidator,
      setFeedSnapshot: cache.setFeedSnapshot,
      builtInParsers: [async () => { parsed++; return [{title: "bad",guid: "bad"}]; }],
    });
    const runner = createChannelRunner({cacheStore: cache, fetchFeed: pipeline.fetchFeed,
      sendMessage: async () => { deliveries++; }, parseDiscord: async () => [],
    });
    await runner.checkFeedsForChannel(0, {cacheKey: "test-channel", RSS: [server.url], Webhook: "fixture"});
    await runner.checkFeedsForChannel(1, {cacheKey: "untouched-new-channel", RSS: [server.url], Webhook: "fixture"});
    assert.equal(parsed, 0);
    assert.equal(deliveries, 0);
    assert.equal(JSON.stringify(cache.getState()), beforeState);
    assert.equal(fs.readFileSync(file, "utf8"), beforeFile);
  });
}
test("legitimate article and RSS/Atom/JSON mentioning challenges remain valid", async () => {
  const article = fixture("article");
  assert.equal(isBlockedPage(article, {headers: {server: "cloudflare", "cf-ray": "fixture"}}), false);
  assert.equal(htmlToFeedItems(article).length, 1);
  assert.equal((await parseFallback("https://example.test/", {get: async () => ({status: 200, data: article})})).length, 1);
  for (const source of ['<rss><channel><title>Just a moment...</title></channel></rss>', '<?xml version="1.0"?><feed><title>Checking your browser...</title></feed>', '{"title":"One moment, please..."}']) assert.equal(isBlockedPage(source), false);
  assert.equal(isBlockedPage(article, {status: 503}), true);
  assert.equal(isBlockedPage(article, {headers: {"CF-Mitigated": "challenge"}}), true);
});
for (const policy of [
  {Enabled:false}, {Enabled:true, AutoFallback:false},
  {Enabled:true, AntiBot:{Enabled:false}}, {Enabled:true, perUrlDisabled:true},
]) test(`challenge rejection respects Scrapling policy ${JSON.stringify(policy)}`, async t => {
  const server = await serve(t, (_req,res) => res.end(fixture("one-moment")));
  const config = {Proxy:{Enabled:false}, Scrapling:{...policy}};
  if (policy.perUrlDisabled) config.Scrapling.PerUrlConfig = {[server.url]:{enabled:false}};
  let calls=0;
  t.mock.method(getScrapling(config), "fetch", async () => {calls++; return {html:fixture("article"),status:200};});
  const result = await download(server.url,{config});
  assert.equal(result.ok,false); assert.equal(calls,0);
});
test("enabled fallback can solve a challenge but cannot emit a second challenge as an entry", async t => {
  const server=await serve(t,(_req,res)=>res.end(fixture("one-moment")));
  const config={Proxy:{Enabled:false},Scrapling:{Enabled:true,AutoFallback:true,AntiBot:{MaxAttempts:1}}};
  const scrapling=getScrapling(config); let calls=0;
  t.mock.method(scrapling,"fetch",async()=>{calls++;return {html:'<html><head><title>Actual article</title></head><body><article><h1>Actual article</h1></article></body></html>',status:200};});
  assert.equal((await download(server.url,{config})).ok,true);
  t.mock.method(scrapling,"fetch",async()=>{calls++;return {html:fixture("checking"),status:200};});
  const failed=await download(server.url,{config});
  assert.equal(failed.ok,false); assert.equal(failed.reason,"ANTIBOT_CHALLENGE_UNRESOLVED");assert.equal(calls,2);
});

test("titleless challenges and HTTP error responses cannot replay cached pending entries", async () => {
  for (const body of ["One moment, please...", "<html><body>Checking your browser...</body></html>"]) {
    assert.equal(isBlockedPage(body), true);
    assert.deepEqual(htmlToFeedItems(body), []);
  }
  let snapshots = 0;
  const pipeline = createFeedPipeline({
    config: {Scrapling:{Enabled:false}},
    download: async () => ({ok:false,status:503,data:"<html><title>Unexpected server response</title></html>",reason:"HTTP_ERROR"}),
    getFeedItems: () => [{title:"Pending cached item",guid:"pending"}],
    setFeedSnapshot: () => {snapshots++;},
  });
  assert.deepEqual(await pipeline.fetchFeed("https://example.test/feed"), []);
  assert.equal(snapshots, 0);
});
