"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { offline, serve, readBody, deferred } = require("./fixtures/network.cjs");
const { networkAdapter } = require("../src/network/http-adapter");
const { resetNetwork, getNetwork } = require("../src/network/service");
const { runContext } = require("../src/network/context");
const { isCancelled } = require("../src/network/abort");
const { buildTelegramMessage, sendTelegramMessage } = require("../src/telegram");

const bounded = { timeout: 10000 };
const target = { BotToken: "synthetic-test-token", ChatID: "test-chat" };
const entry = { title: "Local delivery", link: "https://example.invalid/article" };

beforeEach((t) => {
  offline(t);
  const network = resetNetwork();
  t.after(() => {
    assert.equal(network.operations.size, 0, "Delivery must release the network operation");
    assert.equal(network.http.active, 0, "Delivery must release its HTTP slot");
    resetNetwork();
  });
});

// Only replace the provider URL. Serialization, status handling, network
// admission and cancellation all use the real Axios/network adapter path.
function routeToLocalServer(t, server, inspect = () => {}) {
  const post = axios.post.bind(axios);
  return t.mock.method(axios, "post", (url, payload, options) => {
    assert.equal(url, `https://api.telegram.org/bot${target.BotToken}/sendMessage`);
    assert.equal(options.adapter, networkAdapter);
    inspect(payload, options);
    return post(server.url, payload, { ...options, proxy: false });
  });
}

test("Telegram builds escaped HTML while rejecting unsafe article and attachment URLs", () => {
  const message = buildTelegramMessage({
    title: '  A <title> & "quoted"  ',
    author: "<author>",
    isoDate: "2026-10-12",
    contentSnippet: "One\n<script>alert(1)</script> & two",
    link: 'https://example.invalid/article?a=1&b="two"',
    attachments: ["javascript:alert(1)", "file:///local/private", "https://example.invalid/file"],
    enclosure: "https://example.invalid/enclosure",
  });
  assert.equal(message, [
    "<b>A &lt;title&gt; &amp; &quot;quoted&quot;</b>",
    "&lt;author&gt; · 2026-10-12",
    "One &lt;script&gt;alert(1)&lt;/script&gt; &amp; two",
    '<a href="https://example.invalid/article?a=1&amp;b=%22two%22">Open article</a>',
    '<a href="https://example.invalid/file">Attachment 1</a>',
    '<a href="https://example.invalid/enclosure">Attachment 2</a>',
  ].join("\n\n"));
  assert.equal(buildTelegramMessage({ link: "javascript:alert(1)" }), "<b>New entry</b>");
});

test("Telegram caps escaped text and omits links that exceed the message budget", () => {
  const message = buildTelegramMessage({
    title: "&".repeat(1000),
    content: "<".repeat(4000),
    author: '"'.repeat(1000),
    link: `https://example.invalid/${"x".repeat(4096)}`,
    attachments: ["https://example.invalid/a", "https://example.invalid/b", "https://example.invalid/c"],
    enclosure: "https://example.invalid/d",
  });
  const [title, meta, snippet] = message.split("\n\n");
  assert.equal(title, `<b>${"&amp;".repeat(96)}</b>`);
  assert.equal(meta, `${"&quot;".repeat(53)}…`);
  assert.equal(snippet, "&lt;".repeat(650));
  assert.ok(message.length <= 4096);
  assert.doesNotMatch(message, /Open article|Attachment 3|example\.invalid\/[cd]/);
  assert.match(message, /Attachment 1/);
  assert.match(message, /Attachment 2/);
});

for (const [name, config, error] of [
  ["disabled target", { ...target, Enabled: false }, "Telegram target is disabled."],
  ["missing token", { ChatID: "test-chat" }, "Telegram bot token is missing."],
  ["blank chat ID", { ...target, ChatID: " " }, "Telegram chat ID is missing."],
]) {
  test(`Telegram rejects ${name} before making a request`, async (t) => {
    const post = t.mock.method(axios, "post", () => {
      assert.fail("Invalid target must never reach Axios");
    });
    await assert.rejects(sendTelegramMessage(config, entry), { message: error });
    assert.equal(post.mock.callCount(), 0);
  });
}

