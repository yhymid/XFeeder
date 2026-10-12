"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { download } = require("../src/parsers/downloader");
const { getScrapling } = require("../src/extensions/Scrapling");
const { getNetwork, resetNetwork } = require("../src/network/service");
const { offline, serve, deferred, mockScraplingDetector } = require("./fixtures/network.cjs");
const { rss } = require("./fixtures/feeds.cjs");

// Response fixtures stay on loopback. Only the optional browser/process boundary
// is replaced; downloader, fallback policy and the shared HTTP client are real.
const challenge = fs.readFileSync(path.join(__dirname, "fixtures/challenge-pages/just-moment.html"), "utf8");
const bounded = { timeout: 10000 };
const config = (scrapling = {}) => ({
  Proxy: { Enabled: false },
  Scrapling: { Enabled: true, AntiBot: { MaxAttempts: 1 }, ...scrapling },
});
const recovered = {
  html: rss,
  status: 200,
  headers: { "content-type": "application/rss+xml", etag: '"browser-v1"' },
  fetchMode: "stealthy-fetch",
  runtime: "session",
  requestedRuntime: "cli",
  resolvedRuntime: "session",
  runtimeAutoSwitched: true,
  elapsed: 12,
};

beforeEach((t) => {
  offline(t);
  mockScraplingDetector(t, true);
  resetNetwork();
});
afterEach(() => resetNetwork());

test("fetch: returned validators produce a conditional request and bodyless 304", bounded, async (t) => {
  const validators = { ETag: '"feed-v1"', "Last-Modified": "Thu, 01 Jan 2026 00:00:00 GMT" };
  const server = await serve(t, (req, res) => {
    if (req.headers["if-none-match"] === validators.ETag && req.headers["if-modified-since"] === validators["Last-Modified"]) {
      res.writeHead(304, validators);
      res.end();
    } else {
      res.writeHead(200, { ...validators, "Content-Type": "application/rss+xml" });
      res.end(rss);
    }
  });
  const rootConfig = config();
  const fallback = t.mock.method(getScrapling(rootConfig), "fetch", async () => recovered);
  const first = await download(server.url, { config: rootConfig, accept: "rss" });
  assert.equal(first.ok, true);
  assert.equal(first.status, 200);
  assert.equal(first.data, rss);
  assert.equal(first.contentType, "application/rss+xml");
  const second = await download(server.url, {
    config: rootConfig,
    accept: "rss",
    etag: first.headers.etag,
    lastModified: first.headers["last-modified"],
  });
  assert.equal(second.ok, true);
  assert.equal(second.status, 304);
  assert.equal(second.notModified, true);
  assert.equal(second.data, "");
  assert.equal(second.headers.etag, validators.ETag);
  assert.equal(second.headers["last-modified"], validators["Last-Modified"]);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].headers["if-none-match"], undefined);
  assert.equal(server.requests[0].headers["if-modified-since"], undefined);
  assert.equal(server.requests[1].headers["if-none-match"], validators.ETag);
  assert.equal(server.requests[1].headers["if-modified-since"], validators["Last-Modified"]);
  assert.match(server.requests[1].headers.accept, /application\/rss\+xml/);
  assert.equal(fallback.mock.callCount(), 0);
});

for (const [label, policy] of [
  ["global Enabled false", () => ({ Enabled: false })],
  ["AutoFallback false", () => ({ AutoFallback: false })],
  ["per-URL enabled false", (url) => ({ PerUrlConfig: { [url]: { enabled: false } } })],
]) {
  test(`fallback decision: 403 preserves HTTP failure when ${label}`, bounded, async (t) => {
    const server = await serve(t, (_req, res) => {
      res.writeHead(403, { "Content-Type": "text/html", "X-Fixture": "denied" });
      res.end(challenge);
    });
    const rootConfig = config(policy(server.url));
    const fallback = t.mock.method(getScrapling(rootConfig), "fetch", async () => recovered);
    const result = await download(server.url, { config: rootConfig });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.reason, "HTTP_ERROR");
    assert.equal(result.data, challenge);
    assert.equal(result.headers["x-fixture"], "denied");
    assert.equal(result.error.response.status, 403);
    assert.equal(server.requests.length, 1);
    assert.equal(fallback.mock.callCount(), 0);
  });
}

