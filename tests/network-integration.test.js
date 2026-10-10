"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { once, getEventListeners } = require("node:events");
const { gzipSync } = require("node:zlib");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const https = require("node:https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { getWithFallback, getHttpClient } = require("../src/client");
const { getNetwork, resetNetwork } = require("../src/network/service");
const {
  offline,
  serve,
  readBody,
  deferred,
  holdDelay,
  mockScraplingDetector,
  config: base,
} = require("./fixtures/network.cjs");
const { createApp } = require("../src/app/bootstrap");
const { context } = require("../src/network/context");
const { createChannelRunner } = require("../src/app/channel-runner");
const { createCacheStore } = require("../src/core/cache-store");
const { ChannelTasks } = require("../src/app/channel-tasks");
const { rss } = require("./fixtures/feeds.cjs");
const { startChannelQueue } = require("../src/app/runtime");

beforeEach((t) => {
  offline(t);
  mockScraplingDetector(t);
  resetNetwork();
});
const bounded = { timeout: 15000 };
const options = (network = {}, extra = {}) => ({
  config: { ...base, network },
  proxy: false,
  maxAttempts: 1,
  ...extra,
});

test("TASK 13: fully received Connection: close response drains its bandwidth queue before EOF", bounded, async (t) => {
  const expected = Buffer.alloc(1024, 0x53);
  const closed = deferred();
  const server = await serve(t, (req, res) => {
    req.socket.once("close", closed.resolve);
    res.writeHead(200, { Connection: "close", "Content-Length": expected.length });
    res.end(expected);
  });
  const response = await getWithFallback(server.url, options({
    bandwidthProfile: "potato", idleTimeoutMs: 50,
  }, { responseType: "stream" }));
  await closed.promise;
  assert.equal(response.data.readableEnded, false);
  assert.deepEqual(await readBody(response.data), expected);
  assert.equal(getNetwork().snapshot().operations, 0);
});

test("TASK 13: truncated buffered response retries without accepting partial body", bounded, async (t) => {
  const server = await serve(t, async (_req, res, requests) => {
    res.writeHead(200, { "Content-Length": 10 });
    if (requests.length === 1) {
      await new Promise((resolve) => res.write("partial", resolve));
      await new Promise(setImmediate);
      res.destroy();
    } else res.end("0123456789");
  });
  const response = await getWithFallback(server.url, options({}, {
    maxAttempts: 2, retryBaseDelayMs: 0,
  }));
  assert.equal(response.data, "0123456789");
  assert.equal(server.requests.length, 2);
  assert.equal(getNetwork().metricsSnapshot().downloadedBytes, 17);
  assert.equal(getNetwork().snapshot().operations, 0);
});

test("TASK 13: shutdown cancels a bodyless request before response headers and releases admission", bounded, async (t) => {
  const started = deferred();
  const server = await serve(t, () => started.resolve());
  const request = getWithFallback(server.url, options());
  const rejected = assert.rejects(request, { code: "ERR_CANCELED" });
  await started.promise;
  await getNetwork().shutdown(0);
  await rejected;
  assert.equal(getNetwork().snapshot().operations, 0);
  assert.equal(getNetwork().snapshot().http.active, 0);
});

test("TASK 13: chunked response preserves byte order, trailers and deferred EOF under a shared limit", bounded, async (t) => {
  const expected = Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256));
  const server = await serve(t, (_req, res) => {
    res.writeHead(200, { Trailer: "x-complete" });
    res.cork();
    for (const byte of expected) res.write(Buffer.from([byte]));
    res.addTrailers({ "x-complete": "yes" });
    res.end();
    res.uncork();
  });
  const start = performance.now();
  const response = await getWithFallback(server.url, options({
    bandwidthProfile: "custom", downloadLimitMbps: 0.008192, uploadLimitMbps: 1,
  }, { responseType: "stream" }));
  const chunks = [];
  for await (const chunk of response.data) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), expected);
  assert.equal(response.data.trailers["x-complete"], "yes");
  assert.ok(performance.now() - start >= 350);
  assert.equal(getNetwork().snapshot().download.grantedBytes, expected.length);
  assert.equal(getNetwork().metricsSnapshot().downloadedBytes, expected.length);
});

