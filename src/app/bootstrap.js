"use strict";

const { sendMessage } = require("../message");
const { sendMatrixMessage } = require("../matrix");
const { download } = require("../parsers/downloader");
const { getWithFallback, postWithFallback } = require("../client");
const { loadConfig } = require("../config-loader");
const { createCacheStore } = require("../core/cache-store");
const { collectConfiguredChannels, summarizeChannel, validateChannels } = require("../core/channel-config");
const { createFeedPipeline } = require("../core/feed-pipeline");
const { createChannelRunner } = require("./channel-runner");
const { runChannelsOnce, startChannelQueue } = require("./runtime");

const { parseRSS } = require("../parsers/rss");
const { parseAtom } = require("../parsers/atom");
const { parseYouTube } = require("../parsers/youtube");
const { parseXML } = require("../parsers/xml");
const { parseJSON } = require("../parsers/json");
const { parseFreshRSS } = require("../parsers/freshrss");
const { parseApiX } = require("../parsers/api_x");
const { parseFallback } = require("../parsers/fallback");
const { parseDiscord } = require("../parsers/discord");

function logChannelSummary(channels) {
  const warnings = validateChannels(channels);
  for (const warning of warnings) {
    console.warn(warning);
  }

  for (const summary of (channels || []).map(summarizeChannel)) {
    const targets = [
      summary.hasWebhook ? "webhook" : null,
      summary.hasDiscord ? "discord-source" : null,
      summary.hasMatrix ? "matrix" : null,
    ].filter(Boolean).join("+") || "none";
    console.log(
      `[Config] ${summary.label}: feeds=${summary.feeds}, targets=${targets}, interval=${summary.interval}m, burst=${summary.burst}, cacheKey=${summary.cacheKey}`
    );
  }
}

function createApp({
  configPath = "./config.json",
  cachePath = "./cache.json",
  autostart = true,
  delayBetweenChannels = 30000,
  dryRun = false,
} = {}) {
  const state = {
    config: {},
    allChannels: [],
    configDigest: "",
  };
  const cacheStore = createCacheStore(cachePath);
  let queueRuntime = null;

  const { fetchFeed } = createFeedPipeline({
    getConfig: () => state.config,
    download,
    getWithFallback,
    postWithFallback,
    builtInParsers: [
      parseFreshRSS,
      parseYouTube,
      parseAtom,
      parseXML,
      parseJSON,
      parseApiX,
      parseRSS,
      parseFallback,
    ],
  });

  const { checkFeedsForChannel } = createChannelRunner({
    cacheStore,
    fetchFeed,
    parseDiscord,
    sendMessage,
    sendMatrixMessage,
    dryRun,
  });

  function applyConfig(nextConfig, { quiet = false } = {}) {
    state.config = nextConfig;
    state.allChannels = collectConfiguredChannels(nextConfig);

    if (!quiet) {
      console.log(`[System] Channels to process: ${state.allChannels.length}`);
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

      state.configDigest = nextDigest;
      applyConfig(nextConfig, { quiet });
      return true;
    } catch (error) {
      console.error(`[Config] Failed to load ${configPath}: ${error.message}`);
      return false;
    }
  }

  function startQueue() {
    if (queueRuntime) {
      return queueRuntime;
    }

    queueRuntime = startChannelQueue({
      getChannels: () => state.allChannels,
      checkFeedsForChannel,
      delayBetweenChannels,
      beforeCycle: () => {
        refreshConfig({ quiet: false });
      },
    });

    return queueRuntime;
  }

  async function runOnce() {
    return runChannelsOnce({
      getChannels: () => state.allChannels,
      checkFeedsForChannel,
      beforeRun: async () => {
        refreshConfig({ force: true, quiet: false });
      },
    });
  }

  function shutdown({ exit = false, exitCode = 0, persistCache = !dryRun } = {}) {
    if (queueRuntime && typeof queueRuntime.stop === "function") {
      queueRuntime.stop();
      queueRuntime = null;
    }

    if (persistCache) {
      cacheStore.save();
    }

    if (exit) {
      process.exit(exitCode);
    }
  }

  refreshConfig({ force: true, quiet: false });
  if (autostart) {
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
