"use strict";

// Integration suite: real pinned Scrapling + Chromium, loopback fixture only.
// Kept separate from npm test so the Node suite needs no Python/browser install.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { Scrapling } = require("../src/extensions/Scrapling");
const worker = require("../src/extensions/Scrapling/browser-worker");
const { getNetwork, resetNetwork } = require("../src/network/service");
const { download } = require("../src/parsers/downloader");
const {
  serve,
  offline,
  deferred,
  mockScraplingDetector,
} = require("./fixtures/network.cjs");

const python =
  process.env.XFEEDER_SCRAPLING_PYTHON ||
  path.resolve("src/extensions/Scrapling/.venv/bin/python");
const executable = process.env.XFEEDER_BROWSER_PATH;
const common = {
  mode: "fetch",
  timeoutMs: 10000,
  timeout: 20,
  retries: 1,
  waitSelector: "#ready",
  googleSearch: false,
  extraHeaders: { "x-browser-fixture": "yes" },
  ...(executable ? { executablePath: executable } : {}),
  // Test-only guard. Production uses Scrapling's native resource policy.
  pageSetup: `def page_setup(page):
    from urllib.parse import urlsplit
    def local_only(route):
        if urlsplit(route.request.url).hostname in ('127.0.0.1', 'localhost'):
            route.fallback()
        else:
            route.abort()
    page.route('**/*', local_only)
`,
};

function useRealPython(scrapling) {
  scrapling.detector.pythonCmd = python;
  scrapling.detector.scraplingCmd = path.join(
    path.dirname(python),
    "scrapling",
  );
  return scrapling;
}

async function fixture(t) {
  resetNetwork();
  offline(t);
  mockScraplingDetector(t, true);
  const arrived = deferred();
  const server = await serve(t, (req, res) => {
    if (!req.headers["x-browser-fixture"]) {
      res.writeHead(403);
      res.end("Browser required");
      return;
    }
    if (req.url === "/app.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(`fetch('/data').then(r => r.json()).then(data => {
        const ready = () => { document.body.insertAdjacentHTML('beforeend', '<article id="ready">' + data.title + '</article>'); };
        if (location.pathname === '/needs-css') {
          const check = () => getComputedStyle(document.body).getPropertyValue('--fixture-ready').trim() === 'yes' ? ready() : setTimeout(check, 10);
          check();
        } else ready();
      });`);
    } else if (req.url === "/data") {
      res.setHeader("Content-Type", "application/json");
      res.end('{"title":"Dynamic fixture entry"}');
    } else if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end("body { --fixture-ready: yes; }");
    } else if (req.url === "/image.svg") {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
      );
    } else if (req.url === "/hang") {
      res.end("<html><body>Waiting for abort</body></html>");
      arrived.resolve();
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><img src="/image.svg"><script src="/app.js"></script></body></html>',
      );
    }
  });
  t.after(() => worker.close());
  return { ...server, arrived };
}

test("pinned Scrapling 0.4.15 is the runtime used by the browser suite", () => {
  const version = execFileSync(
    python,
    [
      "-c",
      "import importlib.metadata; print(importlib.metadata.version('scrapling'))",
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(version, "0.4.15");
});

for (const setting of ["default", "disabled", "per-url"]) {
  test(
    `real browser ${setting}: dynamic fallback works and native resource policy is enforced`,
    { timeout: 45000 },
    async (t) => {
      const server = await fixture(t);
      const target = `${server.url}/${setting === "default" ? "dynamic" : "needs-css"}`;
      const config = {
        Proxy: { Enabled: false },
        network: {
          networkFriendlyMode: true,
          ...(setting === "disabled" ? { scraplingResourceSaving: false } : {}),
        },
        Scrapling: {
          Enabled: true,
          DefaultOptions: common,
          AntiBot: {
            ModeOrder: ["fetch"],
            MaxAttempts: 1,
            PreferStealthOnSignals: false,
          },
          PerUrlConfig:
            setting === "per-url"
              ? { [target]: { scraplingResourceSaving: false } }
              : {},
        },
      };
      const { getScrapling } = require("../src/extensions/Scrapling");
      useRealPython(getScrapling(config));
      const result = await download(target, { config });
      assert.equal(result.ok, true, result.error?.message || result.reason);
      assert.equal(result.scraplingRuntime, "session");
      assert.match(result.data, /id="ready">Dynamic fixture entry/);
      assert.equal(
        server.requests[0].headers["x-browser-fixture"],
        undefined,
        "Start with ordinary HTTP then fall back",
      );
      assert.ok(server.requests.some((req) => req.url === "/app.js"));
      assert.ok(server.requests.some((req) => req.url === "/data"));
      assert.equal(
        server.requests.some((req) => req.url === "/style.css"),
        setting !== "default",
      );
      assert.equal(
        server.requests.some((req) => req.url === "/image.svg"),
        setting !== "default",
      );
    },
  );
}

test(
  "real shell browser uses the same resource policy",
  { timeout: 45000 },
  async (t) => {
    const server = await fixture(t);
    const scrapling = useRealPython(
      new Scrapling({
        Scrapling: { PreferredMode: "shell", PersistentBrowserSessions: false },
      }),
    );
    const result = await scrapling.fetch(`${server.url}/dynamic`, common);
    assert.match(result.html, /id="ready">Dynamic fixture entry/);
    assert.equal(result.runtime, "shell");
    assert.equal(
      server.requests.some((req) => req.url === "/style.css"),
      false,
    );
  },
);

function descendants(pid) {
  if (process.platform !== "linux") return [];
  try {
    const children = fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    return children.flatMap((child) => [child, ...descendants(child)]);
  } catch {
    return [];
  }
}

function assertStopped(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    assert.match(
      status,
      /^State:\s+Z/m,
      `Process ${pid} still running after abort`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

test("TASK 07: network shutdown aborts active Scrapling and cleans the real browser tree", { timeout: 45000 }, async (t) => {
  const server = await fixture(t);
  const scrapling = useRealPython(new Scrapling({ network: { networkFriendlyMode: true } }));
  const pending = assert.rejects(scrapling.fetch(`${server.url}/hang`, { ...common, waitSelector: "#never" }), { name: "AbortError" });
  await server.arrived.promise;
  const pid = worker.child.pid;
  const children = descendants(pid);
  await getNetwork().shutdown(0);
  await pending;
  await scrapling.closeBrowserSessions();
  if (process.platform === "linux") [pid, ...children].forEach(assertStopped);
  assert.equal(getNetwork().snapshot().scrapling.active, 0);
  assert.equal(getNetwork().snapshot().operations, 0);
});

test(
  "abort terminates the managed browser tree, preserves queued work and permits a fresh fetch",
  { timeout: 45000 },
  async (t) => {
    const server = await fixture(t);
    const scrapling = useRealPython(new Scrapling());
    const controller = new AbortController();
    const pending = assert.rejects(
      scrapling.fetch(`${server.url}/hang`, {
        ...common,
        signal: controller.signal,
        waitSelector: "#never",
      }),
      { name: "AbortError" },
    );
    await server.arrived.promise;
    const pid = worker.child.pid;
    const children = descendants(pid);
    if (process.platform === "linux")
      assert.ok(
        children.length > 1,
        "Real browser descendants must be present",
      );
    const next = scrapling.fetch(`${server.url}/dynamic`, common);
    controller.abort();
    await pending;
    if (process.platform === "linux") [pid, ...children].forEach(assertStopped);
    const response = await next;
    assert.match(response.html, /id="ready">Dynamic fixture entry/);
    assert.notEqual(worker.child.pid, pid);
  },
);
