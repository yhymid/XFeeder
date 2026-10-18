"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createWorkerController } = require("../src/dashboard/worker-control");
const { startTestDashboard } = require("./helpers/dashboard.cjs");

test("Dashboard controller: start stop restart own child; never duplicate external workers", async () => {
  const calls = [];
  const spawnWorker = (exe, args, options) => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.unref = () => {};
    child.kill = signal => {
      calls.push(signal);
      child.killed = true;
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, signal));
      return true;
    };
    calls.push({ exe, args, options });
    return child;
  };
  let external = false;
  const control = createWorkerController({
    dataDir: "/tmp/fixture", spawnWorker, isWorkerRunning: () => external,
  });
  assert.deepEqual(control.status(), { running: false, externalWorker: false, busy: false, managed: false });
  external = true;
  assert.throws(() => control.start(), /already running/);
  external = false;
  const first = control.start();
  assert.equal(first.running, true);
  assert.deepEqual(calls[0].args.slice(0, 1), [require("node:path").resolve(__dirname, "../main.js")]);
  assert.equal(calls[0].options.shell, undefined);
  assert.throws(() => control.start(), /already running/);
  await control.stop();
  assert.equal(control.status().running, false);
  assert.equal(calls[1], "SIGTERM");
  const started = control.start();
  assert.equal(started.running, true);
  assert.equal((await control.restart()).action, "restart");
  assert.equal(control.status().running, true);
  assert.equal(calls.filter(x => x === "SIGTERM").length, 2);
  await control.stop();
});

test("Dashboard controller: external worker stop/restart are rejected", async () => {
  const controller = createWorkerController({
    dataDir: "/tmp/fixture", isWorkerRunning: () => true,
  });
  await assert.rejects(controller.stop(), /dashboard-managed workers/);
  await assert.rejects(controller.restart(), /dashboard-managed workers/);
  assert.equal(controller.status().externalWorker, true);
});

test("Dashboard control API: requires login and same-origin POST", async t => {
  const fixture = await startTestDashboard(t, { password: "test-worker-password" });
  assert.equal((await fixture.request("/api/worker/control")).status, 401);
  assert.equal((await fixture.request("/api/worker/control", { method: "POST", json: { action: "start" } })).status, 401);
  const login = await fixture.login();
  const cookieHeader = login.headers["set-cookie"];
  const headers = { Cookie: (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader).split(";")[0] };
  const status = await fixture.request("/api/worker/control", { headers });
  assert.equal(status.status, 200);
  assert.equal(status.data.running, false);
  const invalid = await fixture.request("/api/worker/control", {
    method: "POST", headers: { ...headers, Origin: fixture.origin }, json: { action: "unknown" },
  });
  assert.equal(invalid.status, 400);
  const externalStop = await fixture.request("/api/worker/control", {
    method: "POST", headers: { ...headers, Origin: fixture.origin }, json: { action: "stop" },
  });
  assert.equal(externalStop.status, 409);
});

test("Dashboard controller: stale telemetry cannot permit duplicate worker while PID exists", t => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { tempDir } = require("./helpers/temp-dir.cjs");
  const { runtimePath } = require("../src/network/runtime-state");
  const dir = tempDir(t);
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ network: {} }));
  fs.writeFileSync(runtimePath(configPath), JSON.stringify({
    pid: process.pid, schemaVersion: 1, updatedAt: "2001-01-01T00:00:00Z",
    workerReady: false,
  }));
  const controller = createWorkerController({ dataDir: dir });
  assert.equal(controller.status().externalWorker, true);
  assert.throws(() => controller.start(), /already running/);
});