test("fallback decision: allowed 403 recovery preserves Scrapling mode and runtime metadata", bounded, async (t) => {
  const server = await serve(t, (_req, res) => {
    res.writeHead(403, { "Content-Type": "text/html" });
    res.end(challenge);
  });
  const rootConfig = config();
  const controller = new AbortController();
  const fallback = t.mock.method(getScrapling(rootConfig), "fetch", async (url, options) => {
    assert.equal(url, server.url);
    assert.equal(options.includeResponseMetadata, true);
    assert.equal(options.mode, "stealthy-fetch");
    assert.equal(options.signal, controller.signal);
    return recovered;
  });
  const result = await download(server.url, { config: rootConfig, signal: controller.signal });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.data, rss);
  assert.equal(result.headers.etag, '"browser-v1"');
  assert.equal(result.scrapling, true);
  assert.equal(result.scraplingMode, "stealthy-fetch");
  assert.equal(result.scraplingRuntime, "session");
  assert.equal(result.scraplingRuntimeRequested, "cli");
  assert.equal(result.scraplingRuntimeResolved, "session");
  assert.equal(result.scraplingRuntimeAutoSwitched, true);
  assert.equal(result.elapsed, 12);
  assert.equal(result.antiBotSignals.blocked, false);
  assert.equal(server.requests.length, 1);
  assert.equal(fallback.mock.callCount(), 1);
});

test("fallback decision: a browser returning another challenge cannot recover HTTP 403", bounded, async (t) => {
  const server = await serve(t, (_req, res) => {
    res.writeHead(403, { "Content-Type": "text/html" });
    res.end(challenge);
  });
  const rootConfig = config();
  const fallback = t.mock.method(getScrapling(rootConfig), "fetch", async () => ({
    ...recovered,
    html: challenge,
    headers: { "content-type": "text/html" },
  }));
  const result = await download(server.url, { config: rootConfig });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.reason, "ANTIBOT_CHALLENGE_UNRESOLVED");
  assert.equal(result.scraplingReason, "SCRAPLING_BLOCKED");
  assert.equal(result.antiBotSignals.blocked, true);
  assert.equal(server.requests.length, 1);
  assert.equal(fallback.mock.callCount(), 1, "AntiBot.MaxAttempts bounds fallback attempts");
});

test("fallback decision: exact per-URL opt-in forces Scrapling even with AutoFallback disabled", bounded, async (t) => {
  const server = await serve(t, (_req, res) => res.end(rss));
  const selected = `${server.url}/selected`;
  const rootConfig = config({ AutoFallback: false, PerUrlConfig: { [selected]: { enabled: true } } });
  const fallback = t.mock.method(getScrapling(rootConfig), "fetch", async () => recovered);
  const forced = await download(selected, { config: rootConfig });
  assert.equal(forced.ok, true);
  assert.equal(forced.scrapling, true);
  assert.equal(server.requests.length, 0);
  assert.equal(fallback.mock.callCount(), 1);
  assert.equal(fallback.mock.calls[0].arguments[0], selected);
  const ordinary = await download(`${selected}?variant=other`, { config: rootConfig });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.data, rss);
  assert.equal(ordinary.scrapling, undefined);
  assert.equal(server.requests.length, 1);
  assert.equal(fallback.mock.callCount(), 1);
});

test("fetch: logical request deadline returns HTTP_ERROR without retry or browser fallback", bounded, async (t) => {
  // This response fixture accepts a connection but never sends headers or a body.
  const server = await serve(t, () => {});
  const rootConfig = config();
  const fallback = t.mock.method(getScrapling(rootConfig), "fetch", async () => recovered);
  const result = await download(server.url, { config: rootConfig, deadlineMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "HTTP_ERROR");
  assert.equal(result.status, undefined);
  assert.equal(result.data, undefined);
  assert.equal(result.error.code, "ECONNABORTED");
  assert.equal(result.error.phase, "deadline");
  assert.equal(server.requests.length, 1);
  assert.equal(fallback.mock.callCount(), 0);
  assert.equal(getNetwork().snapshot().operations, 0);
  assert.equal(getNetwork().snapshot().http.active, 0);
});

test("fetch: caller cancellation rejects instead of returning a failed feed or starting fallback", bounded, async (t) => {
  const requested = deferred();
  const server = await serve(t, () => requested.resolve());
  const rootConfig = config();
  const fallback = t.mock.method(getScrapling(rootConfig), "fetch", async () => recovered);
  const controller = new AbortController();
  const pending = download(server.url, { config: rootConfig, signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "ERR_CANCELED" });
  await requested.promise;
  controller.abort();
  await rejected;
  assert.equal(server.requests.length, 1);
  assert.equal(fallback.mock.callCount(), 0);
  assert.equal(getNetwork().snapshot().operations, 0);
  assert.equal(getNetwork().snapshot().http.active, 0);
});
