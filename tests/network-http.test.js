"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { performance } = require("node:perf_hooks");
const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const {
  getWithFallback,
  postWithFallback,
  getRetryAfterMs,
  getHttpClient,
} = require("../src/client");
const {
  config,
  requestOptions: opts,
  deferred,
  offline,
  serve,
  readBody,
  holdDelay,
} = require("./fixtures/network.cjs");

beforeEach(offline);
const bounded = { timeout: 10000 };

test(
  "HTTP GET preserves status, headers and body; POST sends JSON once",
  bounded,
  async (t) => {
    const server = await serve(t, async (req, res) => {
      const body = await readBody(req);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Fixture": "baseline",
      });
      res.end(JSON.stringify({ method: req.method, body: body.toString() }));
    });
    const get = await getWithFallback(server.url, opts);
    assert.equal(get.status, 200);
    assert.equal(get.headers["x-fixture"], "baseline");
    assert.deepEqual(get.data, { method: "GET", body: "" });
    const post = await postWithFallback(server.url, { title: "Żółw" }, opts);
    assert.deepEqual(JSON.parse(post.data.body), { title: "Żółw" });
    assert.equal(server.requests.length, 2);
  },
);

test(
  "chunked response exposes the first chunk before the server finishes",
  bounded,
  async (t) => {
    const finish = deferred();
    t.after(finish.resolve);
    const server = await serve(t, async (_req, res) => {
      res.write("first-");
      await finish.promise;
      res.end("last");
    });
    const response = await getWithFallback(server.url, {
      ...opts,
      responseType: "stream",
    });
    assert.equal(response.headers["transfer-encoding"], "chunked");
    const iterator = response.data[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.toString(), "first-");
    finish.resolve();
    const remaining = [];
    for await (const chunk of iterator) remaining.push(chunk);
    assert.equal(Buffer.concat(remaining).toString(), "last");
  },
);

test(
  "connection reset before headers is propagated and retries are bounded",
  bounded,
  async (t) => {
    const server = await serve(t, (req) => req.socket.destroy());
    await assert.rejects(
      getWithFallback(server.url, {
        ...opts,
        maxAttempts: 3,
        retryBaseDelayMs: 0,
      }),
      { code: "ECONNRESET" },
    );
    assert.equal(server.requests.length, 3);
  },
);

test(
  "interrupted response stream rejects without silently retrying partial data",
  bounded,
  async (t) => {
    let response;
    const server = await serve(t, (_req, res) => {
      response = res;
      res.write("partial");
    });
    const result = await getWithFallback(server.url, {
      ...opts,
      responseType: "stream",
      maxAttempts: 3,
    });
    const reading = assert.rejects(
      readBody(result.data),
      (error) =>
        error.code === "ECONNRESET" || error.code === "ERR_BAD_RESPONSE",
    );
    response.destroy();
    await reading;
    assert.equal(server.requests.length, 1);
  },
);

test(
  "a server that never responds reaches the configured request timeout",
  bounded,
  async (t) => {
    const server = await serve(t, () => {});
    await assert.rejects(
      getWithFallback(server.url, { ...opts, timeout: 80 }),
      { code: "ECONNABORTED" },
    );
    assert.equal(server.requests.length, 1);
  },
);

test(
  "redirect is followed and 304 is accepted without retries",
  bounded,
  async (t) => {
    const server = await serve(t, (req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/cached" });
        res.end();
      } else {
        res.writeHead(304, { ETag: '"v1"' });
        res.end();
      }
    });
    const response = await getWithFallback(`${server.url}/redirect`, {
      ...opts,
      maxAttempts: 3,
    });
    assert.equal(response.status, 304);
    assert.equal(response.data, "");
    assert.equal(response.headers.etag, '"v1"');
    assert.deepEqual(
      server.requests.map((r) => r.url),
      ["/redirect", "/cached"],
    );
  },
);

test("403 is permanent and never retried", bounded, async (t) => {
  const server = await serve(t, (_req, res) => {
    res.writeHead(403);
    res.end("forbidden");
  });
  await assert.rejects(
    getWithFallback(server.url, { ...opts, maxAttempts: 5 }),
    (error) =>
      error.response.status === 403 && error.response.data === "forbidden",
  );
  assert.equal(server.requests.length, 1);
});

for (const status of [500, 502, 503, 504]) {
  test(
    `${status} retries up to the configured attempt limit`,
    bounded,
    async (t) => {
      const server = await serve(t, (_req, res) => {
        res.writeHead(status);
        res.end("temporary");
      });
      await assert.rejects(
        getWithFallback(server.url, {
          ...opts,
          maxAttempts: 3,
          retryBaseDelayMs: 0,
        }),
        (error) => error.response.status === status,
      );
      assert.equal(server.requests.length, 3);
    },
  );
}

