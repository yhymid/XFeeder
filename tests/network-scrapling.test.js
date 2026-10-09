"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const childProcess = require("node:child_process");
const {
  config,
  offline,
  serve,
  mockScraplingDetector,
} = require("./fixtures/network.cjs");
const { rss } = require("./fixtures/feeds.cjs");
const { Scrapling, getScrapling } = require("../src/extensions/Scrapling");
const cli = require("../src/extensions/Scrapling/cli");
const shell = require("../src/extensions/Scrapling/shell");
const worker = require("../src/extensions/Scrapling/browser-worker");
const { download } = require("../src/parsers/downloader");

beforeEach((t) => {
  offline(t);
  mockScraplingDetector(t, true);
  // Any runtime not explicitly selected/mocked by a test must fail locally.
  for (const [runtime, method] of [
    [cli, "extract"],
    [shell, "fetch"],
    [worker, "fetch"],
  ]) {
    t.mock.method(runtime, method, async () => {
      throw new Error("Unmocked Scrapling runtime");
    });
  }
});
const enabledConfig = { ...config, Scrapling: { Enabled: true } };
const bounded = { timeout: 10000 };
const fetched = {
  html: rss,
  status: 200,
  headers: { "content-type": "application/rss+xml" },
};

test(
  "Scrapling selects CLI, metadata shell and persistent browser session runtimes",
  bounded,
  async (t) => {
    const calls = [];
    t.mock.method(cli, "extract", async (command, options) => {
      calls.push({ runtime: "cli", command, options });
      return fetched;
    });
    t.mock.method(shell, "fetch", async (command, options) => {
      calls.push({ runtime: "shell", command, options });
      return fetched;
    });
    t.mock.method(worker, "fetch", async (command, url, mode, options) => {
      calls.push({ runtime: "session", command, url, mode, options });
      return fetched;
    });
    const scrapling = new Scrapling(enabledConfig);
    const url = "http://127.0.0.1/fixture";
    assert.equal((await scrapling.fetch(url, { mode: "get" })).runtime, "cli");
    const metadata = await scrapling.fetch(url, {
      mode: "get",
      includeResponseMetadata: true,
    });
    assert.equal(metadata.runtime, "shell");
    assert.equal(metadata.runtimeAutoSwitched, true);
    assert.equal(
      (
        await scrapling.fetch(url, {
          mode: "stealthy-fetch",
          proxy: "http://127.0.0.1:9999",
        })
      ).runtime,
      "session",
    );
    assert.deepEqual(
      calls.map((call) => call.runtime),
      ["cli", "shell", "session"],
    );
    assert.equal(calls[0].command, "fixture-scrapling");
    assert.equal(calls[1].command, "fixture-python");
    assert.equal(calls[1].options.includeResponseMetadata, true);
    assert.equal(calls[2].url, url);
    assert.equal(calls[2].mode, "stealthy-fetch");
    assert.equal(calls[2].options.proxy, "http://127.0.0.1:9999");
    let closed = 0;
    t.mock.method(worker, "close", async () => {
      closed++;
    });
    await scrapling.closeBrowserSessions();
    assert.equal(closed, 1);
  },
);

test(
  "downloader falls back to Scrapling after HTTP 403",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => {
      res.writeHead(403);
      res.end("forbidden");
    });
    const scrapling = getScrapling(enabledConfig);
    const fetch = t.mock.method(scrapling, "fetch", async (url, options) => {
      assert.equal(url, server.url);
      assert.equal(options.includeResponseMetadata, true);
      return { ...fetched, runtime: "shell" };
    });
    const result = await download(server.url, { config: enabledConfig });
    assert.equal(result.ok, true);
    assert.equal(result.scrapling, true);
    assert.equal(result.data, rss);
    assert.equal(server.requests.length, 1);
    assert.equal(fetch.mock.callCount(), 1);
  },
);

test(
  "429 exhausts shared GET retries without invoking Scrapling fallback",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => {
      res.writeHead(429, { "Retry-After": "0" });
      res.end("limited");
    });
    const scrapling = getScrapling(enabledConfig);
    const fetch = t.mock.method(scrapling, "fetch", async () => fetched);
    const result = await download(server.url, { config: enabledConfig });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "HTTP_RATE_LIMITED");
    assert.equal(result.status, 429);
    assert.equal(server.requests.length, 3);
    assert.equal(fetch.mock.callCount(), 0);
  },
);

