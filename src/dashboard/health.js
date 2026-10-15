"use strict";

const fs = require("node:fs");
const { normalizeNetworkConfig } = require("../network/config");
const { readNetworkRuntime } = require("../network/runtime-state");

// This is the dashboard's readiness for proxy/orchestration use, not merely
// proof that its HTTP listener accepts connections. Fail closed on malformed,
// unavailable, stale, stopped, unready or unapplied worker telemetry.
function workerReady(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!normalizeNetworkConfig(config.network).ok) return false;
    const runtime = readNetworkRuntime(configPath, config.network);
    return runtime.available === true &&
      runtime.applied === true &&
      runtime.workerReady === true &&
      runtime.metrics?.stopping === false;
  } catch {
    return false;
  }
}

module.exports = { workerReady };
