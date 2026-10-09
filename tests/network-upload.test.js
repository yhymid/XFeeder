"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { Readable } = require("node:stream");
const { performance } = require("node:perf_hooks");
const { gzipSync } = require("node:zlib");
const {
  offline,
  serve,
  readBody,
  config,
  holdDelay,
} = require("./fixtures/network.cjs");
const { getHttpClient, getWithFallback } = require("../src/client");
const { resetNetwork, getNetwork } = require("../src/network/service");
const { NetworkMetrics } = require("../src/network/metrics");
const { sendMessage } = require("../src/message");
const { sendTelegramMessage } = require("../src/telegram");
const { entry } = require("./fixtures/feeds.cjs");
beforeEach((t) => {
  offline(t);
  resetNetwork();
});
const bounded = { timeout: 15000 };
function client(network = {}) {
  return getHttpClient("unused", { ...config, network });
}
const custom = { bandwidthProfile: "custom", uploadLimitMbps: 0.08 };

test(
  "TASK 09: Unlimited and custom preserve JSON bytes and Content-Length; simultaneous uploads share budget",
  bounded,
  async (t) => {
    const received = [];
    const server = await serve(t, async (req, res) => {
      const body = await readBody(req);
      received.push({ body, length: req.headers["content-length"] });
      res.end("ok");
    });
    const payload = { text: "Żółć".repeat(1000) };
    const expected = Buffer.from(JSON.stringify(payload));
    await client().post(server.url, payload);
    let start = performance.now();
    const managed = client(custom);
    await Promise.all([
      managed.post(server.url, payload),
      managed.post(server.url, payload),
    ]);
    const elapsed = performance.now() - start;
    assert.ok(
      elapsed >= ((expected.length * 2) / 10000) * 1000 - 150,
      `${elapsed}ms`,
    );
    assert.ok(elapsed < 6000);
    for (const { body, length } of received) {
      assert.deepEqual(body, expected);
      assert.equal(Number(length), expected.length);
    }
    assert.equal(
      getNetwork().metricsSnapshot().uploadedBytes,
      expected.length * 3,
    );
    assert.equal(getNetwork().metricsSnapshot().unshapedUploadBytes, 0);
  },
);

test(
  "TASK 09: abort during upload admission sends no body and releases permit",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => res.end("unexpected"));
    const controller = new AbortController();
    const promise = client({ ...custom, uploadLimitMbps: 0.001 }).post(
      server.url,
      Buffer.alloc(10000),
      { signal: controller.signal },
    );
    const rejection = assert.rejects(promise, { code: "ERR_CANCELED" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await rejection;
    assert.equal(server.requests.length, 0);
    assert.equal(getNetwork().metricsSnapshot().uploadedBytes, 0);
    assert.equal(getNetwork().snapshot().upload.pending, 0);
    assert.equal(getNetwork().snapshot().http.active, 0);
  },
);

test(
  "TASK 09: shutdown wakes queued upload bodies without waiting for their budget",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => res.end("unexpected"));
    const promise = client({ ...custom, uploadLimitMbps: 0.001 }).post(
      server.url,
      Buffer.alloc(10000),
    );
    const rejected = assert.rejects(promise, { code: "ERR_CANCELED" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await getNetwork().shutdown(0);
    await rejected;
    assert.equal(getNetwork().snapshot().upload.pending, 0);
  },
);

