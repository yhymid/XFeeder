"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { startDashboard } = require("../src/dashboard/server");
const { createApp } = require("../src/app/bootstrap");
const { resetNetwork, getNetwork } = require("../src/network/service");
const {
  readNetworkRuntime,
  runtimePath,
  startNetworkRuntime,
} = require("../src/network/runtime-state");
const {
  offline,
  serve,
  config,
  mockScraplingDetector,
} = require("./fixtures/network.cjs");
const { getWithFallback } = require("../src/client");
const bounded = { timeout: 15000 };
beforeEach((t) => {
  offline(t);
  resetNetwork();
  mockScraplingDetector(t);
});
async function fixture(t, password = "") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xfeeder-network-api-"));
  const configPath = path.join(dir, "config.json");
  const initial = {
    ...config,
    Settings: { Logs: false },
    Auth: { Token: "DO_NOT_EXPOSE" },
    custom: { retained: true },
  };
  await fs.writeFile(configPath, JSON.stringify(initial));
  await fs.writeFile(path.join(dir, ".env"), "SECRET=PRIVATE_ENV\n");
  const previous = process.env.XFEEDER_DASHBOARD_PASSWORD;
  process.env.XFEEDER_DASHBOARD_PASSWORD = password;
  const server = startDashboard({ dataDir: dir, port: 0 });
  if (previous === undefined) delete process.env.XFEEDER_DASHBOARD_PASSWORD;
  else process.env.XFEEDER_DASHBOARD_PASSWORD = previous;
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    configPath,
    initial,
    url,
    call: (route, options = {}) => fetch(url + route, { ...options, headers: { Origin: url, ...options.headers } }),
  };
}
const settingsPath = "/api/settings/network";
const metricsPath = "/api/network/metrics";
const put = (revision, body, headers = {}) => ({
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    ...(revision ? { "If-Match": `"${revision}"` } : {}),
    ...headers,
  },
  body: JSON.stringify(body),
});

