"use strict";

const {
  collectChannelGroupEntries, collectConfiguredChannels,
} = require("./channel-config");
const { validateConfigSchema, ConfigSchemaError } = require("./config-schema");

const issue = (path, code, message) => ({ path, code, message });
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const allowed = (obj, keys, at, errors) => {
  if (!plain(obj)) {
    errors.push(issue(at, "invalid_type", "Expected object"));
    return false;
  }
  for (const key of Object.keys(obj)) if (!keys.includes(key))
    errors.push(issue(at + "." + key, "unsupported_legacy_field",
      "Field has no lossless mapping to schema v2"));
  return true;
};
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const noVal = value => value === undefined || value === null || value === "";
const str = value => String(value ?? "").trim();

class ConfigMigrationError extends ConfigSchemaError {
  constructor(errors) {
    super(errors, "CONFIG_MIGRATION_UNSAFE");
    this.name = "ConfigMigrationError";
  }
}

function toLegacyRuntime(v2) {
  const valid = validateConfigSchema(v2);
  if (!valid.ok || valid.schemaVersion !== 2)
    throw new ConfigMigrationError(valid.errors);
  const errors = [];
  const settings = v2.settings || {}, ints = v2.integrations || {};
  const legacy = {
    Settings: {
      ...(settings.logs === undefined ? {} : { Logs: settings.logs }),
      ...(settings.debugExpert === undefined ? {} : { DebugExpert: settings.debugExpert }),
      ...(settings.maxConcurrentChannels === undefined ? {} :
        { MaxConcurrentChannels: settings.maxConcurrentChannels }),
    },
    Auth: {
      ...(ints.discord?.token ? { Token: ints.discord.token } : {}),
      ...(ints.discord?.cookie ? { cookie: ints.discord.cookie } : {}),
      ...(ints.discord?.superProperties ?
        { "x-super-properties": ints.discord.superProperties } : {}),
    },
    Proxy: {
      ...(ints.proxy?.enabled === undefined ? {} : { Enabled: ints.proxy.enabled }),
      ...(ints.proxy?.url ? { Url: ints.proxy.url } : {}),
    },
    Scrapling: {
      ...(ints.scrapling?.enabled === undefined ? {} : { Enabled: ints.scrapling.enabled }),
      ...(ints.scrapling?.autoFallback === undefined ? {} : { AutoFallback: ints.scrapling.autoFallback }),
    },
    Telegram: {
      ...(ints.telegram?.enabled === undefined ? {} : { Enabled: ints.telegram.enabled }),
      ...(ints.telegram?.botToken ? { BotToken: ints.telegram.botToken } : {}),
      ...(ints.telegram?.chatId ? { ChatID: ints.telegram.chatId } : {}),
      ...(ints.telegram?.timeoutMs ? { TimeoutMs: ints.telegram.timeoutMs } : {}),
    },
    channels: {},
  };

  for (const [name, channel] of Object.entries(v2.channels)) {
    const at = "channels." + name;
    if (channel.enabled === false)
      errors.push(issue(at + ".enabled", "unsupported_semantics",
        "Legacy runner cannot safely disable channels"));
    let webhook, telegram, discord;
    const feeds = [];
    for (const [i, source] of channel.sources.entries()) {
      if (source.type === "feed") feeds.push(source.url);
      else if (source.type === "discord") {
        if (discord) errors.push(issue(at + ".sources[" + i + "]", "duplicate_source",
          "Only one Discord source per channel is supported"));
        else discord = {
          ChannelIDs: source.channelIds,
          ...(source.token ? { Token: source.token } : {}),
          ...(source.guildId ? { GuildID: source.guildId } : {}),
          ...(source.cookie ? { cookie: source.cookie } : {}),
          ...(source.superProperties ? { "x-super-properties": source.superProperties } : {}),
        };
      }
    }
    for (const [i, dest] of channel.destinations.entries()) {
      if (dest.type === "webhook") {
        if (webhook) errors.push(issue(at + ".destinations[" + i + "]", "duplicate_destination",
          "Only one webhook destination per channel is supported"));
        webhook = dest;
      }
      if (dest.type === "telegram") {
        if (telegram) errors.push(issue(at + ".destinations[" + i + "]", "duplicate_destination",
          "Only one Telegram destination per channel is supported"));
        telegram = dest;
      }
    }
    legacy.channels[name] = {
      CacheKey: channel.id || "channels:" + name,
      ...(channel.timeChecker ? { TimeChecker: channel.timeChecker } : {}),
      ...(channel.requestSend ? { RequestSend: channel.requestSend } : {}),
      ...(feeds.length ? { Feeds: feeds } : {}),
      ...(discord ? { Discord: discord } : {}),
      ...(webhook ? { Webhook: webhook.url,
        ...(webhook.threadId ? { Thread: webhook.threadId } : {}) } : {}),
      ...(telegram ? { Telegram: {
        Enabled: true,
        ...(telegram.botToken ? { BotToken: telegram.botToken } : {}),
        ChatID: telegram.chatId,
        ...(telegram.messageThreadId ? { MessageThreadID: telegram.messageThreadId } : {}),
        ...(telegram.disableWebPagePreview === undefined ? {} :
          { DisableWebPagePreview: telegram.disableWebPagePreview }),
        ...(telegram.timeoutMs ? { TimeoutMs: telegram.timeoutMs } : {}),
      } } : (ints.telegram?.botToken && ints.telegram?.chatId ?
        { Telegram: { Enabled: false } } : {})),
    };
  }
  if (errors.length) throw new ConfigMigrationError(errors);
  return legacy;
}

