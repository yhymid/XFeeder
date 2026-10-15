"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const activityPath = configPath => path.resolve(configPath) + ".activity-runtime.json";

// A snapshot is published in the same protected config directory as network
// telemetry. The dashboard is a separate process; no extra HTTP listener.
function startActivityRuntime({ configPath, events, metrics, intervalMs = 2000 }) {
  const target = activityPath(configPath);
  let stopped = false, pending = Promise.resolve(), dirty = false;
  let seq = 0;
  async function publish() {
    const payload = JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      events: events.snapshot(),
      metrics: metrics.snapshot(),
    });
    if (Buffer.byteLength(payload) > MAX_FILE_BYTES) return;
    const temp = target + "." + process.pid + "." + (++seq) + ".tmp";
    try {
      await fs.promises.writeFile(temp, payload, { flag: "wx", mode: 0o600 });
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.unlink(temp).catch(() => {});
    }
  }
  function tick() {
    if (stopped) return;
    dirty = true;
    pending = pending.catch(() => {}).then(async () => {
      if (!dirty) return;
      dirty = false;
      try { await publish(); }
      catch { /* Dashboard reports missing/stale data. Never fail delivery. */ }
    });
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
    // Keep the last bounded sanitized snapshot for post-mortem inspection.
    try { await publish(); } catch { /* Best effort. */ }
  };
}

function readActivityRuntime(configPath) {
  try {
    const file = activityPath(configPath);
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES || stat.size < 2) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.schemaVersion !== 1 || !Array.isArray(data.events) ||
        data.events.length > 10000 || !data.metrics ||
        !Number.isFinite(Date.parse(data.updatedAt))) return null;
    return data;
  } catch { return null; }
}
module.exports = { startActivityRuntime, readActivityRuntime, activityPath, MAX_FILE_BYTES };
