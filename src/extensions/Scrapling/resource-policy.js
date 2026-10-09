"use strict";

// Normalize aliases within each layer, before merging: a per-URL snake_case
// option must override a global camelCase option (and vice versa).
function normalizeResourceOptions(options = {}) {
  const normalized = { ...options };
  for (const [camel, snake] of [
    ["disableResources", "disable_resources"],
    ["blockAds", "block_ads"],
    ["blockedDomains", "blocked_domains"],
  ]) {
    if (normalized[camel] === undefined && normalized[snake] !== undefined) {
      normalized[camel] = normalized[snake];
    }
    delete normalized[snake];
  }
  return normalized;
}

function resolveResourcePolicy(network = {}, ...layers) {
  const options = Object.assign({}, ...layers.map(normalizeResourceOptions));
  const saving =
    options.scraplingResourceSaving ?? network.scraplingResourceSaving ?? true;
  if (typeof saving !== "boolean")
    throw new TypeError("scraplingResourceSaving must be a boolean");
  for (const key of ["disableResources", "blockAds"]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") {
      throw new TypeError(`${key} must be a boolean`);
    }
  }
  // Explicit native settings always win, including false. No ad/domain lists
  // are silently enabled, and disabling Saving does not undo user-set blockers.
  options.disableResources ??= saving;
  delete options.scraplingResourceSaving;
  return options;
}

function resolveScraplingConcurrency(network = {}) {
  const { requireNetworkConfig, resolveNetworkPolicy } = require("../../network/config");
  return resolveNetworkPolicy(requireNetworkConfig(network)).scraplingConcurrency;
}

module.exports = { resolveResourcePolicy, resolveScraplingConcurrency };
