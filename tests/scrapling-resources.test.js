"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveResourcePolicy,
  resolveScraplingConcurrency,
} = require("../src/extensions/Scrapling/resource-policy");
const { Scrapling } = require("../src/extensions/Scrapling");
const cli = require("../src/extensions/Scrapling/cli");
const shell = require("../src/extensions/Scrapling/shell");
const worker = require("../src/extensions/Scrapling/browser-worker");
const { download } = require("../src/parsers/downloader");
const { EventEmitter } = require("node:events");
const { runChild } = require("../src/extensions/Scrapling/process-control");
const {
  offline,
  mockScraplingDetector,
  deferred,
  serve,
} = require("./fixtures/network.cjs");

beforeEach((t) => {
  offline(t);
  mockScraplingDetector(t, true);
});
const bounded = { timeout: 10000 };
const url = "http://127.0.0.1/fixture";

test("Saving defaults on, global/per-URL off work, explicit native options win", () => {
  assert.deepEqual(resolveResourcePolicy(), { disableResources: true });
  assert.equal(
    resolveResourcePolicy({ scraplingResourceSaving: false }).disableResources,
    false,
  );
  assert.equal(
    resolveResourcePolicy({}, { scraplingResourceSaving: false })
      .disableResources,
    false,
  );
  assert.equal(
    resolveResourcePolicy(
      { scraplingResourceSaving: false },
      {},
      { scraplingResourceSaving: true },
    ).disableResources,
    true,
  );
  assert.equal(
    resolveResourcePolicy({}, { disableResources: false }).disableResources,
    false,
  );
  assert.equal(
    resolveResourcePolicy(
      { scraplingResourceSaving: false },
      { disableResources: true },
    ).disableResources,
    true,
  );
  assert.equal(
    resolveResourcePolicy().blockAds,
    undefined,
    "Saving must not silently enable ad blocking",
  );
  assert.equal(resolveResourcePolicy().blockedDomains, undefined);
});

test("per-URL aliases override default aliases and request options take precedence", () => {
  const defaults = {
    disableResources: true,
    blockAds: true,
    blockedDomains: ["ads.invalid"],
  };
  const perURL = {
    disable_resources: false,
    block_ads: false,
    blocked_domains: [],
  };
  assert.deepEqual(resolveResourcePolicy({}, defaults, perURL), {
    disableResources: false,
    blockAds: false,
    blockedDomains: [],
  });
  assert.equal(
    resolveResourcePolicy({}, defaults, perURL, { disableResources: true })
      .disableResources,
    true,
  );
  assert.deepEqual(
    defaults.blockedDomains,
    ["ads.invalid"],
    "Resolution must not mutate configuration",
  );
});

test("Scrapling concurrency defaults to one in Friendly Mode with a positive explicit override", () => {
  assert.equal(resolveScraplingConcurrency(), Infinity);
  assert.equal(resolveScraplingConcurrency({ networkFriendlyMode: true }), 1);
  assert.equal(
    resolveScraplingConcurrency({
      networkFriendlyMode: true,
      maxConcurrentScraplingRequests: 2,
    }),
    2,
  );
  for (const value of [0, -1, 1.5, "2", NaN, Infinity]) {
    assert.throws(
      () =>
        resolveScraplingConcurrency({ maxConcurrentScraplingRequests: value }),
      /positive integer/,
    );
  }
  assert.throws(
    () => resolveResourcePolicy({ scraplingResourceSaving: "false" }),
    /boolean/,
  );
});

for (const runtime of ["cli", "shell", "session"]) {
  test(
    `${runtime}: browser fetch receives native Saving options and the per-URL override`,
    bounded,
    async (t) => {
      const calls = [];
      t.mock.method(cli, "extract", async (_cmd, options) => {
        calls.push(options);
        return { html: "ok" };
      });
      t.mock.method(shell, "fetch", async (_cmd, options) => {
        calls.push(options);
        return { html: "ok" };
      });
      t.mock.method(worker, "fetch", async (_cmd, _url, _mode, options) => {
        calls.push(options);
        return { html: "ok" };
      });
      const scrapling = new Scrapling({
        Scrapling: {
          Enabled: true,
          PreferredMode: runtime === "shell" ? "shell" : "cli",
          PersistentBrowserSessions: runtime === "session",
          PerUrlConfig: { [url]: { scraplingResourceSaving: false } },
        },
      });
      const first = await scrapling.fetch(`${url}/default`, { mode: "fetch" });
      const second = await scrapling.fetch(url, { mode: "fetch" });
      assert.equal(first.runtime, runtime);
      assert.equal(second.runtime, runtime);
      assert.equal(calls[0].disableResources, true);
      assert.equal(calls[1].disableResources, false);
      assert.equal(calls[0].blockAds, undefined);
      assert.equal(calls[0].scraplingResourceSaving, undefined);
    },
  );
}

test(
  "plain HTTP Scrapling get receives no automatic browser resource options",
  bounded,
  async (t) => {
    const extract = t.mock.method(cli, "extract", async (_cmd, options) => {
      assert.equal(options.disableResources, undefined);
      return { html: "ok" };
    });
    await new Scrapling().fetch(url, { mode: "get" });
    assert.equal(extract.mock.callCount(), 1);
  },
);

