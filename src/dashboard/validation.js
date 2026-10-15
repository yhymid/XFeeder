"use strict";
const {
  collectConfiguredChannels,
  validateChannels,
  unsupportedConfigSections,
} = require("../core/channel-config");
const { loadDotEnv } = require("../config-loader");
const { normalizeNetworkConfig } = require("../network/config");
const { sanitizeText } = require("../core/diagnostics");
const { validateConfigSchema } = require("../core/config-schema");

function validateConfig(config, envPath) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return { errors: ["Config root must be a JSON object."], warnings: [] };
  const structural = validateConfigSchema(config);
  if (structural.schemaVersion !== 1 || !structural.ok) return {
    errors: structural.errors.map(e => sanitizeText(e.path + ": " + e.message)),
    warnings: [],
    issues: structural.errors,
    schemaVersion: structural.schemaVersion,
    runtimeSupported: false,
  };
  const env = { ...loadDotEnv(envPath, { reload: true }), ...process.env };
  const resolve = (value) => {
    if (typeof value === "string") {
      const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      return match ? env[match[1]] || "" : value;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, resolve(v)]),
      );
    return value;
  };
  const resolved = resolve(config);
  const channels = collectConfiguredChannels(resolved);
  const networkValidation = normalizeNetworkConfig(resolved.network);
  const errors = networkValidation.errors.map((error) => `${error.path}: ${error.message}`);
  const defaults = resolved.ChannelDefaults || resolved.DefaultChannel || {};
  for (const [key, label] of [
    ["TimeChecker", "Default check interval"],
    ["RequestSend", "Default maximum entries"],
  ]) {
    if (
      defaults[key] !== undefined &&
      (!Number.isInteger(Number(defaults[key])) || Number(defaults[key]) <= 0)
    )
      errors.push(`${label} must be a positive whole number.`);
  }
  for (const ch of channels) {
    for (const [key, label] of [
      ["TimeChecker", "Check interval"],
      ["RequestSend", "Maximum entries"],
    ]) {
      if (
        ch.raw[key] !== undefined &&
        (!Number.isInteger(Number(ch.raw[key])) || Number(ch.raw[key]) <= 0)
      )
        errors.push(
          `${ch.name || ch.sourceKey}: ${label} must be a positive whole number.`,
        );
    }
  }
  return {
    errors: errors.map(sanitizeText),
    warnings: [...unsupportedConfigSections(resolved), ...validateChannels(channels)].map(sanitizeText),
  };
}
module.exports = { validateConfig };
