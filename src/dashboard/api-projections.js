"use strict";

const crypto = require("node:crypto");
const { collectConfiguredChannels } = require("../core/channel-config");
const { toLegacyRuntime } = require("../core/config-migration");
const { sanitizeText } = require("../core/diagnostics");

// The default dashboard API intentionally never serializes raw channel,
// integration or environment objects. Inline secrets may exist at *any*
// depth in legacy config, not just in a field named "Token".
function normalizedChannels(config) {
  const runtime = config?.schemaVersion === 2 ? toLegacyRuntime(config) : config;
  return collectConfiguredChannels(runtime || {});
}

function projectChannels(config) {
  return normalizedChannels(config).map((channel, index) => {
    const idInput = JSON.stringify([channel.sourceKey || "channels",
      channel.name === null ? index : channel.name]);
    const id = crypto.createHash("sha256").update(idInput).digest("hex").slice(0, 24);
    return {
      id,
      label: channel.name ? sanitizeText(channel.name).slice(0, 80) : "Channel " + (index + 1),
      intervalMinutes: channel.TimeChecker,
      maxEntriesPerCycle: channel.RequestSend,
      sources: {
        feedCount: Array.isArray(channel.RSS) ? channel.RSS.length : 0,
        discord: Boolean(channel.Discord),
      },
      destinations: {
        webhook: Boolean(channel.Webhook),
        telegram: Boolean(channel.Telegram?.BotToken && channel.Telegram?.ChatID &&
          channel.Telegram?.Enabled !== false),
      },
    };
  });
}

function projectOverview(config, ready) {
  const channels = projectChannels(config);
  return {
    workerReady: ready === true,
    totalChannels: channels.length,
    totalFeeds: channels.reduce((n, channel) => n + channel.sources.feedCount, 0),
    destinations: {
      webhook: channels.filter(channel => channel.destinations.webhook).length,
      telegram: channels.filter(channel => channel.destinations.telegram).length,
    },
  };
}

function projectSettings(config, networkSettings = null) {
  const v2 = config?.schemaVersion === 2;
  const settings = v2 ? config.settings || {} : config?.Settings || {};
  const integrations = v2 ? config.integrations || {} : {};
  const proxy = v2 ? integrations.proxy : config?.Proxy;
  const scrapling = v2 ? integrations.scrapling : config?.Scrapling;
  return {
    schemaVersion: v2 ? 2 : 1,
    general: {
      logs: (v2 ? settings.logs : settings.Logs) === true,
      expertDiagnostics: (v2 ? settings.debugExpert : settings.DebugExpert) === true,
      maxConcurrentChannels: v2
        ? settings.maxConcurrentChannels ?? 1 : settings.MaxConcurrentChannels ?? 1,
    },
    integrations: {
      proxyEnabled: (v2 ? proxy?.enabled : proxy?.Enabled) === true,
      scraplingEnabled: (v2 ? scrapling?.enabled : scrapling?.Enabled) === true,
    },
    network: networkSettings,
  };
}

module.exports = { projectChannels, projectOverview, projectSettings };