test("TASK 13: a paused UTF-8 consumer keeps bounded buffering without a false idle timeout", bounded, async (t) => {
  const expected = "Zażółć 🍵\n".repeat(50000);
  const server = await serve(t, (_req, res) => res.end(expected));
  const response = await getWithFallback(server.url, options({
    bandwidthProfile: "medium", idleTimeoutMs: 40,
  }, { responseType: "stream" }));
  response.data.setEncoding("utf8");
  const iterator = response.data[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(typeof first.value, "string");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(response.data.destroyed, false);
  assert.ok(response.data.readableLength <= response.data.readableHighWaterMark + 16384);
  let actual = first.value;
  for await (const chunk of iterator) actual += chunk;
  assert.equal(actual, expected);
  assert.equal(getNetwork().metricsSnapshot().downloadedBytes, Buffer.byteLength(expected));
});

test("TASK 13: shared shutdown signal does not retain completed HTTP requests and aborts all open streams", bounded, async (t) => {
  const server = await serve(t, (req, res) => {
    if (req.url === "/hang") res.write("headers and first bytes");
    else res.end("complete");
  });
  const network = getNetwork();
  const signal = network.controller.signal;
  const listenerCount = getEventListeners(signal, "abort").length;
  const client = getHttpClient("unused", { ...base, network: {} });
  for (let round = 0; round < 3; round++) {
    const responses = await Promise.all(Array.from({ length: 32 }, () =>
      client.get(server.url, { proxy: false })));
    assert.ok(responses.every((response) => response.data === "complete"));
    await new Promise(setImmediate);
    assert.equal(getEventListeners(signal, "abort").length, listenerCount);
    assert.equal(network.snapshot().operations, 0);
  }
  const open = await Promise.all(Array.from({ length: 16 }, () =>
    getWithFallback(`${server.url}/hang`, options({}, { responseType: "stream" }))));
  assert.equal(network.snapshot().http.active, 16);
  await network.shutdown(0);
  await new Promise(setImmediate);
  assert.ok(open.every((response) => response.data.destroyed));
  assert.equal(getEventListeners(signal, "abort").length, 0);
  assert.equal(network.snapshot().operations, 0);
  assert.equal(network.snapshot().http.active, 0);
});

test(
  "TASK 06: invalid request timeouts fail before admission and are never retried",
  bounded,
  async (t) => {
    let requests = 0;
    const server = await serve(t, (_req, res) => {
      requests++;
      res.end("unexpected");
    });
    for (const key of ["setupTimeoutMs", "idleTimeoutMs", "deadlineMs"]) {
      for (const value of [-1, Infinity, NaN, "1000", 2_147_000_001]) {
        await assert.rejects(
          getWithFallback(
            server.url,
            options({}, { [key]: value, maxAttempts: 3 }),
          ),
          { code: "ERR_BAD_OPTION_VALUE" },
        );
      }
    }
    assert.equal(requests, 0);
    assert.equal(getNetwork().snapshot().operations, 0);
  },
);

test(
  "TASK 04: two downloads share the 10 Mbps budget, including through direct getHttpClient",
  bounded,
  async (t) => {
    const body = Buffer.alloc(1024 * 1024, 0x63);
    const server = await serve(t, (_req, res) => res.end(body));
    const opts = options(
      { bandwidthProfile: "medium" },
      { responseType: "arraybuffer" },
    );
    const start = performance.now();
    const [a, b] = await Promise.all([
      getWithFallback(server.url, opts),
      getHttpClient("unused", opts.config).get(server.url, {
        responseType: "arraybuffer",
        proxy: false,
      }),
    ]);
    const elapsed = performance.now() - start;
    assert.deepEqual(a.data, body);
    assert.deepEqual(b.data, body);
    // 2 MiB at 1,250,000 B/s needs ~1.68 s, less <=64 KiB startup credit.
    assert.ok(
      elapsed > 1300 && elapsed < 5500,
      `Aggregate 10 Mbps transfer took ${elapsed} ms`,
    );
    assert.equal(
      getNetwork().download.snapshot().grantedBytes,
      2 * body.length,
    );
    assert.equal(getNetwork().snapshot().http.active, 0);
  },
);

test(
  "TASK 04/06: Potato transfer lasts much longer than idle timeout without false failure",
  bounded,
  async (t) => {
    const body = Buffer.alloc(3000, 0x71);
    const server = await serve(t, (_req, res) => res.end(body));
    const start = performance.now();
    const response = await getWithFallback(
      server.url,
      options(
        { bandwidthProfile: "potato", idleTimeoutMs: 70 },
        { responseType: "arraybuffer" },
      ),
    );
    assert.deepEqual(response.data, body);
    assert.ok(performance.now() - start > 1900);
    assert.equal(server.requests.length, 1);
  },
);

test(
  "TASK 06: a server hanging after headers hits idle timeout, not setup timeout",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => res.write("hello"));
    await assert.rejects(
      getWithFallback(
        server.url,
        options({ idleTimeoutMs: 70, setupTimeoutMs: 1000 }),
      ),
      (error) => error.code === "ECONNABORTED" && error.phase === "idle",
    );
    assert.equal(getNetwork().snapshot().http.active, 0);
  },
);

