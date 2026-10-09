"use strict";

const { getChannelLabel } = require("../core/channel-config");
const { expert } = require("../core/diagnostics");
const { isCancelled } = require("../network/abort");

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
  shouldStop = () => false,
} = {}) {
  if (typeof beforeRun === "function") {
    await beforeRun();
  }

  const channels = normalizeChannels(getChannels);
  expert("run.channels.begin", { channelCount: channels.length });
  if (channels.length === 0) {
    console.error("[System] No valid channels configured. Nothing to run.");
    return {
      totalChannels: 0,
      checkedChannels: 0,
    };
  }

  let checkedChannels = 0;
  for (const [index, channel] of channels.entries()) {
    if (shouldStop()) break;
    const label = getChannelLabel(channel);
    const startedAt = Date.now();
    console.log(`[Once] Checking ${label} (${index + 1}/${channels.length})`);
    expert("channel.begin", { index: index + 1, label });
    try {
      await checkFeedsForChannel(index, channel);
      checkedChannels++;
      expert("channel.complete", { index: index + 1, label, durationMs: Date.now() - startedAt });
    } catch (error) {
      if (isCancelled(error)) { expert("channel.cancelled", { index: index + 1, label }); break; }
      expert("channel.failed", { index: index + 1, label, durationMs: Date.now() - startedAt, error });
      throw error;
    }
  }

  return {
    totalChannels: channels.length,
    checkedChannels,
  };
}

function startChannelQueue({
  getChannels,
  getTaskStates = () => ({}),
  checkFeedsForChannel,
  delayBetweenChannels = 30000,
  beforeCycle,
} = {}) {
  const initialChannels = normalizeChannels(getChannels);
  if (initialChannels.length === 0) {
    console.error("[System] No valid channels configured. Queue not started.");
    expert("queue.not_started", { reason: "no channels" });
    return null;
  }

  const lastCheckByCacheKey = new Map();
  let currentIndex = 0;
  let timer = null;
  let stopped = false;

  async function processNextChannel() {
    if (stopped) return;
    expert("queue.cycle.begin", { currentIndex, stopped });

    if (typeof beforeCycle === "function") {
      try {
        await beforeCycle();
      } catch (err) {
        console.error(`[Queue] Config refresh error: ${err.message}`);
      }
    }

    if (stopped) return;
    const channels = normalizeChannels(getChannels);
    if (channels.length === 0) {
      console.warn("[Queue] No channels available after refresh. Waiting...");
      expert("queue.wait", { reason: "no channels", delayMs: delayBetweenChannels });
      timer = setTimeout(processNextChannel, delayBetweenChannels);
      return;
    }

    if (currentIndex >= channels.length) {
      currentIndex = 0;
    }

    const channel = channels[currentIndex];
    if (!channel) {
      expert("queue.skip", { index: currentIndex + 1, reason: "missing channel entry" });
      currentIndex = (currentIndex + 1) % channels.length;
      timer = setTimeout(processNextChannel, delayBetweenChannels);
      return;
    }

    const now = Date.now();
    const minutes = channel.TimeChecker || 30;
    const minDelay = minutes * 60 * 1000;
    const cacheKey = channel.cacheKey || `${currentIndex}`;
    const lastCheck = lastCheckByCacheKey.get(cacheKey) || 0;
    expert("queue.channel.selected", {
      index: currentIndex + 1,
      totalChannels: channels.length,
      channel: getChannelLabel(channel),
      intervalMinutes: minutes,
      elapsedSinceLastCheckMs: lastCheck ? now - lastCheck : null,
      delayBetweenChannelsMs: delayBetweenChannels,
    });

    if (now - lastCheck >= minDelay) {
      const label = getChannelLabel(channel);
      const startedAt = Date.now();
      console.log(`[Queue] Checking ${label} (${currentIndex + 1}/${channels.length})`);
      try {
        await checkFeedsForChannel(currentIndex, channel);
        lastCheckByCacheKey.set(cacheKey, Date.now());
        expert("queue.channel.complete", { index: currentIndex + 1, channel: label, durationMs: Date.now() - startedAt });
      } catch (err) {
        if (isCancelled(err)) { expert("queue.channel.cancelled", { channel: label }); }
        else {
        console.error(`[Queue] ${label} error: ${err.message}`);
        expert("queue.channel.failed", { index: currentIndex + 1, channel: label, durationMs: Date.now() - startedAt, error: err });
        }
      }
    } else {
      expert("queue.channel.skipped", {
        index: currentIndex + 1,
        channel: getChannelLabel(channel),
        reason: "interval not elapsed",
        remainingMs: Math.max(0, minDelay - (now - lastCheck)),
      });
    }

    currentIndex = (currentIndex + 1) % channels.length;
    if (!stopped) timer = setTimeout(processNextChannel, delayBetweenChannels);
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
        channels: getTaskStates(),
      };
    },
  };
}

module.exports = {
  runChannelsOnce,
  startChannelQueue,
};
