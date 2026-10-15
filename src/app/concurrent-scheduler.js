"use strict";

const { getChannelLabel } = require("../core/channel-config");
const { expert } = require("../core/diagnostics");
const { errorRecord } = require("../core/errors");
const { createLogger } = require("../core/logger");
const { isCancelled } = require("../network/abort");
const { getRetryAfterMs } = require("../client");
const { queueKey, nextChannelIndex, validateQueueDelay } = require("./scheduler-policy");

const logger = createLogger("Scheduler");

function validateConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8)
    throw new RangeError("maxConcurrentChannels must be an integer from 1 to 8");
  return value;
}

function channelsFrom(getChannels) {
  const result = typeof getChannels === "function" ? getChannels() : getChannels;
  return Array.isArray(result) ? result : [];
}

// Concurrency is opt-in. One polling timer walks the round-robin cursor,
// dispatching at most one eligible *different* channel per tick. Completion
// never triggers an extra timer, even after a synchronous provider failure.
function startConcurrentChannelQueue({
  getChannels,
  getTaskStates = () => ({}),
  checkFeedsForChannel,
  delayBetweenChannels = 30000,
  beforeCycle,
  maxConcurrentChannels = 2,
} = {}) {
  validateConcurrency(maxConcurrentChannels);
  validateQueueDelay(delayBetweenChannels);
  if (typeof checkFeedsForChannel !== "function")
    throw new TypeError("checkFeedsForChannel must be a function");

  const initial = channelsFrom(getChannels);
  if (initial.length === 0) return null;

  const scheduleByCacheKey = new Map();
  const lastCheckByCacheKey = new Map();
  const active = new Map();
  let currentIndex = 0;
  let nextChannelKey = null;
  let timer = null;
  let stopped = false;
  let polling = false;

  function scheduleNext() {
    if (!stopped && timer === null)
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, delayBetweenChannels);
  }

  async function perform(key, index, channel, schedule, minDelay) {
    const label = getChannelLabel(channel);
    const startedAt = Date.now();
    schedule.lastAttemptAt = startedAt;
    scheduleByCacheKey.set(key, schedule);
    expert("queue.channel.selected", { index: index + 1, channel: label, concurrent: true });
    try {
      await checkFeedsForChannel(index, channel);
      const finishedAt = Date.now();
      schedule.lastSuccessAt = finishedAt;
      schedule.failures = 0;
      schedule.nextRunAt = finishedAt + minDelay;
      lastCheckByCacheKey.set(key, finishedAt);
      expert("queue.channel.complete", { index: index + 1, channel: label, durationMs: finishedAt - startedAt });
    } catch (err) {
      const finishedAt = Date.now();
      if (!isCancelled(err)) schedule.failures = Math.min(32, schedule.failures + 1);
      const backoff = Math.min(minDelay * 2 ** Math.min(3, Math.max(0, schedule.failures - 1)),
        Math.max(minDelay, 3600000));
      const retryAfter = getRetryAfterMs(err?.response?.headers, finishedAt) || 0;
      schedule.nextRunAt = finishedAt + Math.max(minDelay, backoff, retryAfter);
      if (err?.code === "CACHE_UNSAFE") {
        // Storage is no longer trustworthy; don't poll/feed more channels.
        logger.error("Persistent state is unsafe; stopping scheduler", { failure: errorRecord(err, { context: "state" }) });
        stop();
      } else if (!isCancelled(err)) {
        logger.error("Channel failed", { label, failure: errorRecord(err, { context: "source" }) });
        expert("queue.channel.failed", { index: index + 1, channel: label, durationMs: finishedAt - startedAt, error: err });
      }
    } finally {
      active.delete(key);
    }
  }

  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      try { await beforeCycle?.(); }
      catch (error) {
        logger.error("Configuration refresh failed", { failure: errorRecord(error, { context: "configuration" }) });
      }
      if (stopped) return;

      let channels;
      try { channels = channelsFrom(getChannels); }
      catch (error) {
        logger.error("Channel list refresh failed", { failure: errorRecord(error, { context: "configuration" }) });
        return;
      }
      if (channels.length === 0) return;

      currentIndex = nextChannelIndex(channels, nextChannelKey, currentIndex);
      const index = currentIndex;
      const channel = channels[index];
      currentIndex = (index + 1) % channels.length;
      nextChannelKey = channels[currentIndex] ? queueKey(channels[currentIndex], currentIndex) : null;
      if (!channel) return;

      const key = queueKey(channel, index);
      if (active.has(key) || active.size >= maxConcurrentChannels) return;

      const schedule = scheduleByCacheKey.get(key) || {
        lastAttemptAt: null, lastSuccessAt: null, nextRunAt: 0, failures: 0,
      };
      if (Date.now() < schedule.nextRunAt) return;

      // Insert into the active map before invoking user work. ChannelTasks
      // uses the same stable key and prevents duplicate tasks independently.
      const promise = perform(key, index, channel, schedule, (channel.TimeChecker || 30) * 60000);
      active.set(key, promise);
    } finally {
      polling = false;
      scheduleNext();
    }
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  void poll();
  return {
    stop,
    async idle() { await Promise.allSettled(Array.from(active.values())); },
    getState() {
      let totalChannels = 0;
      try { totalChannels = channelsFrom(getChannels).length; }
      catch { /* diagnostics must not crash on an invalid hot reload */ }
      return {
        currentIndex, nextChannelKey, totalChannels,
        maxConcurrentChannels,
        activeKeys: Array.from(active.keys()),
        lastCheckByCacheKey: Object.fromEntries(lastCheckByCacheKey),
        scheduleByCacheKey: Object.fromEntries(
          Array.from(scheduleByCacheKey, ([key, state]) => [key, { ...state }])),
        channels: getTaskStates(),
      };
    },
  };
}

module.exports = { startConcurrentChannelQueue, validateConcurrency };