test(
  "TASK 04: abort during a bandwidth wait destroys streams and releases concurrency",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => res.end(Buffer.alloc(50000)));
    const controller = new AbortController();
    const response = await getWithFallback(
      server.url,
      options(
        { bandwidthProfile: "potato" },
        { responseType: "stream", signal: controller.signal },
      ),
    );
    const first = once(response.data, "data");
    const reading = assert.rejects(
      readBody(response.data),
      (error) => error.code === "ERR_CANCELED" || error.name === "AbortError",
    );
    await first;
    controller.abort();
    await reading;
    await new Promise(setImmediate);
    assert.equal(response.data.destroyed, true);
    assert.equal(getNetwork().snapshot().download.pending, 0);
    assert.equal(getNetwork().snapshot().http.active, 0);
  },
);

test(
  "TASK 04: gzip charges compressed bytes once and still enforces decompressed body limits",
  bounded,
  async (t) => {
    const body = Buffer.from("compressed fixture ".repeat(10000)),
      zipped = gzipSync(body);
    const server = await serve(t, (_req, res) => {
      res.setHeader("Content-Encoding", "gzip");
      res.end(zipped);
    });
    const response = await getWithFallback(
      server.url,
      options({ bandwidthProfile: "medium" }, { responseType: "arraybuffer" }),
    );
    assert.deepEqual(response.data, body);
    assert.equal(getNetwork().download.snapshot().grantedBytes, zipped.length);
    await assert.rejects(
      getWithFallback(
        server.url,
        options({ bandwidthProfile: "medium" }, { maxContentLength: 1000 }),
      ),
      /maxContentLength/,
    );
  },
);

test(
  "TASK 04: HTTPS remains certificate-verified through the shared limiter and proxy CONNECT",
  bounded,
  async (t) => {
    // Public, test-only self-signed identity; never use this key outside fixtures.
    const cert = await fs.readFile(
      path.join(__dirname, "fixtures/tls/localhost-test-cert.pem"),
    );
    const key = await fs.readFile(
      path.join(__dirname, "fixtures/tls/localhost-test-key.pem"),
    );
    const server = await serve(t, (_req, res) => res.end("secure fixture"), {
      key,
      cert,
    });
    const { X509Certificate, createPrivateKey } = require("node:crypto");
    const identity = new X509Certificate(cert);
    assert.equal(identity.ca, false, "the public fixture must not be a CA");
    assert.equal(identity.checkPrivateKey(createPrivateKey(key)), true);
    assert.equal(identity.checkHost("localhost"), "localhost");
    assert.equal(identity.checkIP("127.0.0.1"), "127.0.0.1");
    assert.equal(identity.checkHost("example.com"), undefined);
    // No global trust override: the default client must reject this identity.
    const untrusted = new https.Agent();
    t.after(() => untrusted.destroy());
    await assert.rejects(
      getWithFallback(server.url, options({}, { httpsAgent: untrusted })),
      error => error.code === "DEPTH_ZERO_SELF_SIGNED_CERT",
    );
    const direct = new https.Agent({ ca: cert });
    t.after(() => direct.destroy());
    assert.equal(
      (
        await getWithFallback(
          server.url,
          options({ bandwidthProfile: "medium" }, { httpsAgent: direct }),
        )
      ).data,
      "secure fixture",
    );
    const proxy = await serve(t, (_req, res) => {
      res.writeHead(405);
      res.end();
    });
    let connects = 0;
    proxy.server.on("connect", (req, socket, head) => {
      connects++;
      assert.equal(req.url, new URL(server.url).host);
      const upstream = net.connect(
        server.server.address().port,
        "127.0.0.1",
        () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        },
      );
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    });
    const agent = new HttpsProxyAgent(proxy.url);
    agent.options.ca = cert;
    t.after(() => agent.destroy());
    const response = await getWithFallback(
      server.url,
      options({ bandwidthProfile: "medium" }, { httpsAgent: agent }),
    );
    assert.equal(response.data, "secure fixture");
    assert.equal(connects, 1);
    assert.equal(getNetwork().download.snapshot().grantedBytes, 28);
  },
);