test(
  "TASK 11: Network API requires authentication and same origin; exposes no unrelated secrets",
  bounded,
  async (t) => {
    const f = await fixture(t, "test-password");
    for (const route of [settingsPath, metricsPath])
      assert.equal((await f.call(route)).status, 401);
    assert.equal((await f.call(settingsPath, put(null, {}))).status, 401);
    const login = await f.call("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    const Cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await f.call(settingsPath, { headers: { Cookie } });
    const data = await response.json();
    assert.equal(data.settings.bandwidthProfile, "unlimited");
    assert.equal(data.runtime.available, false);
    for (const secret of ["DO_NOT_EXPOSE", "PRIVATE_ENV", "Auth", "configPath"])
      assert.ok(!JSON.stringify(data).includes(secret));
    assert.equal(
      (
        await f.call(
          settingsPath,
          put(data.revision, {}, { Cookie, Origin: "https://outside.example" }),
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.call(metricsPath, { headers: { Cookie } })).status,
      200,
    );
  },
);

test(
  "TASK 11: validated network-only writes preserve other config and reject stale revisions",
  bounded,
  async (t) => {
    const f = await fixture(t);
    const initialResponse = await f.call(settingsPath);
    const first = await initialResponse.json();
    assert.equal(initialResponse.headers.get("etag"), `"${first.revision}"`);
    assert.equal((await f.call(settingsPath, put(null, {}))).status, 428);
    for (const invalid of [
      { bandwidthProfile: "unknown" },
      { bandwidthProfile: "custom", uploadLimitMbps: 0 },
      { bandwidthProfile: "custom", downloadLimitMbps: -1 },
      { token: "secret" },
    ]) {
      const response = await f.call(settingsPath, put(first.revision, invalid));
      assert.equal(response.status, 400);
      assert.ok(
        (await response.json()).errors.every(
          (e) => e.path && e.code && e.message,
        ),
      );
    }
    const update = await f.call(
      settingsPath,
      put(first.revision, {
        bandwidthProfile: "medium",
        networkFriendlyMode: true,
      }),
    );
    assert.equal(update.status, 200);
    const updated = await update.json();
    assert.equal(updated.effective.downloadLimitBytesPerSecond, 1250000);
    assert.equal(updated.effective.httpConcurrency, 2);
    assert.equal(updated.runtime.applied, false);
    const stored = JSON.parse(await fs.readFile(f.configPath));
    assert.deepEqual(stored.Auth, f.initial.Auth);
    assert.deepEqual(stored.custom, f.initial.custom);
    assert.equal(
      (await f.call(settingsPath, put(first.revision, {}))).status,
      412,
    );
    // A full editor save must also respect the revision changed by Network.
    assert.equal(
      (await f.call("/api/config", put(first.revision, f.initial))).status,
      412,
    );
    const unlimited = await f.call(
      settingsPath,
      put(updated.revision, { bandwidthProfile: "unlimited" }),
    );
    assert.equal(unlimited.status, 200);
    assert.equal(
      (await unlimited.json()).effective.downloadLimitBytesPerSecond,
      null,
    );
  },
);

test(
  "TASK 11/13: separate dashboard applies runtime profile without worker restart and publishes real metrics",
  bounded,
  async (t) => {
    const f = await fixture(t);
    const app = createApp({
      configPath: f.configPath,
      cachePath: path.join(f.dir, "cache.json"),
      autostart: true,
    });
    t.after(() => app.shutdown({ graceMs: 0, persistCache: false }));
    const body = "worker-response";
    const source = await serve(t, (_req, res) => res.end(body));
    const first = await (await f.call(settingsPath)).json();
    const response = await f.call(
      settingsPath,
      put(first.revision, {
        bandwidthProfile: "custom",
        downloadLimitMbps: 2,
        uploadLimitMbps: 0.5,
        networkFriendlyMode: true,
      }),
    );
    assert.equal(response.status, 200);
    const deadline = Date.now() + 7000;
    let snapshot;
    do {
      await new Promise((r) => setTimeout(r, 100));
      snapshot = await (await f.call(metricsPath)).json();
    } while (
      (!snapshot.applied || snapshot.metrics?.profile !== "custom") &&
      Date.now() < deadline
    );
    assert.equal(snapshot.applied, true);
    assert.equal(snapshot.metrics.downloadLimitBytesPerSecond, 250000);
    assert.equal(snapshot.metrics.uploadLimitBytesPerSecond, 62500);
    assert.equal(app.network.config.bandwidthProfile, "custom");
    await getWithFallback(source.url, { config: f.initial, maxAttempts: 1 });
    do {
      await new Promise((r) => setTimeout(r, 100));
      snapshot = await (await f.call(metricsPath)).json();
    } while (
      snapshot.metrics?.downloadedBytes !== body.length &&
      Date.now() < deadline
    );
    assert.equal(snapshot.metrics.downloadedBytes, body.length);
    assert.equal(snapshot.metrics.scraplingBytes.status, "unavailable");
    await app.shutdown({ graceMs: 0, persistCache: false });
    assert.equal((await (await f.call(metricsPath)).json()).available, false);
  },
);

test(
  "TASK 10/11: stale or malformed runtime snapshots never masquerade as live zeros",
  bounded,
  async (t) => {
    const f = await fixture(t);
    for (const payload of [
      "broken",
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date(Date.now() - 20000).toISOString(),
        metrics: {},
      }),
    ]) {
      await fs.writeFile(runtimePath(f.configPath), payload);
      assert.equal(readNetworkRuntime(f.configPath, {}).available, false);
    }
  },
);

test(
  "TASK 11: runtime API allowlists fields even when its local snapshot contains extra data",
  bounded,
  async (t) => {
    const f = await fixture(t);
    await fs.writeFile(
      runtimePath(f.configPath),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        metrics: {
          ...getNetwork().metricsSnapshot(),
          token: "EXTRA_SECRET",
          policy: {
            httpConcurrency: null,
            scraplingConcurrency: null,
            password: "HIDDEN_PASSWORD",
          },
        },
      }),
    );
    const result = await (await f.call(metricsPath)).json();
    assert.equal(result.available, true);
    assert.ok(!JSON.stringify(result).includes("EXTRA_SECRET"));
    assert.ok(!JSON.stringify(result).includes("HIDDEN_PASSWORD"));
  },
);

test(
  "TASK 11/13: shutdown waits for an in-flight snapshot and cannot leave a false live worker",
  bounded,
  async (t) => {
    const f = await fixture(t);
    const stop = startNetworkRuntime({
      configPath: f.configPath,
      network: getNetwork(),
      refreshConfig: () => {},
    });
    await stop();
    await assert.rejects(fs.access(runtimePath(f.configPath)), {
      code: "ENOENT",
    });
  },
);