test(
  "429 respects Retry-After before the successful retry, even above the backoff cap",
  bounded,
  async (t) => {
    const delay = holdDelay(t, 2000);
    const server = await serve(t, (_req, res, requests) => {
      res.writeHead(requests.length === 1 ? 429 : 200, { "Retry-After": "2" });
      res.end("ok");
    });
    const pending = getWithFallback(server.url, {
      ...opts,
      maxAttempts: 2,
      retryMaxDelayMs: 1,
    });
    await delay.scheduled;
    assert.equal(server.requests.length, 1);
    delay.release();
    assert.equal((await pending).status, 200);
    assert.equal(server.requests.length, 2);
  },
);

test("Retry-After supports seconds, HTTP dates and invalid values", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(getRetryAfterMs({ "Retry-After": "0.125" }, now), 125);
  assert.equal(
    getRetryAfterMs({ "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" }, now),
    3000,
  );
  assert.equal(
    getRetryAfterMs({ "retry-after": "Wed, 31 Dec 2025 00:00:00 GMT" }, now),
    0,
  );
  assert.equal(getRetryAfterMs({ "retry-after": "invalid" }, now), null);
  assert.equal(getRetryAfterMs({}, now), null);
});

test(
  "transient recovery uses exponential backoff and jitter",
  bounded,
  async (t) => {
    t.mock.method(Math, "random", () => 0.75); // jitter multiplier = 1.1
    const firstDelay = holdDelay(t, 110);
    const secondDelay = holdDelay(t, 220);
    const server = await serve(t, (_req, res, requests) => {
      res.writeHead(requests.length < 3 ? 500 : 200);
      res.end("ok");
    });
    const pending = getWithFallback(server.url, {
      ...opts,
      maxAttempts: 3,
      retryBaseDelayMs: 100,
    });
    await firstDelay.scheduled;
    assert.equal(server.requests.length, 1);
    firstDelay.release();
    await secondDelay.scheduled;
    assert.equal(server.requests.length, 2);
    secondDelay.release();
    assert.equal((await pending).status, 200);
  },
);

test(
  "simultaneous requests reach the server before either response completes",
  bounded,
  async (t) => {
    const both = deferred();
    const server = await serve(t, (_req, res, requests) => {
      if (requests.length === 2) both.resolve();
      return both.promise.then(() => res.end("ok"));
    });
    t.after(both.resolve);
    const responses = await Promise.all([
      getWithFallback(server.url, opts),
      getWithFallback(server.url, opts),
    ]);
    assert.deepEqual(
      responses.map((r) => r.data),
      ["ok", "ok"],
    );
    assert.equal(server.requests.length, 2);
  },
);

test(
  "AbortSignal cancels an active request and closes its server socket without retry",
  bounded,
  async (t) => {
    const arrived = deferred();
    const closed = deferred();
    const server = await serve(t, (req) => {
      req.socket.once("close", closed.resolve);
      arrived.resolve();
    });
    const controller = new AbortController();
    const rejected = assert.rejects(
      getWithFallback(server.url, {
        ...opts,
        maxAttempts: 3,
        signal: controller.signal,
      }),
      { code: "ERR_CANCELED" },
    );
    await arrived.promise;
    controller.abort();
    await rejected;
    await closed.promise;
    assert.equal(server.requests.length, 1);
  },
);

test(
  "AbortSignal cancels a response stream after headers",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => res.write("partial"));
    const controller = new AbortController();
    const response = await getWithFallback(server.url, {
      ...opts,
      responseType: "stream",
      signal: controller.signal,
    });
    const rejected = assert.rejects(readBody(response.data), {
      code: "ERR_CANCELED",
    });
    controller.abort();
    await rejected;
    assert.equal(response.data.destroyed, true);
    assert.equal(server.requests.length, 1);
  },
);

test("an already aborted signal sends no GET or POST", bounded, async (t) => {
  const server = await serve(t, (_req, res) => res.end("unexpected"));
  const options = { ...opts, signal: AbortSignal.abort() };
  await assert.rejects(getWithFallback(server.url, options), {
    code: "ERR_CANCELED",
  });
  await assert.rejects(postWithFallback(server.url, {}, options), {
    code: "ERR_CANCELED",
  });
  assert.equal(server.requests.length, 0);
});

