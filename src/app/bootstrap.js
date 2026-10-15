"use strict";

const { sendMessage } = require("../message");
const { sendTelegramMessage } = require("../telegram");
const { download } = require("../parsers/downloader");
const { getHttpClient, getWithFallback, postWithFallback } = require("../client");
const { loadConfig } = require("../config-loader");
const { getNetwork, resetNetwork } = require("../network/service");
const { ChannelTasks } = require("./channel-tasks");
const { startNetworkRuntime } = require("../network/runtime-state");
const { createCacheStore } = require("../core/cache-store");
const {
  collectConfiguredChannels,
  hasTelegramDeliveryTarget,
  summarizeChannel,
  validateChannels,
} = require("../core/channel-config");
const { createFeedPipeline } = require("../core/feed-pipeline");
const { expert, setExpertDebug } = require("../core/diagnostics");
const { setTerminalLogEnabled } = require("../core/terminal-log");
const { createLogger } = require("../core/logger");
const logger = createLogger("App");
const { errorRecord } = require("../core/errors");
const { createChannelRunner } = require("./channel-runner");
const { runChannelsOnce, startChannelQueue } = require("./runtime");
const { closeBrowserSessions } = require("../extensions/Scrapling");

const { createSourceAdapters } = require("../core/source-adapters");

function logChannelSummary(channels) {
  const warnings = validateChannels(channels);
  for (const warning of warnings) {
    logger.warn(warning);
  }

  for (const summary of (channels || []).map(summarizeChannel)) {
    const targets = [
      summary.hasWebhook ? "webhook" : null,
      summary.hasDiscord ? "discord-source" : null,
      summary.hasTelegram ? "telegram" : null,
    ].filter(Boolean).join("+") || "none";
    logger.info("Channel configured", { label: summary.label, feeds: summary.feeds, targets, intervalMinutes: summary.interval, burst: summary.burst, cacheKey: summary.cacheKey });
  }
}