for (const profile of ["potato", "unlimited"])
  test(
    `TASK 04: unread ${profile} stream applies backpressure with bounded buffering`,
    bounded,
    async (t) => {
      let sent = 0;
      const stopped = deferred();
      const chunk = Buffer.alloc(65536);
      const server = await serve(t, async (_req, res) => {
        while (!res.destroyed && sent < 64 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            const drained = new Promise((resolve) => {
              const done = () => {
                res.removeListener("drain", done);
                res.removeListener("close", done);
                resolve();
              };
              res.once("drain", done);
              res.once("close", done);
            });
            stopped.resolve();
            await drained;
          }
        }
        if (!res.destroyed) res.end();
      });
      const response = await getWithFallback(
        server.url,
        options({ bandwidthProfile: profile }, { responseType: "stream" }),
      );
      await stopped.promise;
      await new Promise(setImmediate);
      // highWaterMark is a threshold: the last native transport chunk can
      // cross it before push returns false and pauses the producer.
      assert.ok(response.data.readableLength <= response.data.readableHighWaterMark + 65536);
      assert.ok(
        sent < 64 * 1024 * 1024,
        "Server must not finish a large response while consumer is paused",
      );
      response.data.destroy();
    },
  );

test(
  "TASK 04: changing Potato to Unlimited wakes an active stream",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) =>
      res.end(Buffer.alloc(50000, 0x74)),
    );
    const response = await getWithFallback(
      server.url,
      options({ bandwidthProfile: "potato" }, { responseType: "stream" }),
    );
    const first = once(response.data, "data");
    const reading = readBody(response.data);
    await first;
    getNetwork().configure({ bandwidthProfile: "unlimited" });
    assert.equal((await reading).length, 50000);
  },
);

test(
  "TASK 05: queued requests do not consume setup timeout or contact the server",
  bounded,
  async (t) => {
    const firstArrived = deferred(),
      release = deferred();
    t.after(release.resolve);
    const server = await serve(t, async (_req, res, requests) => {
      if (requests.length === 1) {
        firstArrived.resolve();
        await release.promise;
      }
      res.end("ok");
    });
    const opts = options({ maxConcurrentRequests: 1 });
    const first = getWithFallback(server.url, opts);
    await firstArrived.promise;
    const second = getWithFallback(server.url, { ...opts, timeout: 70 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(server.requests.length, 1);
    assert.equal(getNetwork().snapshot().http.waiting, 1);
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(server.requests.length, 2);
  },
);

test(
  "TASK 06: 429 retry re-enters concurrency and charges each response to the same budget",
  bounded,
  async (t) => {
    const delay = holdDelay(t, 2000),
      busy = deferred(),
      release = deferred();
    t.after(release.resolve);
    let attempts = 0;
    const server = await serve(t, async (req, res) => {
      if (req.url === "/busy") {
        busy.resolve();
        await release.promise;
        res.end("busy");
        return;
      }
      attempts++;
      res.writeHead(attempts === 1 ? 429 : 200, { "Retry-After": "2" });
      res.end("retry");
    });
    const opts = options(
      { bandwidthProfile: "medium", maxConcurrentRequests: 1 },
      { maxAttempts: 2 },
    );
    const retry = getWithFallback(`${server.url}/retry`, opts);
    await delay.scheduled;
    const other = getWithFallback(`${server.url}/busy`, opts);
    await busy.promise;
    delay.release();
    await new Promise(setImmediate);
    assert.equal(attempts, 1);
    release.resolve();
    await Promise.all([retry, other]);
    assert.equal(attempts, 2);
    assert.equal(getNetwork().download.snapshot().grantedBytes, 14);
  },
);

test(
  "TASK 06: explicit deadline includes throttling and is not retried",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => res.end(Buffer.alloc(50000)));
    await assert.rejects(
      getWithFallback(
        server.url,
        options(
          { bandwidthProfile: "potato" },
          { deadlineMs: 100, maxAttempts: 3 },
        ),
      ),
      (error) => error.code === "ECONNABORTED" && error.phase === "deadline",
    );
    assert.equal(server.requests.length, 1);
  },
);

