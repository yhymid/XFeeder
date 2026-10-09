"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  normalizeNetworkConfig,
  resolveNetworkPolicy,
} = require("../network/config");
const { readNetworkRuntime } = require("../network/runtime-state");
const revision = (text) =>
  crypto.createHash("sha256").update(text).digest("hex");
function readNetworkSettings(configPath) {
  const text = fs.readFileSync(configPath, "utf8"),
    config = JSON.parse(text);
  const result = normalizeNetworkConfig(config.network);
  const value = result.value;
  const settings = result.ok
    ? {
        bandwidthProfile: value.bandwidthProfile,
        downloadLimitMbps: config.network?.downloadLimitMbps ?? null,
        uploadLimitMbps: config.network?.uploadLimitMbps ?? null,
        networkFriendlyMode: value.networkFriendlyMode,
        maxConcurrentRequests: value.maxConcurrentRequests,
        maxConcurrentScraplingRequests: value.maxConcurrentScraplingRequests,
        scraplingResourceSaving: value.scraplingResourceSaving,
        setupTimeoutMs: value.setupTimeoutMs,
        idleTimeoutMs: value.idleTimeoutMs,
        requestDeadlineMs: value.requestDeadlineMs,
        shutdownGraceMs: value.shutdownGraceMs,
      }
    : null;
  const policy = result.ok ? resolveNetworkPolicy(value) : null;
  return {
    config,
    payload: {
      settings,
      revision: revision(text),
      errors: result.errors,
      effective: result.ok
        ? {
            downloadLimitBytesPerSecond: value.downloadBytesPerSecond,
            uploadLimitBytesPerSecond: value.uploadBytesPerSecond,
            httpConcurrency: Number.isFinite(policy.httpConcurrency)
              ? policy.httpConcurrency
              : null,
            scraplingConcurrency: Number.isFinite(policy.scraplingConcurrency)
              ? policy.scraplingConcurrency
              : null,
          }
        : null,
      runtime: result.ok
        ? readNetworkRuntime(configPath, config.network)
        : {
            available: false,
            applied: false,
            reason: "Invalid network configuration",
          },
    },
  };
}
module.exports = { revision, readNetworkSettings };