test(
  "abort during retry cancels backoff immediately and sends no next request",
  bounded,
  async (t) => {
    const delay = holdDelay(t, 2000);
    const server = await serve(t, (_req, res) => {
      res.writeHead(429, { "Retry-After": "2" });
      res.end();
    });
    const controller = new AbortController();
    let settled = false;
    const pending = getWithFallback(server.url, {
      ...opts,
      maxAttempts: 2,
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      pending.finally(() => {
        settled = true;
      }),
      { code: "ERR_CANCELED" },
    );
    await delay.scheduled;
    controller.abort();
    await new Promise(setImmediate);
    assert.equal(
      settled,
      true,
      "Abort must settle without releasing the held retry timer",
    );
    delay.release();
    await rejected;
    assert.equal(server.requests.length, 1);
  },
);

test(
  "decompression preserves bytes and buffered response size limits still apply",
  bounded,
  async (t) => {
    const body = Buffer.from("Zażółć gęślą jaźń. ".repeat(1000));
    const server = await serve(t, (_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(gzipSync(body));
    });
    const response = await getWithFallback(server.url, {
      ...opts,
      responseType: "arraybuffer",
    });
    assert.deepEqual(response.data, body);
    await assert.rejects(
      getWithFallback(server.url, { ...opts, maxContentLength: 100 }),
      /maxContentLength/,
    );
    assert.equal(server.requests.length, 2);
  },
);

test(
  "invalid URLs and unsupported protocols fail before network access",
  bounded,
  async () => {
    for (const request of [
      getWithFallback,
      (url, options) => postWithFallback(url, {}, options),
    ]) {
      await assert.rejects(request("not a url", opts), { code: "INVALID_URL" });
      await assert.rejects(request("file:///tmp/unused", opts), {
        code: "UNSUPPORTED_PROTOCOL",
      });
    }
  },
);

test(
  "configured HTTP proxy forwards absolute URLs and receives proxy authentication",
  bounded,
  async (t) => {
    const target = await serve(t, (_req, res) => res.end("via proxy"));
    const proxy = await serve(t, (req, res) => {
      const destination = new URL(req.url);
      assert.equal(destination.origin, target.url);
      const upstream = http.request(
        destination,
        { headers: { "X-From-Proxy": "yes" } },
        (incoming) => incoming.pipe(res),
      );
      upstream.on("error", (error) => res.destroy(error));
      req.pipe(upstream);
    });
    const proxyConfig = {
      Proxy: {
        Enabled: true,
        Url: proxy.url.replace("://", "://fixture:password@"),
      },
    };
    const response = await getWithFallback(`${target.url}/feed`, {
      ...opts,
      config: proxyConfig,
    });
    assert.equal(response.data, "via proxy");
    assert.equal(proxy.requests.length, 1);
    assert.equal(proxy.requests[0].url, `${target.url}/feed`);
    assert.equal(
      proxy.requests[0].headers["proxy-authorization"],
      `Basic ${Buffer.from("fixture:password").toString("base64")}`,
    );
    assert.equal(target.requests[0].headers["x-from-proxy"], "yes");
    assert.equal(target.requests[0].headers["proxy-authorization"], undefined);
    const proxied = getHttpClient("unused", proxyConfig);
    assert.equal(
      proxied.defaults.httpsAgent.constructor.name,
      "HttpsProxyAgent",
    );
    assert.notEqual(
      getHttpClient("unused", config),
      proxied,
      "Changing proxy configuration invalidates the cached client",
    );
  },
);

for (const network of [undefined, { bandwidthProfile: "unlimited" }]) {
  test(
    `Unlimited (${network ? "explicit" : "legacy config"}) streams a large payload without a low bandwidth cap`,
    bounded,
    async (t) => {
      // Smoke regression, not a throughput benchmark: 16 MiB needs >13 seconds
      // at 10 Mbps. The 5-second allowance is generous for a loopback transfer.
      const chunk = Buffer.alloc(64 * 1024, 0x5a);
      const chunks = 256;
      const expected = createHash("sha256");
      for (let i = 0; i < chunks; i++) expected.update(chunk);
      const server = await serve(t, async (_req, res) => {
        for (let i = 0; i < chunks; i++) {
          if (!res.write(chunk)) await once(res, "drain");
        }
        res.end();
      });
      const started = performance.now();
      const response = await getWithFallback(server.url, {
        ...opts,
        config: { ...config, ...(network ? { network } : {}) },
        responseType: "stream",
      });
      const actual = createHash("sha256");
      let bytes = 0;
      for await (const part of response.data) {
        bytes += part.length;
        actual.update(part);
      }
      const elapsed = performance.now() - started;
      assert.equal(bytes, chunk.length * chunks);
      assert.equal(actual.digest("hex"), expected.digest("hex"));
      assert.ok(
        elapsed < 5000,
        `Loopback transfer took ${Math.round(elapsed)} ms; expected <5000 ms`,
      );
    },
  );
}