test(
  "forced Scrapling bypasses HTTP and reports a bounded runtime failure",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) =>
      res.end("must not be requested"),
    );
    const forced = {
      ...config,
      Scrapling: {
        Enabled: true,
        ForceGlobal: true,
        AntiBot: { MaxAttempts: 1 },
      },
    };
    const scrapling = getScrapling(forced);
    const fetch = t.mock.method(scrapling, "fetch", async () => {
      throw new Error("fixture child failed");
    });
    const result = await download(server.url, { config: forced });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "SCRAPLING_FORCED_FAILED");
    assert.equal(server.requests.length, 0);
    assert.equal(fetch.mock.callCount(), 1);
  },
);

// These adapters destructure execFile on load. Reload just the adapter with a
// fake process boundary, then immediately restore the original module cache.
function loadAdapterWithFakeExec(t, name, implementation) {
  t.mock.method(childProcess, "execFile", implementation);
  const path = require.resolve(`../src/extensions/Scrapling/${name}`);
  const cached = require.cache[path];
  delete require.cache[path];
  try {
    return require(path);
  } finally {
    if (cached) require.cache[path] = cached;
    else delete require.cache[path];
  }
}

test(
  "CLI adapter passes URL/options and process deadline, then removes temporary output",
  bounded,
  async (t) => {
    let outputPath;
    const adapter = loadAdapterWithFakeExec(
      t,
      "cli",
      (command, args, options, callback) => {
        assert.equal(command, "fixture-scrapling");
        assert.deepEqual(args.slice(0, 3), [
          "extract",
          "get",
          "http://127.0.0.1/feed",
        ]);
        assert.equal(options.timeout, 7000);
        assert.equal(options.maxBuffer, 16 * 1024 * 1024);
        outputPath = args[3];
        t.after(() => fs.rmSync(outputPath, { force: true }));
        fs.writeFileSync(outputPath, rss);
        callback(null, "", "");
      },
    );
    const result = await adapter.extract("fixture-scrapling", {
      url: "http://127.0.0.1/feed",
      timeout: 7,
    });
    assert.equal(result.html, rss);
    assert.equal(result.runtime, "cli");
    assert.equal(result.status, null, "CLI does not supply HTTP metadata");
    assert.equal(fs.existsSync(outputPath), false);
  },
);

test(
  "shell adapter passes JSON options and preserves response metadata after diagnostic output",
  bounded,
  async (t) => {
    const adapter = loadAdapterWithFakeExec(
      t,
      "shell",
      (command, args, options, callback) => {
        assert.equal(command, "fixture-python");
        assert.equal(args[0], "-c");
        const payload = JSON.parse(args[2]);
        assert.equal(payload.url, "http://127.0.0.1/feed");
        assert.equal(payload.mode, "get");
        assert.equal(payload.proxy, "http://127.0.0.1:9999");
        assert.equal(options.timeout, 9000);
        callback(
          null,
          `fixture diagnostic\n${JSON.stringify({ ...fetched, url: payload.url })}\n`,
          "",
        );
      },
    );
    const result = await adapter.fetch("fixture-python", {
      url: "http://127.0.0.1/feed",
      mode: "get",
      proxy: "http://127.0.0.1:9999",
      timeout: 9,
    });
    assert.equal(result.status, 200);
    assert.equal(result.html, rss);
    assert.equal(result.headers["content-type"], "application/rss+xml");
    assert.equal(result.runtime, "shell");
  },
);

test(
  "shell process errors reject instead of producing a successful empty response",
  bounded,
  async (t) => {
    const adapter = loadAdapterWithFakeExec(
      t,
      "shell",
      (_command, _args, _options, callback) => {
        callback(new Error("fixture process killed"), "", "fixture timeout");
      },
    );
    await assert.rejects(
      adapter.fetch("fixture-python", { url: "http://127.0.0.1/feed" }),
      /fixture timeout/,
    );
  },
);