test(
  "TASK 06/07: shutdown interrupts a long Retry-After immediately",
  bounded,
  async (t) => {
    const delay = holdDelay(t, 60000);
    const server = await serve(t, (_req, res) => {
      res.writeHead(429, { "Retry-After": "60" });
      res.end();
    });
    const retry = assert.rejects(
      getWithFallback(server.url, options({}, { maxAttempts: 3 })),
      { code: "ERR_CANCELED" },
    );
    await delay.scheduled;
    await getNetwork().shutdown(100);
    await retry;
    assert.equal(server.requests.length, 1);
    assert.equal(getNetwork().snapshot().operations, 0);
  },
);

test(
  "TASK 06: Friendly retry adds jitter without shortening Retry-After",
  bounded,
  async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const delay = holdDelay(t, 2100);
    const server = await serve(t, (_req, res, requests) => {
      res.writeHead(requests.length === 1 ? 429 : 200, { "Retry-After": "2" });
      res.end("ok");
    });
    const request = getWithFallback(
      server.url,
      options({ networkFriendlyMode: true }, { maxAttempts: 2 }),
    );
    await delay.scheduled;
    assert.equal(server.requests.length, 1);
    delay.release();
    await request;
    assert.equal(server.requests.length, 2);
  },
);

test(
  "TASK 06: streaming deadline remains active after headers have been returned",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => res.end(Buffer.alloc(50000)));
    const response = await getWithFallback(
      server.url,
      options(
        { bandwidthProfile: "potato" },
        { responseType: "stream", deadlineMs: 100 },
      ),
    );
    await assert.rejects(
      readBody(response.data),
      (error) => error.code === "ERR_CANCELED" || error.phase === "deadline",
    );
    assert.equal(getNetwork().snapshot().download.pending, 0);
  },
);

async function appFixture(t, network = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "xfeeder-network-app-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      ...base,
      network,
      Channels: [{ RSS: ["http://127.0.0.1/unused"], ID: "fixture" }],
    }),
  );
  const app = createApp({
    configPath: file,
    cachePath: path.join(directory, "cache.json"),
    autostart: false,
  });
  t.after(() => app.shutdown({ persistCache: false, graceMs: 0 }));
  return { app, file, directory };
}

test(
  "TASK 02/07: invalid hot config is rejected atomically and valid profile changes apply",
  bounded,
  async (t) => {
    const { app, file } = await appFixture(t);
    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(
      file,
      JSON.stringify({ ...base, network: { bandwidthProfile: "invalid" } }),
    );
    assert.equal(app.refreshConfig(), false);
    assert.equal(app.network.config.bandwidthProfile, "unlimited");
    const config = JSON.parse(original);
    config.network.bandwidthProfile = "medium";
    await fs.writeFile(file, JSON.stringify(config));
    assert.equal(app.refreshConfig(), true);
    assert.equal(app.network.download.rate, 1250000);
  },
);

