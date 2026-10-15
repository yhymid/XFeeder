"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { sendMessage } = require("../src/message");
const { getNetwork, resetNetwork } = require("../src/network/service");
const { runContext } = require("../src/network/context");
const { cancelled, isCancelled } = require("../src/network/abort");
const { entry } = require("./fixtures/feeds.cjs");
const { offline, serve, readBody, deferred } = require("./fixtures/network.cjs");

const bounded = { timeout: 10000 };

beforeEach((t) => {
  offline(t);
  resetNetwork();
});

// Keep the provider request, transport, status parsing and payload serialization
// real; skip only elapsed retry time when checking the chosen delay and budget.
function recordRetryWaits(t) {
  const waits = [];
  t.mock.method(getNetwork(), "wait", async (ms, signal, reason) => {
    waits.push({ ms, signal, reason });
  });
  return waits;
}

async function webhook(t, handler = () => ({ status: 204 })) {
  const bodies = [];
  const server = await serve(t, async (req, res) => {
    bodies.push(JSON.parse((await readBody(req)).toString()));
    const { status, headers = {}, body } = handler(bodies.length);
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { ...server, bodies };
}

test("Discord success keeps the query, sets Components V2 and omits a null thread", bounded, async (t) => {
  const server = await webhook(t);
  await sendMessage(`${server.url}/webhook?wait=true&with_components=false`, "null", {
    title: "  Release\u0000 test  ",
    contentSnippet: "A small update",
    link: "https://example.invalid/post",
    enclosure: "file:///private/image.png",
  });

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, "POST");
  assert.match(server.requests[0].headers["content-type"], /^application\/json/);
  const url = new URL(server.requests[0].url, server.url);
  assert.equal(url.pathname, "/webhook");
  assert.equal(url.searchParams.get("wait"), "true");
  assert.equal(url.searchParams.get("with_components"), "true");
  assert.equal(url.searchParams.has("thread_id"), false);
  assert.deepEqual(server.bodies[0], {
    flags: 1 << 15,
    components: [{
      type: 17,
      components: [
        { type: 10, content: "📰 **  Release test  **" },
        { type: 10, content: "A small update" },
        { type: 1, components: [{ type: 2, style: 5, label: "Open", url: "https://example.invalid/post" }] },
      ],
    }],
  });
});

test("Discord YouTube delivery uses the video thumbnail and selected thread", bounded, async (t) => {
  const server = await webhook(t);
  const link = "https://www.youtube.com/watch?v=abcdefghijk";
  await sendMessage(`${server.url}/webhook?thread_id=previous`, "thread-new", {
    title: "New video", link,
  });
  const components = server.bodies[0].components[0].components;
  assert.equal(new URL(server.requests[0].url, server.url).searchParams.get("thread_id"), "thread-new");
  assert.deepEqual(components, [
    { type: 10, content: "📺 New video" },
    { type: 10, content: link },
    { type: 12, items: [{ media: { url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" }, description: "New video" }] },
    { type: 1, components: [{ type: 2, style: 5, label: "Open on YouTube", url: link }] },
  ]);
});

test("Discord source forwarding bounds media and text and drops unsafe button URLs", bounded, async (t) => {
  const server = await webhook(t);
  await sendMessage(server.url, null, {
    categories: ["discord"],
    author: "Fixture author",
    contentSnippet: "x".repeat(2000),
    link: "javascript:alert(1)",
    enclosure: "https://example.invalid/cover.png",
    embedThumbnail: "https://example.invalid/embed.png",
    attachments: Array.from({ length: 12 }, (_, index) => `https://example.invalid/${index}.png`),
    referenced: { author: "Original author", content: "Previous message" },
  });
  const components = server.bodies[0].components[0].components;
  const text = components.filter((item) => item.type === 10).map((item) => item.content);
  assert.ok(text.every((item) => item.length <= 1800));
  assert.ok(text.includes(`${"x".repeat(1797)}...`));
  assert.ok(text.some((item) => item.includes('Original author — "Previous message"')));
  assert.deepEqual(components.find((item) => item.type === 12).items.map((item) => item.media.url), [
    "https://example.invalid/cover.png",
    "https://example.invalid/embed.png",
    ...Array.from({ length: 8 }, (_, index) => `https://example.invalid/${index}.png`),
  ]);
  assert.equal(components.some((item) => item.type === 1), false);
});

for (const status of [400, 401, 403, 404]) {
  test(`Discord ${status} rejects after one request without a retry wait`, bounded, async (t) => {
    const server = await webhook(t, () => ({ status, body: { message: "Fixture rejection", code: 123 } }));
    const waits = recordRetryWaits(t);
    await assert.rejects(sendMessage(server.url, null, entry), (error) => {
      assert.equal(error.response.status, status);
      assert.deepEqual(error.response.data, { message: "Fixture rejection", code: 123 });
      return true;
    });
    assert.equal(server.requests.length, 1);
    assert.deepEqual(waits, []);
  });
}

const rateLimitCases = [
  { name: "body seconds take precedence over both headers", body: { retry_after: 1.25 }, headers: { "x-ratelimit-reset-after": "2", "Retry-After": "3" }, delay: 1250 },
  { name: "reset-after seconds take precedence over Retry-After", body: { retry_after: "invalid" }, headers: { "x-ratelimit-reset-after": "1.75", "Retry-After": "3" }, delay: 1750 },
  { name: "numeric Retry-After below 100 is interpreted as seconds", headers: { "Retry-After": "2.5" }, delay: 2500 },
  { name: "legacy numeric Retry-After at least 100 is interpreted as milliseconds", headers: { "Retry-After": "1500" }, delay: 1500 },
  { name: "short body delays are clamped to 500 ms", body: { retry_after: 0.01 }, delay: 500 },
  { name: "long body delays are clamped to 15000 ms", body: { retry_after: 60 }, delay: 15000 },
  { name: "invalid or nonpositive hints use the initial backoff", body: { retry_after: -1 }, headers: { "x-ratelimit-reset-after": "0", "Retry-After": "invalid" }, delay: 500 },
  // Characterize the provider's current numeric-only parser, not the shared GET
  // Retry-After parser: the latter separately supports HTTP dates.
  { name: "HTTP-date Retry-After currently uses fallback backoff", headers: { "Retry-After": "Fri, 01 Jan 2100 00:00:00 GMT" }, delay: 500 },
];

for (const { name, body, headers, delay } of rateLimitCases) {
  test(`Discord 429: ${name}`, bounded, async (t) => {
    const server = await webhook(t, (attempt) => attempt === 1 ? { status: 429, headers, body } : { status: 204 });
    const waits = recordRetryWaits(t);
    const controller = new AbortController();
    await runContext({ signal: controller.signal }, () => sendMessage(server.url, null, entry));
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.bodies[1], server.bodies[0]);
    assert.deepEqual(waits, [{ ms: delay, signal: controller.signal, reason: "retry:discord" }]);
    assert.equal(getNetwork().snapshot().operations, 0);
  });
}

test("Discord repeated 429 exhausts three retries with exponential backoff and preserves the final error", bounded, async (t) => {
  const server = await webhook(t, (attempt) => ({ status: 429, body: { message: `Rate limited ${attempt}` } }));
  const waits = recordRetryWaits(t);
  await assert.rejects(sendMessage(server.url, null, entry), (error) => {
    assert.equal(error.response.status, 429);
    assert.equal(error.response.data.message, "Rate limited 4");
    return true;
  });
  assert.equal(server.requests.length, 4);
  assert.deepEqual(waits.map((item) => item.ms), [500, 1000, 2000]);
  assert.ok(server.bodies.every((body) => JSON.stringify(body) === JSON.stringify(server.bodies[0])));
  assert.equal(getNetwork().snapshot().operations, 0);
});

test("Discord 503 after a 429 stops retries without replaying a possibly accepted POST", bounded, async (t) => {
  const server = await webhook(t, (attempt) => ({ status: attempt === 1 ? 429 : 503, body: { message: "Fixture error" } }));
  const waits = recordRetryWaits(t);
  await assert.rejects(sendMessage(server.url, null, entry), (error) => error.response.status === 503);
  assert.equal(server.requests.length, 2);
  assert.deepEqual(waits.map((item) => item.ms), [500]);
});

test("Discord an already cancelled channel makes no request", bounded, async (t) => {
  const server = await webhook(t);
  const waits = recordRetryWaits(t);
  const controller = new AbortController();
  controller.abort(cancelled("Fixture cancellation"));
  await assert.rejects(runContext({ signal: controller.signal }, () => sendMessage(server.url, null, entry)), isCancelled);
  assert.equal(server.requests.length, 0);
  assert.deepEqual(waits, []);
  assert.equal(getNetwork().snapshot().operations, 0);
});

test("Discord cancellation interrupts an outstanding webhook response and releases network admission", bounded, async (t) => {
  const received = deferred();
  const server = await serve(t, async (req) => {
    await readBody(req);
    received.resolve();
    // Leave the response pending until the caller cancels; cleanup closes it.
  });
  const waits = recordRetryWaits(t);
  const controller = new AbortController();
  const rejected = assert.rejects(runContext({ signal: controller.signal }, () => sendMessage(server.url, null, entry)), isCancelled);
  await received.promise;
  controller.abort(cancelled("Fixture cancellation during request"));
  await rejected;
  assert.equal(server.requests.length, 1);
  assert.deepEqual(waits, []);
  assert.equal(getNetwork().snapshot().operations, 0);
  assert.equal(getNetwork().snapshot().http.active, 0);
});

for (const shutdown of [false, true]) {
  test(`Discord ${shutdown ? "network shutdown" : "channel cancellation"} interrupts the actual 429 wait without a second POST`, bounded, async (t) => {
    const server = await webhook(t, () => ({ status: 429, body: { retry_after: 15 } }));
    const waiting = deferred();
    const controller = new AbortController();
    const finishedWaits = [];
    const rejected = assert.rejects(runContext({
      signal: controller.signal,
      onWaiting(reason) {
        if (reason !== "retry:discord") return;
        waiting.resolve(reason);
        return () => finishedWaits.push(reason);
      },
    }, () => sendMessage(server.url, null, entry)), isCancelled);
    assert.equal(await waiting.promise, "retry:discord");
    if (shutdown) getNetwork().beginShutdown();
    else controller.abort(cancelled("Fixture cancellation during retry"));
    await rejected;
    assert.equal(server.requests.length, 1);
    assert.deepEqual(finishedWaits, ["retry:discord"]);
    assert.equal(getNetwork().snapshot().operations, 0);
    assert.equal(getNetwork().snapshot().http.active, 0);
  });
}


test("X3-12: Discord delivery error logs redact provider credentials", bounded, async (t) => {
  const secret = "synthetic-provider-credential";
  const server = await webhook(t, () => ({
    status: 403,
    body: {
      authorization: `Bearer ${secret}`,
      details: `https://discord.com/api/webhooks/123456789/${secret}`,
    },
  }));
  const logged = [];
  t.mock.method(console, "error", (...values) => logged.push(values.join(" ")));
  await assert.rejects(sendMessage(server.url, null, entry), error => error.response?.status === 403);
  assert.equal(server.requests.length, 1);
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes(secret), "provider credentials must not be logged");
  assert.match(logged[0], /\[Discord delivery\]\[error\]/);
  assert.match(logged[0], /\[REDACTED\]/);
});