test("Telegram sends a minimal JSON payload and returns the provider result", bounded, async (t) => {
  let body;
  const result = { message_id: 42, chat: { id: -100123 } };
  const server = await serve(t, async (req, res) => {
    body = JSON.parse((await readBody(req)).toString());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  });
  routeToLocalServer(t, server, (_payload, options) => {
    assert.equal(options.timeout, 15000);
    assert.equal(options.xfeederDefaultTimeout, 15000);
  });
  assert.deepEqual(await sendTelegramMessage({ ...target, ChatID: -100123 }, entry), result);
  assert.deepEqual(body, {
    chat_id: "-100123",
    text: '<b>Local delivery</b>\n\n<a href="https://example.invalid/article">Open article</a>',
    parse_mode: "HTML",
  });
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, "POST");
  assert.match(server.requests[0].headers["content-type"], /^application\/json/);
});

test("Telegram rejects an API-level failure at HTTP 200 without a description", bounded, async (t) => {
  const server = await serve(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  routeToLocalServer(t, server);
  await assert.rejects(sendTelegramMessage(target, entry), {
    message: "Telegram API error: request was rejected",
  });
  assert.equal(server.requests.length, 1);
});

for (const status of [400, 401, 403, 500, 503]) {
  test(`Telegram HTTP ${status} without an API description fails after one request`, bounded, async (t) => {
    const server = await serve(t, (_req, res) => {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("provider unavailable");
    });
    routeToLocalServer(t, server);
    await assert.rejects(sendTelegramMessage(target, entry), {
      message: `Telegram API request failed with HTTP ${status}.`,
    });
    assert.equal(server.requests.length, 1);
  });
}

test("Telegram 429 reports the provider error without an immediate retry or retained retry metadata", bounded, async (t) => {
  const server = await serve(t, (_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "30" });
    res.end(JSON.stringify({
      ok: false, error_code: 429, description: "Too Many Requests: retry after 30",
      parameters: { retry_after: 30 },
    }));
  });
  routeToLocalServer(t, server);
  await assert.rejects(sendTelegramMessage(target, entry), (error) => {
    assert.equal(error.message, "Telegram API error: Too Many Requests: retry after 30");
    // This characterizes the existing error wrapper, not a new retry policy.
    assert.equal(error.response, undefined);
    assert.equal(error.code, undefined);
    return true;
  });
  assert.equal(server.requests.length, 1);
});

test("Telegram wraps a dropped connection without exposing the bot token", bounded, async (t) => {
  const server = await serve(t, (req) => req.socket.destroy());
  routeToLocalServer(t, server);
  await assert.rejects(sendTelegramMessage(target, entry), (error) => {
    assert.equal(error.message, "Telegram API request failed (ECONNRESET).");
    assert.ok(!error.message.includes(target.BotToken));
    return true;
  });
  assert.equal(server.requests.length, 1);
});

test("Telegram preserves cancellation when the delivery context is already aborted", bounded, async (t) => {
  const server = await serve(t, (_req, res) => res.end());
  const controller = new AbortController();
  controller.abort();
  routeToLocalServer(t, server, (_payload, options) => {
    assert.equal(options.signal, controller.signal);
  });
  await assert.rejects(
    runContext({ signal: controller.signal }, () => sendTelegramMessage(target, entry)),
    (error) => isCancelled(error),
  );
  assert.equal(server.requests.length, 0);
});

test("Telegram aborts an in-flight request and releases network admission", bounded, async (t) => {
  const received = deferred();
  const server = await serve(t, async (req) => {
    await readBody(req);
    received.resolve();
    // Deliberately leave the response open until the caller aborts.
  });
  const controller = new AbortController();
  routeToLocalServer(t, server, (_payload, options) => {
    assert.equal(options.signal, controller.signal);
  });
  const pending = runContext({ signal: controller.signal }, () => sendTelegramMessage(target, entry));
  const rejected = assert.rejects(pending, (error) => isCancelled(error));
  await received.promise;
  assert.equal(getNetwork().http.active, 1);
  controller.abort();
  await rejected;
  assert.equal(server.requests.length, 1);
  assert.equal(getNetwork().operations.size, 0);
  assert.equal(getNetwork().http.active, 0);
});