for (const limit of [1, 2]) {
  test(
    `Friendly Mode limits all Scrapling instances to ${limit} concurrent jobs and releases permits`,
    bounded,
    async (t) => {
      const entered = deferred();
      const release = deferred();
      t.after(release.resolve);
      let active = 0,
        peak = 0,
        calls = 0;
      t.mock.method(shell, "fetch", async () => {
        active++;
        calls++;
        peak = Math.max(peak, active);
        if (active === limit) entered.resolve();
        try {
          await release.promise;
          return { html: "ok" };
        } finally {
          active--;
        }
      });
      const config = {
        network: {
          networkFriendlyMode: true,
          ...(limit === 2 ? { maxConcurrentScraplingRequests: 2 } : {}),
        },
        Scrapling: { PreferredMode: "shell", PersistentBrowserSessions: false },
      };
      const a = new Scrapling(config),
        b = new Scrapling(config);
      const tasks = [
        a.fetch(url, { mode: "fetch" }),
        b.fetch(url, { mode: "fetch" }),
        a.fetch(url, { mode: "fetch" }),
      ];
      await entered.promise;
      await new Promise(setImmediate);
      assert.equal(calls, limit);
      release.resolve();
      await Promise.all(tasks);
      assert.equal(peak, limit);
      assert.equal(active, 0);
      assert.equal(calls, 3);
    },
  );
}

test(
  "queued abort never starts a runtime and errors release the Friendly permit",
  bounded,
  async (t) => {
    const entered = deferred(),
      release = deferred();
    t.after(release.resolve);
    let calls = 0;
    t.mock.method(shell, "fetch", async () => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
        throw new Error("fixture failure");
      }
      return { html: "ok" };
    });
    const scrapling = new Scrapling({
      network: { networkFriendlyMode: true },
      Scrapling: { PreferredMode: "shell", PersistentBrowserSessions: false },
    });
    const failed = assert.rejects(
      scrapling.fetch(url, { mode: "fetch" }),
      /fixture failure/,
    );
    await entered.promise;
    const controller = new AbortController();
    const cancelled = assert.rejects(
      scrapling.fetch(url, { mode: "fetch", signal: controller.signal }),
      { name: "AbortError" },
    );
    controller.abort();
    await cancelled;
    assert.equal(calls, 1);
    release.resolve();
    await failed;
    await scrapling.fetch(url, { mode: "fetch" });
    assert.equal(calls, 2);
  },
);

test(
  "downloader stops Scrapling fallback after abort rather than retrying another mode",
  bounded,
  async (t) => {
    const entered = deferred();
    const server = await serve(t, (_req, res) => {
      res.writeHead(403);
      res.end();
    });
    const controller = new AbortController();
    const fetch = t.mock.method(shell, "fetch", async (_cmd, options) => {
      entered.resolve();
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("fixture abort");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        ),
      );
    });
    const pending = assert.rejects(
      download(server.url, {
        signal: controller.signal,
        config: {
          Proxy: { Enabled: false },
          Scrapling: { Enabled: true, PersistentBrowserSessions: false },
        },
      }),
      { name: "AbortError" },
    );
    await entered.promise;
    controller.abort();
    await pending;
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(server.requests.length, 1);
  },
);

test(
  "CLI/shell process boundary rejects pre-abort without spawning and waits for child close after active abort",
  bounded,
  async () => {
    let calls = 0;
    const child = new EventEmitter();
    child.exitCode = null;
    const closed = deferred();
    child.kill = (signal) => {
      assert.equal(signal, "SIGTERM");
      closed.promise.then(() => {
        child.exitCode = 0;
        child.emit("close");
      });
    };
    const fakeExec = (_command, _args, options) => {
      calls++;
      assert.equal(options.timeout, 5000);
      return child;
    };
    await assert.rejects(
      runChild(fakeExec, "fixture", [], 5000, AbortSignal.abort()),
      { name: "AbortError" },
    );
    assert.equal(calls, 0);
    const controller = new AbortController();
    let settled = false;
    const pending = assert.rejects(
      runChild(fakeExec, "fixture", [], 5000, controller.signal).finally(() => {
        settled = true;
      }),
      { name: "AbortError" },
    );
    controller.abort();
    await new Promise(setImmediate);
    assert.equal(
      settled,
      false,
      "Do not release concurrency before browser process cleanup",
    );
    closed.resolve();
    await pending;
    assert.equal(calls, 1);
  },
);

test(
  "closing browser sessions cancels Friendly waiters instead of starting another browser",
  bounded,
  async (t) => {
    const entered = deferred(),
      release = deferred();
    t.after(release.resolve);
    t.mock.method(worker, "close", async () => {
      release.resolve();
    });
    const fetch = t.mock.method(worker, "fetch", async () => {
      entered.resolve();
      await release.promise;
      return { html: "ok" };
    });
    const scrapling = new Scrapling({ network: { networkFriendlyMode: true } });
    const active = scrapling.fetch(url, { mode: "fetch" });
    await entered.promise;
    const waiting = assert.rejects(scrapling.fetch(url, { mode: "fetch" }), {
      name: "AbortError",
    });
    await scrapling.closeBrowserSessions();
    await Promise.all([active, waiting]);
    assert.equal(fetch.mock.callCount(), 1);
  },
);
