"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getNetwork } = require("../src/network/service");
const { runtimePath, signature } = require("../src/network/runtime-state");
const { workerReady } = require("../src/dashboard/health");
const { startTestDashboard } = require("./helpers/dashboard.cjs");

function publishFixture(configPath, {
  workerReady: ready = true, stopping = false, stale = false, applied = true,
} = {}) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(runtimePath(configPath), JSON.stringify({
    schemaVersion: 1,
    workerId: "synthetic-worker",
    pid: 42,
    updatedAt: new Date(Date.now() - (stale ? 10000 : 0)).toISOString(),
    configSignature: applied ? signature(config.network) : "mismatched-signature",
    workerReady: ready,
    metrics: { ...getNetwork().metricsSnapshot(), stopping },
  }));
}

test("X3-23: existing health and new live endpoint stay available without a worker", async t => {
  const fixture = await startTestDashboard(t);
  const health = await fixture.request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.name, "xfeeder-dashboard");
  const live = await fixture.request("/api/live");
  assert.equal(live.status, 200);
  assert.deepEqual(live.data, { ok: true, service: "xfeeder-dashboard", status: "live" });
  const ready = await fixture.request("/api/ready");
  assert.equal(ready.status, 503);
  assert.deepEqual(ready.data, { ok: false, service: "xfeeder-worker", status: "not-ready" });
  assert.equal(workerReady(path.join(fixture.dir, "config.json")), false);
});

test("X3-23: readiness only passes for fresh, applied, healthy worker telemetry", async t => {
  const config = {
    network: {},
    channels: [{ Feeds: ["https://feed.example.invalid/rss"],
      Webhook: "https://discord.example.invalid/webhook" }],
  };
  const fixture = await startTestDashboard(t, { config });
  const configPath = path.join(fixture.dir, "config.json");
  publishFixture(configPath);
  const good = await fixture.request("/api/ready");
  assert.equal(good.status, 200);
  assert.deepEqual(good.data, { ok: true, service: "xfeeder-worker", status: "ready" });
  assert.equal(workerReady(configPath), true);

  for (const variation of [
    { ready: false }, { stopping: true }, { stale: true }, { applied: false },
  ]) {
    publishFixture(configPath, variation);
    const result = await fixture.request("/api/ready");
    assert.equal(result.status, 503, JSON.stringify(variation));
    assert.equal(result.data.ok, false);
    assert.equal((await fixture.request("/api/live")).status, 200);
  }
});

test("X3-23: unknown readiness flag and broken config fail closed", async t => {
  const fixture = await startTestDashboard(t, { config: { network: {} } });
  const configPath = path.join(fixture.dir, "config.json");
  publishFixture(configPath);
  const persisted = JSON.parse(fs.readFileSync(runtimePath(configPath), "utf8"));
  delete persisted.workerReady;
  fs.writeFileSync(runtimePath(configPath), JSON.stringify(persisted));
  assert.equal((await fixture.request("/api/ready")).status, 503,
    "old telemetry cannot falsely claim readiness");
  fs.writeFileSync(configPath, "{invalid json");
  assert.equal((await fixture.request("/api/ready")).status, 503);
  assert.equal((await fixture.request("/api/live")).status, 200);
});

test("X3-23: public probes never disclose secrets, paths, worker pid or metrics", async t => {
  const fixture = await startTestDashboard(t, {
    password: "synthetic-private-password",
    config: { network: {}, SensitiveToken: "do-not-show-me" },
  });
  const configPath = path.join(fixture.dir, "config.json");
  publishFixture(configPath);
  for (const endpoint of ["/api/live", "/api/ready"]) {
    const res = await fixture.request(endpoint);
    const body = res.text;
    for (const secret of [
      fixture.password, "do-not-show-me", fixture.dir, "synthetic-worker",
      "42", "downloadedBytes",
    ]) assert.equal(body.includes(secret), false, endpoint + ": " + secret);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal((await fixture.request(endpoint, {
      headers: { Host: "attacker.invalid" },
    })).status, 403);
  }
});

test("X3-23: worker telemetry marker changes as scheduling readiness changes", async t => {
  const { tempDir } = require("./helpers/temp-dir.cjs");
  const { startNetworkRuntime, readNetworkRuntime } = require("../src/network/runtime-state");
  const { getNetwork, resetNetwork } = require("../src/network/service");
  const dir = tempDir(t), configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ network: {} }));
  let ready = true;
  const network = resetNetwork();
  let stop = startNetworkRuntime({
    configPath, network, refreshConfig: () => {},
    isWorkerReady: () => ready,
  });
  t.after(async () => {
    await stop();
    resetNetwork();
  });
  // Publisher runs asynchronously at startup; wait for the first snapshot.
  const deadline = Date.now() + 2500;
  while (!fs.existsSync(runtimePath(configPath)) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  const initial = readNetworkRuntime(configPath, {});
  assert.equal(initial.available, true);
  assert.equal(initial.workerReady, true);
  ready = false;
  // No new I/O probe is needed for liveness; existing two-second reporter
  // eventually updates the marker, which the dashboard reads.
  const expires = Date.now() + 4500;
  while (Date.now() < expires) {
    await new Promise(resolve => setTimeout(resolve, 60));
    const refreshed = readNetworkRuntime(configPath, {});
    if (refreshed.available && refreshed.workerReady === false) {
      assert.equal(refreshed.applied, true);
      return;
    }
  }
  assert.fail("worker readiness telemetry did not update");
});