test(
  "TASK 07: idle shutdown is idempotent and creates no future queue timers",
  bounded,
  async (t) => {
    const { app } = await appFixture(t);
    const first = app.shutdown({ persistCache: false }),
      second = app.shutdown({ persistCache: false });
    assert.equal(first, second);
    await first;
    assert.equal(app.startQueue(), null);
    assert.equal(app.network.snapshot().operations, 0);
  },
);

test(
  "TASK 07: active HTTP gets a grace period then aborts before cache is saved",
  bounded,
  async (t) => {
    const arrived = deferred();
    const server = await serve(t, (_req, res) => {
      arrived.resolve();
      res.write("waiting");
    });
    const { app, directory } = await appFixture(t);
    const pending = assert.rejects(
      app.fetchFeed(server.url),
      (error) => error.code === "ERR_CANCELED" || error.name === "AbortError",
    );
    await arrived.promise;
    await app.shutdown({ graceMs: 50 });
    await pending;
    const saved = JSON.parse(
      await fs.readFile(path.join(directory, "cache.json"), "utf8"),
    );
    assert.equal(typeof saved, "object");
    assert.equal(app.network.snapshot().http.active, 0);
  },
);

test(
  "TASK 07: an active request may finish successfully during the grace period",
  bounded,
  async (t) => {
    const arrived = deferred(),
      release = deferred();
    const server = await serve(t, async (_req, res) => {
      arrived.resolve();
      await release.promise;
      res.end("finished");
    });
    const { app } = await appFixture(t);
    const pending = getWithFallback(server.url, {
      proxy: false,
      config: app.config,
    });
    await arrived.promise;
    const stopped = app.shutdown({ graceMs: 2000, persistCache: false });
    release.resolve();
    assert.equal((await pending).data, "finished");
    await stopped;
    assert.equal(app.network.snapshot().operations, 0);
  },
);

async function until(predicate) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Expected state was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const reason of ["concurrency:http", "bandwidth"]) {
  test(
    `TASK 07: shutdown during ${reason} cancels channel tasks without failures`,
    bounded,
    async (t) => {
      const server = await serve(t, (_req, res) => {
        if (reason === "concurrency:http") res.write("waiting");
        else res.end(rss.repeat(30));
      });
      const { app } = await appFixture(t, {
        maxConcurrentRequests: 1,
        bandwidthProfile: reason === "bandwidth" ? "potato" : "unlimited",
      });
      const channel = { RSS: [server.url] };
      const first = assert.rejects(
        app.checkFeedsForChannel(0, { ...channel, cacheKey: "first" }),
        (error) => error.code === "ERR_CANCELED" || error.name === "AbortError",
      );
      const second = assert.rejects(
        app.checkFeedsForChannel(1, { ...channel, cacheKey: "second" }),
        (error) => error.code === "ERR_CANCELED" || error.name === "AbortError",
      );
      await until(() =>
        Object.values(app.channelStates).some(
          (state) => state.reason === reason,
        ),
      );
      assert.ok(
        Object.values(app.channelStates).every((state) => state.failures === 0),
      );
      await app.shutdown({ graceMs: 0, persistCache: false });
      await Promise.all([first, second]);
      assert.ok(
        Object.values(app.channelStates).every(
          (state) => state.status === "cancelled" && state.failures === 0,
        ),
      );
      assert.equal(app.network.snapshot().http.active, 0);
      assert.equal(app.network.snapshot().http.waiting, 0);
      assert.equal(app.network.snapshot().download.pending, 0);
    },
  );
}

