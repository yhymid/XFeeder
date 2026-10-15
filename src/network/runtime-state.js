"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { requireNetworkConfig } = require("./config");
const signature = (config) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(requireNetworkConfig(config)))
    .digest("hex");
const runtimePath = (configPath) =>
  `${path.resolve(configPath)}.network-runtime.json`;

function publicMetrics(metrics) {
  const result = {};
  for (const key of [
    "downloadedBytes",
    "uploadedBytes",
    "unshapedUploadBytes",
    "downloadBytesPerSecond",
    "uploadBytesPerSecond",
    "rateWindowSeconds",
    "activeHttpRequests",
    "waitingHttpRequests",
    "activeScraplingTasks",
    "waitingScraplingTasks",
    "waitingDownload",
    "waitingUpload",
  ]) {
    if (!Number.isFinite(metrics[key]) || metrics[key] < 0)
      throw new Error("Invalid metrics");
    result[key] = metrics[key];
  }
  for (const key of [
    "downloadLimitBytesPerSecond",
    "uploadLimitBytesPerSecond",
  ]) {
    if (
      metrics[key] !== null &&
      (!Number.isFinite(metrics[key]) || metrics[key] <= 0)
    )
      throw new Error("Invalid limit");
    result[key] = metrics[key];
  }
  if (
    ![
      "potato",
      "low",
      "medium",
      "high",
      "very-high",
      "unlimited",
      "custom",
    ].includes(metrics.profile)
  )
    throw new Error("Invalid profile");
  result.profile = metrics.profile;
  result.friendlyMode = metrics.friendlyMode === true;
  result.stopping = metrics.stopping === true;
  result.policy = {};
  for (const key of ["httpConcurrency", "scraplingConcurrency"]) {
    const value = metrics.policy?.[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 1))
      throw new Error("Invalid policy");
    result.policy[key] = value;
  }
  result.scraplingBytes = {
    status: "unavailable",
    downloadedBytes: null,
    uploadedBytes: null,
  };
  result.accounting =
    "encoded HTTP body read / request body handed to transport; excludes headers, TLS and redirect replay";
  result.uploadEnforcement =
    "buffered initial bodies paced before dispatch; streams, multipart and redirect replay are unshaped";
  return result;
}

// One compact snapshot per two seconds, for the separately running dashboard.
// Only the allowlisted service snapshot is persisted, never config/URLs/secrets.
function startNetworkRuntime({ configPath, network, refreshConfig, isWorkerReady = () => false }) {
  const target = runtimePath(configPath),
    temp = `${target}.${process.pid}.tmp`;
  const workerId = crypto.randomUUID();
  let stopped = false,
    writing = false;
  let publication = Promise.resolve();
  async function publish() {
    if (stopped || writing) return;
    writing = true;
    try {
      const snapshot = {
        schemaVersion: 1,
        workerId,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        configSignature: crypto
          .createHash("sha256")
          .update(network.signature)
          .digest("hex"),
        workerReady: isWorkerReady() === true,
        metrics: network.metricsSnapshot(),
      };
      await fs.promises.writeFile(temp, JSON.stringify(snapshot), {
        mode: 0o600,
      });
      if (!stopped) await fs.promises.rename(temp, target);
    } catch {
      /* Telemetry failure must not interrupt delivery. Dashboard reports unavailable. */
    } finally {
      await fs.promises.unlink(temp).catch(() => {});
      writing = false;
    }
  }
  const reload = setInterval(() => {
    if (!stopped) refreshConfig({ quiet: true });
  }, 1000);
  const schedule = () => {
    if (!writing && !stopped) publication = publish();
  };
  const report = setInterval(schedule, 2000);
  reload.unref();
  report.unref();
  schedule();
  return async () => {
    stopped = true;
    clearInterval(reload);
    clearInterval(report);
    await publication;
    try {
      if (JSON.parse(fs.readFileSync(target, "utf8")).workerId === workerId)
        fs.unlinkSync(target);
    } catch {
      /* Already gone. */
    }
  };
}
function readNetworkRuntime(configPath, config) {
  let value;
  try {
    const target = runtimePath(configPath);
    if (fs.statSync(target).size > 65536) throw new Error("Oversized snapshot");
    value = JSON.parse(fs.readFileSync(target, "utf8"));
    if (
      value.schemaVersion !== 1 ||
      !value.metrics ||
      !Number.isFinite(Date.parse(value.updatedAt))
    )
      throw new Error("Invalid snapshot");
    value.metrics = publicMetrics(value.metrics);
  } catch {
    return {
      available: false,
      applied: false,
      reason: "Worker metrics unavailable",
    };
  }
  const age = Date.now() - Date.parse(value.updatedAt);
  if (age < -1000 || age > 6500)
    return {
      available: false,
      applied: false,
      reason: "Worker metrics are stale",
      updatedAt: value.updatedAt,
    };
  return {
    available: true,
    applied: value.configSignature === signature(config),
    updatedAt: value.updatedAt,
    metrics: value.metrics,
    // Older workers may not publish workerReady. Fail closed for readiness
    // without changing their existing network metrics/dashboard compatibility.
    workerReady: value.workerReady === true,
  };
}
module.exports = {
  startNetworkRuntime,
  readNetworkRuntime,
  runtimePath,
  signature,
};
