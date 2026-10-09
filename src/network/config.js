"use strict";

const PRESETS = Object.freeze({
  potato: 10_000,
  low: 2_000_000,
  medium: 10_000_000,
  high: 50_000_000,
  "very-high": 100_000_000,
  unlimited: null,
});
const MAX_MBPS = 1_000_000; // 1 Tb/s; finite, safely representable canonical bytes/s.
const FIELDS = new Set([
  "bandwidthProfile",
  "downloadLimitMbps",
  "uploadLimitMbps",
  "networkFriendlyMode",
  "maxConcurrentRequests",
  "maxConcurrentScraplingRequests",
  "scraplingResourceSaving",
  "setupTimeoutMs",
  "idleTimeoutMs",
  "requestDeadlineMs",
  "shutdownGraceMs",
]);

function normalizeNetworkConfig(input = {}) {
  const errors = [];
  const fail = (field, code, message) =>
    errors.push({
      path: field ? `network.${field}` : "network",
      code,
      message,
    });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("", "INVALID_TYPE", "network must be an object");
    return { ok: false, errors };
  }
  for (const key of Object.keys(input))
    if (!FIELDS.has(key))
      fail(key, "UNKNOWN_FIELD", "Unsupported network setting or unit");
  const profile = input.bandwidthProfile ?? "unlimited";
  if (
    typeof profile !== "string" ||
    (!Object.hasOwn(PRESETS, profile) && profile !== "custom")
  )
    fail("bandwidthProfile", "UNKNOWN_PROFILE", "Unknown bandwidth profile");
  const rate = (field) => {
    const value = input[field];
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(field, "INVALID_NUMBER", "Limit must be a finite number in Mbps");
      return null;
    }
    if (value <= 0 || value > MAX_MBPS || Math.round(value * 125000) < 1) {
      fail(
        field,
        "OUT_OF_RANGE",
        "Limit must be positive and representable (up to 1,000,000 Mbps)",
      );
      return null;
    }
    return Math.round(value * 125000);
  };
  const download = rate("downloadLimitMbps"),
    upload = rate("uploadLimitMbps");
  if (
    profile === "custom" &&
    download === null &&
    upload === null &&
    !errors.length
  )
    fail(
      "downloadLimitMbps",
      "CUSTOM_LIMIT_REQUIRED",
      "Custom requires at least one limit; null leaves a direction unlimited",
    );
  const bool = (field, fallback) => {
    if (input[field] === undefined) return fallback;
    if (typeof input[field] !== "boolean") {
      fail(field, "INVALID_BOOLEAN", "Setting must be a boolean");
      return fallback;
    }
    return input[field];
  };
  const integer = (field, fallback, min = 1, max = 10000) => {
    const value = input[field];
    if (value == null) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      fail(
        field,
        "OUT_OF_RANGE",
        `Setting must be ${min > 0 ? "a positive integer" : "an integer"} between ${min} and ${max}`,
      );
      return fallback;
    }
    return value;
  };
  const value = {
    bandwidthProfile: profile,
    downloadBytesPerSecond:
      profile === "custom"
        ? download
        : PRESETS[profile] == null
          ? null
          : PRESETS[profile] / 8,
    uploadBytesPerSecond: profile === "custom" ? upload : null,
    networkFriendlyMode: bool("networkFriendlyMode", false),
    scraplingResourceSaving: bool("scraplingResourceSaving", true),
    maxConcurrentRequests: integer("maxConcurrentRequests", null),
    maxConcurrentScraplingRequests: integer(
      "maxConcurrentScraplingRequests",
      null,
    ),
    setupTimeoutMs: integer("setupTimeoutMs", 15000, 0, 2_147_000_000),
    idleTimeoutMs: integer("idleTimeoutMs", 15000, 0, 2_147_000_000),
    requestDeadlineMs: integer("requestDeadlineMs", null, 1, 2_147_000_000),
    shutdownGraceMs: integer("shutdownGraceMs", 5000, 0, 60000),
  };
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value, errors: [] };
}

class NetworkConfigError extends Error {
  constructor(errors) {
    super(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    this.name = "NetworkConfigError";
    this.code = "INVALID_NETWORK_CONFIG";
    this.errors = errors;
  }
}
function requireNetworkConfig(input) {
  const result = normalizeNetworkConfig(input);
  if (!result.ok) throw new NetworkConfigError(result.errors);
  return result.value;
}
function resolveNetworkPolicy(config) {
  return {
    httpConcurrency:
      config.maxConcurrentRequests ??
      (config.networkFriendlyMode ? 2 : Infinity),
    scraplingConcurrency:
      config.maxConcurrentScraplingRequests ??
      (config.networkFriendlyMode ? 1 : Infinity),
    heavySpacingMs: config.networkFriendlyMode ? [100, 300] : [0, 0],
    retryJitterMs: config.networkFriendlyMode ? [50, 150] : [0, 0],
  };
}
module.exports = {
  PRESETS,
  normalizeNetworkConfig,
  requireNetworkConfig,
  resolveNetworkPolicy,
  NetworkConfigError,
};