function createApp({
  configPath = "./config.json",
  cachePath = "./cache.json",
  autostart = true,
  delayBetweenChannels = 30000,
  dryRun = false,
  debugExpert = false,
} = {}) {
  setExpertDebug(debugExpert);
  expert("app.start", { configPath, cachePath, dryRun, autostart });
  const state = {
    config: {},
    allChannels: [],
    configDigest: "",
  };
  const cacheStore = createCacheStore(cachePath);
  let queueRuntime = null;
  let shutdownPromise = null;
  let stopNetworkRuntime = () => {};
  const tasks = new ChannelTasks();
  const network = getNetwork().stopping ? resetNetwork() : getNetwork();
  network.ownedByApp = true;

  const sources = createSourceAdapters({
    getDiscordHttpClient: () => getHttpClient(configPath, state.config),
  });

  const { fetchFeed } = createFeedPipeline({
    getConfig: () => state.config,
    configPath,
    getFeedValidator: (feedUrl) => cacheStore.getFeedValidator(feedUrl),
    getFeedItems: (feedUrl) => cacheStore.getFeedItems(feedUrl),
    setFeedSnapshot: (feedUrl, validator, items) => cacheStore.setFeedSnapshot(
      feedUrl,
      validator,
      items,
      { persist: !dryRun }
    ),
    download,
    getWithFallback,
    postWithFallback,
    builtInParsers: sources.feedParsers,
  });

  const { checkFeedsForChannel: runChannel } = createChannelRunner({
    cacheStore,
    fetchFeed,
    parseDiscord: (discordConfig) => sources.discord.read(discordConfig),
    sendMessage,
    sendTelegramMessage,
    dryRun,
  });

  const checkFeedsForChannel = (index, channel) => tasks.run(index, channel, runChannel);

  function applyConfig(nextConfig, { quiet = false } = {}) {
    network.configure(nextConfig.network);
    state.config = nextConfig;
    const debugExpertEnabled = debugExpert || nextConfig?.Settings?.DebugExpert === true;
    setExpertDebug(debugExpertEnabled);
    setTerminalLogEnabled(debugExpertEnabled || nextConfig?.Settings?.Logs === true);
    state.allChannels = collectConfiguredChannels(nextConfig);

    if (!quiet) {
      logger.info("Channels to process", { count: state.allChannels.length });
      logChannelSummary(state.allChannels);
    }
  }

  function refreshConfig({ force = false, quiet = true } = {}) {
    try {
      const nextConfig = loadConfig(configPath);
      const nextDigest = JSON.stringify(nextConfig);
      if (!force && state.configDigest === nextDigest) {
        return false;
      }

      applyConfig(nextConfig, { quiet });
      state.configDigest = nextDigest;
      expert("config.loaded", {
        path: configPath,
        channelCount: state.allChannels.length,
        warnings: validateChannels(state.allChannels).length,
        channels: state.allChannels.map((channel, index) => ({
          index: index + 1,
          label: summarizeChannel(channel).label,
          feeds: channel.RSS || channel.Feeds || channel.URLs || channel.Sources || [],
          feedCount: summarizeChannel(channel).feeds,
          intervalMinutes: summarizeChannel(channel).interval,
          sources: [
            Array.isArray(channel.RSS) && channel.RSS.length ? "feeds" : null,
            channel.Discord ? "discord" : null,
          ].filter(Boolean),
          deliveryTargets: [
            channel.Webhook || channel.Discord?.Webhook ? "webhook" : null,
            hasTelegramDeliveryTarget(channel.Telegram) ? "telegram" : null,
          ].filter(Boolean),
          telegramSettingsPresent: Boolean(channel.Telegram),
        })),
      });
      return true;
    } catch (error) {
      logger.error("Configuration reload failed", { configPath, failure: errorRecord(error, { context: "configuration" }) });
      expert("config.load.failed", { path: configPath, error });
      if (!state.configDigest) throw error;
      return false;
    }
  }

  function startQueue() {
    if (shutdownPromise) return null;
    if (queueRuntime) {
      return queueRuntime;
    }

    queueRuntime = startChannelQueue({
      getChannels: () => state.allChannels,
      getTaskStates: () => tasks.snapshot(),
      checkFeedsForChannel,
      delayBetweenChannels,
      beforeCycle: () => {
        refreshConfig({ quiet: false });
      },
    });

    return queueRuntime;
  }

  async function runOnce() {
    const startedAt = Date.now();
    expert("run.once.begin", { channelCount: state.allChannels.length });
    try {
      const result = await runChannelsOnce({
        getChannels: () => state.allChannels,
        checkFeedsForChannel,
        shouldStop: () => tasks.stopping,
        beforeRun: async () => {
          refreshConfig({ force: true, quiet: false });
        },
      });
      expert("run.once.complete", { ...result, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      expert("run.once.failed", { durationMs: Date.now() - startedAt, error });
      throw error;
    }
  }

  function shutdown({ exit = false, exitCode = 0, persistCache = !dryRun, graceMs = network.config.shutdownGraceMs } = {}) {
    if (shutdownPromise) return shutdownPromise;
    tasks.stop();
    const telemetryStopped = stopNetworkRuntime();
    queueRuntime?.stop();
    shutdownPromise = (async () => {
      expert("app.shutdown", { exit, exitCode, persistCache, dryRun });
      const failures = [];
      const cleanup = async (operation) => {
        try { await operation(); }
        catch (error) { failures.push(error); }
      };

      // A failed network/browser cleanup must not skip task cancellation,
      // telemetry shutdown or the final delivery-state flush.
      await cleanup(() => network.shutdown(graceMs));
      tasks.abort();
      await cleanup(() => closeBrowserSessions());
      // Every built-in operation observes cancellation. Bound third-party plugin
      // cleanup too; a plugin that ignores its signal cannot hold shutdown forever.
      let cleanupTimer;
      try {
        await cleanup(() => Promise.race([
          tasks.idle(),
          new Promise((resolve) => { cleanupTimer = setTimeout(resolve, 2000); }),
        ]));
      } finally { clearTimeout(cleanupTimer); }
      await cleanup(() => telemetryStopped);
      if (persistCache) await cleanup(() => cacheStore.save());

      if (failures.length) {
        const failure = failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Multiple XFeeder shutdown steps failed");
        if (exit) {
          logger.error("Shutdown cleanup failed; exiting with an error");
          process.exit(1);
        }
        throw failure;
      }
      if (exit) process.exit(exitCode);
    })();
    return shutdownPromise;
  }

  refreshConfig({ force: true, quiet: false });
  if (autostart) {
    stopNetworkRuntime = startNetworkRuntime({ configPath, network, refreshConfig });
    startQueue();
  }

  return {
    get config() {
      return state.config;
    },
    get allChannels() {
      return state.allChannels;
    },
    cacheStore,
    fetchFeed,
    checkFeedsForChannel,
    get channelStates() { return tasks.snapshot(); },
    network,
    get queueRuntime() {
      return queueRuntime;
    },
    dryRun,
    refreshConfig,
    runOnce,
    shutdown,
    startQueue,
  };
}

module.exports = {
  createApp,
};