test(
  "TASK 07: stopping queue during a cycle never schedules another timer",
  bounded,
  async () => {
    const entered = deferred(),
      release = deferred();
    let calls = 0;
    const queue = startChannelQueue({
      getChannels: () => [{ cacheKey: "one", TimeChecker: 1 }],
      delayBetweenChannels: 5,
      checkFeedsForChannel: async () => {
        calls++;
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    queue.stop();
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1);
  },
);

test(
  "TASK 07: successful deliveries stay cached when shutdown interrupts the send interval",
  bounded,
  async (t) => {
    const { directory } = await appFixture(t);
    const cacheStore = createCacheStore(
      path.join(directory, "delivery-cache.json"),
    );
    const delivered = deferred();
    const tasks = new ChannelTasks();
    const runner = createChannelRunner({
      cacheStore,
      fetchFeed: async () => [
        { title: "entry", link: "http://127.0.0.1/article" },
      ],
      sendMessage: async () => {
        delivered.resolve();
      },
    });
    const channel = {
      cacheKey: "channel",
      RSS: ["http://127.0.0.1/feed"],
      Webhook: "http://127.0.0.1/webhook",
    };
    const pending = assert.rejects(
      tasks.run(0, channel, runner.checkFeedsForChannel),
      { name: "AbortError" },
    );
    await delivered.promise;
    await new Promise(setImmediate);
    tasks.abort();
    await pending;
    const bucket = cacheStore.getChannelBucket("channel");
    assert.ok(
      bucket["http://127.0.0.1/feed::webhook"].includes(
        "http://127.0.0.1/article",
      ),
    );
    assert.equal(tasks.snapshot().channel.status, "cancelled");
  },
);

test(
  "TASK 13: three downloads share Medium; Custom directions remain independent",
  bounded,
  async (t) => {
    const bytes = 512 * 1024;
    const source = await serve(t, (_req, res) => res.end(Buffer.alloc(bytes)));
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 3 }, () =>
        getWithFallback(
          source.url,
          options(
            { bandwidthProfile: "medium" },
            { responseType: "arraybuffer" },
          ),
        ),
      ),
    );
    const elapsed = performance.now() - start;
    assert.ok(elapsed > 1000 && elapsed < 5500, `${elapsed}ms`);
    assert.equal(getNetwork().metricsSnapshot().downloadedBytes, bytes * 3);
    const received = [];
    const destination = await serve(t, async (req, res) => {
      received.push(await readBody(req));
      res.end(Buffer.alloc(2000));
    });
    const settings = {
      ...base,
      network: {
        bandwidthProfile: "custom",
        downloadLimitMbps: 0.032,
        uploadLimitMbps: 0.016,
      },
    };
    const result = await getHttpClient("unused", settings).post(
      destination.url,
      Buffer.alloc(1000, 0x62),
      { responseType: "arraybuffer" },
    );
    assert.deepEqual(received[0], Buffer.alloc(1000, 0x62));
    assert.equal(result.data.length, 2000);
    const snapshot = getNetwork().snapshot();
    assert.equal(snapshot.download.rate, 4000);
    assert.equal(snapshot.upload.rate, 2000);
  },
);

for (const profile of ["potato", "unlimited"])
  test(
    `TASK 13: destroying ${profile} → limited stream removes pending bandwidth immediately`,
    bounded,
    async (t) => {
      const bodyReady = deferred();
      t.after(() => bodyReady.resolve());
      const server = await serve(t, async (_req, res) => {
        res.flushHeaders();
        await bodyReady.promise;
        res.end(Buffer.alloc(10000));
      });
      const response = await getWithFallback(
        server.url,
        options({ bandwidthProfile: profile }, { responseType: "stream" }),
      );
      getNetwork().configure({ bandwidthProfile: "potato" });
      response.data.resume();
      // The new profile applies to future bytes, not bytes already delivered
      // into the native Unlimited buffer before the setting changed.
      bodyReady.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(getNetwork().snapshot().download.pending > 0);
      response.data.destroy();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getNetwork().snapshot().download.pending, 0);
      assert.equal(getNetwork().snapshot().http.active, 0);
    },
  );

test(
  "TASK 13: an active Unlimited stream safely adopts a smaller runtime limit",
  bounded,
  async (t) => {
    const next = deferred();
    t.after(() => next.resolve());
    const server = await serve(t, async (_req, res) => {
      res.write("first");
      await next.promise;
      res.end(Buffer.alloc(1250));
    });
    const response = await getWithFallback(
      server.url,
      options({}, { responseType: "stream" }),
    );
    const stream = response.data[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value.toString(), "first");
    getNetwork().configure({ bandwidthProfile: "potato" });
    const start = performance.now();
    next.resolve();
    let bytes = 0;
    for await (const chunk of stream) bytes += chunk.length;
    assert.equal(bytes, 1250);
    assert.ok(performance.now() - start > 750);
  },
);