function migrateConfig(oldConfig) {
  const version = validateConfigSchema(oldConfig);
  if (!version.ok) throw new ConfigMigrationError(version.errors);
  if (version.schemaVersion === 2) {
    toLegacyRuntime(oldConfig);
    return structuredClone(oldConfig);
  }

  const errors = [];
  const groups = collectChannelGroupEntries(oldConfig);
  const groupKeys = groups.map(([name]) => name);
  const knownRoot = [
    "schemaVersion", "Settings", "Auth", "Telegram", "Proxy", "Scrapling",
    "ChannelDefaults", "DefaultChannel", ...groupKeys,
  ];
  allowed(oldConfig, knownRoot, "$", errors);
  const rootShapes = [
    ["Settings", ["Logs", "DebugExpert", "MaxConcurrentChannels"]],
    ["Auth", ["Token", "cookie", "x-super-properties"]],
    ["Telegram", ["Enabled", "BotToken", "ChatID", "TimeoutMs",
      "MessageThreadID", "DisableWebPagePreview"]],
    ["Proxy", ["Enabled", "Url"]],
    ["Scrapling", ["Enabled", "AutoFallback"]],
    ["ChannelDefaults", ["TimeChecker", "RequestSend"]],
    ["DefaultChannel", ["TimeChecker", "RequestSend"]],
  ];
  for (const [key, fields] of rootShapes) if (oldConfig[key] !== undefined)
    allowed(oldConfig[key], fields, key, errors);

  const channels = collectConfiguredChannels(oldConfig);
  const expectedCount = groups.reduce((n, [, value]) => n +
    (Array.isArray(value) ? value.length : Object.keys(value).length), 0);
  if (expectedCount !== channels.length) errors.push(issue("channels",
    "unrecognized_channel", "Some legacy channel entries could not be parsed"));
  const names = new Set(), cacheKeys = new Set();
  const output = {};
  const channelFields = [
    "RSS", "Feeds", "URLs", "Sources", "Webhook", "Thread",
    "Discord", "Telegram", "TimeChecker", "RequestSend",
    "CacheKey", "Key", "ID", "__sourceKey", "__channelName",
  ];
  for (const [index, channel] of channels.entries()) {
    const at = channel.sourceKey + (channel.name ? "." + channel.name : "[" + index + "]");
    allowed(channel.raw, channelFields, at, errors);
    const raw = channel.raw;
    if (raw.Discord !== undefined)
      allowed(raw.Discord, ["Token", "ChannelIDs", "ChannelID", "GuildID",
        "cookie", "x-super-properties", "Thread"], at + ".Discord", errors);
    if (raw.Telegram !== undefined && raw.Telegram !== null)
      allowed(raw.Telegram, ["Enabled", "BotToken", "ChatID", "MessageThreadID",
        "DisableWebPagePreview", "TimeoutMs"], at + ".Telegram", errors);
    if (channel.Discord?.Thread && !noVal(channel.Discord.Thread))
      errors.push(issue(at + ".Discord.Thread", "unsupported_legacy_field",
        "Discord source thread has no v2 mapping"));
    if (raw.Discord?.Webhook)
      errors.push(issue(at + ".Discord.Webhook", "unsupported_legacy_field",
        "Discord source webhook must be mapped manually"));
    if (channel.Telegram && channel.Telegram.Enabled !== false &&
        (!channel.Telegram.BotToken || !channel.Telegram.ChatID))
      errors.push(issue(at + ".Telegram", "incomplete_destination",
        "Incomplete Telegram destination cannot be migrated safely"));
    if (cacheKeys.has(channel.cacheKey))
      errors.push(issue(at + ".CacheKey", "duplicate_identity",
        "Duplicate delivery cache key would make migration unsafe"));
    cacheKeys.add(channel.cacheKey);

    const unsafeArray = !channel.name &&
      /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(JSON.stringify(raw));
    if (unsafeArray) errors.push(issue(at, "dynamic_identity",
      "Anonymous channels using environment references require a stable explicit ID"));

    const base = channel.name && idPattern.test(channel.name) && !names.has(channel.name)
      ? channel.name : (channel.sourceKey || "channels") + "_" + (channel.name || String(index + 1));
    let key = base.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 70).replace(/^[^A-Za-z0-9]+/, "") || "channel";
    let n = 1;
    while (names.has(key)) key = base.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 62) + "_" + (++n);
    names.add(key);

    const sources = channel.RSS.map(url => ({ type: "feed", url }));
    const discord = channel.Discord;
    if (discord) {
      const ids = Array.isArray(discord.ChannelIDs) ? discord.ChannelIDs :
        (discord.ChannelID ? [discord.ChannelID] : []);
      sources.push({
        type: "discord", channelIds: ids,
        ...(discord.Token ? { token: discord.Token } : {}),
        ...(discord.GuildID ? { guildId: discord.GuildID } : {}),
        ...(discord.cookie && discord.cookie !== oldConfig.Auth?.cookie ?
          { cookie: discord.cookie } : {}),
        ...(discord["x-super-properties"] &&
          discord["x-super-properties"] !== oldConfig.Auth?.["x-super-properties"] ?
          { superProperties: discord["x-super-properties"] } : {}),
      });
    }
    const destinations = [];
    if (channel.Webhook) destinations.push({
      type: "webhook", url: channel.Webhook,
      ...(channel.Thread ? { threadId: channel.Thread } : {}),
    });
    if (channel.Telegram && channel.Telegram.Enabled !== false &&
        channel.Telegram.BotToken && channel.Telegram.ChatID) {
      const tel = channel.Telegram;
      destinations.push({
        type: "telegram",
        chatId: tel.ChatID,
        ...(tel.BotToken !== oldConfig.Telegram?.BotToken ? { botToken: tel.BotToken } : {}),
        ...(tel.MessageThreadID ? { messageThreadId: tel.MessageThreadID } : {}),
        ...(tel.DisableWebPagePreview === undefined ? {} :
          { disableWebPagePreview: tel.DisableWebPagePreview }),
        ...(tel.TimeoutMs && tel.TimeoutMs !== oldConfig.Telegram?.TimeoutMs ?
          { timeoutMs: tel.TimeoutMs } : {}),
      });
    }
    output[key] = {
      id: channel.cacheKey, sources, destinations,
      timeChecker: channel.TimeChecker, requestSend: channel.RequestSend,
    };
  }
  const v2 = {
    schemaVersion: 2,
    settings: {
      ...(oldConfig.Settings?.Logs === undefined ? {} : { logs: oldConfig.Settings.Logs }),
      ...(oldConfig.Settings?.DebugExpert === undefined ? {} : { debugExpert: oldConfig.Settings.DebugExpert }),
      ...(oldConfig.Settings?.MaxConcurrentChannels === undefined ? {} :
        { maxConcurrentChannels: oldConfig.Settings.MaxConcurrentChannels }),
    },
    integrations: {
      ...(oldConfig.Auth ? { discord: {
        ...(oldConfig.Auth.Token ? { token: oldConfig.Auth.Token } : {}),
        ...(oldConfig.Auth.cookie ? { cookie: oldConfig.Auth.cookie } : {}),
        ...(oldConfig.Auth["x-super-properties"] ?
          { superProperties: oldConfig.Auth["x-super-properties"] } : {}),
      } } : {}),
      ...(oldConfig.Telegram ? { telegram: {
        ...(oldConfig.Telegram.Enabled === undefined ? {} : { enabled: oldConfig.Telegram.Enabled }),
        ...(oldConfig.Telegram.BotToken ? { botToken: oldConfig.Telegram.BotToken } : {}),
        ...(oldConfig.Telegram.ChatID ? { chatId: String(oldConfig.Telegram.ChatID) } : {}),
        ...(oldConfig.Telegram.TimeoutMs ? { timeoutMs: oldConfig.Telegram.TimeoutMs } : {}),
      } } : {}),
      ...(oldConfig.Proxy ? { proxy: {
        ...(oldConfig.Proxy.Enabled === undefined ? {} : { enabled: oldConfig.Proxy.Enabled }),
        ...(oldConfig.Proxy.Url ? { url: oldConfig.Proxy.Url } : {}),
      } } : {}),
      ...(oldConfig.Scrapling ? { scrapling: {
        ...(oldConfig.Scrapling.Enabled === undefined ? {} : { enabled: oldConfig.Scrapling.Enabled }),
        ...(oldConfig.Scrapling.AutoFallback === undefined ? {} :
          { autoFallback: oldConfig.Scrapling.AutoFallback }),
      } } : {}),
    },
    channels: output,
  };
  const result = validateConfigSchema(v2);
  errors.push(...result.errors);
  if (!errors.length) {
    const migrated = collectConfiguredChannels(toLegacyRuntime(v2));
    for (let i = 0; i < channels.length; i++) {
      const a = channels[i], b = migrated[i];
      const normalizeDiscord = value => value ? {
        ids: value.ChannelIDs || (value.ChannelID ? [value.ChannelID] : []),
        token: value.Token || "",
        guildId: value.GuildID || "",
        cookie: value.cookie || "",
        superProperties: value["x-super-properties"] || "",
      } : null;
      const normalizeTelegram = value => value?.Enabled === false || !value?.BotToken || !value?.ChatID
        ? null : {
          botToken: value.BotToken, chatId: value.ChatID,
          threadId: value.MessageThreadID ?? null,
          preview: value.DisableWebPagePreview === true,
          timeoutMs: value.TimeoutMs,
        };
      for (const field of ["cacheKey", "TimeChecker", "RequestSend", "RSS", "Webhook", "Thread"]) {
        if (JSON.stringify(a[field]) !== JSON.stringify(b[field]))
          errors.push(issue("channels[" + i + "]." + field, "semantic_mismatch",
            "Migrated runtime behavior differs from legacy configuration"));
      }
      if (JSON.stringify(normalizeDiscord(a.Discord)) !== JSON.stringify(normalizeDiscord(b.Discord)) ||
          JSON.stringify(normalizeTelegram(a.Telegram)) !== JSON.stringify(normalizeTelegram(b.Telegram)))
        errors.push(issue("channels[" + i + "]", "semantic_mismatch",
          "Migrated source or destination differs from legacy configuration"));
    }
  }
  if (errors.length) throw new ConfigMigrationError(errors.slice(0, 50));
  return v2;
}

module.exports = { migrateConfig, toLegacyRuntime, ConfigMigrationError };
