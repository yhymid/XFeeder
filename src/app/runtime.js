"use strict";

const { getChannelLabel } = require("../core/channel-config");
const { expert } = require("../core/diagnostics");
const { isCancelled } = require("../network/abort");
const { getRetryAfterMs } = require("../client");
const { createLogger } = require("../core/logger");
const logger = createLogger("Scheduler");
const { errorRecord } = require("../core/errors");
const { queueKey, nextChannelIndex, validateQueueDelay } = require("./scheduler-policy");
const { startConcurrentChannelQueue, validateConcurrency } = require("./concurrent-scheduler");

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
    logger.error("No valid channels configured for one-shot execution");
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
    logger.info("Checking channel", { mode: "once", label, index: index + 1, total: channels.length });
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
  maxConcurrentChannels = 1,
  onFatal,
} = {}) {
  validateConcurrency(maxConcurrentChannels);
  delayBetweenChannels = validateQueueDelay(delayBetweenChannels);
  if (maxConcurrentChannels > 1) return startConcurrentChannelQueue({
    getChannels, getTaskStates, checkFeedsForChannel,
    delayBetweenChannels, beforeCycle, maxConcurrentChannels, onFatal,
  });
  const initialChannels = normalizeChannels(getChannels);
  if (initialChannels.length === 0) {
    logger.error("No valid channels configured; queue not started");
    expert("queue.not_started", { reason: "no channels" });
    return null;
  }

  const lastCheckByCacheKey = new Map();
  const scheduleByCacheKey = new Map();
  let currentIndex = 0;
  let nextChannelKey = null;
  let timer = null;
  let stopped = false;

  async function processNextChannel() {
    if (stopped) return;
    expert("queue.cycle.begin", { currentIndex, stopped });

    if (typeof beforeCycle === "function") {
      try {
        await beforeCycle();
      } catch (err) {
        logger.error("Configuration refresh failed", { failure: errorRecord(err, { context: "configuration" }) });
      }
    }

    if (stopped) return;
    let channels;
    try {
      channels = normalizeChannels(getChannels);
    } catch (error) {
      // A transient config/provider failure must not kill the async timer
      // callback and strand the queue with no future scheduled turn.
      logger.error("Channel list refresh failed", { failure: errorRecord(error, { context: "configuration" }) });
      expert("queue.refresh.failed", { error });
      if (!stopped) timer = setTimeout(processNextChannel, delayBetweenChannels);
      return;
    }
    if (channels.length === 0) {
      logger.warn("No channels available after refresh; waiting");
      expert("queue.wait", { reason: "no channels", delayMs: delayBetweenChannels });
      timer = setTimeout(processNextChannel, delayBetweenChannels);
      return;
    }

    // Prefer the intended next channel's identity over its former position.
    // A hot reload may insert/reorder channels before our next rotation.
    currentIndex = nextChannelIndex(channels, nextChannelKey, currentIndex);

    const channel = channels[currentIndex];
    if (!channel) {
      expert("queue.skip", { index: currentIndex + 1, reason: "missing channel entry" });
      currentIndex = (currentIndex + 1) % channels.length;
      nextChannelKey = queueKey(channels[currentIndex], currentIndex);
      if (!stopped) timer = setTimeout(processNextChannel, delayBetweenChannels);
      return;
    }

    const now = Date.now();
    const minutes = channel.TimeChecker || 30;
    const minDelay = minutes * 60 * 1000;
    const cacheKey = queueKey(channel, currentIndex);
    const schedule = scheduleByCacheKey.get(cacheKey) || {
      lastAttemptAt: null, lastSuccessAt: null, nextRunAt: 0, failures: 0,
    };
    const lastCheck = schedule.lastSuccessAt || 0;
    expert("queue.channel.selected", {
      index: currentIndex + 1,
      totalChannels: channels.length,
      channel: getChannelLabel(channel),
      intervalMinutes: minutes,
      elapsedSinceLastCheckMs: lastCheck ? now - lastCheck : null,
      delayBetweenChannelsMs: delayBetweenChannels,
    });

    if (now >= schedule.nextRunAt) {
      const label = getChannelLabel(channel);
      const startedAt = Date.now();
      schedule.lastAttemptAt = startedAt;
      scheduleByCacheKey.set(cacheKey, schedule);
      logger.info("Checking channel", { mode: "queue", label, index: currentIndex + 1, total: channels.length });
      try {
        await checkFeedsForChannel(currentIndex, channel);
        schedule.lastSuccessAt = Date.now();
        schedule.failures = 0;
        schedule.nextRunAt = schedule.lastSuccessAt + minDelay;
        lastCheckByCacheKey.set(cacheKey, schedule.lastSuccessAt);
        expert("queue.channel.complete", { index: currentIndex + 1, channel: label, durationMs: Date.now() - startedAt });
      } catch (err) {
        const completedAt = Date.now();
        if (err?.code === "CACHE_UNSAFE") {
          stopped = true;
          if (timer !== null) { clearTimeout(timer); timer = null; }
          try { onFatal?.(err); }
          catch (failure) {
            logger.error("Fatal cancellation callback failed", { failure: errorRecord(failure) });
          }
        }
        if (!isCancelled(err)) schedule.failures = Math.min(32, schedule.failures + 1);
        // A failed attempt still consumes the base interval. Backoff is per
        // channel, at most 8 intervals / one hour (never below TimeChecker).
        const backoff = Math.min(minDelay * 2 ** Math.min(3, Math.max(0, schedule.failures - 1)), Math.max(minDelay, 3600000));
        const retryAfter = getRetryAfterMs(err?.response?.headers, completedAt) || 0;
        schedule.nextRunAt = completedAt + Math.max(minDelay, backoff, retryAfter);
        if (isCancelled(err)) { expert("queue.channel.cancelled", { channel: label }); }
        else {
        logger.error("Channel failed", { label, failure: errorRecord(err, { context: "source" }) });
        expert("queue.channel.failed", { index: currentIndex + 1, channel: label, durationMs: Date.now() - startedAt, error: err });
        }
      }
    } else {
      expert("queue.channel.skipped", {
        index: currentIndex + 1,
        channel: getChannelLabel(channel),
        reason: "interval not elapsed",
        remainingMs: Math.max(0, schedule.nextRunAt - now),
      });
    }

    currentIndex = (currentIndex + 1) % channels.length;
    nextChannelKey = queueKey(channels[currentIndex], currentIndex);
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
        nextChannelKey,
        totalChannels: channels.length,
        lastCheckByCacheKey: Object.fromEntries(lastCheckByCacheKey.entries()),
        scheduleByCacheKey: Object.fromEntries([...scheduleByCacheKey].map(([key, state]) => [key, { ...state }])),
        channels: getTaskStates(),
      };
    },
  };
}

module.exports = {
  runChannelsOnce,
  startChannelQueue,
};