test(
  "TASK 09: slow pre-dispatch upload does not consume setup timeout; runtime Unlimited wakes it",
  bounded,
  async (t) => {
    const server = await serve(t, async (req, res) => {
      await readBody(req);
      res.end("ok");
    });
    const promise = client({ ...custom, uploadLimitMbps: 0.001 }).post(
      server.url,
      "x".repeat(5000),
      { setupTimeoutMs: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    getNetwork().configure({});
    assert.equal((await promise).data, "ok");
  },
);

test(
  "TASK 09: streams and multipart preserve payload and explicitly count unshaped bytes",
  bounded,
  async (t) => {
    const received = [];
    const server = await serve(t, async (req, res) => {
      received.push({ body: await readBody(req), headers: req.headers });
      res.end("ok");
    });
    const managed = client(custom);
    const bytes = Buffer.from("raw-stream-Żółć");
    await managed.post(server.url, Readable.from([bytes]), {
      headers: {
        "Content-Length": bytes.length,
        "Content-Type": "application/octet-stream",
      },
    });
    const form = new FormData();
    form.set("message", "żółć");
    form.set("file", new Blob(["fixture"]), "fixture.txt");
    await managed.post(server.url, form);
    assert.deepEqual(received[0].body, bytes);
    assert.equal(Number(received[0].headers["content-length"]), bytes.length);
    const multipart = received[1];
    const boundary =
      multipart.headers["content-type"].match(/boundary=([^;]+)/)[1];
    assert.ok(multipart.body.toString().includes(`--${boundary}`));
    assert.ok(multipart.body.toString().includes("żółć"));
    assert.equal(
      Number(multipart.headers["content-length"]),
      multipart.body.length,
    );
    assert.equal(
      getNetwork().metricsSnapshot().unshapedUploadBytes,
      received.reduce((n, r) => n + r.body.length, 0),
    );
  },
);

for (const destination of ["Discord", "Telegram"]) {
  test(
    `TASK 09: ${destination} delivery retains identical bytes with custom upload`,
    bounded,
    async (t) => {
      const bodies = [];
      const server = await serve(t, async (req, res) => {
        bodies.push(await readBody(req));
        res.setHeader("Content-Type", "application/json");
        res.end('{"ok":true,"result":{"message_id":1}}');
      });
      if (destination === "Telegram") {
        const post = axios.post.bind(axios);
        t.mock.method(axios, "post", (_url, payload, options) =>
          post(server.url, payload, { ...options, proxy: false }),
        );
      }
      const send = () =>
        destination === "Discord"
          ? sendMessage(server.url, null, entry)
          : sendTelegramMessage({ BotToken: "fixture", ChatID: "chat" }, entry);
      await send();
      getNetwork().configure(custom);
      await send();
      assert.deepEqual(bodies[0], bodies[1]);
      assert.equal(
        getNetwork().metricsSnapshot().uploadedBytes,
        bodies[0].length * 2,
      );
    },
  );
}

test(
  "TASK 09/10: Discord retry pays upload budget again and accounts each actual body once",
  bounded,
  async (t) => {
    const bodies = [];
    const server = await serve(t, async (req, res) => {
      bodies.push(await readBody(req));
      res.writeHead(bodies.length === 1 ? 429 : 200, {
        "Content-Type": "application/json",
      });
      res.end(bodies.length === 1 ? '{"retry_after":0.5}' : "{}");
    });
    const delay = holdDelay(t, 500);
    getNetwork().configure({ ...custom, uploadLimitMbps: 0.008 });
    const promise = sendMessage(server.url, null, entry);
    await delay.scheduled;
    delay.release();
    await promise;
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(
      getNetwork().metricsSnapshot().uploadedBytes,
      bodies[0].length * 2,
    );
    assert.equal(
      getNetwork().snapshot().upload.grantedBytes,
      bodies[0].length * 2,
    );
  },
);

test(
  "TASK 10: gzip and HTTP retry account compressed bytes once per actual response",
  bounded,
  async (t) => {
    const body = gzipSync(Buffer.alloc(10000, 0x61));
    let count = 0;
    const server = await serve(t, (_req, res) => {
      res.writeHead(++count === 1 ? 503 : 200, { "Content-Encoding": "gzip" });
      res.end(body);
    });
    await getWithFallback(server.url, {
      config,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });
    assert.equal(
      getNetwork().metricsSnapshot().downloadedBytes,
      body.length * 2,
    );
    assert.deepEqual(getNetwork().metricsSnapshot().scraplingBytes, {
      status: "unavailable",
      downloadedBytes: null,
      uploadedBytes: null,
    });
  },
);

test("TASK 10: rates use bounded monotonic buckets and decay to zero without resetting totals", () => {
  let now = 0;
  const metrics = new NetworkMetrics(() => now);
  metrics.record("download", 2000);
  now = 1000;
  metrics.record("upload", 4000, false);
  now = 2000;
  let s = metrics.snapshot();
  assert.equal(s.downloadBytesPerSecond, 1000);
  assert.equal(s.uploadBytesPerSecond, 2000);
  now = 7000;
  s = metrics.snapshot();
  assert.equal(s.downloadBytesPerSecond, 0);
  assert.equal(s.uploadBytesPerSecond, 0);
  assert.equal(s.downloadedBytes, 2000);
  assert.equal(s.unshapedUploadBytes, 4000);
  assert.equal(metrics.buckets.length, 5);
});
