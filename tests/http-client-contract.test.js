"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { createManagedClient, postManaged } = require("../src/network/http-client");
const { networkAdapter } = require("../src/network/http-adapter");
const { getNetwork, resetNetwork } = require("../src/network/service");
const { runContext } = require("../src/network/context");
const { offline, serve, readBody } = require("./fixtures/network.cjs");

const bounded = { timeout: 10000 };

beforeEach(t => {
  offline(t);
  resetNetwork();
  t.after(() => resetNetwork());
});

test("X3-17: all managed Axios clients retain network admission, headers and request semantics", bounded, async t => {
  const server = await serve(t, async (req, res) => {
    const body = await readBody(req);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      method: req.method,
      customHeader: req.headers["x-custom"],
      body: body.toString("utf8"),
    }));
  });
  const defaults = { proxy: false, timeout: 1234, headers: { "X-Custom": "fixture" } };
  const client = createManagedClient(defaults);
  assert.equal(client.defaults.adapter, networkAdapter);
  assert.equal(client.defaults.timeout, 1234);
  assert.equal(defaults.adapter, undefined, "do not mutate caller defaults");
  const result = await client.get(server.url);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { method: "GET", customHeader: "fixture", body: "" });

  const post = await postManaged(server.url, { title: "Żółw" }, { proxy: false, headers: { "X-Custom": "post" } });
  assert.equal(post.status, 200);
  assert.equal(post.data.method, "POST");
  assert.equal(post.data.customHeader, "post");
  assert.deepEqual(JSON.parse(post.data.body), { title: "Żółw" });
  assert.deepEqual(server.requests.map(req => req.method), ["GET", "POST"]);
  assert.equal(getNetwork().snapshot().http.active, 0);
  assert.equal(getNetwork().snapshot().operations, 0);
});

test("X3-17: static managed POST still delegates through Axios with the original options", async t => {
  const originalContextSignal = new AbortController().signal;
  const explicitSignal = new AbortController().signal;
  const options = {
    proxy: false,
    timeout: 4800,
    xfeederDefaultTimeout: 4800,
    signal: explicitSignal,
    headers: { Authorization: "Bearer synthetic-credential" },
    adapter: () => assert.fail("Unmanaged adapter must not be used"),
  };
  const originalHeaders = options.headers;
  const calls = [];
  t.mock.method(axios, "post", async (...args) => {
    calls.push(args);
    return { status: 204, data: null };
  });
  const payload = { hello: "provider" };
  const result = await runContext({ signal: originalContextSignal },
    () => postManaged("https://example.invalid/provider", payload, options));
  assert.equal(result.status, 204);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://example.invalid/provider");
  assert.equal(calls[0][1], payload);
  assert.equal(calls[0][2].adapter, networkAdapter, "managed transport cannot be bypassed");
  assert.equal(calls[0][2].signal, explicitSignal, "explicit signal takes precedence");
  assert.equal(calls[0][2].timeout, 4800);
  assert.equal(calls[0][2].headers, originalHeaders);
  assert.equal(options.adapter === networkAdapter, false, "do not mutate original request config");
});

test("X3-17: channel-local AbortSignal is inherited by managed POST when not supplied", async t => {
  const signal = new AbortController().signal;
  t.mock.method(axios, "post", async (_url, _data, options) => {
    assert.equal(options.signal, signal);
    assert.equal(options.adapter, networkAdapter);
    return { status: 204 };
  });
  await runContext({ signal }, () => postManaged("https://example.invalid/send", { ok: 1 }));
});

test("X3-17: provider POST never auto-retries ambiguous 503 responses", bounded, async t => {
  const server = await serve(t, (_req, res) => {
    res.writeHead(503, { "Retry-After": "5" });
    res.end("fixture unavailable");
  });
  await assert.rejects(
    postManaged(server.url, { hello: "fixture" }, { proxy: false }),
    error => error.response.status === 503 && error.response.headers["retry-after"] === "5",
  );
  assert.equal(server.requests.length, 1, "an uncertain POST success must not be replayed");
  assert.equal(getNetwork().snapshot().operations, 0);
});

test("X3-17: aborted inherited context prevents managed POST from reaching the server", bounded, async t => {
  const server = await serve(t, (_req, res) => res.end("unexpected"));
  const signal = AbortSignal.abort();
  await assert.rejects(
    runContext({ signal }, () => postManaged(server.url, { forbidden: true }, { proxy: false })),
    error => error.code === "ERR_CANCELED" || error.name === "CanceledError",
  );
  assert.equal(server.requests.length, 0);
  assert.equal(getNetwork().snapshot().operations, 0);
});
