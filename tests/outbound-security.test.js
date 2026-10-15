"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns");
const {
  isPublicAddress, validatePublicUrl, publicLookup, applyPublicOnlyPolicy,
} = require("../src/network/outbound-policy");
const { getWithFallback } = require("../src/client");
const { postManaged } = require("../src/network/http-client");
const { getNetwork, resetNetwork } = require("../src/network/service");
const { normalizeNetworkConfig, requireNetworkConfig } = require("../src/network/config");
const { offline, serve, readBody } = require("./fixtures/network.cjs");

const bounded = { timeout: 10000 };
beforeEach(t => {
  offline(t);
  resetNetwork();
  t.after(() => resetNetwork());
});

test("X3-19: policy is explicit and validates optional response budgets", () => {
  const defaults = requireNetworkConfig();
  assert.equal(defaults.outboundPolicy, "unrestricted");
  assert.equal(defaults.maxResponseBytes, null);
  assert.equal(requireNetworkConfig({ outboundPolicy: "public-only", maxResponseBytes: 4096 }).maxResponseBytes, 4096);
  for (const input of [
    { outboundPolicy: true }, { outboundPolicy: "bad-policy" },
    { maxResponseBytes: 0 }, { maxResponseBytes: -1 },
    { maxResponseBytes: 1.5 }, { maxResponseBytes: "1024" },
    { maxResponseBytes: 268435457 },
  ]) assert.equal(normalizeNetworkConfig(input).ok, false, JSON.stringify(input));
});

