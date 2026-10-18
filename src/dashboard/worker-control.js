"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { readNetworkRuntime } = require("../network/runtime-state");

function createWorkerController({ dataDir, entrypoint = path.resolve(__dirname, "../../main.js"),
  spawnWorker = spawn, isWorkerRunning } = {}) {
  let child = null;
  let pending = false;
  const configPath = path.join(dataDir, "config.json");
  const cachePath = path.join(dataDir, "cache.json");
  const alive = () => {
    if (typeof isWorkerRunning === "function") return isWorkerRunning();
    // Existing externally launched workers are not owned by the dashboard.
    // Never start a competing process on their delivery cache.
    const fs = require("node:fs");
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const runtime = readNetworkRuntime(configPath, config.network);
      return runtime.available === true;
    } catch { return false; }
  };
  const status = () => ({
    running: Boolean(child && child.exitCode === null && !child.killed),
    externalWorker: !child && alive(),
    busy: pending,
    managed: Boolean(child),
  });
  const start = () => {
    if (pending) throw Object.assign(new Error("Worker operation in progress"), { status: 409 });
    if (child || alive()) throw Object.assign(new Error("Worker is already running or managed externally"), { status: 409 });
    pending = true;
    try {
      child = spawnWorker(process.execPath, [entrypoint, "--config", configPath, "--cache", cachePath], {
        cwd: dataDir,
        stdio: "ignore",
        env: { ...process.env, XFEEDER_RUN_ONCE: "0", XFEEDER_DRY_RUN: "0" },
      });
      child.once("exit", () => { child = null; });
      child.once("error", () => { child = null; });
      child.unref?.();
      return { action: "start", ...status() };
    } finally { pending = false; }
  };
  const stop = async () => {
    if (pending) throw Object.assign(new Error("Worker operation in progress"), { status: 409 });
    if (!child) throw Object.assign(new Error("Only dashboard-managed workers can be stopped here"), { status: 409 });
    pending = true;
    try {
      const target = child;
      if (target.exitCode !== null) { child = null; return { action: "stop", ...status() }; }
      const completed = new Promise(resolve => target.once("exit", resolve));
      target.kill("SIGTERM");
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Object.assign(
          new Error("Worker shutdown still in progress; do not start another worker"), { status: 503 })), 15000);
        timer.unref?.();
        completed.finally(() => clearTimeout(timer));
      });
      await Promise.race([completed, timeout]);
      child = null;
      return { action: "stop", ...status() };
    } finally { pending = false; }
  };
  const restart = async () => {
    await stop();
    return { ...start(), action: "restart" };
  };
  return { status, start, stop, restart };
}
module.exports = { createWorkerController };
