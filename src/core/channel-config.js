"use strict";

const crypto = require("crypto");

const FEED_FIELD_NAMES = ["RSS", "Feeds", "URLs", "Sources"];
const CHANNEL_FIELD_HINTS = new Set([
  ...FEED_FIELD_NAMES,
  "Webhook",
  "Thread",
  "Discord",
  "Matrix",
  "TimeChecker",
  "RequestSend",
  "ID",
  "Key",
  "CacheKey",
]);
const RESERVED_ROOT_KEYS = new Set([
  "Settings",
  "Auth",
  "Proxy",
  "Scrapling",
  "ChannelDefaults",
  "DefaultChannel",
  "Matrix",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function looksLikeChannelEntry(value) {
  if (typeof value === "string") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string");
  }

  if (!isPlainObject(value)) {
    return false;
  }

  return Object.keys(value).some((key) => CHANNEL_FIELD_HINTS.has(key));
}

function isChannelConfigGroup(key, value) {
  if (RESERVED_ROOT_KEYS.has(key)) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length === 0
      ? key.toLowerCase().startsWith("channels")
      : value.every((entry) => looksLikeChannelEntry(entry));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  const entries = Object.values(value);
  return entries.length === 0
    ? key.toLowerCase().startsWith("channels")
    : entries.every((entry) => looksLikeChannelEntry(entry));
}

function collectChannelGroupEntries(config) {
  return Object.entries(config || {}).filter(([key, value]) => isChannelConfigGroup(key, value));
}

function normalizeFeedList(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveChannelFeeds(channel) {
  const merged = [];
  const seen = new Set();

  for (const fieldName of FEED_FIELD_NAMES) {
    for (const entry of normalizeFeedList(channel[fieldName])) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }

  return merged;
}

function normalizeThreadValue(value) {
  if (value === null || value === undefined || value === "" || value === "null") {
    return null;
  }
  return String(value);
}

function normalizeRequestSend(value, fallback = 5) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function normalizeTimeChecker(value, fallback = 30) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function normalizeAuthDefaults(authConfig) {
  if (!isPlainObject(authConfig)) return {};

  return {
    ...(typeof authConfig.Token === "string" && authConfig.Token.trim()
      ? { Token: authConfig.Token.trim() }
      : {}),
    ...(typeof authConfig["x-super-properties"] === "string" && authConfig["x-super-properties"].trim()
      ? { "x-super-properties": authConfig["x-super-properties"].trim() }
      : {}),
    ...(typeof authConfig.cookie === "string" && authConfig.cookie.trim()
      ? { cookie: authConfig.cookie.trim() }
      : {}),
  };
}

function normalizeDiscordConfig(discordConfig, authDefaults = {}) {
  if (!isPlainObject(discordConfig)) return null;

  const normalized = {
    ...authDefaults,
    ...discordConfig,
  };

  if (normalized.Webhook) normalized.Webhook = String(normalized.Webhook).trim();
  if (normalized.Token) normalized.Token = String(normalized.Token).trim();
  if (normalized.GuildID) normalized.GuildID = String(normalized.GuildID).trim();
  if (normalized.cookie) normalized.cookie = String(normalized.cookie).trim();
  if (normalized["x-super-properties"]) {
    normalized["x-super-properties"] = String(normalized["x-super-properties"]).trim();
  }
  normalized.Thread = normalizeThreadValue(normalized.Thread);
  normalized.ChannelIDs = Array.isArray(normalized.ChannelIDs)
    ? normalized.ChannelIDs
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim())
    : normalized.ChannelIDs;
  if (typeof normalized.ChannelID === "string") {
    normalized.ChannelID = normalized.ChannelID.trim();
  }

  return normalized;
}

function mergeMatrixConfig(rootMatrixConfig, channelMatrixConfig) {
  const root = isPlainObject(rootMatrixConfig) ? rootMatrixConfig : null;
  const local = isPlainObject(channelMatrixConfig) ? channelMatrixConfig : null;
  if (!root && !local) return null;

  return {
    ...(root ? { ...root } : {}),
    ...(local ? { ...local } : {}),
  };
}

function hasWebhookTarget(webhookUrl) {
  return typeof webhookUrl === "string" && webhookUrl.trim().length > 0;
}

function hasMatrixDeliveryTarget(matrixConfig) {
  return Boolean(
    matrixConfig &&
    typeof matrixConfig === "object" &&
    matrixConfig.Enabled !== false &&
    String(matrixConfig.Homeserver || "").trim() &&
    String(matrixConfig.AccessToken || "").trim() &&
    String(matrixConfig.RoomID || "").trim()
  );
}

function hasDiscordSource(discordConfig) {
  return Boolean(discordConfig && typeof discordConfig === "object");
}

function cloneDefaults(defaults) {
  if (!defaults || typeof defaults !== "object") return {};
  return {
    ...defaults,
    Discord: defaults.Discord && typeof defaults.Discord === "object" ? { ...defaults.Discord } : defaults.Discord,
    Matrix: defaults.Matrix && typeof defaults.Matrix === "object" ? { ...defaults.Matrix } : defaults.Matrix,
  };
}

function buildChannelFromShorthand(input, defaults) {
  if (typeof input === "string") {
    return {
      ...cloneDefaults(defaults),
      Feeds: [input],
    };
  }

  if (Array.isArray(input)) {
    return {
      ...cloneDefaults(defaults),
      Feeds: input,
    };
  }

  if (input && typeof input === "object") {
    const merged = {
      ...cloneDefaults(defaults),
      ...input,
    };

    if (defaults?.Discord || input.Discord) {
      merged.Discord = {
        ...(defaults?.Discord && typeof defaults.Discord === "object" ? defaults.Discord : {}),
        ...(input.Discord && typeof input.Discord === "object" ? input.Discord : {}),
      };
    }

    if (defaults?.Matrix || input.Matrix) {
      merged.Matrix = {
        ...(defaults?.Matrix && typeof defaults.Matrix === "object" ? defaults.Matrix : {}),
        ...(input.Matrix && typeof input.Matrix === "object" ? input.Matrix : {}),
      };
    }

    return merged;
  }

  return null;
}

function getExplicitChannelId(channel) {
  const candidates = [
    channel?.CacheKey,
    channel?.Key,
    channel?.ID,
    channel?.raw?.CacheKey,
    channel?.raw?.Key,
    channel?.raw?.ID,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function buildChannelCacheKey(channel) {
  const explicit = getExplicitChannelId(channel);
  if (explicit) return explicit;

  const fingerprint = stableStringify({
    sourceKey: channel?.sourceKey || "channels",
    name: channel?.name || "",
    feeds: Array.isArray(channel?.RSS) ? channel.RSS : [],
    webhook: channel?.Webhook || "",
    thread: channel?.Thread || null,
    discord: channel?.Discord
      ? {
          channelIds: Array.isArray(channel.Discord.ChannelIDs) ? channel.Discord.ChannelIDs : channel.Discord.ChannelID || null,
          guildId: channel.Discord.GuildID || "",
          webhook: channel.Discord.Webhook || "",
          thread: channel.Discord.Thread || null,
        }
      : null,
    matrix: channel?.Matrix
      ? {
          enabled: channel.Matrix.Enabled !== false,
          homeserver: channel.Matrix.Homeserver || "",
          roomId: channel.Matrix.RoomID || "",
          msgType: channel.Matrix.MsgType || "",
        }
      : null,
  });

  const digest = crypto.createHash("sha1").update(fingerprint).digest("hex").slice(0, 12);
  return `${channel?.sourceKey || "channels"}:${channel?.name || digest}`;
}

function getChannelLabel(channel) {
  return channel?.name || `${channel?.sourceKey || "channels"}#${Number(channel?.index) + 1}`;
}

function normalizeChannel(channel, index, rootConfig = {}) {
  const normalized = {
    index,
    name: channel.__channelName || null,
    sourceKey: channel.__sourceKey || null,
    Webhook: typeof channel.Webhook === "string" ? channel.Webhook.trim() : "",
    Thread: normalizeThreadValue(channel.Thread),
    RSS: resolveChannelFeeds(channel),
    TimeChecker: normalizeTimeChecker(channel.TimeChecker, 30),
    RequestSend: normalizeRequestSend(channel.RequestSend, 5),
    Discord: normalizeDiscordConfig(channel.Discord, normalizeAuthDefaults(rootConfig.Auth)),
    Matrix: mergeMatrixConfig(rootConfig.Matrix, channel.Matrix),
    raw: channel,
  };

  normalized.cacheKey = buildChannelCacheKey(normalized);
  return normalized;
}

function collectConfiguredChannels(config) {
  const result = [];
  const channelDefaults =
    (config && typeof config.ChannelDefaults === "object" && config.ChannelDefaults) ||
    (config && typeof config.DefaultChannel === "object" && config.DefaultChannel) ||
    {};

  for (const [key, value] of collectChannelGroupEntries(config || {})) {
    if (Array.isArray(value)) {
      for (const channel of value) {
        const built = buildChannelFromShorthand(channel, channelDefaults);
        if (!built || typeof built !== "object") continue;
        result.push({
          ...built,
          __sourceKey: key,
        });
      }
      continue;
    }

    if (value && typeof value === "object") {
      for (const [channelName, channelValue] of Object.entries(value)) {
        const built = buildChannelFromShorthand(channelValue, channelDefaults);
        if (!built || typeof built !== "object") continue;
        result.push({
          ...built,
          __sourceKey: key,
          __channelName: channelName,
        });
      }
    }
  }

  return result
    .map((channel, index) => normalizeChannel(channel, index, config))
    .filter((channel) => channel && typeof channel === "object");
}

function summarizeChannel(channel) {
  return {
    label: getChannelLabel(channel),
    feeds: Array.isArray(channel.RSS) ? channel.RSS.length : 0,
    hasWebhook: hasWebhookTarget(channel.Webhook),
    hasDiscord: hasDiscordSource(channel.Discord),
    hasMatrix: hasMatrixDeliveryTarget(channel.Matrix),
    interval: channel.TimeChecker,
    burst: channel.RequestSend,
    cacheKey: channel.cacheKey,
  };
}

function validateChannels(channels) {
  const warnings = [];
  const seenCacheKeys = new Map();

  for (const channel of channels || []) {
    const label = getChannelLabel(channel);
    const hasFeeds = Array.isArray(channel.RSS) && channel.RSS.length > 0;
    const hasDiscord = hasDiscordSource(channel.Discord);
    const hasWebhook = hasWebhookTarget(channel.Webhook);
    const hasMatrix = hasMatrixDeliveryTarget(channel.Matrix);

    if (!hasWebhook && !hasMatrix) {
      warnings.push(`[Config] ${label}: missing delivery target (Webhook or complete Matrix config).`);
    }

    if (!hasFeeds && !hasDiscord) {
      warnings.push(`[Config] ${label}: missing feed sources or Discord source.`);
    }

    if (hasFeeds && new Set(channel.RSS).size !== channel.RSS.length) {
      warnings.push(`[Config] ${label}: contains duplicate feed URLs.`);
    }

    if (hasDiscord) {
      const channelIds = Array.isArray(channel.Discord.ChannelIDs)
        ? channel.Discord.ChannelIDs
        : (typeof channel.Discord.ChannelID === "string" && channel.Discord.ChannelID.trim()
          ? [channel.Discord.ChannelID.trim()]
          : []);
      if (channelIds.length === 0) {
        warnings.push(`[Config] ${label}: Discord source is enabled but ChannelIDs are missing.`);
      }
      if (!String(channel.Discord.Token || "").trim()) {
        warnings.push(`[Config] ${label}: Discord source is enabled but Token is missing (global Auth also counts).`);
      }
    }

    if (channel.Matrix && channel.Matrix.Enabled !== false && !hasMatrix) {
      warnings.push(`[Config] ${label}: Matrix is enabled but Homeserver, AccessToken or RoomID is missing.`);
    }

    if (seenCacheKeys.has(channel.cacheKey)) {
      warnings.push(
        `[Config] ${label}: cache key collision with ${seenCacheKeys.get(channel.cacheKey)}. Set explicit ID/CacheKey for one of them.`
      );
    } else {
      seenCacheKeys.set(channel.cacheKey, label);
    }
  }

  return warnings;
}

module.exports = {
  buildChannelCacheKey,
  collectChannelGroupEntries,
  collectConfiguredChannels,
  getChannelLabel,
  isChannelConfigGroup,
  normalizeChannel,
  normalizeDiscordConfig,
  summarizeChannel,
  validateChannels,
};
