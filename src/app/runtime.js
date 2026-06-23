"use strict";

const { getChannelLabel } = require("../core/channel-config");

function normalizeChannels(getChannels) {
  if (typeof getChannels === "function") {
    const result = getChannels();
    return Array.isArray(result) ? result : [];
  }
  return Array.isArray(getChannels) ? getChannels : [];
}

async function runChannelsOnce({
  getChannels,
  checkFeedsForChannel,
  beforeRun,
} = {}) {
  if (typeof beforeRun === "function") {
    await beforeRun();
  }

  const channels = normalizeChannels(getChannels);
  if (channels.length === 0) {
    console.error("[System] No valid channels configured. Nothing to run.");
    return {
      totalChannels: 0,
      checkedChannels: 0,
    };
  }

  for (const [index, channel] of channels.entries()) {
    const label = getChannelLabel(channel);
    console.log(`[Once] Checking ${label} (${index + 1}/${channels.length})`);
    await checkFeedsForChannel(index, channel);
  }

  return {
    totalChannels: channels.length,
    checkedChannels: channels.length,
  };
}

function startChannelQueue({
  getChannels,
  checkFeedsForChannel,
  delayBetweenChannels = 30000,
  beforeCycle,
} = {}) {
  const initialChannels = normalizeChannels(getChannels);
  if (initialChannels.length === 0) {
    console.error("[System] No valid channels configured. Queue not started.");
    return null;
  }

  const lastCheckByCacheKey = new Map();
  let currentIndex = 0;
  let timer = null;
  let stopped = false;

  async function processNextChannel() {
    if (stopped) return;

    if (typeof beforeCycle === "function") {
      try {
        await beforeCycle();
      } catch (err) {
        console.error(`[Queue] Config refresh error: ${err.message}`);
      }
    }

    const channels = normalizeChannels(getChannels);
    if (channels.length === 0) {
      console.warn("[Queue] No channels available after refresh. Waiting...");
      timer = setTimeout(processNextChannel, delayBetweenChannels);
      return;
    }

    if (currentIndex >= channels.length) {
      currentIndex = 0;
    }

    const channel = channels[currentIndex];
    if (!channel) {
      currentIndex = (currentIndex + 1) % channels.length;
      timer = setTimeout(processNextChannel, delayBetweenChannels);
      return;
    }

    const now = Date.now();
    const minutes = channel.TimeChecker || 30;
    const minDelay = minutes * 60 * 1000;
    const cacheKey = channel.cacheKey || `${currentIndex}`;
    const lastCheck = lastCheckByCacheKey.get(cacheKey) || 0;

    if (now - lastCheck >= minDelay) {
      const label = getChannelLabel(channel);
      console.log(`[Queue] Checking ${label} (${currentIndex + 1}/${channels.length})`);
      try {
        await checkFeedsForChannel(currentIndex, channel);
        lastCheckByCacheKey.set(cacheKey, Date.now());
      } catch (err) {
        console.error(`[Queue] ${label} error: ${err.message}`);
      }
    }

    currentIndex = (currentIndex + 1) % channels.length;
    timer = setTimeout(processNextChannel, delayBetweenChannels);
  }

  processNextChannel();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    getState() {
      const channels = normalizeChannels(getChannels);
      return {
        currentIndex,
        totalChannels: channels.length,
        lastCheckByCacheKey: Object.fromEntries(lastCheckByCacheKey.entries()),
      };
    },
  };
}

module.exports = {
  runChannelsOnce,
  startChannelQueue,
};