test("X3-19: blocked IP literals include loopback, private, link local, metadata, special IPv6", () => {
  for (const address of [
    "127.0.0.1", "0.0.0.0", "10.0.1.2", "172.16.1.1",
    "172.31.255.254", "192.168.0.50", "100.64.1.1",
    "169.254.169.254", "192.0.2.8", "198.18.0.1",
    "198.51.100.3", "203.0.113.4", "224.0.0.1",
    "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1",
    "2001:db8::1", "2002:c0a8:0101::1",
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(address), true, address);
});

test("X3-19: URL parser blocks localhost aliases and alternate numeric encodings", () => {
  for (const url of [
    "http://127.0.0.1/feed", "http://2130706433/",
    "http://0x7f000001/", "http://0177.0.0.1/",
    "http://localhost/", "http://api.localhost./",
    "http://printer.local/", "http://metadata.internal/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/", "http://user:password@example.com/",
    "file:///etc/passwd", "ftp://example.org/", "not a url",
  ]) assert.throws(() => validatePublicUrl(url), { code: "OUTBOUND_TARGET_BLOCKED" }, url);
  assert.equal(validatePublicUrl("https://example.com/feed").hostname, "example.com");
});

test("X3-19: the socket resolver rejects mixed public/internal DNS answers (rebinding)", async t => {
  t.mock.method(dns, "lookup", (_hostname, _options, callback) => {
    callback(null, [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
  });
  await assert.rejects(new Promise((resolve, reject) => {
    publicLookup("feed.example.com", { family: 0 }, (error, ip) => error ? reject(error) : resolve(ip));
  }), { code: "OUTBOUND_TARGET_BLOCKED" });
});

test("X3-19: socket lookup returns validated address directly and never re-resolves", async t => {
  const lookups = t.mock.method(dns, "lookup", (_hostname, _options, callback) => {
    callback(null, [{ address: "1.1.1.1", family: 4 }]);
  });
  const result = await new Promise((resolve, reject) => {
    publicLookup("feed.example.com", { family: 4 }, (error, address, family) =>
      error ? reject(error) : resolve({ address, family }));
  });
  assert.deepEqual(result, { address: "1.1.1.1", family: 4 });
  assert.equal(lookups.mock.callCount(), 1);
});

test("X3-19: protected outbound mode rejects proxy/agent bypass and forbids redirects", () => {
  for (const overrides of [
    { proxy: { host: "proxy.example.com", port: 8080 } },
    { httpAgent: {} }, { httpsAgent: {} },
    { transport: { request() {} } }, { socketPath: "/tmp/network.sock" },
    { lookup() {} },
  ]) assert.throws(() =>
    applyPublicOnlyPolicy({ url: "https://feeds.example.com/rss", ...overrides }),
    { code: "OUTBOUND_TARGET_BLOCKED" });
  const safe = applyPublicOnlyPolicy({ url: "https://feeds.example.com/rss", maxRedirects: 10 });
  assert.equal(safe.maxRedirects, 0);
  assert.equal(safe.proxy, false);
  assert.equal(typeof safe.lookup, "function");
});

test("X3-19: public-only blocks loopback GET/POST before a socket can connect", bounded, async t => {
  const server = await serve(t, (_req, res) => res.end("unexpected"));
  const config = { Proxy: { Enabled: false }, network: { outboundPolicy: "public-only" } };
  await assert.rejects(
    getWithFallback(server.url, { config, proxy: false, maxAttempts: 1 }),
    { code: "OUTBOUND_TARGET_BLOCKED" },
  );
  getNetwork().configure({ outboundPolicy: "public-only" });
  await assert.rejects(
    postManaged(server.url, { secret: "synthetic" }, { proxy: false }),
    { code: "OUTBOUND_TARGET_BLOCKED" },
  );
  assert.equal(server.requests.length, 0);
  assert.equal(getNetwork().snapshot().operations, 0);
});

test("X3-19: configured buffered-response budget rejects oversized decoded content", bounded, async t => {
  const server = await serve(t, (_req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("A".repeat(2048));
  });
  const config = { Proxy: { Enabled: false }, network: { maxResponseBytes: 1024 } };
  await assert.rejects(
    getWithFallback(server.url, { config, proxy: false, maxAttempts: 1 }),
    error => error.code === "ERR_BAD_RESPONSE" || /maxContentLength/.test(error.message),
  );
  assert.equal(server.requests.length, 1);
  assert.equal(getNetwork().snapshot().operations, 0);
});

test("X3-19: streamed decoded responses enforce the same byte budget and release slots", bounded, async t => {
  const server = await serve(t, (_req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("B".repeat(2048));
  });
  const config = { Proxy: { Enabled: false }, network: { maxResponseBytes: 1024 } };
  const response = await getWithFallback(server.url, {
    config, proxy: false, responseType: "stream", maxAttempts: 1,
  });
  await assert.rejects(
    readBody(response.data),
  error => error.code === "ERR_RESPONSE_TOO_LARGE" ||
    (error.code === "ERR_BAD_RESPONSE" && /maxContentLength/.test(error.message)),
  );
  assert.equal(server.requests.length, 1);
  // finished() cleanup may resolve on the following stream close tick.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getNetwork().snapshot().operations, 0);
  assert.equal(getNetwork().snapshot().http.active, 0);
});

test("X3-19: explicit Axios maxContentLength also constrains responseType stream", bounded, async t => {
  const server = await serve(t, (_req, res) => res.end("C".repeat(1024)));
  const response = await getWithFallback(server.url, {
    config: { Proxy: { Enabled: false } }, proxy: false,
    responseType: "stream", maxContentLength: 256, maxAttempts: 1,
  });
  await assert.rejects(readBody(response.data),
    error => error.code === "ERR_RESPONSE_TOO_LARGE" ||
      (error.code === "ERR_BAD_RESPONSE" && /maxContentLength/.test(error.message)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getNetwork().snapshot().operations, 0);
});

test("X3-19: strict egress refuses forced Scrapling browser bypass", bounded, async t => {
  const { mockScraplingDetector } = require("./fixtures/network.cjs");
  const { getScrapling } = require("../src/extensions/Scrapling");
  const { download } = require("../src/parsers/downloader");
  mockScraplingDetector(t, true);
  const config = {
    Proxy: { Enabled: false },
    network: { outboundPolicy: "public-only" },
    Scrapling: { Enabled: true, ForceGlobal: true },
  };
  const scrapling = getScrapling(config);
  const fetch = t.mock.method(scrapling, "fetch", async () =>
    assert.fail("Strict public-only egress must not invoke the browser"));
  const result = await download("https://feeds.example.com/feed", { config });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SCRAPLING_DISALLOWED_BY_PUBLIC_ONLY");
  assert.equal(fetch.mock.callCount(), 0);
});
